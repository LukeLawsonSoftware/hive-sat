import { DurableObject } from "cloudflare:workers";
import {
  COORDINATOR_ALARM_BATCH_SIZE,
  COORDINATOR_HEARTBEAT_INTERVAL_MS,
  COORDINATOR_LEASE_DURATION_MS,
  COORDINATOR_LEASE_RENEW_THRESHOLD_MS,
  COORDINATOR_MAX_FRONTIER,
  COORDINATOR_MAX_LEASE_TENURE_MS,
  COORDINATOR_MAX_MESSAGE_BYTES,
  COORDINATOR_MAX_CUBE_DEPTH,
  COORDINATOR_MAX_TASKS,
  COORDINATOR_SPLIT_PERMIT_MS,
  COORDINATOR_SPLIT_SEED_MS,
  type CoordinatorClientMessage,
  type CoordinatorErrorMessage,
  type CoordinatorServerMessage,
  type CubeTask,
  type HelloMessage,
  type Lease,
  type ResultMessage,
  type SessionHeartbeatMessage,
  type SplitMessage,
  type TaskState,
  type WorkMessage,
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
import { formulaObjectKey } from "./contracts";
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
import { deleteJobArtifacts, getJobArtifact, putJobArtifact } from "./job-artifacts";

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
  lease_count: number;
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
  object_key: string;
  verification_status: "UPLOADED" | "SERVER_CERTIFIED" | "OWNER_CHECK_REQUIRED" | "OWNER_VERIFIED" | "INVALID";
  created_at: number;
}

interface ModelArtifactRow {
  [key: string]: SqlStorageValue;
  lease_id: string;
  object_key: string;
  artifact_bytes: number;
  created_at: number;
}

interface LeaseRow {
  [key: string]: SqlStorageValue;
  lease_id: string;
  task_id: string;
  session_id: string;
  slot_id: string;
  lease_count: number;
  issued_at: number;
  expires_at: number;
  maximum_expires_at: number;
  last_active_ms: number;
  status: "ACTIVE" | "EXPIRED" | "SPLIT" | "YIELDED" | "RESULT" | "SUPERSEDED" | "CANCELLED";
}

interface SocketAttachment {
  protocolVersion: typeof PUBLIC_JOB_PROTOCOL_VERSION;
  jobId: string;
  connectedAt: number;
  sessionId: string | null;
  assignmentId: string | null;
  slotIds: string[];
}

interface SplitPermitRow {
  [key: string]: SqlStorageValue;
  permit_id: string;
  task_id: string;
  lease_id: string;
  session_id: string;
  slot_id: string;
  expires_at: number;
  status: "ACTIVE" | "CONSUMED" | "CANCELLED";
}

interface HandledResponse {
  serialized: string;
  deadlineChanged: boolean;
}

