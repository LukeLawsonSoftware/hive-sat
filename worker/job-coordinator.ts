import { DurableObject } from "cloudflare:workers";
import {
  COORDINATOR_ALARM_BATCH_SIZE,
  COORDINATOR_HEARTBEAT_INTERVAL_MS,
  COORDINATOR_LEASE_DURATION_MS,
  COORDINATOR_LEASE_EXTENSION_MS,
  COORDINATOR_MAX_MESSAGE_BYTES,
  COORDINATOR_MAX_CUBE_DEPTH,
  COORDINATOR_MAX_TASKS,
  COORDINATOR_MAX_TASK_ATTEMPTS,
  cubeQueueWatermarks,
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
import {
  MAX_SAT_MODEL_ARTIFACT_BYTES,
  MAX_UNSAT_PROOF_COMPRESSED_BYTES,
  MAX_UNSAT_PROOF_DECOMPRESSED_BYTES,
  resultPathHash,
  satModelObjectKey,
  unsatProofObjectKey,
  type UnsatProofManifest,
} from "../shared/result-manifest";
import type {
  InitializeJobInput,
  ModelUploadAuthorization,
  ProofUploadAuthorization,
  OwnerActionResult,
  PublicJobStatus,
  UploadAuthorization,
} from "./contracts";
import { fixedTimeHexEqual, randomToken } from "./crypto";
import type { VerifySatResult, VerifyUnsatResult } from "./result-verifier";
import { calibratedTaskProfile } from "../shared/capability-profile";

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
  proof_required: number;
}

