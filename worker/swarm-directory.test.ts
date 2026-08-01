import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SWARM_ASSIGNMENT_ACTIVATION_MS } from "../shared/swarm-protocol";

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
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ id: number }>(
        "SELECT id FROM _sql_schema_migrations ORDER BY id",
      ).toArray().map((row) => row.id)).toEqual([1, 2, 3]);
    });
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

  it("expires an unactivated reservation and rolls back all reserved service", async () => {
    const { stub, now } = await readyDirectory(1);
    const before = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{
        virtual_worker_ms: number;
        reserved_worker_ms: number;
        assigned_workers: number;
      }>(
        "SELECT virtual_worker_ms, reserved_worker_ms, assigned_workers FROM active_jobs WHERE job_id = 'job-0'",
      ).one());
    const assignedAt = now - SWARM_ASSIGNMENT_ACTIVATION_MS - 1;
    const assignment = await stub.assign("unactivated-session", capabilities(2), undefined, assignedAt);
    expect(assignment).toMatchObject({ ok: true, jobId: "job-0", workers: 2 });
    if (!assignment.ok) throw new Error("Expected a pending assignment.");

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{
        status: string;
        expires_at: number;
        reserved_worker_ms: number;
      }>(
        "SELECT status, expires_at, reserved_worker_ms FROM assignments WHERE assignment_id = ?",
        assignment.assignmentId,
      ).one()).toEqual({
        status: "PENDING",
        expires_at: assignedAt + SWARM_ASSIGNMENT_ACTIVATION_MS,
        reserved_worker_ms: assignment.reservedWorkerMs,
      });
      expect(state.storage.sql.exec<{
        virtual_worker_ms: number;
        reserved_worker_ms: number;
        assigned_workers: number;
      }>(
        "SELECT virtual_worker_ms, reserved_worker_ms, assigned_workers FROM active_jobs WHERE job_id = 'job-0'",
      ).one()).toEqual({
        virtual_worker_ms: before.virtual_worker_ms + assignment.reservedWorkerMs,
        reserved_worker_ms: assignment.reservedWorkerMs,
        assigned_workers: assignment.workers,
      });
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM assignments WHERE assignment_id = ?",
        assignment.assignmentId,
      ).one().status).toBe("EXPIRED");
      expect(state.storage.sql.exec<{
        virtual_worker_ms: number;
        reserved_worker_ms: number;
        assigned_workers: number;
      }>(
        "SELECT virtual_worker_ms, reserved_worker_ms, assigned_workers FROM active_jobs WHERE job_id = 'job-0'",
      ).one()).toEqual(before);
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

  it("accepts idempotent reconciliation after a job cancellation released the assignment", async () => {
    const { stub, now } = await readyDirectory(1);
    const first = await stub.assign("cancelled-session", capabilities(2), undefined, now + 1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await stub.close(first.jobId);
    const next = await stub.assign("cancelled-session", capabilities(1), {
      assignmentId: first.assignmentId,
      activeWorkerMs: 10_000,
    }, now + 2);

    expect(next).toEqual({ ok: false, code: "NO_WORK" });
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
      protocolVersion: 4,
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

  it("consumes challenge digests once and removes them through the directory alarm", async () => {
    const stub = env.SWARM_DIRECTORY.getByName(`replay-${++sequence}`);
    expect(await stub.consumeTurnstile("aa".repeat(32), Date.now() + 60_000)).toBe(true);
    expect(await stub.consumeTurnstile("aa".repeat(32), Date.now() + 60_000)).toBe(false);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE turnstile_replays SET expires_at = ?", Date.now() - 1);
      return state.storage.setAlarm(Date.now() + 10_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM turnstile_replays",
      ).one().total).toBe(0);
    });
  });
});
