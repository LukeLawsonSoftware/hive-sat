import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

let sequence = 0;

function capabilities(maxWorkers = 2) {
  return {
    hardwareConcurrency: 8,
    maxWorkers,
    mobile: false,
    solverVersion: "cadical-3.0.1",
  };
}

async function readyDirectory(jobCount = 2) {
  const stub = env.SWARM_DIRECTORY.getByName(`fair-${++sequence}`);
  const now = Date.now();
  for (let index = 0; index < jobCount; index += 1) {
    const jobId = `job-${index}`;
    expect(await stub.admit({
      jobId,
      deviceDigest: `device-${index}`,
      networkDigest: `network-${index}`,
      createdAt: now + index,
      expiresAt: now + 24 * 60 * 60_000,
      globalCeiling: 100,
    })).toEqual({ ok: true });
    expect(await stub.markReady(jobId, now + index)).toBe(true);
  }
  return { stub, now };
}

describe("SwarmDirectoryDO fair assignment", () => {
  it("reserves virtual worker time, reconciles actual time, and rotates jobs", async () => {
    const { stub, now } = await readyDirectory();
    const first = await stub.assign("session-a", capabilities(2), undefined, now + 10);
    expect(first).toMatchObject({ ok: true, jobId: "job-0", workers: 2 });
    if (!first.ok) return;
    const second = await stub.assign("session-b", capabilities(1), undefined, now + 20);
    expect(second).toMatchObject({ ok: true, jobId: "job-1", workers: 1 });
    const third = await stub.assign("session-a", capabilities(1), {
      assignmentId: first.assignmentId,
      activeWorkerMs: 120_000,
    }, now + 30);
    expect(third.ok).toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      const firstJob = state.storage.sql.exec<{
        virtual_worker_ms: number;
        assigned_workers: number;
        reserved_worker_ms: number;
      }>("SELECT virtual_worker_ms, assigned_workers, reserved_worker_ms FROM active_jobs WHERE job_id = 'job-0'").one();
      expect(firstJob.virtual_worker_ms).toBeGreaterThanOrEqual(120_000);
      expect(firstJob.assigned_workers).toBeLessThanOrEqual(8);
      expect(firstJob.reserved_worker_ms).toBeGreaterThanOrEqual(0);
    });
  });

  it("admits new jobs at the current minimum and rejects forged reconciliation", async () => {
    const { stub, now } = await readyDirectory(1);
    const first = await stub.assign("owner-session", capabilities(1), undefined, now + 1);
    expect(first.ok).toBe(true);
    expect(await stub.admit({
      jobId: "new-job",
      deviceDigest: "new-device",
      networkDigest: "new-network",
      createdAt: now + 2,
      expiresAt: now + 24 * 60 * 60_000,
      globalCeiling: 100,
    })).toEqual({ ok: true });
    await stub.markReady("new-job", now + 2);
    await runInDurableObject(stub, (_instance, state) => {
      const values = state.storage.sql.exec<{ job_id: string; virtual_worker_ms: number }>(
        "SELECT job_id, virtual_worker_ms FROM active_jobs ORDER BY job_id",
      ).toArray();
      expect(values.find((row) => row.job_id === "new-job")?.virtual_worker_ms).toBe(3_600_000);
    });
    await expect(stub.assign("attacker", capabilities(), {
      assignmentId: first.ok ? first.assignmentId : "missing",
      activeWorkerMs: 0,
    }, now + 3)).resolves.toEqual({ ok: false, code: "INVALID_ASSIGNMENT" });
  });

  it("hands an opted-in socket one assignment and closes before coordinator handoff", async () => {
    const { stub } = await readyDirectory(1);
    const response = await stub.fetch("https://hive-sat.test/swarm", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected a directory WebSocket.");
    socket.accept();
    const message = new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => resolve(JSON.parse(String(event.data))));
    });
    const closed = new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve());
    });
    socket.send(JSON.stringify({
      type: "SWARM_HELLO",
      protocolVersion: 1,
      messageId: "directory-request",
      sessionId: "browser-session",
      capabilities: capabilities(1),
    }));
    await expect(message).resolves.toMatchObject({
      type: "SWARM_ASSIGNMENT",
      jobId: "job-0",
      workers: 1,
    });
    await expect(closed).resolves.toBeUndefined();
  });
});
