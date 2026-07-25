import { DurableObject } from "cloudflare:workers";
import {
  CREATION_WINDOW_MS,
  MAX_CREATIONS_PER_WINDOW,
  type AdmissionInput,
  type AdmissionResult,
} from "./contracts";
import {
  SWARM_ASSIGNMENT_QUANTUM_MS,
  SWARM_MAX_JOB_WORKERS,
  SWARM_MAX_MESSAGE_BYTES,
  SWARM_NO_WORK_RETRY_MS,
  parseSwarmClientMessage,
  type PreviousSwarmAssignment,
  type SwarmServerMessage,
} from "../shared/swarm-protocol";
import type { WorkerCapabilities } from "../shared/coordinator-protocol";
import { randomToken } from "./crypto";
import {
  newJobVirtualRuntime,
  reconciledVirtualRuntime,
  selectFairJob,
  type FairJob,
} from "./fair-scheduler";
import { calibratedTaskProfile } from "../shared/capability-profile";
import { PUBLIC_JOB_PROTOCOL_VERSION } from "../shared/public-jobs";

interface CreationRow {
  [key: string]: SqlStorageValue;
  created_at: number;
}

interface ActiveJobRow {
  [key: string]: SqlStorageValue;
  job_id: string;
  virtual_worker_ms: number;
  assigned_workers: number;
  last_service_at: number;
  expires_at: number;
  eligible: number;
}

interface AssignmentRow {
  [key: string]: SqlStorageValue;
  assignment_id: string;
  job_id: string;
  session_id: string;
  workers: number;
  reserved_worker_ms: number;
  actual_worker_ms: number | null;
  status: "ACTIVE" | "COMPLETE" | "EXPIRED" | "CANCELLED";
  assigned_at: number;
  expires_at: number;
}

export type SwarmAssignmentResult =
  | {
      ok: true;
      assignmentId: string;
      jobId: string;
      workers: number;
      quantumMs: number;
      reservedWorkerMs: number;
      conflictBudget: number;
      leaseTargetMs: number;
    }
  | { ok: false; code: "NO_WORK" | "INVALID_ASSIGNMENT" };

