import {
  SELF,
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateJobResult, PublicJobStatus } from "./contracts";
import { putJobArtifact } from "./job-artifacts";

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
      protocolVersion: 3,
      turnstileToken: `test-turnstile-token-${sequence}`,
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
    expect(response.headers.get("content-security-policy")).toContain("wasm-unsafe-eval");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      features: { publicJobs: true, publicSwarm: true },
      configuration: { publicJobsReady: true },
      activeJobs: 0,
      activeWorkers: 0,
      quota: { state: "NORMAL", limits: { maxActiveJobs: 100, safetyMarginPercent: 80 } },
    });
  });

  it("rejects older protocol clients before anti-abuse validation", async () => {
    const response = await SELF.fetch("https://hive-sat.test/api/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "device_000000000000000000000099",
        protocolVersion: 1,
        turnstileToken: "old-client-token",
        publicConsent: true,
        formula: FORMULA,
      }),
    });
    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UPGRADE_REQUIRED" } });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("prevents Turnstile replay even across distinct device and network identities", async () => {
    const replayToken = `replay-${++sequence}`;
    const first = await createJob({ turnstileToken: replayToken });
    expect(first.jobId).toBeTruthy();
    const response = await SELF.fetch("https://hive-sat.test/api/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.220" },
      body: JSON.stringify({
        deviceId: "device_replay_000000000000000002",
        protocolVersion: 3,
        turnstileToken: replayToken,
        publicConsent: true,
        formula: FORMULA,
      }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "TURNSTILE_REPLAY" } });
  });

  it("rotates owner tokens atomically and invalidates the previous credential", async () => {
    const job = await createJob();
    const rotated = await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/rotate-owner`, {
      method: "POST",
      headers: { authorization: `Bearer ${job.ownerToken}` },
    });
    expect(rotated.status).toBe(200);
    const next = await rotated.json<{ ownerToken: string }>();
    expect(next.ownerToken).not.toBe(job.ownerToken);
    expect((await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${job.ownerToken}` },
    })).status).toBe(403);
    expect((await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${next.ownerToken}` },
    })).status).toBe(200);
  });

  it("requires explicit public consent before validating Turnstile", async () => {
    const response = await SELF.fetch("https://hive-sat.test/api/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "device_000000000000000000000001",
        protocolVersion: 3,
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

  it("streams a job-scoped formula to KV and exposes public status/download", async () => {
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
    expect(download.headers.get("content-type")).toBe("application/vnd.hivesat.cnf+gzip");
    expect(download.headers.get("etag")).toBe(`W/"${FORMULA.hash}"`);
    expect(download.headers.get("x-hivesat-formula-sha256")).toBe(FORMULA.hash);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([0x1f, 0x8b, 0x00, 0x00]));

    const artifactKey = await runInDurableObject(
      env.JOB_COORDINATORS.getByName(job.jobId),
      (_instance, state) => state.storage.sql.exec<{ object_key: string }>(
        "SELECT object_key FROM jobs",
      ).one().object_key,
    );
    const stored = await env.JOB_ARTIFACTS.getWithMetadata<{
      kind: string;
      formulaHash: string;
      bytes: number;
    }>(artifactKey, "arrayBuffer");
    expect(stored.metadata).toMatchObject({
      kind: "formula",
      formulaHash: FORMULA.hash,
      bytes: FORMULA.compressedBytes,
    });
  });

  it("rejects a streamed length mismatch without consuming the upload capability", async () => {
    const job = await createJob();
    const mismatched = await SELF.fetch(job.uploadUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${job.uploadToken}`,
        "content-length": String(FORMULA.compressedBytes),
      },
      body: new Uint8Array([0x1f, 0x8b, 0x00]),
    });
    expect(mismatched.status).toBe(400);
    await expect(mismatched.json()).resolves.toMatchObject({ error: { code: "INVALID_BODY" } });
    expect((await uploadFormula(job)).status).toBe(201);
  });

  it("commits only one immutable key when formula uploads race", async () => {
    const job = await createJob();
    const responses = await Promise.all([uploadFormula(job), uploadFormula(job)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const keys = await env.JOB_ARTIFACTS.list({ prefix: `jobs/${job.jobId}/formula/` });
    expect(keys.keys).toHaveLength(1);
  });

  it("returns a retryable error when committed KV data is temporarily unavailable", async () => {
    const job = await createJob();
    expect((await uploadFormula(job)).status).toBe(201);
    const artifactKey = await runInDurableObject(
      env.JOB_COORDINATORS.getByName(job.jobId),
      (_instance, state) => state.storage.sql.exec<{ object_key: string }>(
        "SELECT object_key FROM jobs",
      ).one().object_key,
    );
    await env.JOB_ARTIFACTS.delete(artifactKey);
    const response = await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/formula`);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "ARTIFACT_UNAVAILABLE" } });
  });

  it("downloads certified proofs with explicit content headers and a strong hash ETag", async () => {
    const job = await createJob();
    expect((await uploadFormula(job)).status).toBe(201);
    const artifactId = "proof-download";
    const artifactSha256 = "cd".repeat(32);
    const objectKey = `jobs/${job.jobId}/proof/${artifactId}-unique.lrat.gz`;
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    await putJobArtifact(env.JOB_ARTIFACTS, objectKey, new Response(bytes).body!, {
      kind: "unsat-proof",
      jobId: job.jobId,
      taskId: "root",
      formulaHash: FORMULA.hash,
      artifactSha256,
      contentType: "application/vnd.hivesat.lrat+gzip",
      bytes: bytes.byteLength,
    }, Date.now() + 24 * 60 * 60_000);
    await runInDurableObject(env.JOB_COORDINATORS.getByName(job.jobId), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO proof_artifacts (
          artifact_id, task_id, lease_id, artifact_sha256, compressed_bytes,
          decompressed_bytes, verification_status, created_at, object_key
        ) VALUES (?, 'root', ?, ?, ?, 8, 'SERVER_CERTIFIED', ?, ?)`,
        artifactId,
        artifactId,
        artifactSha256,
        bytes.byteLength,
        Date.now(),
        objectKey,
      );
    });

    const response = await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/proofs/${artifactId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.hivesat.lrat+gzip");
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(response.headers.get("etag")).toBe(`"${artifactSha256}"`);
    expect(response.headers.get("x-hivesat-proof-sha256")).toBe(artifactSha256);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("routes WebSocket upgrades to the job coordinator", async () => {
    const job = await createJob();
    expect((await uploadFormula(job)).status).toBe(201);
    const response = await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/socket`, {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    response.webSocket?.accept();
    response.webSocket?.close(1000, "done");
  });

  it("routes opted-in browsers through one-shot fair swarm assignment", async () => {
    const job = await createJob();
    expect((await uploadFormula(job)).status).toBe(201);
    const response = await SELF.fetch("https://hive-sat.test/api/v1/swarm/socket", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected a swarm directory WebSocket.");
    socket.accept();
    const assigned = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))));
    });
    socket.send(JSON.stringify({
      type: "SWARM_HELLO",
      protocolVersion: 3,
      messageId: "swarm-index-request",
      sessionId: "swarm-index-session",
      capabilities: {
        hardwareConcurrency: 8,
        maxWorkers: 2,
        mobile: false,
        solverVersion: "cadical-3.0.1",
      },
    }));
    await expect(assigned).resolves.toMatchObject({
      type: "SWARM_ASSIGNMENT",
      workers: 2,
    });
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

    const artifactKey = await runInDurableObject(
      env.JOB_COORDINATORS.getByName(job.jobId),
      (_instance, state) => state.storage.sql.exec<{ object_key: string }>(
        "SELECT object_key FROM jobs",
      ).one().object_key,
    );
    expect(await env.JOB_ARTIFACTS.get(artifactKey, "arrayBuffer")).not.toBeNull();

    const cancelled = await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${job.ownerToken}` },
    });
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({ state: "CANCELLED", changed: true });
    expect((await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}/formula`)).status).toBe(404);
    expect(await env.JOB_ARTIFACTS.get(artifactKey)).toBeNull();
  });

  it("enforces active and rolling-day admission per device/network digest", async () => {
    const deviceId = "device_999999999999999999999999";
    const ip = "198.51.100.9";
    let attemptSequence = 0;
    async function attempt(): Promise<Response> {
      return SELF.fetch("https://hive-sat.test/api/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({
          deviceId,
          protocolVersion: 3,
          turnstileToken: `token-${++attemptSequence}`,
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

  it("expires coordinator data and KV content through its 24-hour alarm", async () => {
    const job = await createJob();
    expect((await uploadFormula(job)).status).toBe(201);
    const stub = env.JOB_COORDINATORS.getByName(job.jobId);
    const artifactKey = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ object_key: string }>("SELECT object_key FROM jobs").one().object_key);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET expires_at = ?", Date.now() - 1);
      return state.storage.setAlarm(Date.now() + 10_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect((await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${job.jobId}`)).status).toBe(404);
    expect(await env.JOB_ARTIFACTS.get(artifactKey)).toBeNull();
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

  it("fuzzes bounded API JSON without leaking unstructured failures", async () => {
    for (let index = 0; index < 100; index += 1) {
      const body = index % 2 === 0
        ? `{${"x".repeat(index)}}`
        : JSON.stringify({ protocolVersion: index % 2, noise: "y".repeat(index) });
      const response = await SELF.fetch("https://hive-sat.test/api/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: expect.any(String), message: expect.any(String) },
      });
    }
    const oversized = await SELF.fetch("https://hive-sat.test/api/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "z".repeat(9 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: { code: "REQUEST_TOO_LARGE" } });
  });

  it("rejects unknown well-formed job IDs at the directory without coordinator allocation", async () => {
    const response = await SELF.fetch(`https://hive-sat.test/api/v1/jobs/${"z".repeat(32)}`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "JOB_NOT_FOUND" } });
  });
});