const PROCESSED_MESSAGE_LIMIT = 2_048;

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const attachment = value as Record<string, unknown>;
  return attachment.protocolVersion === PUBLIC_JOB_PROTOCOL_VERSION &&
    typeof attachment.jobId === "string" &&
    typeof attachment.connectedAt === "number" &&
    (attachment.sessionId === null || typeof attachment.sessionId === "string") &&
    (attachment.assignmentId === null || typeof attachment.assignmentId === "string") &&
    Array.isArray(attachment.slotIds) && attachment.slotIds.every((slotId) => typeof slotId === "string");
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
  private readonly inFlightResults = new Map<string, Promise<HandledResponse>>();

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
    if (version < 6) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE proof_artifacts ADD COLUMN object_key TEXT NOT NULL DEFAULT '';
        CREATE TABLE model_artifacts (
          lease_id TEXT PRIMARY KEY,
          object_key TEXT NOT NULL UNIQUE,
          artifact_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (6, unixepoch('now') * 1000);
      `);
    }
    if (version < 7) {
      this.ctx.storage.sql.exec(`
        ALTER TABLE tasks ADD COLUMN lease_count INTEGER NOT NULL DEFAULT 0;
        UPDATE tasks SET lease_count = attempt_count;
        ALTER TABLE leases ADD COLUMN slot_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE leases ADD COLUMN lease_count INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE leases ADD COLUMN maximum_expires_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE leases ADD COLUMN last_active_ms INTEGER NOT NULL DEFAULT 0;
        UPDATE leases SET
          lease_count = attempt,
          maximum_expires_at = CASE WHEN expires_at > issued_at + ${COORDINATOR_MAX_LEASE_TENURE_MS}
            THEN expires_at ELSE issued_at + ${COORDINATOR_MAX_LEASE_TENURE_MS} END;
        ALTER TABLE session_profiles ADD COLUMN proof_generation INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE split_permits (
          permit_id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          lease_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          slot_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          status TEXT NOT NULL
        );
        CREATE UNIQUE INDEX split_permits_active_lease
          ON split_permits(lease_id) WHERE status = 'ACTIVE';
        CREATE INDEX split_permits_expiry ON split_permits(status, expires_at);
        ALTER TABLE jobs ADD COLUMN status_revision INTEGER NOT NULL DEFAULT 1;
        UPDATE tasks SET state = 'READY', active_lease_id = NULL
          WHERE state IN ('YIELDED', 'UNKNOWN')
            AND EXISTS (SELECT 1 FROM jobs WHERE state IN ('QUEUED', 'RUNNING'));
        UPDATE leases SET status = 'EXPIRED' WHERE status = 'ACTIVE';
        INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (7, unixepoch('now') * 1000);
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
        "",
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
    if (row.state !== "UPLOADING") return { ok: false, code: "INVALID_STATE" };
    if (!row.upload_digest || !fixedTimeHexEqual(uploadDigest, row.upload_digest)) {
      return { ok: false, code: "INVALID_TOKEN" };
    }
    return {
      ok: true,
      objectKey: row.object_key,
      formulaHash: row.formula_hash,
      compressedBytes: row.compressed_bytes,
    };
  }

  async storeFormula(
    uploadDigest: string,
    body: ReadableStream<Uint8Array>,
    contentLength: number,
  ): Promise<
    | { ok: true; formulaHash: string; bytes: number }
    | { ok: false; code: "NOT_FOUND" | "INVALID_TOKEN" | "INVALID_STATE" | "INVALID_BODY" | "STORAGE_UNAVAILABLE" }
  > {
    const authorization = this.authorizeUpload(uploadDigest);
    if (!authorization.ok) return authorization;
    if (contentLength !== authorization.compressedBytes) return { ok: false, code: "INVALID_BODY" };
    const job = this.job();
    if (!job) return { ok: false, code: "NOT_FOUND" };
    const objectKey = formulaObjectKey(job.job_id, randomToken(18));
    try {
      await putJobArtifact(this.env.JOB_ARTIFACTS, objectKey, body, {
        kind: "formula",
        jobId: job.job_id,
        formulaHash: job.formula_hash,
        contentType: "application/vnd.hivesat.cnf+gzip",
        bytes: contentLength,
      }, job.expires_at);
    } catch (error) {
      return {
        ok: false,
        code: String(error).includes("declared byte length") ? "INVALID_BODY" : "STORAGE_UNAVAILABLE",
      };
    }
    const committed = this.ctx.storage.sql.exec(
      `UPDATE jobs SET state = 'QUEUED', uploaded_bytes = ?, upload_digest = NULL, object_key = ?
       WHERE state = 'UPLOADING' AND upload_digest = ?`,
      contentLength,
      objectKey,
      uploadDigest,
    ).rowsWritten === 1;
    if (!committed) {
      await this.env.JOB_ARTIFACTS.delete(objectKey);
      return { ok: false, code: "INVALID_STATE" };
    }
    return { ok: true, formulaHash: authorization.formulaHash, bytes: contentLength };
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

  async storeModel(
    leaseId: string,
    body: ReadableStream<Uint8Array>,
    contentLength: number,
  ): Promise<
    | { ok: true; taskId: string; bytes: number }
    | { ok: false; code: "NOT_FOUND" | "INVALID_STATE" | "INVALID_BODY" | "ALREADY_UPLOADED" | "STORAGE_UNAVAILABLE" }
  > {
    const authorization = this.authorizeModelUpload(leaseId);
    if (!authorization.ok) return authorization;
    if (contentLength < 12 || contentLength > authorization.maximumBytes) {
      return { ok: false, code: "INVALID_BODY" };
    }
    if (this.modelArtifact(leaseId)) return { ok: false, code: "ALREADY_UPLOADED" };
    const job = this.job();
    if (!job) return { ok: false, code: "NOT_FOUND" };
    const objectKey = satModelObjectKey(job.job_id, `${leaseId}-${randomToken(12)}`);
    try {
      await putJobArtifact(this.env.JOB_ARTIFACTS, objectKey, body, {
        kind: "sat-model",
        jobId: job.job_id,
        taskId: authorization.task.taskId,
        formulaHash: job.formula_hash,
        contentType: "application/vnd.hivesat.model",
        bytes: contentLength,
      }, job.expires_at);
    } catch (error) {
      return {
        ok: false,
        code: String(error).includes("declared byte length") ? "INVALID_BODY" : "STORAGE_UNAVAILABLE",
      };
    }
    if (!this.authorizeModelUpload(leaseId).ok) {
      await this.env.JOB_ARTIFACTS.delete(objectKey);
      return { ok: false, code: "INVALID_STATE" };
    }
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO model_artifacts (lease_id, object_key, artifact_bytes, created_at) VALUES (?, ?, ?, ?)",
      leaseId,
      objectKey,
      contentLength,
      Date.now(),
    );
    const committed = this.modelArtifact(leaseId)?.object_key === objectKey;
    if (!committed) {
      await this.env.JOB_ARTIFACTS.delete(objectKey);
      return { ok: false, code: "ALREADY_UPLOADED" };
    }
    return { ok: true, taskId: authorization.task.taskId, bytes: contentLength };
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

  async storeProof(
    leaseId: string,
    body: ReadableStream<Uint8Array>,
    contentLength: number,
    artifactSha256: string,
    decompressedBytes: number,
  ): Promise<
    | { ok: true; taskId: string; bytes: number }
    | { ok: false; code: "NOT_FOUND" | "INVALID_STATE" | "PROOF_BUDGET_EXHAUSTED" | "INVALID_BODY" | "ALREADY_UPLOADED" | "STORAGE_UNAVAILABLE" }
  > {
    const authorization = this.authorizeProofUpload(leaseId, decompressedBytes);
    if (!authorization.ok) return authorization;
    if (contentLength < 1 || contentLength > authorization.maximumCompressedBytes) {
      return { ok: false, code: "INVALID_BODY" };
    }
    const job = this.job();
    if (!job) return { ok: false, code: "NOT_FOUND" };
    const objectKey = unsatProofObjectKey(job.job_id, `${leaseId}-${randomToken(12)}`);
    try {
      await putJobArtifact(this.env.JOB_ARTIFACTS, objectKey, body, {
        kind: "unsat-proof",
        jobId: job.job_id,
        taskId: authorization.task.taskId,
        formulaHash: job.formula_hash,
        artifactSha256,
        contentType: "application/vnd.hivesat.lrat+gzip",
        bytes: contentLength,
      }, job.expires_at);
    } catch (error) {
      return {
        ok: false,
        code: String(error).includes("declared byte length") ? "INVALID_BODY" : "STORAGE_UNAVAILABLE",
      };
    }
    const current = this.authorizeProofUpload(leaseId, decompressedBytes);
    if (!current.ok || contentLength > current.maximumCompressedBytes) {
      await this.env.JOB_ARTIFACTS.delete(objectKey);
      return { ok: false, code: current.ok ? "PROOF_BUDGET_EXHAUSTED" : current.code };
    }
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO proof_artifacts (
        artifact_id, task_id, lease_id, artifact_sha256, compressed_bytes,
        decompressed_bytes, object_key, verification_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'UPLOADED', ?)`,
      leaseId,
      authorization.task.taskId,
      leaseId,
      artifactSha256,
      contentLength,
      decompressedBytes,
      objectKey,
      Date.now(),
    );
    const committed = this.ctx.storage.sql.exec<ProofArtifactRow>(
      "SELECT * FROM proof_artifacts WHERE artifact_id = ?",
      leaseId,
    ).toArray()[0]?.object_key === objectKey;
    if (!committed) {
      await this.env.JOB_ARTIFACTS.delete(objectKey);
      return { ok: false, code: "ALREADY_UPLOADED" };
    }
    return { ok: true, taskId: authorization.task.taskId, bytes: contentLength };
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

  async formulaDownload(): Promise<
    | { ok: true; body: ReadableStream; hash: string; bytes: number }
    | { ok: false; code: "NOT_FOUND" | "ARTIFACT_UNAVAILABLE" }
  > {
    const job = this.job();
    if (!job || !job.object_key ||
      ["UPLOADING", "CANCELLED", "INVALID"].includes(job.state)) {
      return { ok: false, code: "NOT_FOUND" };
    }
    const body = await getJobArtifact(this.env.JOB_ARTIFACTS, job.object_key);
    if (!body) return { ok: false, code: "ARTIFACT_UNAVAILABLE" };
    return { ok: true, body, hash: job.formula_hash, bytes: job.compressed_bytes };
  }

  proofDownload(artifactId: string): { objectKey: string; sha256: string; bytes: number } | null {
    const job = this.job();
    const proof = this.ctx.storage.sql.exec<ProofArtifactRow>(
      `SELECT * FROM proof_artifacts WHERE artifact_id = ?
       AND verification_status IN ('SERVER_CERTIFIED', 'OWNER_CHECK_REQUIRED', 'OWNER_VERIFIED')`,
      artifactId,
    ).toArray()[0];
    if (!job || !proof || !proof.object_key || ["CANCELLED", "INVALID"].includes(job.state)) return null;
    return { objectKey: proof.object_key, sha256: proof.artifact_sha256, bytes: proof.compressed_bytes };
  }

  async proofArtifactDownload(artifactId: string): Promise<
    | { ok: true; body: ReadableStream; sha256: string; bytes: number }
    | { ok: false; code: "NOT_FOUND" | "ARTIFACT_UNAVAILABLE" }
  > {
    const authorization = this.proofDownload(artifactId);
    if (!authorization) return { ok: false, code: "NOT_FOUND" };
    const body = await getJobArtifact(this.env.JOB_ARTIFACTS, authorization.objectKey);
    if (!body) return { ok: false, code: "ARTIFACT_UNAVAILABLE" };
    return { ok: true, body, sha256: authorization.sha256, bytes: authorization.bytes };
  }

  async confirmOwnerProof(
    ownerDigest: string,
    artifactId: string,
    artifactSha256: string,
  ): Promise<{ ok: boolean; state?: PublicJobStatus["state"]; code?: string }> {
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
      await this.env.SWARM_DIRECTORY.getByName("global-v1").close(job.job_id);
    } else {
      await this.env.SWARM_DIRECTORY.getByName("global-v1").setEligible(job.job_id, true);
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
      const remaining = await this.cleanupArtifactBatch();
      await this.ctx.storage.setAlarm(remaining ? now + 1_000 : row.expires_at);
    }
    return { ok: true, changed };
  }

  rotateOwnerToken(ownerDigest: string, nextOwnerDigest: string): boolean {
    const row = this.job();
    if (!row || Date.now() >= row.expires_at || !fixedTimeHexEqual(ownerDigest, row.owner_digest)) return false;
    return this.ctx.storage.sql.exec(
      "UPDATE jobs SET owner_digest = ? WHERE owner_digest = ?",
      nextOwnerDigest,
      row.owner_digest,
    ).rowsWritten === 1;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }
    const row = this.job();
    if (!row || !["QUEUED", "RUNNING"].includes(row.state) || Date.now() >= row.expires_at) {
      return new Response("Job is not available", { status: 409 });
    }
    const maximumConnections = Number.parseInt(this.env.MAX_JOB_CONNECTIONS, 10);
    if (!Number.isSafeInteger(maximumConnections) || maximumConnections < 1 ||
      this.ctx.getWebSockets().length >= maximumConnections) {
      return new Response("Job connection capacity reached", {
        status: 503,
        headers: { "retry-after": "30" },
      });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = {
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      jobId: row.job_id,
      connectedAt: Date.now(),
      sessionId: null,
      assignmentId: null,
      slotIds: [],
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
      await this.handleHello(ws, attachment, message);
      return;
    }
    if (!attachment.sessionId) {
      this.sendError(ws, attachment.jobId, "HELLO_REQUIRED", true, message.messageId);
      return;
    }

    const handled = await this.handleClientMessage(attachment.sessionId, message);
    ws.send(handled.serialized);
    this.dispatchPendingWork();
    await this.scheduleNextAlarm();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Unexpected disconnects retain leases for session resumption. An explicit
    // client stop is authoritative and releases all of that socket's slots now.
    if (code !== 1000 || reason !== "Client stopped") return;
    const attachment = ws.deserializeAttachment();
    if (!isSocketAttachment(attachment) || !attachment.sessionId) return;
    for (const candidate of this.ctx.getWebSockets()) {
      if (candidate === ws || candidate.readyState !== WebSocket.OPEN) continue;
      const current = candidate.deserializeAttachment();
      if (isSocketAttachment(current) && current.sessionId === attachment.sessionId &&
        current.connectedAt >= attachment.connectedAt) return;
    }
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const active = this.ctx.storage.sql.exec<LeaseRow>(
        "SELECT * FROM leases WHERE session_id = ? AND status = 'ACTIVE'",
        attachment.sessionId,
      ).toArray();
      for (const lease of active) {
        this.ctx.storage.sql.exec(
          "UPDATE leases SET status = 'YIELDED' WHERE lease_id = ? AND status = 'ACTIVE'",
          lease.lease_id,
        );
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'READY', active_lease_id = NULL, updated_at = ? WHERE task_id = ? AND active_lease_id = ?",
          now,
          lease.task_id,
          lease.lease_id,
        );
        this.ctx.storage.sql.exec(
          "UPDATE split_permits SET status = 'CANCELLED' WHERE lease_id = ? AND status = 'ACTIVE'",
          lease.lease_id,
        );
      }
    });
    this.dispatchPendingWork(now);
    await this.scheduleNextAlarm();
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
    if (row.state === "CANCELLED") {
      const remaining = await this.cleanupArtifactBatch();
      if (remaining) {
        await this.ctx.storage.setAlarm(now + 1_000);
      } else if (now >= row.expires_at) {
        await this.env.SWARM_DIRECTORY.getByName("global-v1").close(row.job_id);
        await this.ctx.storage.deleteAll();
        this.deleted = true;
      } else {
        await this.ctx.storage.setAlarm(row.expires_at);
      }
      return;
    }
    if (now >= row.expires_at) {
      this.broadcast({
        ...this.serverBase(row.job_id, now),
        type: "JOB_CANCELLED",
        reason: "EXPIRED",
      });
      if (!this.env.JOB_ARTIFACTS || !this.env.SWARM_DIRECTORY) {
        throw new Error("Job cleanup bindings are not configured.");
      }
      const remaining = await this.cleanupArtifactBatch();
      if (remaining) {
        await this.ctx.storage.setAlarm(now + 1_000);
        return;
      }
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
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'READY', active_lease_id = NULL, updated_at = ? WHERE task_id = ? AND active_lease_id = ?",
          now,
          task.task_id,
          lease.lease_id,
        );
        this.ctx.storage.sql.exec(
          "UPDATE split_permits SET status = 'CANCELLED' WHERE lease_id = ? AND status = 'ACTIVE'",
          lease.lease_id,
        );
      }
      this.ctx.storage.sql.exec(
        `DELETE FROM processed_messages WHERE rowid IN (
          SELECT rowid FROM processed_messages ORDER BY processed_at DESC LIMIT -1 OFFSET ?
        )`,
        PROCESSED_MESSAGE_LIMIT,
      );
    });

    this.dispatchPendingWork(now);
    if (expired.length === COORDINATOR_ALARM_BATCH_SIZE && this.hasExpiredLease(now)) {
      await this.ctx.storage.setAlarm(Math.min(now + 1, row.expires_at));
    } else {
      await this.scheduleNextAlarm();
    }
  }

  private async handleHello(ws: WebSocket, attachment: SocketAttachment, message: HelloMessage): Promise<void> {
    const reliability = this.ctx.storage.sql.exec<{ quarantined: number }>(
      "SELECT quarantined FROM session_reliability WHERE session_id = ?",
      message.sessionId,
    ).toArray()[0];
    if (reliability?.quarantined === 1) {
      this.sendError(ws, attachment.jobId, "SESSION_QUARANTINED", false, message.messageId);
      ws.close(1008, "Session quarantined");
      return;
    }
    if (message.assignmentId && !await this.env.SWARM_DIRECTORY.getByName("global-v1").activate(
      message.assignmentId,
      message.sessionId,
      message.jobId,
    )) {
      this.sendError(ws, attachment.jobId, "INVALID_STATE", false, message.messageId);
      ws.close(1008, "Assignment expired");
      return;
    }
    for (const candidate of this.ctx.getWebSockets()) {
      if (candidate === ws) continue;
      const existing = candidate.deserializeAttachment();
      if (isSocketAttachment(existing) && existing.sessionId === message.sessionId) {
        candidate.close(1000, "Session resumed on a newer connection");
      }
    }
    const nextAttachment: SocketAttachment = {
      ...attachment,
      sessionId: message.sessionId,
      assignmentId: message.assignmentId ?? null,
      slotIds: [...message.slotIds],
    };
    ws.serializeAttachment(nextAttachment);
    const now = Date.now();
    const profile = calibratedTaskProfile(message.capabilities);
    this.ctx.storage.sql.exec(
      `INSERT INTO session_profiles (
        session_id, conflict_budget, lease_duration_ms, updated_at, proof_generation
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        conflict_budget = excluded.conflict_budget,
        lease_duration_ms = excluded.lease_duration_ms,
        proof_generation = excluded.proof_generation,
        updated_at = excluded.updated_at`,
      message.sessionId,
      profile.conflictBudget,
      profile.leaseDurationMs,
      now,
      message.capabilities.proofGeneration === true ? 1 : 0,
    );
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql.exec<LeaseRow>(
        `SELECT * FROM leases WHERE session_id = ? AND status = 'ACTIVE' AND expires_at > ?
         ORDER BY issued_at, lease_id`,
        message.sessionId,
        now,
      ).toArray();
      const claimed = new Set<string>();
      for (const lease of existing) {
        const slotId = message.slotIds.includes(lease.slot_id)
          ? lease.slot_id
          : message.slotIds.find((candidate) => !claimed.has(candidate));
        if (!slotId) {
          this.ctx.storage.sql.exec(
            "UPDATE leases SET status = 'YIELDED' WHERE lease_id = ? AND status = 'ACTIVE'",
            lease.lease_id,
          );
          this.ctx.storage.sql.exec(
            "UPDATE tasks SET state = 'READY', active_lease_id = NULL, updated_at = ? WHERE task_id = ? AND active_lease_id = ?",
            now,
            lease.task_id,
            lease.lease_id,
          );
          continue;
        }
        claimed.add(slotId);
        if (lease.slot_id !== slotId) {
          this.ctx.storage.sql.exec("UPDATE leases SET slot_id = ? WHERE lease_id = ?", slotId, lease.lease_id);
        }
      }
    });
    // Initial assignments ride in WELCOME. This removes one frame per slot and
    // avoids relying on a rehydrated socket handle during the HELLO event.
    for (const slotId of message.slotIds) {
      this.leaseWorkForSlot(message.sessionId, slotId, now);
    }
    const activeLeases = this.ctx.storage.sql.exec<LeaseRow & TaskRow>(
      `SELECT l.*, t.task_id, t.parent_task_id, t.depth, t.assumptions_json,
              t.state, t.created_at, t.updated_at, t.lease_count,
              t.active_lease_id, t.proof_required
       FROM leases l JOIN tasks t ON t.task_id = l.task_id
       WHERE l.session_id = ? AND l.status = 'ACTIVE' AND l.expires_at > ?
       ORDER BY l.issued_at`,
      message.sessionId,
      now,
    ).toArray().map((row) => ({ slotId: row.slot_id, task: this.toCubeTask(row), lease: this.toLease(row) }));
    const response: CoordinatorServerMessage = {
      ...this.serverBase(message.jobId, now),
      type: "WELCOME",
      heartbeatIntervalMs: COORDINATOR_HEARTBEAT_INTERVAL_MS,
      leaseDurationMs: profile.leaseDurationMs,
      activeLeases,
    };
    ws.send(JSON.stringify(response));
    this.dispatchPendingWork(now);
    await this.scheduleNextAlarm();
  }

  private async handleClientMessage(
    sessionId: string,
    message: Exclude<CoordinatorClientMessage, HelloMessage>,
  ): Promise<HandledResponse> {
    const duplicate = this.processedResponse(sessionId, message.messageId);
    if (duplicate) return { serialized: duplicate, deadlineChanged: false };
    switch (message.type) {
      case "SESSION_HEARTBEAT": return this.handleSessionHeartbeat(sessionId, message);
      case "SPLIT": return this.handleSplit(sessionId, message);
      case "YIELD": return this.handleYield(sessionId, message);
      case "RESULT": return this.handleResultOnce(sessionId, message);
    }
  }

  private async handleResultOnce(sessionId: string, message: ResultMessage): Promise<HandledResponse> {
    const key = `${sessionId}:${message.messageId}`;
    const existing = this.inFlightResults.get(key);
    if (existing) return existing;
    const pending = this.handleResult(sessionId, message);
    this.inFlightResults.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlightResults.get(key) === pending) this.inFlightResults.delete(key);
    }
  }

  private handleSessionHeartbeat(sessionId: string, message: SessionHeartbeatMessage): HandledResponse {
    const now = Date.now();
    let deadlineChanged = false;
    this.ctx.storage.transactionSync(() => {
      for (const progress of message.slots) {
        if (!progress.leaseId) continue;
        const lease = this.ctx.storage.sql.exec<LeaseRow>(
          `SELECT * FROM leases
           WHERE lease_id = ? AND session_id = ? AND slot_id = ? AND status = 'ACTIVE'`,
          progress.leaseId,
          sessionId,
          progress.slotId,
        ).toArray()[0];
        if (!lease || progress.activeMs <= lease.last_active_ms) continue;
        const crossedSplitSeed = lease.last_active_ms < COORDINATOR_SPLIT_SEED_MS &&
          progress.activeMs >= COORDINATOR_SPLIT_SEED_MS;
        const shouldRenew = lease.expires_at - now <= COORDINATOR_LEASE_RENEW_THRESHOLD_MS;
        if (!crossedSplitSeed && !shouldRenew) continue;
        const expiresAt = shouldRenew
          ? Math.min(
            now + COORDINATOR_LEASE_DURATION_MS,
            lease.maximum_expires_at,
            this.job()?.expires_at ?? lease.maximum_expires_at,
          )
          : lease.expires_at;
        const recordedActiveMs = shouldRenew ? progress.activeMs : COORDINATOR_SPLIT_SEED_MS;
        deadlineChanged ||= expiresAt > lease.expires_at;
        this.ctx.storage.sql.exec(
          `UPDATE leases SET last_active_ms = ?, expires_at = ?
           WHERE lease_id = ? AND status = 'ACTIVE' AND last_active_ms < ?`,
          recordedActiveMs,
          expiresAt,
          lease.lease_id,
          recordedActiveMs,
        );
      }
    });
    const response: CoordinatorServerMessage = {
      ...this.serverBase(message.jobId, now),
      type: "ACK",
      requestMessageId: message.messageId,
      action: "SESSION_HEARTBEAT",
    };
    return { serialized: JSON.stringify(response), deadlineChanged };
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
      if (!lease || !task || !job || lease.slot_id !== message.slotId ||
        task.depth >= COORDINATOR_MAX_CUBE_DEPTH || task.proof_required === 1) {
        return this.errorResponse(message.jobId, lease ? "INVALID_STATE" : "STALE_LEASE", false, message.messageId).serialized;
      }
      const permit = this.ctx.storage.sql.exec<SplitPermitRow>(
        `SELECT * FROM split_permits
         WHERE permit_id = ? AND task_id = ? AND lease_id = ? AND session_id = ?
           AND slot_id = ? AND status = 'ACTIVE' AND expires_at > ?`,
        message.permitId,
        message.taskId,
        message.leaseId,
        sessionId,
        message.slotId,
        now,
      ).toArray()[0];
      const connectedSlots = this.connectedSessions().reduce(
        (total, entry) => total + entry.attachment.slotIds.length,
        0,
      );
      const busySlots = this.ctx.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM leases WHERE status = 'ACTIVE' AND expires_at > ?",
        now,
      ).one().total;
      const frontier = this.ctx.storage.sql.exec<{ total: number }>(
        `SELECT COUNT(*) AS total FROM tasks
         WHERE proof_required = 0 AND state IN ('READY', 'LEASED')`,
      ).one().total;
      if (!permit || connectedSlots <= busySlots || frontier >= Math.min(connectedSlots * 2, COORDINATOR_MAX_FRONTIER)) {
        if (permit) {
          this.ctx.storage.sql.exec(
            "UPDATE split_permits SET status = 'CANCELLED' WHERE permit_id = ?",
            permit.permit_id,
          );
        }
        return this.errorResponse(message.jobId, "SPLIT_NOT_NEEDED", true, message.messageId).serialized;
      }
      const taskCount = this.ctx.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM tasks",
      ).one().total;
      if (taskCount > COORDINATOR_MAX_TASKS - 2) {
        this.ctx.storage.sql.exec(
          "UPDATE split_permits SET status = 'CANCELLED' WHERE permit_id = ?",
          permit.permit_id,
        );
        return this.errorResponse(message.jobId, "TASK_LIMIT", true, message.messageId).serialized;
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
      this.ctx.storage.sql.exec(
        "UPDATE split_permits SET status = 'CONSUMED' WHERE permit_id = ?",
        permit.permit_id,
      );
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
      if (!lease || lease.slot_id !== message.slotId) {
        return this.errorResponse(message.jobId, "STALE_LEASE", false, message.messageId).serialized;
      }
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET state = 'READY', active_lease_id = NULL, updated_at = ? WHERE task_id = ? AND active_lease_id = ?",
        now,
        message.taskId,
        message.leaseId,
      );
      this.ctx.storage.sql.exec("UPDATE leases SET status = 'YIELDED' WHERE lease_id = ?", message.leaseId);
      this.ctx.storage.sql.exec(
        "UPDATE split_permits SET status = 'CANCELLED' WHERE lease_id = ? AND status = 'ACTIVE'",
        message.leaseId,
      );
      if (message.reason === "UNSUPPORTED") {
        this.ctx.storage.sql.exec(
          "UPDATE session_profiles SET proof_generation = 0, updated_at = ? WHERE session_id = ?",
          now,
          sessionId,
        );
      }
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
    if (!lease || lease.slot_id !== message.slotId) {
      return this.errorResponse(message.jobId, "STALE_LEASE", false, message.messageId);
    }
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
      const model = this.modelArtifact(message.leaseId);
      const [formulaStream, modelStream] = await Promise.all([
        job.object_key ? getJobArtifact(this.env.JOB_ARTIFACTS, job.object_key) : null,
        model?.object_key ? getJobArtifact(this.env.JOB_ARTIFACTS, model.object_key) : null,
      ]);
      verification = !formulaStream || !modelStream
        ? { status: "VERIFICATION_TIMEOUT", reason: "A committed artifact is temporarily unavailable." }
        : await this.env.RESULT_VERIFIERS
          .getByName(`${job.job_id}:${task.task_id}:${message.evidenceSha256}`)
          .verifySat({
            formulaStream,
            modelStream,
            manifest: message.manifest,
            expectedCube: cube,
            expectedVariableCount: job.variable_count,
          });
    } catch (error) {
      verification = { status: "VERIFICATION_TIMEOUT", reason: `Verifier unavailable: ${String(error)}` };
    }

    this.ctx.storage.transactionSync(() => {
      if (this.processedResponse(sessionId, message.messageId)) return;
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
        this.ctx.storage.sql.exec(
          `UPDATE tasks SET state = 'READY', active_lease_id = NULL, updated_at = ?
           WHERE task_id = ? AND state = 'VERIFYING_SAT'`,
          finishedAt,
          task.task_id,
        );
        if (invalid) this.releaseQuarantinedSessionLeases(sessionId, finishedAt);
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
      const model = this.modelArtifact(message.leaseId);
      if (model) {
        await this.env.JOB_ARTIFACTS.delete(model.object_key);
        this.ctx.storage.sql.exec("DELETE FROM model_artifacts WHERE lease_id = ?", message.leaseId);
      }
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
      const reportingCurrentLease = lease.status === "ACTIVE" && task.active_lease_id === lease.lease_id;
      if (reportingCurrentLease && task.state !== "VERIFYING_SAT") {
        // The LRAT proof is the trust boundary. Re-solving the same cube in a
        // second browser adds latency without improving result integrity.
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
        this.ctx.storage.sql.exec(
          "UPDATE split_permits SET status = 'CANCELLED' WHERE lease_id = ? AND status = 'ACTIVE'",
          lease.lease_id,
        );
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
      this.ctx.storage.sql.exec(
        "UPDATE leases SET status = CASE WHEN lease_id = ? THEN 'RESULT' ELSE 'SUPERSEDED' END WHERE task_id = ? AND status = 'ACTIVE'",
        lease.lease_id,
        task.task_id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE split_permits SET status = 'CANCELLED' WHERE task_id = ? AND status = 'ACTIVE'",
        task.task_id,
      );
    });
    let verification: VerifyUnsatResult;
    try {
      const [formulaStream, proofStream] = await Promise.all([
        job.object_key ? getJobArtifact(this.env.JOB_ARTIFACTS, job.object_key) : null,
        artifact.object_key ? getJobArtifact(this.env.JOB_ARTIFACTS, artifact.object_key) : null,
      ]);
      verification = !formulaStream || !proofStream
        ? { status: "VERIFICATION_TIMEOUT", reason: "A committed artifact is temporarily unavailable." }
        : await this.env.RESULT_VERIFIERS
          .getByName(`${job.job_id}:${task.task_id}:${manifest.artifactSha256}`)
          .verifyUnsat({
            formulaStream,
            proofStream,
            manifest,
            expectedCube: parseAssumptions(task.assumptions_json),
          });
    } catch (error) {
      verification = { status: "VERIFICATION_TIMEOUT", reason: `Verifier unavailable: ${String(error)}` };
    }
    const finishedAt = Date.now();
    let terminal: "UNSAT_CERTIFIED" | "UNSAT_OWNER_VERIFIED" | null = null;
    this.ctx.storage.transactionSync(() => {
      if (this.processedResponse(sessionId, message.messageId)) return;
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
      } else if (verification.status === "INVALID_FORMULA") {
        this.ctx.storage.sql.exec("UPDATE jobs SET state = 'INVALID'");
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'UNKNOWN', active_lease_id = NULL, updated_at = ? WHERE state != 'CANCELLED'",
          finishedAt,
        );
        this.ctx.storage.sql.exec("UPDATE leases SET status = 'SUPERSEDED' WHERE status = 'ACTIVE'");
      } else if (verification.status === "VERIFICATION_TIMEOUT") {
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'READY', proof_required = 1, updated_at = ? WHERE task_id = ?",
          finishedAt,
          task.task_id,
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO session_reliability (
            session_id, verified_results, invalid_results, verification_timeouts,
            quarantined, updated_at
          ) VALUES (?, 0, 0, 1, 0, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            verification_timeouts = verification_timeouts + 1,
            updated_at = excluded.updated_at`,
          sessionId,
          finishedAt,
        );
      } else {
        this.ctx.storage.sql.exec(
          "UPDATE proof_artifacts SET verification_status = 'INVALID' WHERE artifact_id = ?",
          manifest.artifactId,
        );
        this.ctx.storage.sql.exec(
          "UPDATE tasks SET state = 'READY', proof_required = 1, active_lease_id = NULL, updated_at = ? WHERE task_id = ?",
          finishedAt,
          task.task_id,
        );
        const invalid = verification.status === "INVALID_PROOF";
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
        if (invalid) this.releaseQuarantinedSessionLeases(sessionId, finishedAt);
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
    if (verification.status === "OWNER_CHECK_REQUIRED") {
      await this.env.SWARM_DIRECTORY.getByName("global-v1").setEligible(job.job_id, false);
      this.broadcast({
        ...this.serverBase(job.job_id),
        type: "JOB_SUSPENDED",
        reason: "OWNER_ACTION_REQUIRED",
      });
    } else if (verification.status === "INVALID_PROOF") {
      if (artifact.object_key) await this.env.JOB_ARTIFACTS.delete(artifact.object_key);
      this.ctx.storage.sql.exec(
        "UPDATE proof_artifacts SET object_key = '' WHERE artifact_id = ?",
        manifest.artifactId,
      );
    } else if (verification.status === "INVALID_FORMULA") {
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

  private modelArtifact(leaseId: string): ModelArtifactRow | null {
    return this.ctx.storage.sql.exec<ModelArtifactRow>(
      "SELECT * FROM model_artifacts WHERE lease_id = ?",
      leaseId,
    ).toArray()[0] ?? null;
  }

  private artifactObjectKeys(): string[] {
    const job = this.job();
    return [
      ...(job?.object_key ? [job.object_key] : []),
      ...this.ctx.storage.sql.exec<{ object_key: string }>(
        "SELECT object_key FROM model_artifacts WHERE object_key != '' ORDER BY created_at",
      ).toArray().map((row) => row.object_key),
      ...this.ctx.storage.sql.exec<{ object_key: string }>(
        "SELECT object_key FROM proof_artifacts WHERE object_key != '' ORDER BY created_at",
      ).toArray().map((row) => row.object_key),
    ];
  }

  private async cleanupArtifactBatch(): Promise<boolean> {
    const keys = this.artifactObjectKeys();
    if (keys.length === 0) return false;
    const deletedKeys = await deleteJobArtifacts(this.env.JOB_ARTIFACTS, keys);
    this.ctx.storage.transactionSync(() => {
      for (const key of deletedKeys) {
        this.ctx.storage.sql.exec("UPDATE jobs SET object_key = '' WHERE object_key = ?", key);
        this.ctx.storage.sql.exec("DELETE FROM model_artifacts WHERE object_key = ?", key);
        this.ctx.storage.sql.exec("UPDATE proof_artifacts SET object_key = '' WHERE object_key = ?", key);
      }
    });
    return this.artifactObjectKeys().length > 0;
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
      slotId: row.slot_id,
      leaseCount: row.lease_count,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      maximumExpiresAt: row.maximum_expires_at,
    };
  }

  private connectedSessions(): Array<{ socket: WebSocket; attachment: SocketAttachment }> {
    const sessions = new Map<string, { socket: WebSocket; attachment: SocketAttachment }>();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = socket.deserializeAttachment();
      if (!isSocketAttachment(attachment) || !attachment.sessionId || attachment.slotIds.length === 0) continue;
      const reliability = this.ctx.storage.sql.exec<{ quarantined: number }>(
        "SELECT quarantined FROM session_reliability WHERE session_id = ?",
        attachment.sessionId,
      ).toArray()[0];
      if (reliability?.quarantined === 1) continue;
      const current = sessions.get(attachment.sessionId);
      if (!current || current.attachment.connectedAt < attachment.connectedAt) {
        sessions.set(attachment.sessionId, { socket, attachment });
      }
    }
    return [...sessions.values()].sort((left, right) =>
      left.attachment.connectedAt - right.attachment.connectedAt ||
      (left.attachment.sessionId ?? "").localeCompare(right.attachment.sessionId ?? ""));
  }

  private releaseQuarantinedSessionLeases(sessionId: string, now: number): void {
    const active = this.ctx.storage.sql.exec<LeaseRow>(
      "SELECT * FROM leases WHERE session_id = ? AND status = 'ACTIVE'",
      sessionId,
    ).toArray();
    for (const lease of active) {
      this.ctx.storage.sql.exec(
        "UPDATE leases SET status = 'SUPERSEDED' WHERE lease_id = ? AND status = 'ACTIVE'",
        lease.lease_id,
      );
      this.ctx.storage.sql.exec(
        `UPDATE tasks SET state = 'READY', active_lease_id = NULL, updated_at = ?
         WHERE task_id = ? AND state = 'LEASED' AND active_lease_id = ?`,
        now,
        lease.task_id,
        lease.lease_id,
      );
      this.ctx.storage.sql.exec(
        "UPDATE split_permits SET status = 'CANCELLED' WHERE lease_id = ? AND status = 'ACTIVE'",
        lease.lease_id,
      );
    }
  }

  private leaseWorkForSlot(sessionId: string, slotId: string, now: number): WorkMessage | null {
    const leaseId = randomToken(24);
    return this.ctx.storage.transactionSync(() => {
      const job = this.job();
      if (!job || !["QUEUED", "RUNNING"].includes(job.state) || now >= job.expires_at) return null;
      const alreadyBusy = this.ctx.storage.sql.exec<{ total: number }>(
        `SELECT COUNT(*) AS total FROM leases
         WHERE session_id = ? AND slot_id = ? AND status = 'ACTIVE' AND expires_at > ?`,
        sessionId,
        slotId,
        now,
      ).one().total > 0;
      if (alreadyBusy) return null;
      const proofGeneration = this.ctx.storage.sql.exec<{ proof_generation: number }>(
        "SELECT proof_generation FROM session_profiles WHERE session_id = ?",
        sessionId,
      ).toArray()[0]?.proof_generation === 1;
      const task = this.ctx.storage.sql.exec<TaskRow>(
        proofGeneration
          ? `SELECT * FROM tasks WHERE state = 'READY'
             ORDER BY proof_required DESC, depth, created_at, task_id LIMIT 1`
          : `SELECT * FROM tasks WHERE state = 'READY' AND proof_required = 0
             ORDER BY depth, created_at, task_id LIMIT 1`,
      ).toArray()[0];
      if (!task) return null;
      const leaseCount = task.lease_count + 1;
      const maximumExpiresAt = Math.min(now + COORDINATOR_MAX_LEASE_TENURE_MS, job.expires_at);
      const lease: Lease = {
        leaseId,
        taskId: task.task_id,
        slotId,
        leaseCount,
        issuedAt: now,
        expiresAt: Math.min(now + COORDINATOR_LEASE_DURATION_MS, maximumExpiresAt),
        maximumExpiresAt,
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO leases (
          lease_id, task_id, session_id, slot_id, attempt, lease_count, issued_at,
          expires_at, maximum_expires_at, last_active_ms, status, extended
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ACTIVE', 0)`,
        lease.leaseId,
        lease.taskId,
        sessionId,
        slotId,
        leaseCount,
        leaseCount,
        lease.issuedAt,
        lease.expiresAt,
        lease.maximumExpiresAt,
      );
      this.ctx.storage.sql.exec(
        `UPDATE tasks SET state = 'LEASED', lease_count = ?, active_lease_id = ?, updated_at = ?
         WHERE task_id = ? AND state = 'READY'`,
        leaseCount,
        leaseId,
        now,
        task.task_id,
      );
      this.ctx.storage.sql.exec("UPDATE jobs SET state = 'RUNNING' WHERE state = 'QUEUED'");
      return {
        ...this.serverBase(job.job_id, now),
        type: "WORK",
        slotId,
        task: this.toCubeTask(task),
        lease,
      };
    });
  }

  private rollbackUndeliveredLease(leaseId: string, now: number): void {
    this.ctx.storage.transactionSync(() => {
      const lease = this.ctx.storage.sql.exec<LeaseRow>(
        "SELECT * FROM leases WHERE lease_id = ? AND status = 'ACTIVE'",
        leaseId,
      ).toArray()[0];
      if (!lease) return;
      this.ctx.storage.sql.exec("UPDATE leases SET status = 'EXPIRED' WHERE lease_id = ?", leaseId);
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET state = 'READY', active_lease_id = NULL, updated_at = ? WHERE task_id = ? AND active_lease_id = ?",
        now,
        lease.task_id,
        leaseId,
      );
    });
  }

  private dispatchPendingWork(now = Date.now()): void {
    const sessions = this.connectedSessions();
    for (const { socket, attachment } of sessions) {
      if (!attachment.sessionId) continue;
      for (const slotId of attachment.slotIds) {
        const work = this.leaseWorkForSlot(attachment.sessionId, slotId, now);
        if (!work) continue;
        try {
          socket.send(JSON.stringify(work));
        } catch (error) {
          this.rollbackUndeliveredLease(work.lease.leaseId, now);
          console.error(JSON.stringify({
            event: "coordinator.work_delivery_error",
            jobId: work.jobId,
            sessionId: attachment.sessionId,
            slotId,
            error: String(error),
          }));
        }
      }
    }
    this.issueSplitPermits(now, sessions);
  }

  private issueSplitPermits(
    now: number,
    sessions = this.connectedSessions(),
  ): void {
    this.ctx.storage.sql.exec(
      "UPDATE split_permits SET status = 'CANCELLED' WHERE status = 'ACTIVE' AND expires_at <= ?",
      now,
    );
    const connectedSlots = sessions.reduce((total, { attachment }) => total + attachment.slotIds.length, 0);
    if (connectedSlots === 0) return;
    const busySlots = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM leases WHERE status = 'ACTIVE' AND expires_at > ?",
      now,
    ).one().total;
    const idleSlots = Math.max(0, connectedSlots - busySlots);
    if (idleSlots === 0) return;
    const taskCount = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM tasks",
    ).one().total;
    if (taskCount > COORDINATOR_MAX_TASKS - 2) return;
    const frontier = this.ctx.storage.sql.exec<{ total: number }>(
      `SELECT COUNT(*) AS total FROM tasks
       WHERE proof_required = 0 AND state IN ('READY', 'LEASED')`,
    ).one().total;
    const outstanding = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM split_permits WHERE status = 'ACTIVE' AND expires_at > ?",
      now,
    ).one().total;
    let remaining = Math.min(
      idleSlots,
      Math.max(0, Math.min(connectedSlots * 2, COORDINATOR_MAX_FRONTIER) - frontier - outstanding),
    );
    if (remaining === 0) return;
    const candidates = this.ctx.storage.sql.exec<LeaseRow>(
      `SELECT l.* FROM leases l
       JOIN tasks t ON t.task_id = l.task_id
       LEFT JOIN split_permits p ON p.lease_id = l.lease_id AND p.status = 'ACTIVE'
       WHERE l.status = 'ACTIVE' AND l.expires_at > ?
         AND (l.issued_at <= ? OR l.last_active_ms >= ?)
         AND t.state = 'LEASED' AND t.proof_required = 0 AND t.depth < ? AND p.permit_id IS NULL
       ORDER BY l.issued_at, l.lease_id`,
      now,
      now - COORDINATOR_SPLIT_SEED_MS,
      COORDINATOR_SPLIT_SEED_MS,
      COORDINATOR_MAX_CUBE_DEPTH,
    ).toArray();
    const sockets = new Map(sessions.map((entry) => [entry.attachment.sessionId, entry.socket]));
    for (const lease of candidates) {
      if (remaining <= 0) break;
      const socket = sockets.get(lease.session_id);
      if (!socket) continue;
      const permitId = randomToken(18);
      const expiresAt = Math.min(now + COORDINATOR_SPLIT_PERMIT_MS, lease.expires_at);
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO split_permits (
          permit_id, task_id, lease_id, session_id, slot_id, expires_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        permitId,
        lease.task_id,
        lease.lease_id,
        lease.session_id,
        lease.slot_id,
        expiresAt,
      );
      const message: CoordinatorServerMessage = {
        ...this.serverBase(this.job()?.job_id ?? "unknown", now),
        type: "SPLIT_PERMIT",
        permitId,
        slotId: lease.slot_id,
        taskId: lease.task_id,
        leaseId: lease.lease_id,
        expiresAt,
      };
      try {
        socket.send(JSON.stringify(message));
        remaining -= 1;
      } catch {
        this.ctx.storage.sql.exec(
          "UPDATE split_permits SET status = 'CANCELLED' WHERE permit_id = ?",
          permitId,
        );
      }
    }
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
    const permit = this.ctx.storage.sql.exec<{ expires_at: number | null }>(
      "SELECT MIN(expires_at) AS expires_at FROM split_permits WHERE status = 'ACTIVE'",
    ).one();
    const splitSeedAt = this.nextSplitSeedAt(Date.now());
    await this.ctx.storage.setAlarm(Math.min(
      job.expires_at,
      lease.expires_at ?? job.expires_at,
      permit.expires_at ?? job.expires_at,
      splitSeedAt ?? job.expires_at,
    ));
  }

  private nextSplitSeedAt(now: number): number | null {
    const sessions = this.connectedSessions();
    const connectedSlots = sessions.reduce((total, { attachment }) => total + attachment.slotIds.length, 0);
    if (connectedSlots === 0) return null;
    const busySlots = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM leases WHERE status = 'ACTIVE' AND expires_at > ?",
      now,
    ).one().total;
    if (connectedSlots <= busySlots) return null;
    const taskCount = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM tasks",
    ).one().total;
    if (taskCount > COORDINATOR_MAX_TASKS - 2) return null;
    const frontier = this.ctx.storage.sql.exec<{ total: number }>(
      `SELECT COUNT(*) AS total FROM tasks
       WHERE proof_required = 0 AND state IN ('READY', 'LEASED')`,
    ).one().total;
    const outstanding = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT COUNT(*) AS total FROM split_permits WHERE status = 'ACTIVE' AND expires_at > ?",
      now,
    ).one().total;
    if (frontier + outstanding >= Math.min(connectedSlots * 2, COORDINATOR_MAX_FRONTIER)) return null;
    const candidate = this.ctx.storage.sql.exec<{ seed_at: number | null }>(
      `SELECT MIN(l.issued_at + ?) AS seed_at FROM leases l
       JOIN tasks t ON t.task_id = l.task_id
       LEFT JOIN split_permits p ON p.lease_id = l.lease_id AND p.status = 'ACTIVE'
       WHERE l.status = 'ACTIVE' AND l.expires_at > ?
         AND t.state = 'LEASED' AND t.proof_required = 0 AND t.depth < ? AND p.permit_id IS NULL`,
      COORDINATOR_SPLIT_SEED_MS,
      now,
      COORDINATOR_MAX_CUBE_DEPTH,
    ).one().seed_at;
    return candidate === null ? null : Math.max(now + COORDINATOR_SPLIT_SEED_MS, candidate);
  }

  private job(): JobRow | null {
    if (this.deleted) return null;
    return this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs LIMIT 1").toArray()[0] ?? null;
  }
}
