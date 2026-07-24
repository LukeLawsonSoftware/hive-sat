import {
  SELF,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateJobResult, PublicJobStatus } from "./contracts";

const FORMULA = {
  hash: "ab".repeat(32),
  variableCount: 1,
  clauseCount: 1,
  literalCount: 1,
  encodedBytes: 28,
  compressedBytes: 4,
};

let sequence = 0;

async function createJob(overrides: Record<string, unknown> = {}): Promise<CreateJobResult> {
  sequence += 1;
  const response = await SELF.fetch("https://hive-sat.test/api/v1/jobs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": `203.0.113.${sequence}`,
    },
    body: JSON.stringify({
      deviceId: `device_${String(sequence).padStart(24, "0")}`,
      protocolVersion: 1,
      turnstileToken: "test-turnstile-token",
      publicConsent: true,
      formula: FORMULA,
      ...overrides,
    }),
  });
  expect(response.status).toBe(201);
  return response.json<CreateJobResult>();
}

async function uploadFormula(job: CreateJobResult): Promise<Response> {
  return SELF.fetch(job.uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${job.uploadToken}`,
      "content-length": String(FORMULA.compressedBytes),
    },
    body: new Uint8Array([0x1f, 0x8b, 0x00, 0x00]),
  });
}

describe("HiveSAT Worker", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ success: true }));
  });

  afterEach(() => vi.restoreAllMocks());

  it("reports local public-job capability and a bounded aggregate snapshot", async () => {
    const response = await SELF.fetch("https://hive-sat.test/api/v1/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      features: { publicJobs: true, publicSwarm: false },
      activeJobs: 0,
    });
  });

  it("requires explicit public consent before validating Turnstile", async () => {
    const response = await SELF.fetch("https://hive-sat.test/api/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "device_000000000000000000000001",
        protocolVersion: 1,
        turnstileToken: "token",
        publicConsent: false,
        formula: FORMULA,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PUBLIC_CONSENT_REQUIRED" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("creates an unguessable job while storing only token digests", async () => {
    const job = await createJob();

    expect(job.jobId).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(job.ownerToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(job.uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(job.publicUrl).not.toContain(job.ownerToken);
    expect(job.ownerUrl).toContain(`#owner=${job.ownerToken}`);

    const stub = env.JOB_COORDINATORS.getByName(job.jobId);
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{
        owner_digest: string;
        upload_digest: string;
      }>("SELECT owner_digest, upload_digest FROM jobs").one();
      expect(row.owner_digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(row.upload_digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(row.owner_digest).not.toContain(job.ownerToken);
      expect(row.upload_digest).not.toContain(job.uploadToken);

      const root = state.storage.sql.exec<{ state: string; assumptions_json: string }>(
        "SELECT state, assumptions_json FROM tasks WHERE task_id = 'root'",
      ).one();
      expect(root).toEqual({ state: "READY", assumptions_json: "[]" });
    });
  });

  it("streams a job-scoped formula to R2 and exposes public status/download", async () => {
    const job = await createJob();
    const uploaded = await uploadFormula(job);
    expect(uploaded.status).toBe(201);

    const statusResponse = await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}`);
    const status = await statusResponse.json<PublicJobStatus>();
    expect(status).toMatchObject({
      jobId: job.jobId,
      state: "QUEUED",
      formula: FORMULA,
      uploadedBytes: 4,
      rootTaskState: "READY",
    });

    const download = await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/formula`);
    expect(download.status).toBe(200);
    expect(download.headers.get("x-hivesat-formula-sha256")).toBe(FORMULA.hash);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([0x1f, 0x8b, 0x00, 0x00]));
  });

  it("rejects bad upload/owner tokens and safely deletes a cancelled formula", async () => {
    const job = await createJob();
    const badUpload = await SELF.fetch(job.uploadUrl, {
      method: "PUT",
      headers: { authorization: `Bearer ${"x".repeat(43)}`, "content-length": "4" },
      body: new Uint8Array(4),
    });
    expect(badUpload.status).toBe(403);
    expect((await uploadFormula(job)).status).toBe(201);

    const badCancel = await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${"y".repeat(43)}` },
    });
    expect(badCancel.status).toBe(403);

    const cancelled = await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${job.ownerToken}` },
    });
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({ state: "CANCELLED", changed: true });
    expect((await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/formula`)).status).toBe(404);
    expect(await env.FORMULAS.get(`jobs/${job.jobId}/formula.hivecnf.gz`)).toBeNull();
  });

  it("enforces active and rolling-day admission per device/network digest", async () => {
    const deviceId = "device_999999999999999999999999";
    const ip = "198.51.100.9";
    async function attempt(): Promise<Response> {
      return SELF.fetch("https://hive-sat.test/api/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({
          deviceId,
          protocolVersion: 1,
          turnstileToken: "token",
          publicConsent: true,
          formula: FORMULA,
        }),
      });
    }

    for (let count = 0; count < 3; count += 1) {
      const response = await attempt();
      expect(response.status).toBe(201);
      const job = await response.json<CreateJobResult>();
      const whileActive = await attempt();
      expect(whileActive.status).toBe(429);
      await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${job.ownerToken}` },
      });
    }
    const limited = await attempt();
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({ error: { code: "CREATION_RATE_LIMIT" } });
  });

  it("fails closed at the configured global active-job ceiling", async () => {
    const directory = env.SWARM_DIRECTORY.getByName("ceiling-test");
    const now = Date.now();
    expect(await directory.admit({
      jobId: "ceiling-one",
      deviceDigest: "device-one",
      networkDigest: "network-one",
      createdAt: now,
      expiresAt: now + 60_000,
      globalCeiling: 1,
    })).toEqual({ ok: true });
    expect(await directory.admit({
      jobId: "ceiling-two",
      deviceDigest: "device-two",
      networkDigest: "network-two",
      createdAt: now,
      expiresAt: now + 60_000,
      globalCeiling: 1,
    })).toEqual({ ok: false, code: "GLOBAL_JOB_LIMIT" });
  });

  it("expires coordinator data and R2 content through its 24-hour alarm", async () => {
    const job = await createJob();
    expect((await uploadFormula(job)).status).toBe(201);
    const stub = env.JOB_COORDINATORS.getByName(job.jobId);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET expires_at = ?", Date.now() - 1);
      return state.storage.setAlarm(Date.now() + 10_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect((await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}`)).status).toBe(404);
    expect(await env.FORMULAS.get(`jobs/${job.jobId}/formula.hivecnf.gz`)).toBeNull();
    await runInDurableObject(env.SWARM_DIRECTORY.getByName("global-v1"), (_instance, state) => {
      const row = state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM active_jobs WHERE job_id = ?",
        job.jobId,
      ).one();
      expect(row.total).toBe(0);
    });
  });

  it("returns a structured error for unknown API routes", async () => {
    const response = await SELF.fetch("https://hive-sat.test/api/v1/missing");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "API route not found" },
    });
  });

  it("rejects unknown well-formed job IDs at the directory without coordinator allocation", async () => {
    const response = await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${"z".repeat(32)}`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "JOB_NOT_FOUND" } });
  });
});