export class SwarmDirectoryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    const version = this.ctx.storage.sql
      .exec<{ version: number }>("SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations")
      .one().version;
    if (version < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE active_jobs (
          job_id TEXT PRIMARY KEY,
          device_digest TEXT NOT NULL,
          network_digest TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX active_jobs_device ON active_jobs(device_digest);
        CREATE UNIQUE INDEX active_jobs_network ON active_jobs(network_digest);
        CREATE TABLE creation_events (
          job_id TEXT PRIMARY KEY,
          device_digest TEXT NOT NULL,
          network_digest TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX creation_events_device ON creation_events(device_digest, created_at);
        CREATE INDEX creation_events_network ON creation_events(network_digest, created_at);
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (1, unixepoch('now') * 1000);
      `);
    }
    if (version < 2) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE active_jobs ADD COLUMN eligible INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE active_jobs ADD COLUMN virtual_worker_ms REAL NOT NULL DEFAULT 0;
        ALTER TABLE active_jobs ADD COLUMN reserved_worker_ms INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE active_jobs ADD COLUMN assigned_workers INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE active_jobs ADD COLUMN last_service_at INTEGER NOT NULL DEFAULT 0;
        UPDATE active_jobs SET last_service_at = created_at WHERE last_service_at = 0;
        CREATE INDEX active_jobs_fair_queue
          ON active_jobs(eligible, virtual_worker_ms, last_service_at);
        CREATE TABLE assignments (
          assignment_id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          workers INTEGER NOT NULL,
          reserved_worker_ms INTEGER NOT NULL,
          actual_worker_ms INTEGER,
          status TEXT NOT NULL,
          assigned_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX assignments_deadline ON assignments(status, expires_at);
        CREATE INDEX assignments_session ON assignments(session_id, status);
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (2, unixepoch('now') * 1000);
      `);
    }
    if (version < 3) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE turnstile_replays (
          token_digest TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX turnstile_replays_expiry ON turnstile_replays(expires_at);
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (3, unixepoch('now') * 1000);
      `);
    }
  }

  async consumeTurnstile(tokenDigest: string, expiresAt: number, now = Date.now()): Promise<boolean> {
    this.ctx.storage.sql.exec("DELETE FROM turnstile_replays WHERE expires_at <= ?", now);
    const inserted = this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO turnstile_replays (token_digest, expires_at) VALUES (?, ?)",
      tokenDigest,
      expiresAt,
    );
    await this.scheduleNextAlarm();
    return inserted.rowsWritten > 0;
  }

  async admit(input: AdmissionInput): Promise<AdmissionResult> {
    const windowStart = input.createdAt - CREATION_WINDOW_MS;
    this.ctx.storage.sql.exec("DELETE FROM creation_events WHERE created_at <= ?", windowStart);

    const active = this.ctx.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM active_jobs").one().total;
    if (active >= input.globalCeiling) return { ok: false, code: "GLOBAL_JOB_LIMIT" };

    const existing = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM active_jobs WHERE device_digest = ? OR network_digest = ?",
      input.deviceDigest,
      input.networkDigest,
    ).one().total;
    if (existing > 0) return { ok: false, code: "ACTIVE_JOB_LIMIT" };

    const recent = this.ctx.storage.sql.exec<CreationRow>(
      `SELECT created_at FROM creation_events
       WHERE (device_digest = ? OR network_digest = ?) AND created_at >= ?
       ORDER BY created_at ASC`,
      input.deviceDigest,
      input.networkDigest,
      windowStart,
    ).toArray();
    if (recent.length >= MAX_CREATIONS_PER_WINDOW) {
      return {
        ok: false,
        code: "CREATION_RATE_LIMIT",
        retryAt: recent[0].created_at + CREATION_WINDOW_MS,
      };
    }

    const fairJobs = this.activeFairJobs();
    const initialVirtualRuntime = newJobVirtualRuntime(fairJobs);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO active_jobs (
          job_id, device_digest, network_digest, created_at, expires_at,
          eligible, virtual_worker_ms, reserved_worker_ms, assigned_workers,
          last_service_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, ?)`,
        input.jobId,
        input.deviceDigest,
        input.networkDigest,
        input.createdAt,
        input.expiresAt,
        initialVirtualRuntime,
        input.createdAt,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO creation_events (job_id, device_digest, network_digest, created_at) VALUES (?, ?, ?, ?)",
        input.jobId,
        input.deviceDigest,
        input.networkDigest,
        input.createdAt,
      );
    });
    await this.scheduleNextAlarm();
    return { ok: true };
  }

  async close(jobId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE assignments SET status = 'CANCELLED' WHERE job_id = ? AND status = 'ACTIVE'",
        jobId,
      );
      this.ctx.storage.sql.exec("DELETE FROM active_jobs WHERE job_id = ?", jobId);
    });
    await this.scheduleNextAlarm();
  }

  markReady(jobId: string, now = Date.now()): boolean {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE active_jobs SET eligible = 1, last_service_at = ?
       WHERE job_id = ? AND eligible = 0`,
      now,
      jobId,
    );
    return cursor.rowsWritten > 0;
  }

  known(jobId: string, now = Date.now()): boolean {
    return this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM creation_events WHERE job_id = ? AND created_at >= ?",
      jobId,
      now - CREATION_WINDOW_MS,
    ).one().total > 0;
  }

  async rollback(jobId: string): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM active_jobs WHERE job_id = ?", jobId);
      this.ctx.storage.sql.exec("DELETE FROM creation_events WHERE job_id = ?", jobId);
    });
    await this.scheduleNextAlarm();
  }

  snapshot(): { activeJobs: number; activeWorkers: number } {
    return this.ctx.storage.sql.exec<{ activeJobs: number; activeWorkers: number }>(
      `SELECT COUNT(*) AS activeJobs,
              COALESCE(SUM(assigned_workers), 0) AS activeWorkers
       FROM active_jobs WHERE eligible = 1`,
    ).one();
  }

  quotaSnapshot(): {
    activeJobs: number;
    activeWorkers: number;
    activeAssignments: number;
    reservedWorkerMs: number;
    directoryConnections: number;
    creationsInWindow: number;
  } {
    const active = this.snapshot();
    const assignments = this.ctx.storage.sql.exec<{
      activeAssignments: number;
      reservedWorkerMs: number;
    }>(
      `SELECT COUNT(*) AS activeAssignments,
              COALESCE(SUM(reserved_worker_ms), 0) AS reservedWorkerMs
       FROM assignments WHERE status = 'ACTIVE'`,
    ).one();
    const creationsInWindow = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM creation_events WHERE created_at >= ?",
      Date.now() - CREATION_WINDOW_MS,
    ).one().total;
    return {
      ...active,
      ...assignments,
      directoryConnections: this.ctx.getWebSockets().length,
      creationsInWindow,
    };
  }

  async assign(
    sessionId: string,
    capabilities: WorkerCapabilities,
    previousAssignment?: PreviousSwarmAssignment,
    now = Date.now(),
  ): Promise<SwarmAssignmentResult> {
    const assignmentId = randomToken(24);
    const result = this.ctx.storage.transactionSync(() => {
      this.expireAssignments(now);
      if (previousAssignment && !this.reconcile(
        sessionId,
        previousAssignment.assignmentId,
        previousAssignment.activeWorkerMs,
      )) {
        return { ok: false, code: "INVALID_ASSIGNMENT" } as const;
      }
      const selected = selectFairJob(this.activeFairJobs(), capabilities.maxWorkers, now);
      if (!selected) return { ok: false, code: "NO_WORK" } as const;
      const workers = selected.workers;
      const profile = calibratedTaskProfile(capabilities);
      const reservedWorkerMs = SWARM_ASSIGNMENT_QUANTUM_MS * workers;
      const expiresAt = now + SWARM_ASSIGNMENT_QUANTUM_MS;
      this.ctx.storage.sql.exec(
        `INSERT INTO assignments (
          assignment_id, job_id, session_id, workers, reserved_worker_ms,
          actual_worker_ms, status, assigned_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'ACTIVE', ?, ?)`,
        assignmentId,
        selected.job.jobId,
        sessionId,
        workers,
        reservedWorkerMs,
        now,
        expiresAt,
      );
      this.ctx.storage.sql.exec(
        `UPDATE active_jobs SET
          virtual_worker_ms = virtual_worker_ms + ?,
          reserved_worker_ms = reserved_worker_ms + ?,
          assigned_workers = assigned_workers + ?,
          last_service_at = ?
         WHERE job_id = ?`,
        reservedWorkerMs,
        reservedWorkerMs,
        workers,
        now,
        selected.job.jobId,
      );
      return {
        ok: true,
        assignmentId,
        jobId: selected.job.jobId,
        workers,
        quantumMs: SWARM_ASSIGNMENT_QUANTUM_MS,
        reservedWorkerMs,
        conflictBudget: profile.conflictBudget,
        leaseTargetMs: profile.leaseDurationMs,
      } as const;
    });
    await this.scheduleNextAlarm();
    return result;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const maximumConnections = Number.parseInt(this.env.MAX_DIRECTORY_CONNECTIONS, 10);
    if (!Number.isSafeInteger(maximumConnections) || maximumConnections < 1 ||
      this.ctx.getWebSockets().length >= maximumConnections) {
      return new Response("Directory connection capacity reached", {
        status: 503,
        headers: { "retry-after": "10" },
      });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > SWARM_MAX_MESSAGE_BYTES) {
      this.sendAndClose(ws, {
        ...this.serverBase("invalid", this.snapshot()),
        type: "SWARM_ERROR",
        code: "INVALID_MESSAGE",
        retryable: false,
      });
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch {
      value = null;
    }
    const parsed = parseSwarmClientMessage(value);
    if (!parsed.ok) {
      this.sendAndClose(ws, {
        ...this.serverBase(
          typeof value === "object" && value && "messageId" in value
            ? String((value as { messageId: unknown }).messageId)
            : "invalid",
          this.snapshot(),
        ),
        type: "SWARM_ERROR",
        code: parsed.code,
        retryable: false,
      });
      return;
    }
    const assigned = await this.assign(
      parsed.message.sessionId,
      parsed.message.capabilities,
      parsed.message.previousAssignment,
    );
    const snapshot = this.snapshot();
    let response: SwarmServerMessage;
    if (assigned.ok) {
      response = {
        ...this.serverBase(parsed.message.messageId, snapshot),
        type: "SWARM_ASSIGNMENT",
        assignmentId: assigned.assignmentId,
        jobId: assigned.jobId,
        workers: assigned.workers,
        quantumMs: assigned.quantumMs,
        reservedWorkerMs: assigned.reservedWorkerMs,
        conflictBudget: assigned.conflictBudget,
        leaseTargetMs: assigned.leaseTargetMs,
      };
    } else if (assigned.code === "NO_WORK") {
      response = {
        ...this.serverBase(parsed.message.messageId, snapshot),
        type: "SWARM_NO_WORK",
        retryAfterMs: SWARM_NO_WORK_RETRY_MS,
      };
    } else {
      response = {
        ...this.serverBase(parsed.message.messageId, snapshot),
        type: "SWARM_ERROR",
        code: "INVALID_ASSIGNMENT",
        retryable: false,
      };
    }
    this.sendAndClose(ws, response);
  }

  webSocketClose(): void {
    // Directory sockets are intentionally one-shot and hold no assignment state.
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    console.error(JSON.stringify({ event: "swarm_directory.socket_error", error: String(error) }));
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => this.expireAssignments(now));
    this.ctx.storage.sql.exec("DELETE FROM active_jobs WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM creation_events WHERE created_at <= ?", now - CREATION_WINDOW_MS);
    this.ctx.storage.sql.exec("DELETE FROM turnstile_replays WHERE expires_at <= ?", now);
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ expires_at: number | null }>(
      `SELECT MIN(expires_at) AS expires_at FROM (
        SELECT expires_at FROM active_jobs
        UNION ALL
        SELECT expires_at FROM assignments WHERE status = 'ACTIVE'
        UNION ALL
        SELECT expires_at FROM turnstile_replays
        UNION ALL
        SELECT created_at + ${CREATION_WINDOW_MS} AS expires_at FROM creation_events
      )`,
    ).one();
    if (row.expires_at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(row.expires_at);
  }

  private activeFairJobs(): FairJob[] {
    return this.ctx.storage.sql.exec<ActiveJobRow>(
      `SELECT job_id, virtual_worker_ms, assigned_workers, last_service_at
       FROM active_jobs WHERE eligible = 1 AND assigned_workers < ?`,
      SWARM_MAX_JOB_WORKERS,
    ).toArray().map((row) => ({
      jobId: row.job_id,
      virtualWorkerMs: row.virtual_worker_ms,
      assignedWorkers: row.assigned_workers,
      lastServiceAt: row.last_service_at,
    }));
  }

  private reconcile(sessionId: string, assignmentId: string, actualWorkerMs: number): boolean {
    const assignment = this.ctx.storage.sql.exec<AssignmentRow>(
      `SELECT * FROM assignments
       WHERE assignment_id = ? AND session_id = ? AND status = 'ACTIVE'`,
      assignmentId,
      sessionId,
    ).toArray()[0];
    if (!assignment || actualWorkerMs > assignment.reserved_worker_ms) return false;
    const job = this.ctx.storage.sql.exec<ActiveJobRow>(
      "SELECT * FROM active_jobs WHERE job_id = ?",
      assignment.job_id,
    ).toArray()[0];
    if (job) {
      this.ctx.storage.sql.exec(
        `UPDATE active_jobs SET
          virtual_worker_ms = ?,
          reserved_worker_ms = MAX(0, reserved_worker_ms - ?),
          assigned_workers = MAX(0, assigned_workers - ?)
         WHERE job_id = ?`,
        reconciledVirtualRuntime(
          job.virtual_worker_ms,
          assignment.reserved_worker_ms,
          actualWorkerMs,
        ),
        assignment.reserved_worker_ms,
        assignment.workers,
        assignment.job_id,
      );
    }
    this.ctx.storage.sql.exec(
      `UPDATE assignments SET status = 'COMPLETE', actual_worker_ms = ?
       WHERE assignment_id = ?`,
      actualWorkerMs,
      assignmentId,
    );
    return true;
  }

  private expireAssignments(now: number): void {
    const expired = this.ctx.storage.sql.exec<AssignmentRow>(
      "SELECT * FROM assignments WHERE status = 'ACTIVE' AND expires_at <= ?",
      now,
    ).toArray();
    for (const assignment of expired) {
      this.ctx.storage.sql.exec(
        `UPDATE active_jobs SET
          reserved_worker_ms = MAX(0, reserved_worker_ms - ?),
          assigned_workers = MAX(0, assigned_workers - ?)
         WHERE job_id = ?`,
        assignment.reserved_worker_ms,
        assignment.workers,
        assignment.job_id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE assignments SET status = 'EXPIRED' WHERE assignment_id = ?",
        assignment.assignment_id,
      );
    }
  }

  private serverBase(requestMessageId: string, snapshot: ReturnType<SwarmDirectoryDO["snapshot"]>) {
    return {
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: crypto.randomUUID(),
      requestMessageId,
      serverTime: Date.now(),
      snapshot,
    };
  }

  private sendAndClose(ws: WebSocket, message: SwarmServerMessage): void {
    ws.send(JSON.stringify(message));
    ws.close(1000, "Directory handoff complete");
  }
}
