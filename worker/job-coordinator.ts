import { DurableObject } from "cloudflare:workers";
import {
  COORDINATOR_ALARM_BATCH_SIZE,
  COORDINATOR_HEARTBEAT_INTERVAL_MS,
  COORDINATOR_LEASE_DURATION_MS,
  COORDINATOR_LEASE_EXTENSION_MS,
  COORDINATOR_MAX_MESSAGE_BYTES,
  COORDINATOR_MAX_TASK_ATTEMPTS,
  type CoordinatorClientMessage,
  type CoordinatorErrorMessage,
  type CoordinatorServerMessage,
  type CubeTask,
  type HeartbeatMessage,
  type HelloMessage,
  type Lease,
  type ResultMessage,
  type SplitMessage,
  type TaskState,
  type YieldMessage,
  parseCoordinatorClientMessage,
} from "../shared/coordinator-protocol";
import { PUBLIC_JOB_PROTOCOL_VERSION } from "../shared/public-jobs";
import type {
  InitializeJobInput,
  OwnerActionResult,
  PublicJobStatus,
  UploadAuthorization,
} from "./contracts";
import { fixedTimeHexEqual, randomToken } from "./crypto";

interface JobRow {
  [key: string]: SqlStorageValue;
  job_id: string;
  state: PublicJobStatus["state"];
  owner_digest: string;
  upload_digest: string | null;
  formula_hash: string;
  variable_count: number;
  clause_count: number;
  literal_count: number;
  encoded_bytes: number;
  compressed_bytes: number;
  uploaded_bytes: number | null;
  object_key: string;
  created_at: number;
  expires_at: number;
}

interface TaskRow {
  [key: string]: SqlStorageValue;
  task_id: string;
  parent_task_id: string | null;
  depth: number;
  assumptions_json: string;
  state: TaskState;
  created_at: number;
  updated_at: number;
  attempt_count: number;
  active_lease_id: string | null;
}

interface LeaseRow {
  [key: string]: SqlStorageValue;
  lease_id: string;
  task_id: string;
  session_id: string;
  attempt: number;
  issued_at: number;
  expires_at: number;
  status: "ACTIVE" | "EXPIRED" | "SPLIT" | "YIELDED" | "RESULT" | "SUPERSEDED" | "CANCELLED";
  extended: number;
}

interface SocketAttachment {
  protocolVersion: typeof PUBLIC_JOB_PROTOCOL_VERSION;
  jobId: string;
  connectedAt: number;
  sessionId: string | null;
}

interface HandledResponse {
  serialized: string;
  deadlineChanged: boolean;
}

const LEASE_EXTENSION_THRESHOLD_MS = 2 * 60_000;
const NO_WORK_RETRY_MS = 5_000;
const MAX_CUBE_DEPTH = 64;
const PROCESSED_MESSAGE_LIMIT = 2_048;

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attachment = value as Record<string, unknown>;
  return attachment.protocolVersion === PUBLIC_JOB_PROTOCOL_VERSION &&
    typeof attachment.jobId === "string" &&
    typeof attachment.connectedAt === "number" &&
    (attachment.sessionId === null || typeof attachment.sessionId === "string");
}

function parseAssumptions(json: string): number[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((literal) => Number.isSafeInteger(literal) && literal !== 0)) {
    throw new Error("Stored cube assumptions are invalid.");
  }
  return value as number[];
}

