import { DurableObject } from "cloudflare:workers";
import {
  CREATION_WINDOW_MS,
  MAX_CREATIONS_PER_WINDOW,
  type AdmissionInput,
  type AdmissionResult,
} from "./contracts";

interface CreationRow {
  [key: string]: SqlStorageValue;
  created_at: number;
}

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
  }

  async admit(input: AdmissionInput): Promise<AdmissionResult> {
    const windowStart = input.createdAt - CREATION_WINDOW_MS;
    this.ctx.storage.sql.exec("DELETE FROM creation_events WHERE created_at < ?", windowStart);

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

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO active_jobs (job_id, device_digest, network_digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        input.jobId,
        input.deviceDigest,
        input.networkDigest,
        input.createdAt,
        input.expiresAt,
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
    this.ctx.storage.sql.exec("DELETE FROM active_jobs WHERE job_id = ?", jobId);
    await this.scheduleNextAlarm();
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

  snapshot(): { activeJobs: number } {
    return this.ctx.storage.sql.exec<{ activeJobs: number }>(
      "SELECT COUNT(*) AS activeJobs FROM active_jobs",
    ).one();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM active_jobs WHERE expires_at <= ?", now);
    this.ctx.storage.sql.exec("DELETE FROM creation_events WHERE created_at < ?", now - CREATION_WINDOW_MS);
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const row = this.ctx.storage.sql.exec<{ expires_at: number | null }>(
      "SELECT MIN(expires_at) AS expires_at FROM active_jobs",
    ).one();
    if (row.expires_at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(row.expires_at);
  }
}