interface ProofArtifactRow {
  [key: string]: SqlStorageValue;
  artifact_id: string;
  task_id: string;
  lease_id: string;
  artifact_sha256: string;
  compressed_bytes: number;
  decompressed_bytes: number;
  verification_status: "UPLOADED" | "SERVER_CERTIFIED" | "OWNER_CHECK_REQUIRED" | "OWNER_VERIFIED" | "INVALID";
  created_at: number;
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
    if (version < 3) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE results ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE results ADD COLUMN manifest_json TEXT NOT NULL DEFAULT '{}';
        CREATE INDEX results_task_kind_session
          ON results(task_id, result_kind, session_id);
        CREATE TABLE result_verifications (
          task_id TEXT NOT NULL,
          evidence_sha256 TEXT NOT NULL,
          lease_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (task_id, evidence_sha256)
        );
        CREATE TABLE session_reliability (
          session_id TEXT PRIMARY KEY,
          verified_results INTEGER NOT NULL DEFAULT 0,
          invalid_results INTEGER NOT NULL DEFAULT 0,
          verification_timeouts INTEGER NOT NULL DEFAULT 0,
          quarantined INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (3, unixepoch('now') * 1000);
      `);
    }
    if (version < 4) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE session_profiles (
          session_id TEXT PRIMARY KEY,
          conflict_budget INTEGER NOT NULL,
          lease_duration_ms INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (4, unixepoch('now') * 1000);
      `);
    }
    if (version < 5) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE tasks ADD COLUMN proof_required INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE proof_artifacts (
          artifact_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          lease_id TEXT NOT NULL,
          artifact_sha256 TEXT NOT NULL,
          compressed_bytes INTEGER NOT NULL,
          decompressed_bytes INTEGER NOT NULL,
          verification_status TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX proof_artifacts_task ON proof_artifacts(task_id, verification_status);
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (5, unixepoch('now') * 1000);
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
    const certificate = this.ctx.storage.sql.exec<ProofArtifactRow>(
      `SELECT * FROM proof_artifacts
       WHERE verification_status IN ('SERVER_CERTIFIED', 'OWNER_CHECK_REQUIRED', 'OWNER_VERIFIED')
       ORDER BY CASE verification_status WHEN 'OWNER_CHECK_REQUIRED' THEN 0 ELSE 1 END,
                created_at ASC LIMIT 1`,
    ).toArray()[0];
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
      certificate: certificate ? {
        artifactId: certificate.artifact_id,
        artifactSha256: certificate.artifact_sha256,
        compressedBytes: certificate.compressed_bytes,
        decompressedBytes: certificate.decompressed_bytes,
        cube: parseAssumptions(this.task(certificate.task_id)?.assumptions_json ?? "[]"),
        verification: certificate.verification_status as
          "SERVER_CERTIFIED" | "OWNER_CHECK_REQUIRED" | "OWNER_VERIFIED",
        downloadUrl: `/api/v1/jobs/${encodeURIComponent(row.job_id)}/proofs/${encodeURIComponent(certificate.artifact_id)}`,
      } : null,
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

  authorizeModelUpload(leaseId: string): ModelUploadAuthorization {
    const job = this.job();
    const lease = this.ctx.storage.sql.exec<LeaseRow>(
      "SELECT * FROM leases WHERE lease_id = ?",
      leaseId,
    ).toArray()[0];
    const task = lease ? this.task(lease.task_id) : null;
    if (!job || !lease || !task) return { ok: false, code: "NOT_FOUND" };
    if (
      Date.now() >= job.expires_at ||
      ["CANCELLED", "INVALID", "SAT_VERIFIED", "UNSAT_CERTIFIED", "UNSAT_OWNER_VERIFIED", "UNKNOWN"].includes(job.state) ||
      task.state === "CANCELLED"
    ) {
      return { ok: false, code: "INVALID_STATE" };
    }
    return {
      ok: true,
      objectKey: satModelObjectKey(job.job_id, leaseId),
      jobId: job.job_id,
      formulaHash: job.formula_hash,
      task: this.toCubeTask(task),
      maximumBytes: MAX_SAT_MODEL_ARTIFACT_BYTES,
    };
  }

  authorizeProofUpload(leaseId: string, decompressedBytes: number): ProofUploadAuthorization {
    const job = this.job();
    const lease = this.ctx.storage.sql.exec<LeaseRow>(
      "SELECT * FROM leases WHERE lease_id = ?",
      leaseId,
    ).toArray()[0];
    const task = lease ? this.task(lease.task_id) : null;
    if (!job || !lease || !task) return { ok: false, code: "NOT_FOUND" };
    if (lease.status !== "ACTIVE" || task.active_lease_id !== leaseId || task.proof_required !== 1 ||
      task.state !== "LEASED" || Date.now() >= job.expires_at ||
      decompressedBytes < 1 || decompressedBytes > MAX_UNSAT_PROOF_DECOMPRESSED_BYTES) {
      return { ok: false, code: "INVALID_STATE" };
    }
    const used = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COALESCE(SUM(compressed_bytes), 0) AS total FROM proof_artifacts",
    ).one().total;
    const remaining = MAX_UNSAT_PROOF_COMPRESSED_BYTES - used;
    if (remaining < 1) return { ok: false, code: "PROOF_BUDGET_EXHAUSTED" };
    return {
      ok: true,
      objectKey: unsatProofObjectKey(job.job_id, leaseId),
      jobId: job.job_id,
      formulaHash: job.formula_hash,
      task: this.toCubeTask(task),
      maximumCompressedBytes: remaining,
      maximumDecompressedBytes: MAX_UNSAT_PROOF_DECOMPRESSED_BYTES,
    };
  }

  recordProofUpload(
    leaseId: string,
    artifactSha256: string,
    compressedBytes: number,
    decompressedBytes: number,
  ): boolean {
    const authorization = this.authorizeProofUpload(leaseId, decompressedBytes);
    if (!authorization.ok || compressedBytes < 1 || compressedBytes > authorization.maximumCompressedBytes) return false;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO proof_artifacts (
        artifact_id, task_id, lease_id, artifact_sha256, compressed_bytes,
        decompressed_bytes, verification_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'UPLOADED', ?)`,
      leaseId,
      authorization.task.taskId,
      leaseId,
      artifactSha256,
      compressedBytes,
      decompressedBytes,
      Date.now(),
    );
    return true;
  }

  proofDownload(artifactId: string): { objectKey: string; sha256: string } | null {
    const job = this.job();
    const proof = this.ctx.storage.sql.exec<ProofArtifactRow>(
      `SELECT * FROM proof_artifacts WHERE artifact_id = ?
       AND verification_status IN ('SERVER_CERTIFIED', 'OWNER_CHECK_REQUIRED', 'OWNER_VERIFIED')`,
      artifactId,
    ).toArray()[0];
    if (!job || !proof) return null;
    return { objectKey: unsatProofObjectKey(job.job_id, artifactId), sha256: proof.artifact_sha256 };
  }

  confirmOwnerProof(
    ownerDigest: string,
    artifactId: string,
    artifactSha256: string,
  ): { ok: boolean; state?: PublicJobStatus["state"]; code?: string } {
    const job = this.job();
    const proof = this.ctx.storage.sql.exec<ProofArtifactRow>(
      "SELECT * FROM proof_artifacts WHERE artifact_id = ?",
      artifactId,
    ).toArray()[0];
    if (!job || !proof) return { ok: false, code: "NOT_FOUND" };
    if (!fixedTimeHexEqual(ownerDigest, job.owner_digest)) return { ok: false, code: "INVALID_TOKEN" };
    if (proof.verification_status !== "OWNER_CHECK_REQUIRED" ||
      !fixedTimeHexEqual(artifactSha256, proof.artifact_sha256)) {
      return { ok: false, code: "INVALID_STATE" };
    }
    const now = Date.now();
    let terminal: "UNSAT_CERTIFIED" | "UNSAT_OWNER_VERIFIED" | null = null;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE proof_artifacts SET verification_status = 'OWNER_VERIFIED' WHERE artifact_id = ?",
        artifactId,
      );
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET state = 'UNSAT_OWNER_VERIFIED', updated_at = ? WHERE task_id = ? AND state = 'VERIFYING_UNSAT'",
        now,
        proof.task_id,
      );
      terminal = this.propagateUnsatCoverage(this.task(proof.task_id)?.parent_task_id ?? null, now);
    });
    if (terminal) {
      this.broadcast({ ...this.serverBase(job.job_id), type: "JOB_RESULT", result: terminal, taskId: "root" });
      void this.env.SWARM_DIRECTORY.getByName("global-v1").close(job.job_id);
    }
    return { ok: true, state: this.job()?.state ?? "RUNNING" };
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
      const artifactKeys = [...this.modelObjectKeys(row.job_id), ...this.proofObjectKeys(row.job_id)];
      if (artifactKeys.length > 0) await this.env.FORMULAS.delete(artifactKeys);
      await this.scheduleNextAlarm();
    }
    return { ok: true, changed, objectKey: row.object_key };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const row = this.job();
    if (!row || !["QUEUED", "RUNNING"].includes(row.state) || Date.now() >= row.expires_at) {
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

    const handled = await this.handleClientMessage(attachment.sessionId, message);
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
      await this.env.FORMULAS.delete([
        row.object_key,
        ...this.modelObjectKeys(row.job_id),
        ...this.proofObjectKeys(row.job_id),
      ]);
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
    const reliability = this.ctx.storage.sql.exec<{ quarantined: number }>(
      "SELECT quarantined FROM session_reliability WHERE session_id = ?",
      message.sessionId,
    ).toArray()[0];
    if (reliability?.quarantined === 1) {
      this.sendError(ws, attachment.jobId, "SESSION_QUARANTINED", false, message.messageId);
      ws.close(1008, "Session quarantined");
      return;
    }
    const nextAttachment: SocketAttachment = { ...attachment, sessionId: message.sessionId };
    ws.serializeAttachment(nextAttachment);
    const now = Date.now();
    const profile = calibratedTaskProfile(message.capabilities);
    this.ctx.storage.sql.exec(
      `INSERT INTO session_profiles (
        session_id, conflict_budget, lease_duration_ms, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        conflict_budget = excluded.conflict_budget,
        lease_duration_ms = excluded.lease_duration_ms,
        updated_at = excluded.updated_at`,
      message.sessionId,
      profile.conflictBudget,
      profile.leaseDurationMs,
      now,
    );
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
      leaseDurationMs: profile.leaseDurationMs,
      activeLeases,
    };
    ws.send(JSON.stringify(response));
  }

  private async handleClientMessage(
    sessionId: string,
    message: Exclude<CoordinatorClientMessage, HelloMessage>,
  ): Promise<HandledResponse> {
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
          "SELECT * FROM tasks WHERE state = 'READY' AND attempt_count < ? ORDER BY proof_required, depth, created_at, task_id LIMIT 1",
          COORDINATOR_MAX_TASK_ATTEMPTS,
        ).toArray()[0]
        : undefined;
      let response: CoordinatorServerMessage;
      const exhausted = job && !task && (job.state === "QUEUED" || job.state === "RUNNING")
        ? this.ctx.storage.sql.exec<TaskRow>(
          "SELECT * FROM tasks WHERE state = 'READY' AND attempt_count >= ? ORDER BY proof_required, depth, created_at, task_id LIMIT 1",
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
        const leaseDurationMs = this.ctx.storage.sql.exec<{ lease_duration_ms: number }>(
          "SELECT lease_duration_ms FROM session_profiles WHERE session_id = ?",
          sessionId,
        ).toArray()[0]?.lease_duration_ms ?? COORDINATOR_LEASE_DURATION_MS;
        const lease: Lease = {
          leaseId,
          taskId: task.task_id,
          attempt: task.attempt_count + 1,
          issuedAt: now,
          expiresAt: Math.min(now + leaseDurationMs, job.expires_at),
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
        const queue = this.queueSnapshot(task.depth, task.proof_required === 1);
        response = {
          ...this.serverBase(message.jobId, now),
          type: "WORK",
          requestMessageId: message.messageId,
          task: this.toCubeTask(task),
          lease,
          queue,
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
      if (!lease || !task || !job || task.depth >= COORDINATOR_MAX_CUBE_DEPTH || task.proof_required === 1) {
        return this.errorResponse(message.jobId, lease ? "INVALID_STATE" : "STALE_LEASE", false, message.messageId).serialized;
      }
      const taskCount = this.ctx.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM tasks",
      ).one().total;
      if (taskCount > COORDINATOR_MAX_TASKS - 2) {
        return this.errorResponse(message.jobId, "TASK_LIMIT", false, message.messageId).serialized;
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

  private async handleResult(sessionId: string, message: ResultMessage): Promise<HandledResponse> {
    const now = Date.now();
    const duplicate = this.processedResponse(sessionId, message.messageId);
    if (duplicate) return { serialized: duplicate, deadlineChanged: false };
    const lease = this.ctx.storage.sql.exec<LeaseRow>(
      "SELECT * FROM leases WHERE lease_id = ? AND task_id = ? AND session_id = ?",
      message.leaseId,
      message.taskId,
      sessionId,
    ).toArray()[0];
    if (!lease) return this.errorResponse(message.jobId, "STALE_LEASE", false, message.messageId);
    const task = this.task(message.taskId);
    const job = this.job();
    if (
      !task ||
      !job ||
      now >= job.expires_at ||
      ["CANCELLED", "INVALID", "SAT_VERIFIED", "UNSAT_CERTIFIED", "UNSAT_OWNER_VERIFIED", "UNKNOWN"].includes(job.state) ||
      task.state === "CANCELLED"
    ) {
      return this.errorResponse(message.jobId, "INVALID_STATE", false, message.messageId);
    }
    const cube = parseAssumptions(task.assumptions_json);
    if (
      message.manifest.formulaHash !== job.formula_hash ||
      message.manifest.taskId !== task.task_id ||
      message.manifest.pathHash !== await resultPathHash(cube) ||
      JSON.stringify(message.manifest.cube) !== JSON.stringify(cube)
    ) {
      return this.errorResponse(message.jobId, "INVALID_STATE", false, message.messageId);
    }
    const stale = lease.status !== "ACTIVE" ||
      lease.expires_at <= now ||
      task.active_lease_id !== lease.lease_id;

    if (message.result === "UNSAT") {
      return this.handleUnsatResult(sessionId, message, lease, task, stale, now);
    }
    if (
      message.manifest.kind !== "SAT_MODEL_V1" ||
      message.manifest.artifactId !== message.leaseId ||
      message.manifest.variableCount !== job.variable_count
    ) {
      return this.errorResponse(message.jobId, "INVALID_STATE", false, message.messageId);
    }

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO results (
          task_id, lease_id, result_kind, evidence_sha256, received_at, stale,
          session_id, manifest_json
        ) VALUES (?, ?, 'SAT', ?, ?, ?, ?, ?)`,
        message.taskId,
        message.leaseId,
        message.evidenceSha256,
        now,
        stale ? 1 : 0,
        sessionId,
        JSON.stringify(message.manifest),
      );
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO result_verifications (
          task_id, evidence_sha256, lease_id, session_id, status, reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'PENDING', NULL, ?, ?)`,
        message.taskId,
        message.evidenceSha256,
        message.leaseId,
        sessionId,
        now,
        now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET state = 'VERIFYING_SAT', active_lease_id = NULL, updated_at = ? WHERE task_id = ?",
        now,
        task.task_id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE leases SET status = CASE WHEN lease_id = ? THEN 'RESULT' ELSE 'SUPERSEDED' END WHERE task_id = ? AND status = 'ACTIVE'",
        message.leaseId,
        message.taskId,
      );
    });

    let verification: VerifySatResult;
    try {
      verification = await this.env.RESULT_VERIFIERS
        .getByName(`${job.job_id}:${task.task_id}:${message.evidenceSha256}`)
        .verifySat({
          formulaObjectKey: job.object_key,
          modelObjectKey: satModelObjectKey(job.job_id, message.leaseId),
          manifest: message.manifest,
          expectedCube: cube,
          expectedVariableCount: job.variable_count,
        });
    } catch (error) {
      verification = { status: "VERIFICATION_TIMEOUT", reason: `Verifier unavailable: ${String(error)}` };
    }

    this.ctx.storage.transactionSync(() => {
      const finishedAt = Date.now();
      this.ctx.storage.sql.exec(
        `UPDATE result_verifications SET status = ?, reason = ?, updated_at = ?
         WHERE task_id = ? AND evidence_sha256 = ? AND status = 'PENDING'`,
        verification.status,
        "reason" in verification ? verification.reason : null,
        finishedAt,
        task.task_id,
        message.evidenceSha256,
      );
      if (verification.status === "VALID_SAT") {
        this.ctx.storage.sql.exec(
          `INSERT INTO session_reliability (
            session_id, verified_results, invalid_results, verification_timeouts,
            quarantined, updated_at
          ) VALUES (?, 1, 0, 0, 0, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            verified_results = verified_results + 1, updated_at = excluded.updated_at`,
          sessionId,
          finishedAt,
        );
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'CANCELLED', active_lease_id = NULL, updated_at = ? WHERE state NOT IN ('CANCELLED', 'SAT_VERIFIED')",
          finishedAt,
        );
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'SAT_VERIFIED', active_lease_id = NULL, updated_at = ? WHERE task_id IN (?, 'root')",
          finishedAt,
          task.task_id,
        );
        this.ctx.storage.sql.exec("UPDATE jobs SET state = 'SAT_VERIFIED'");
        this.ctx.storage.sql.exec("UPDATE leases SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'");
      } else if (verification.status === "INVALID_FORMULA") {
        this.ctx.storage.sql.exec("UPDATE jobs SET state = 'INVALID'");
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'UNKNOWN', active_lease_id = NULL, updated_at = ? WHERE state NOT IN ('CANCELLED')",
          finishedAt,
        );
        this.ctx.storage.sql.exec("UPDATE leases SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'");
      } else {
        const invalid = verification.status === "INVALID_MODEL";
        this.ctx.storage.sql.exec(
          `INSERT INTO session_reliability (
            session_id, verified_results, invalid_results, verification_timeouts,
            quarantined, updated_at
          ) VALUES (?, 0, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            invalid_results = invalid_results + excluded.invalid_results,
            verification_timeouts = verification_timeouts + excluded.verification_timeouts,
            quarantined = MAX(quarantined, excluded.quarantined),
            updated_at = excluded.updated_at`,
          sessionId,
          invalid ? 1 : 0,
          invalid ? 0 : 1,
          invalid ? 1 : 0,
          finishedAt,
        );
        const nextState: TaskState =
          task.attempt_count >= COORDINATOR_MAX_TASK_ATTEMPTS ? "UNKNOWN" : "READY";
        this.ctx.storage.sql.exec(
          `UPDATE tasks SET state = ?, active_lease_id = NULL, updated_at = ?
           WHERE task_id = ? AND state = 'VERIFYING_SAT'`,
          nextState,
          finishedAt,
          task.task_id,
        );
        if (task.task_id === "root" && nextState === "UNKNOWN") {
          this.ctx.storage.sql.exec("UPDATE jobs SET state = 'UNKNOWN'");
        }
      }
      const response: CoordinatorServerMessage = {
        ...this.serverBase(message.jobId, finishedAt),
        type: "ACK",
        requestMessageId: message.messageId,
        action: "RESULT",
        staleLease: stale,
      };
      this.recordProcessed(sessionId, message.messageId, JSON.stringify(response), finishedAt);
    });

    if (verification.status === "INVALID_MODEL") {
      await this.env.FORMULAS.delete(satModelObjectKey(job.job_id, message.leaseId));
    } else if (verification.status === "VALID_SAT") {
      this.broadcast({
        ...this.serverBase(job.job_id),
        type: "JOB_RESULT",
        result: "SAT_VERIFIED",
        taskId: task.task_id,
      });
    }
    if (verification.status === "VALID_SAT" || verification.status === "INVALID_FORMULA") {
      await this.env.SWARM_DIRECTORY.getByName("global-v1").close(job.job_id);
    }
    return {
      serialized: this.processedResponse(sessionId, message.messageId) ??
        this.errorResponse(message.jobId, "INVALID_STATE", false, message.messageId).serialized,
      deadlineChanged: true,
    };
  }

  private async handleUnsatResult(
    sessionId: string,
    message: ResultMessage,
    lease: LeaseRow,
    task: TaskRow,
    stale: boolean,
    now: number,
  ): Promise<HandledResponse> {
    if (message.manifest.kind === "UNSAT_PROOF_V1") {
      return this.handleUnsatProof(sessionId, message, lease, task, stale, now, message.manifest);
    }
    if (task.proof_required === 1 || message.manifest.kind !== "UNSAT_CANDIDATE_V1") {
      return this.errorResponse(message.jobId, "INVALID_STATE", false, message.messageId);
    }
    const serialized = this.ctx.storage.transactionSync(() => {
      const duplicate = this.processedResponse(sessionId, message.messageId);
      if (duplicate) return duplicate;
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO results (
          task_id, lease_id, result_kind, evidence_sha256, received_at, stale,
          session_id, manifest_json
        ) VALUES (?, ?, 'UNSAT', ?, ?, ?, ?, ?)`,
        message.taskId,
        message.leaseId,
        message.evidenceSha256,
        now,
        stale ? 1 : 0,
        sessionId,
        JSON.stringify(message.manifest),
      );
      const independentSolves = this.ctx.storage.sql.exec<{ total: number }>(
        `SELECT COUNT(DISTINCT session_id) AS total FROM results
         WHERE task_id = ? AND result_kind = 'UNSAT'`,
        message.taskId,
      ).one().total;
      const reportingCurrentLease = lease.status === "ACTIVE" && task.active_lease_id === lease.lease_id;
      if (task.state !== "VERIFYING_SAT") {
        if (independentSolves >= 2) {
          this.ctx.storage.sql.exec(
            "UPDATE tasks SET state = 'READY', proof_required = 1, active_lease_id = NULL, updated_at = ? WHERE task_id = ?",
            now,
            task.task_id,
          );
          this.ctx.storage.sql.exec(
            "UPDATE leases SET status = CASE WHEN lease_id = ? THEN 'RESULT' ELSE 'SUPERSEDED' END WHERE task_id = ? AND status = 'ACTIVE'",
            lease.lease_id,
            task.task_id,
          );
        } else if (reportingCurrentLease) {
          const nextState: TaskState =
            task.attempt_count >= COORDINATOR_MAX_TASK_ATTEMPTS ? "UNKNOWN" : "READY";
          this.ctx.storage.sql.exec(
            "UPDATE tasks SET state = ?, active_lease_id = NULL, updated_at = ? WHERE task_id = ?",
            nextState,
            now,
            task.task_id,
          );
          this.ctx.storage.sql.exec("UPDATE leases SET status = 'RESULT' WHERE lease_id = ?", lease.lease_id);
          if (task.task_id === "root" && nextState === "UNKNOWN") {
            this.ctx.storage.sql.exec("UPDATE jobs SET state = 'UNKNOWN'");
          }
        }
      }
      const response: CoordinatorServerMessage = {
        ...this.serverBase(message.jobId, now),
        type: "ACK",
        requestMessageId: message.messageId,
        action: "RESULT",
        staleLease: stale,
      };
      const responseJson = JSON.stringify(response);
      this.recordProcessed(sessionId, message.messageId, responseJson, now);
      return responseJson;
    });
    return { serialized, deadlineChanged: true };
  }

  private async handleUnsatProof(
    sessionId: string,
    message: ResultMessage,
    lease: LeaseRow,
    task: TaskRow,
    stale: boolean,
    now: number,
    manifest: UnsatProofManifest,
  ): Promise<HandledResponse> {
    if (task.proof_required !== 1 || manifest.artifactId !== lease.lease_id) {
      return this.errorResponse(message.jobId, "INVALID_STATE", false, message.messageId);
    }
    const artifact = this.ctx.storage.sql.exec<ProofArtifactRow>(
      "SELECT * FROM proof_artifacts WHERE artifact_id = ? AND task_id = ?",
      manifest.artifactId,
      task.task_id,
    ).toArray()[0];
    if (!artifact || artifact.artifact_sha256 !== manifest.artifactSha256 ||
      artifact.compressed_bytes !== manifest.compressedBytes ||
      artifact.decompressed_bytes !== manifest.decompressedBytes) {
      return this.errorResponse(message.jobId, "INVALID_STATE", false, message.messageId);
    }
    const job = this.job();
    if (!job) return this.errorResponse(message.jobId, "INVALID_STATE", false, message.messageId);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET state = 'VERIFYING_UNSAT', active_lease_id = NULL, updated_at = ? WHERE task_id = ?",
        now,
        task.task_id,
      );
      this.ctx.storage.sql.exec("UPDATE leases SET status = 'RESULT' WHERE lease_id = ?", lease.lease_id);
    });
    let verification: VerifyUnsatResult;
    try {
      verification = await this.env.RESULT_VERIFIERS
        .getByName(`${job.job_id}:${task.task_id}:${manifest.artifactSha256}`)
        .verifyUnsat({
          jobId: job.job_id,
          formulaObjectKey: job.object_key,
          manifest,
          expectedCube: parseAssumptions(task.assumptions_json),
        });
    } catch (error) {
      verification = { status: "VERIFICATION_TIMEOUT", reason: `Verifier unavailable: ${String(error)}` };
    }
    const finishedAt = Date.now();
    let terminal: "UNSAT_CERTIFIED" | "UNSAT_OWNER_VERIFIED" | null = null;
    this.ctx.storage.transactionSync(() => {
      if (verification.status === "VALID_UNSAT") {
        this.ctx.storage.sql.exec(
          "UPDATE proof_artifacts SET verification_status = 'SERVER_CERTIFIED' WHERE artifact_id = ?",
          manifest.artifactId,
        );
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'UNSAT_CERTIFIED', updated_at = ? WHERE task_id = ?",
          finishedAt,
          task.task_id,
        );
        terminal = this.propagateUnsatCoverage(task.parent_task_id, finishedAt);
      } else if (verification.status === "OWNER_CHECK_REQUIRED") {
        this.ctx.storage.sql.exec(
          "UPDATE proof_artifacts SET verification_status = 'OWNER_CHECK_REQUIRED' WHERE artifact_id = ?",
          manifest.artifactId,
        );
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE proof_artifacts SET verification_status = 'INVALID' WHERE artifact_id = ?",
          manifest.artifactId,
        );
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'UNKNOWN', proof_required = 0, updated_at = ? WHERE task_id = ?",
          finishedAt,
          task.task_id,
        );
        if (task.task_id === "root") this.ctx.storage.sql.exec("UPDATE jobs SET state = 'UNKNOWN'");
      }
      const response: CoordinatorServerMessage = {
        ...this.serverBase(message.jobId, finishedAt),
        type: "ACK",
        requestMessageId: message.messageId,
        action: "RESULT",
        staleLease: stale,
      };
      this.recordProcessed(sessionId, message.messageId, JSON.stringify(response), finishedAt);
    });
    if (terminal) {
      this.broadcast({ ...this.serverBase(job.job_id), type: "JOB_RESULT", result: terminal, taskId: "root" });
      await this.env.SWARM_DIRECTORY.getByName("global-v1").close(job.job_id);
    }
    return {
      serialized: this.processedResponse(sessionId, message.messageId) ??
        this.errorResponse(message.jobId, "INVALID_STATE", false, message.messageId).serialized,
      deadlineChanged: true,
    };
  }

  private propagateUnsatCoverage(parentTaskId: string | null, now: number): "UNSAT_CERTIFIED" | "UNSAT_OWNER_VERIFIED" | null {
    let parentId = parentTaskId;
    while (parentId) {
      const parent = this.task(parentId);
      if (!parent || parent.state !== "SPLIT") return null;
      const children = this.ctx.storage.sql.exec<TaskRow>(
        "SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY task_id",
        parentId,
      ).toArray();
      if (children.length !== 2 || children.some((child) =>
        child.state !== "UNSAT_CERTIFIED" && child.state !== "UNSAT_OWNER_VERIFIED")) return null;
      const parentCube = parseAssumptions(parent.assumptions_json);
      const left = parseAssumptions(children[0].assumptions_json);
      const right = parseAssumptions(children[1].assumptions_json);
      const prefixIntact = left.length === parentCube.length + 1 &&
        right.length === parentCube.length + 1 &&
        parentCube.every((literal, index) => left[index] === literal && right[index] === literal);
      const leftBranch = left[left.length - 1];
      const rightBranch = right[right.length - 1];
      if (!prefixIntact || leftBranch === undefined || rightBranch === undefined || leftBranch !== -rightBranch) return null;
      const state: TaskState = children.some((child) => child.state === "UNSAT_OWNER_VERIFIED")
        ? "UNSAT_OWNER_VERIFIED"
        : "UNSAT_CERTIFIED";
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ? AND state = 'SPLIT'",
        state,
        now,
        parentId,
      );
      if (parentId === "root") {
        this.closeUnsatJob(state, now);
        return state;
      }
      parentId = parent.parent_task_id;
    }
    const root = this.task("root");
    if (root?.state === "UNSAT_CERTIFIED" || root?.state === "UNSAT_OWNER_VERIFIED") {
      this.closeUnsatJob(root.state, now);
      return root.state;
    }
    return null;
  }

  private closeUnsatJob(state: "UNSAT_CERTIFIED" | "UNSAT_OWNER_VERIFIED", now: number): void {
    this.ctx.storage.sql.exec("UPDATE jobs SET state = ?", state);
    this.ctx.storage.sql.exec(
      `UPDATE tasks SET state = 'CANCELLED', active_lease_id = NULL, updated_at = ?
       WHERE state IN ('READY', 'LEASED', 'YIELDED', 'PROOF_PENDING')`,
      now,
    );
    this.ctx.storage.sql.exec("UPDATE leases SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'");
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

  private modelObjectKeys(jobId: string): string[] {
    return this.ctx.storage.sql.exec<{ lease_id: string }>(
      "SELECT DISTINCT lease_id FROM results WHERE result_kind = 'SAT'",
    ).toArray().map((row) => satModelObjectKey(jobId, row.lease_id));
  }

  private proofObjectKeys(jobId: string): string[] {
    return this.ctx.storage.sql.exec<{ artifact_id: string }>(
      "SELECT artifact_id FROM proof_artifacts",
    ).toArray().map((row) => unsatProofObjectKey(jobId, row.artifact_id));
  }

  private toCubeTask(row: TaskRow): CubeTask {
    return {
      taskId: row.task_id,
      parentTaskId: row.parent_task_id,
      depth: row.depth,
      assumptions: parseAssumptions(row.assumptions_json),
      purpose: row.proof_required === 1 ? "PROOF_FINISHER" : "SEARCH",
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

  private queueSnapshot(taskDepth: number, proofRequired = false) {
    const readyTasks = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM tasks WHERE state = 'READY'",
    ).one().total;
    const activeWorkers = Math.max(1, this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(DISTINCT session_id) AS total FROM leases WHERE status = 'ACTIVE'",
    ).one().total);
    const taskCount = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM tasks",
    ).one().total;
    return {
      readyTasks,
      activeWorkers,
      ...cubeQueueWatermarks(activeWorkers),
      taskCount,
      canSplit: !proofRequired && taskDepth < COORDINATOR_MAX_CUBE_DEPTH && taskCount <= COORDINATOR_MAX_TASKS - 2,
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
