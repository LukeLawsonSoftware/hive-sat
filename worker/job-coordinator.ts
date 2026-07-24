import { DurableObject } from "cloudflare:workers";
import type {
  InitializeJobInput,
  OwnerActionResult,
  PublicJobStatus,
  UploadAuthorization,
} from "./contracts";
import { fixedTimeHexEqual } from "./crypto";
import { PUBLIC_JOB_PROTOCOL_VERSION } from "../shared/public-jobs";

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

export class JobCoordinatorDO extends DurableObject<Env> {
  private deleted = false;

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
        "INSERT INTO tasks (task_id, parent_task_id, depth, assumptions_json, state, created_at) VALUES ('root', NULL, 0, '[]', 'READY', ?)",
        input.createdAt,
      );
    });
    await this.ctx.storage.setAlarm(input.expiresAt);
  }

  getStatus(): PublicJobStatus | null {
    const row = this.job();
    if (!row) return null;
    const root = this.ctx.storage.sql
      .exec<{ state: "READY" | "CANCELLED" }>("SELECT state FROM tasks WHERE task_id = 'root'")
      .one();
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

  cancel(ownerDigest: string): OwnerActionResult {
    const row = this.job();
    if (!row) return { ok: false, code: "NOT_FOUND" };
    if (!fixedTimeHexEqual(ownerDigest, row.owner_digest)) {
      return { ok: false, code: "INVALID_TOKEN" };
    }
    const changed = row.state !== "CANCELLED";
    if (changed) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE jobs SET state = 'CANCELLED', uploaded_bytes = NULL, upload_digest = NULL");
        this.ctx.storage.sql.exec("UPDATE tasks SET state = 'CANCELLED' WHERE task_id = 'root'");
      });
    }
    return { ok: true, changed, objectKey: row.object_key };
  }

  async alarm(): Promise<void> {
    const row = this.job();
    if (!row) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (Date.now() < row.expires_at) {
      await this.ctx.storage.setAlarm(row.expires_at);
      return;
    }
    if (!this.env.FORMULAS || !this.env.SWARM_DIRECTORY) {
      throw new Error("Job cleanup bindings are not configured.");
    }
    await this.env.FORMULAS.delete(row.object_key);
    await this.env.SWARM_DIRECTORY.getByName("global-v1").close(row.job_id);
    await this.ctx.storage.deleteAll();
    this.deleted = true;
  }

  private job(): JobRow | null {
    if (this.deleted) return null;
    const rows = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs LIMIT 1").toArray();
    return rows[0] ?? null;
  }
}