export class JobCoordinatorDO extends DurableObject<Env> {
  private deleted = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("PING", "PONG"));
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
        CREATE TABLE jobs (
          job_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          owner_digest TEXT NOT NULL,
          upload_digest TEXT,
          formula_hash TEXT NOT NULL,
          variable_count INTEGER NOT NULL,
          clause_count INTEGER NOT NULL,
          literal_count INTEGER NOT NULL,
          encoded_bytes INTEGER NOT NULL,
          compressed_bytes INTEGER NOT NULL,
          uploaded_bytes INTEGER,
          object_key TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE tasks (
          task_id TEXT PRIMARY KEY,
          parent_task_id TEXT,
          depth INTEGER NOT NULL,
          assumptions_json TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (1, unixepoch('now') * 1000);
      `);
    }
    if (version < 2) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE tasks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN active_lease_id TEXT;
        UPDATE tasks SET updated_at = created_at WHERE updated_at = 0;
        CREATE INDEX tasks_ready ON tasks(state, created_at);
        CREATE TABLE leases (
          lease_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          extended INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX leases_active_deadline ON leases(status, expires_at);
        CREATE INDEX leases_session ON leases(session_id, status);
        CREATE TABLE results (
          task_id TEXT NOT NULL,
          lease_id TEXT NOT NULL,
          result_kind TEXT NOT NULL,
          evidence_sha256 TEXT NOT NULL,
          received_at INTEGER NOT NULL,
          stale INTEGER NOT NULL,
          PRIMARY KEY (task_id, lease_id, result_kind, evidence_sha256)
        );
        CREATE TABLE processed_messages (
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          response_json TEXT NOT NULL,
          processed_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, message_id)
        );
        CREATE INDEX processed_messages_age ON processed_messages(processed_at);
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (2, unixepoch('now') * 1000);
      `);
    }
  }

  async initialize(input: InitializeJobInput): Promise<void> {
    const existing = this.job();
    if (existing) {
      if (existing.job_id !== input.jobId || existing.formula_hash !== input.formula.hash) {
        throw new Error("Job coordinator was already initialized with different metadata.");
      }
      return;
    }

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO jobs (
          job_id, state, owner_digest, upload_digest, formula_hash,
          variable_count, clause_count, literal_count, encoded_bytes,
          compressed_bytes, uploaded_bytes, object_key, created_at, expires_at
        ) VALUES (?, 'UPLOADING', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        input.jobId,
        input.ownerDigest,
        input.uploadDigest,
        input.formula.hash,
        input.formula.variableCount,
        input.formula.clauseCount,
        input.formula.literalCount,
        input.formula.encodedBytes,
        input.formula.compressedBytes,
        input.objectKey,
        input.createdAt,
        input.expiresAt,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO tasks (
          task_id, parent_task_id, depth, assumptions_json, state, created_at, updated_at
        ) VALUES ('root', NULL, 0, '[]', 'READY', ?, ?)`,
        input.createdAt,
        input.createdAt,
      );
    });
    await this.ctx.storage.setAlarm(input.expiresAt);
  }

  getStatus(): PublicJobStatus | null {
    const row = this.job();
    if (!row) return null;
    const root = this.ctx.storage.sql.exec<{ state: TaskState }>(
      "SELECT state FROM tasks WHERE task_id = 'root'",
    ).one();
    return {
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      jobId: row.job_id,
      state: row.state,
      formula: {
        hash: row.formula_hash,
        variableCount: row.variable_count,
        clauseCount: row.clause_count,
        literalCount: row.literal_count,
        encodedBytes: row.encoded_bytes,
        compressedBytes: row.compressed_bytes,
      },
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      uploadedBytes: row.uploaded_bytes,
      rootTaskState: root.state,
    };
  }

  authorizeUpload(uploadDigest: string): UploadAuthorization {
    const row = this.job();
    if (!row) return { ok: false, code: "NOT_FOUND" };
    if (!row.upload_digest || !fixedTimeHexEqual(uploadDigest, row.upload_digest)) {
      return { ok: false, code: "INVALID_TOKEN" };
    }
    if (row.state !== "UPLOADING") return { ok: false, code: "INVALID_STATE" };
    return {
      ok: true,
      objectKey: row.object_key,
      formulaHash: row.formula_hash,
      compressedBytes: row.compressed_bytes,
    };
  }

  completeUpload(uploadDigest: string, uploadedBytes: number): UploadAuthorization {
    const authorization = this.authorizeUpload(uploadDigest);
    if (!authorization.ok) return authorization;
    if (uploadedBytes !== authorization.compressedBytes) {
      return { ok: false, code: "INVALID_STATE" };
    }
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET state = 'QUEUED', uploaded_bytes = ?, upload_digest = NULL WHERE state = 'UPLOADING'",
      uploadedBytes,
    );
    return authorization;
  }

  async cancel(ownerDigest: string): Promise<OwnerActionResult> {
    const row = this.job();
    if (!row) return { ok: false, code: "NOT_FOUND" };
    if (!fixedTimeHexEqual(ownerDigest, row.owner_digest)) {
      return { ok: false, code: "INVALID_TOKEN" };
    }
    const changed = row.state !== "CANCELLED";
    if (changed) {
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE jobs SET state = 'CANCELLED', uploaded_bytes = NULL, upload_digest = NULL");
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'CANCELLED', active_lease_id = NULL, updated_at = ?",
          now,
        );
        this.ctx.storage.sql.exec("UPDATE leases SET status = 'CANCELLED' WHERE status = 'ACTIVE'");
      });
      this.broadcast({
        ...this.serverBase(row.job_id, now),
        type: "JOB_CANCELLED",
        reason: "OWNER_CANCELLED",
      });
      await this.scheduleNextAlarm();
    }
    return { ok: true, changed, objectKey: row.object_key };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const row = this.job();
    if (!row || row.state === "UPLOADING" || row.state === "CANCELLED" || Date.now() >= row.expires_at) {
      return new Response("Job is not available", { status: 409 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = {
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      jobId: row.job_id,
      connectedAt: Date.now(),
      sessionId: null,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [`job:${row.job_id}`]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment();
    if (!isSocketAttachment(attachment)) {
      ws.close(1011, "Invalid socket attachment");
      return;
    }
    if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > COORDINATOR_MAX_MESSAGE_BYTES) {
      this.sendError(ws, attachment.jobId, "INVALID_MESSAGE", false);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch {
      this.sendError(ws, attachment.jobId, "INVALID_MESSAGE", false);
      return;
    }
    const parsed = parseCoordinatorClientMessage(value);
    if (!parsed.ok) {
      this.sendError(ws, attachment.jobId, parsed.code, false);
      if (parsed.code === "UPGRADE_REQUIRED") ws.close(1008, "Upgrade required");
      return;
    }
    const message = parsed.message;
    if (message.jobId !== attachment.jobId) {
      this.sendError(ws, attachment.jobId, "JOB_MISMATCH", false, message.messageId);
      return;
    }
    if (message.type === "HELLO") {
      this.handleHello(ws, attachment, message);
      return;
    }
    if (!attachment.sessionId) {
      this.sendError(ws, attachment.jobId, "HELLO_REQUIRED", true, message.messageId);
      return;
    }

    const handled = this.handleClientMessage(attachment.sessionId, message);
    if (handled.deadlineChanged) await this.scheduleNextAlarm();
    ws.send(handled.serialized);
  }

  webSocketClose(): void {
    // A disconnect does not revoke a lease. The same session can reconnect and
    // resume until the persisted deadline; the alarm owns authoritative recovery.
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    const attachment = ws.deserializeAttachment();
    console.error(JSON.stringify({
      event: "coordinator.socket_error",
      jobId: isSocketAttachment(attachment) ? attachment.jobId : "unknown",
      error: String(error),
    }));
  }

  async alarm(): Promise<void> {
    const row = this.job();
    if (!row) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();
    if (now >= row.expires_at) {
      this.broadcast({
        ...this.serverBase(row.job_id, now),
        type: "JOB_CANCELLED",
        reason: "EXPIRED",
      });
      if (!this.env.FORMULAS || !this.env.SWARM_DIRECTORY) {
        throw new Error("Job cleanup bindings are not configured.");
      }
      await this.env.FORMULAS.delete(row.object_key);
      await this.env.SWARM_DIRECTORY.getByName("global-v1").close(row.job_id);
      await this.ctx.storage.deleteAll();
      this.deleted = true;
      return;
    }

    const expired = this.ctx.storage.sql.exec<LeaseRow>(
      `SELECT * FROM leases
       WHERE status = 'ACTIVE' AND expires_at <= ?
       ORDER BY expires_at, lease_id LIMIT ?`,
      now,
      COORDINATOR_ALARM_BATCH_SIZE,
    ).toArray();
    this.ctx.storage.transactionSync(() => {
      for (const lease of expired) {
        this.ctx.storage.sql.exec("UPDATE leases SET status = 'EXPIRED' WHERE lease_id = ? AND status = 'ACTIVE'", lease.lease_id);
        const task = this.ctx.storage.sql.exec<TaskRow>(
          "SELECT * FROM tasks WHERE task_id = ? AND active_lease_id = ?",
          lease.task_id,
          lease.lease_id,
        ).toArray()[0];
        if (!task) continue;
        const state: TaskState = task.attempt_count >= COORDINATOR_MAX_TASK_ATTEMPTS ? "UNKNOWN" : "READY";
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = ?, active_lease_id = NULL, updated_at = ? WHERE task_id = ? AND active_lease_id = ?",
          state,
          now,
          task.task_id,
          lease.lease_id,
        );
        if (task.task_id === "root" && state === "UNKNOWN") {
          this.ctx.storage.sql.exec("UPDATE jobs SET state = 'UNKNOWN'");
        }
      }
      this.ctx.storage.sql.exec(
        `DELETE FROM processed_messages WHERE rowid IN (
          SELECT rowid FROM processed_messages ORDER BY processed_at DESC LIMIT -1 OFFSET ?
        )`,
        PROCESSED_MESSAGE_LIMIT,
      );
    });

    if (expired.length === COORDINATOR_ALARM_BATCH_SIZE && this.hasExpiredLease(now)) {
      await this.ctx.storage.setAlarm(Math.min(now + 1, row.expires_at));
    } else {
      await this.scheduleNextAlarm();
    }
  }

  private handleHello(ws: WebSocket, attachment: SocketAttachment, message: HelloMessage): void {
    const nextAttachment: SocketAttachment = { ...attachment, sessionId: message.sessionId };
    ws.serializeAttachment(nextAttachment);
    const now = Date.now();
    const activeLeases = this.ctx.storage.sql.exec<LeaseRow & TaskRow>(
      `SELECT l.*, t.task_id, t.parent_task_id, t.depth, t.assumptions_json,
              t.state, t.created_at, t.updated_at, t.attempt_count, t.active_lease_id
       FROM leases l JOIN tasks t ON t.task_id = l.task_id
       WHERE l.session_id = ? AND l.status = 'ACTIVE' AND l.expires_at > ?
       ORDER BY l.issued_at`,
      message.sessionId,
      now,
    ).toArray().map((row) => ({ task: this.toCubeTask(row), lease: this.toLease(row) }));
    const response: CoordinatorServerMessage = {
      ...this.serverBase(message.jobId, now),
      type: "WELCOME",
      heartbeatIntervalMs: COORDINATOR_HEARTBEAT_INTERVAL_MS,
      leaseDurationMs: COORDINATOR_LEASE_DURATION_MS,
      activeLeases,
    };
    ws.send(JSON.stringify(response));
  }

  private handleClientMessage(sessionId: string, message: Exclude<CoordinatorClientMessage, HelloMessage>): HandledResponse {
    const duplicate = this.processedResponse(sessionId, message.messageId);
    if (duplicate) return { serialized: duplicate, deadlineChanged: false };
    switch (message.type) {
      case "REQUEST_WORK": return this.handleRequestWork(sessionId, message);
      case "HEARTBEAT": return this.handleHeartbeat(sessionId, message);
      case "SPLIT": return this.handleSplit(sessionId, message);
      case "YIELD": return this.handleYield(sessionId, message);
      case "RESULT": return this.handleResult(sessionId, message);
    }
  }

  private handleRequestWork(sessionId: string, message: Exclude<CoordinatorClientMessage, HelloMessage | HeartbeatMessage | SplitMessage | YieldMessage | ResultMessage>): HandledResponse {
    const now = Date.now();
    const leaseId = randomToken(24);
    let deadlineChanged = false;
    const serialized = this.ctx.storage.transactionSync(() => {
      const duplicate = this.processedResponse(sessionId, message.messageId);
      if (duplicate) return duplicate;
      const job = this.job();
      const task = job && (job.state === "QUEUED" || job.state === "RUNNING")
        ? this.ctx.storage.sql.exec<TaskRow>(
          "SELECT * FROM tasks WHERE state = 'READY' AND attempt_count < ? ORDER BY depth, created_at, task_id LIMIT 1",
          COORDINATOR_MAX_TASK_ATTEMPTS,
        ).toArray()[0]
        : undefined;
      let response: CoordinatorServerMessage;
      const exhausted = job && !task && (job.state === "QUEUED" || job.state === "RUNNING")
        ? this.ctx.storage.sql.exec<TaskRow>(
          "SELECT * FROM tasks WHERE state = 'READY' AND attempt_count >= ? ORDER BY depth, created_at, task_id LIMIT 1",
          COORDINATOR_MAX_TASK_ATTEMPTS,
        ).toArray()[0]
        : undefined;
      if (exhausted) {
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'UNKNOWN', updated_at = ? WHERE task_id = ? AND state = 'READY'",
          now,
          exhausted.task_id,
        );
        if (exhausted.task_id === "root") this.ctx.storage.sql.exec("UPDATE jobs SET state = 'UNKNOWN'");
        response = {
          ...this.serverBase(message.jobId, now),
          type: "ERROR",
          requestMessageId: message.messageId,
          code: "ATTEMPTS_EXHAUSTED",
          retryable: false,
        };
      } else if (!job || !task) {
        response = {
          ...this.serverBase(message.jobId, now),
          type: "NO_WORK",
          requestMessageId: message.messageId,
          retryAfterMs: NO_WORK_RETRY_MS,
        };
      } else {
        const lease: Lease = {
          leaseId,
          taskId: task.task_id,
          attempt: task.attempt_count + 1,
          issuedAt: now,
          expiresAt: Math.min(now + COORDINATOR_LEASE_DURATION_MS, job.expires_at),
        };
        this.ctx.storage.sql.exec(
          `INSERT INTO leases (
            lease_id, task_id, session_id, attempt, issued_at, expires_at, status, extended
          ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 0)`,
          lease.leaseId,
          lease.taskId,
          sessionId,
          lease.attempt,
          lease.issuedAt,
          lease.expiresAt,
        );
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'LEASED', attempt_count = ?, active_lease_id = ?, updated_at = ? WHERE task_id = ? AND state = 'READY'",
          lease.attempt,
          lease.leaseId,
          now,
          task.task_id,
        );
        this.ctx.storage.sql.exec("UPDATE jobs SET state = 'RUNNING' WHERE state = 'QUEUED'");
        response = {
          ...this.serverBase(message.jobId, now),
          type: "WORK",
          requestMessageId: message.messageId,
          task: this.toCubeTask(task),
          lease,
        };
        deadlineChanged = true;
      }
      const responseJson = JSON.stringify(response);
      this.recordProcessed(sessionId, message.messageId, responseJson, now);
      return responseJson;
    });
    return { serialized, deadlineChanged };
  }

  private handleHeartbeat(sessionId: string, message: HeartbeatMessage): HandledResponse {
    const now = Date.now();
    if (message.requestExtension === true) {
      let deadlineChanged = false;
      const serialized = this.ctx.storage.transactionSync(() => {
        const duplicate = this.processedResponse(sessionId, message.messageId);
        if (duplicate) return duplicate;
        const lease = this.activeLease(sessionId, message.taskId, message.leaseId, now);
        if (!lease) return this.errorResponse(message.jobId, "STALE_LEASE", false, message.messageId).serialized;
        let expiresAt = lease.expires_at;
        const job = this.job();
        if (job && lease.extended === 0 && lease.expires_at - now <= LEASE_EXTENSION_THRESHOLD_MS) {
          expiresAt = Math.min(lease.expires_at + COORDINATOR_LEASE_EXTENSION_MS, job.expires_at);
          if (expiresAt > lease.expires_at) {
            this.ctx.storage.sql.exec(
              "UPDATE leases SET expires_at = ?, extended = 1 WHERE lease_id = ? AND status = 'ACTIVE'",
              expiresAt,
              lease.lease_id,
            );
            deadlineChanged = true;
          }
        }
        const response: CoordinatorServerMessage = {
          ...this.serverBase(message.jobId, now),
          type: "ACK",
          requestMessageId: message.messageId,
          action: "HEARTBEAT",
          leaseExpiresAt: expiresAt,
        };
        const responseJson = JSON.stringify(response);
        this.recordProcessed(sessionId, message.messageId, responseJson, now);
        return responseJson;
      });
      return { serialized, deadlineChanged };
    }
    const lease = this.activeLease(sessionId, message.taskId, message.leaseId, now);
    if (!lease) return this.errorResponse(message.jobId, "STALE_LEASE", false, message.messageId);
    const response: CoordinatorServerMessage = {
      ...this.serverBase(message.jobId, now),
      type: "ACK",
      requestMessageId: message.messageId,
      action: "HEARTBEAT",
      leaseExpiresAt: lease.expires_at,
    };
    return { serialized: JSON.stringify(response), deadlineChanged: false };
  }

  private handleSplit(sessionId: string, message: SplitMessage): HandledResponse {
    const now = Date.now();
    const positiveTaskId = randomToken(18);
    const negativeTaskId = randomToken(18);
    let deadlineChanged = false;
    const serialized = this.ctx.storage.transactionSync(() => {
      const duplicate = this.processedResponse(sessionId, message.messageId);
      if (duplicate) return duplicate;
      const lease = this.activeLease(sessionId, message.taskId, message.leaseId, now);
      const task = lease ? this.task(message.taskId) : null;
      const job = this.job();
      if (!lease || !task || !job || task.depth >= MAX_CUBE_DEPTH) {
        return this.errorResponse(message.jobId, lease ? "INVALID_STATE" : "STALE_LEASE", false, message.messageId).serialized;
      }
      const assumptions = parseAssumptions(task.assumptions_json);
      const variable = Math.abs(message.splitLiteral);
      if (variable > job.variable_count || assumptions.some((literal) => Math.abs(literal) === variable)) {
        return this.errorResponse(message.jobId, "INVALID_STATE", false, message.messageId).serialized;
      }
      const literal = message.splitLiteral;
      const depth = task.depth + 1;
      this.ctx.storage.sql.exec(
        `INSERT INTO tasks (task_id, parent_task_id, depth, assumptions_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'READY', ?, ?), (?, ?, ?, ?, 'READY', ?, ?)`,
        positiveTaskId,
        task.task_id,
        depth,
        JSON.stringify([...assumptions, literal]),
        now,
        now,
        negativeTaskId,
        task.task_id,
        depth,
        JSON.stringify([...assumptions, -literal]),
        now,
        now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET state = 'SPLIT', active_lease_id = NULL, updated_at = ? WHERE task_id = ? AND active_lease_id = ?",
        now,
        task.task_id,
        lease.lease_id,
      );
      this.ctx.storage.sql.exec("UPDATE leases SET status = 'SPLIT' WHERE lease_id = ?", lease.lease_id);
      const response: CoordinatorServerMessage = {
        ...this.serverBase(message.jobId, now),
        type: "ACK",
        requestMessageId: message.messageId,
        action: "SPLIT",
      };
      const responseJson = JSON.stringify(response);
      this.recordProcessed(sessionId, message.messageId, responseJson, now);
      deadlineChanged = true;
      return responseJson;
    });
    return { serialized, deadlineChanged };
  }

  private handleYield(sessionId: string, message: YieldMessage): HandledResponse {
    const now = Date.now();
    let deadlineChanged = false;
    const serialized = this.ctx.storage.transactionSync(() => {
      const duplicate = this.processedResponse(sessionId, message.messageId);
      if (duplicate) return duplicate;
      const lease = this.activeLease(sessionId, message.taskId, message.leaseId, now);
      if (!lease) return this.errorResponse(message.jobId, "STALE_LEASE", false, message.messageId).serialized;
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET state = 'READY', active_lease_id = NULL, updated_at = ? WHERE task_id = ? AND active_lease_id = ?",
        now,
        message.taskId,
        message.leaseId,
      );
      this.ctx.storage.sql.exec("UPDATE leases SET status = 'YIELDED' WHERE lease_id = ?", message.leaseId);
      const response: CoordinatorServerMessage = {
        ...this.serverBase(message.jobId, now),
        type: "ACK",
        requestMessageId: message.messageId,
        action: "YIELD",
      };
      const responseJson = JSON.stringify(response);
      this.recordProcessed(sessionId, message.messageId, responseJson, now);
      deadlineChanged = true;
      return responseJson;
    });
    return { serialized, deadlineChanged };
  }

  private handleResult(sessionId: string, message: ResultMessage): HandledResponse {
    const now = Date.now();
    let deadlineChanged = false;
    const serialized = this.ctx.storage.transactionSync(() => {
      const duplicate = this.processedResponse(sessionId, message.messageId);
      if (duplicate) return duplicate;
      const lease = this.ctx.storage.sql.exec<LeaseRow>(
        "SELECT * FROM leases WHERE lease_id = ? AND task_id = ? AND session_id = ?",
        message.leaseId,
        message.taskId,
        sessionId,
      ).toArray()[0];
      if (!lease) return this.errorResponse(message.jobId, "STALE_LEASE", false, message.messageId).serialized;
      const task = this.task(message.taskId);
      const job = this.job();
      if (!task || !job || now >= job.expires_at || job.state === "CANCELLED" || task.state === "CANCELLED") {
        return this.errorResponse(message.jobId, "INVALID_STATE", false, message.messageId).serialized;
      }
      const stale = lease.status !== "ACTIVE" || lease.expires_at <= now || task.active_lease_id !== lease.lease_id;
      const candidateState: TaskState = message.result === "SAT" ? "SAT_CANDIDATE" : "UNSAT_CANDIDATE";
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO results (
          task_id, lease_id, result_kind, evidence_sha256, received_at, stale
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        message.taskId,
        message.leaseId,
        message.result,
        message.evidenceSha256,
        now,
        stale ? 1 : 0,
      );
      this.ctx.storage.sql.exec(
        `UPDATE tasks SET state = ?, active_lease_id = NULL, updated_at = ?
         WHERE task_id = ? AND state NOT IN ('SAT_CANDIDATE', 'UNSAT_CANDIDATE')`,
        candidateState,
        now,
        message.taskId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE leases SET status = CASE WHEN lease_id = ? THEN 'RESULT' ELSE 'SUPERSEDED' END WHERE task_id = ? AND status = 'ACTIVE'",
        message.leaseId,
        message.taskId,
      );
      const response: CoordinatorServerMessage = {
        ...this.serverBase(message.jobId, now),
        type: "ACK",
        requestMessageId: message.messageId,
        action: "RESULT",
        staleLease: stale,
      };
      const responseJson = JSON.stringify(response);
      this.recordProcessed(sessionId, message.messageId, responseJson, now);
      deadlineChanged = true;
      return responseJson;
    });
    return { serialized, deadlineChanged };
  }

  private activeLease(sessionId: string, taskId: string, leaseId: string, now: number): LeaseRow | null {
    return this.ctx.storage.sql.exec<LeaseRow>(
      `SELECT l.* FROM leases l JOIN tasks t ON t.task_id = l.task_id
       WHERE l.lease_id = ? AND l.task_id = ? AND l.session_id = ?
         AND l.status = 'ACTIVE' AND l.expires_at > ?
         AND t.state = 'LEASED' AND t.active_lease_id = l.lease_id`,
      leaseId,
      taskId,
      sessionId,
      now,
    ).toArray()[0] ?? null;
  }

  private processedResponse(sessionId: string, messageId: string): string | null {
    return this.ctx.storage.sql.exec<{ response_json: string }>(
      "SELECT response_json FROM processed_messages WHERE session_id = ? AND message_id = ?",
      sessionId,
      messageId,
    ).toArray()[0]?.response_json ?? null;
  }

  private recordProcessed(sessionId: string, messageId: string, response: string, now: number): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO processed_messages (session_id, message_id, response_json, processed_at) VALUES (?, ?, ?, ?)",
      sessionId,
      messageId,
      response,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM processed_messages WHERE rowid IN (
        SELECT rowid FROM processed_messages ORDER BY processed_at DESC LIMIT -1 OFFSET ?
      )`,
      PROCESSED_MESSAGE_LIMIT,
    );
  }

  private task(taskId: string): TaskRow | null {
    return this.ctx.storage.sql.exec<TaskRow>("SELECT * FROM tasks WHERE task_id = ?", taskId).toArray()[0] ?? null;
  }

  private toCubeTask(row: TaskRow): CubeTask {
    return {
      taskId: row.task_id,
      parentTaskId: row.parent_task_id,
      depth: row.depth,
      assumptions: parseAssumptions(row.assumptions_json),
    };
  }

  private toLease(row: LeaseRow): Lease {
    return {
      leaseId: row.lease_id,
      taskId: row.task_id,
      attempt: row.attempt,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
  }

  private serverBase(jobId: string, now = Date.now()): Pick<CoordinatorServerMessage, "protocolVersion" | "messageId" | "jobId" | "serverTime"> {
    return {
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: crypto.randomUUID(),
      jobId,
      serverTime: now,
    };
  }

  private errorResponse(jobId: string, code: CoordinatorErrorMessage["code"], retryable: boolean, requestMessageId?: string): HandledResponse {
    const response: CoordinatorErrorMessage = {
      ...this.serverBase(jobId),
      type: "ERROR",
      code,
      retryable,
      ...(requestMessageId ? { requestMessageId } : {}),
    };
    return { serialized: JSON.stringify(response), deadlineChanged: false };
  }

  private sendError(ws: WebSocket, jobId: string, code: CoordinatorErrorMessage["code"], retryable: boolean, requestMessageId?: string): void {
    ws.send(this.errorResponse(jobId, code, retryable, requestMessageId).serialized);
  }

  private broadcast(message: CoordinatorServerMessage): void {
    const serialized = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(serialized);
      } catch (error) {
        console.error(JSON.stringify({ event: "coordinator.broadcast_error", error: String(error) }));
      }
    }
  }

  private hasExpiredLease(now: number): boolean {
    return this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM leases WHERE status = 'ACTIVE' AND expires_at <= ?",
      now,
    ).one().total > 0;
  }

  private async scheduleNextAlarm(): Promise<void> {
    const job = this.job();
    if (!job) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const lease = this.ctx.storage.sql.exec<{ expires_at: number | null }>(
      "SELECT MIN(expires_at) AS expires_at FROM leases WHERE status = 'ACTIVE'",
    ).one();
    await this.ctx.storage.setAlarm(Math.min(job.expires_at, lease.expires_at ?? job.expires_at));
  }

  private job(): JobRow | null {
    if (this.deleted) return null;
    return this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs LIMIT 1").toArray()[0] ?? null;
  }
}
