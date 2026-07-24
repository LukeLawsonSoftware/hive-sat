import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  COORDINATOR_ALARM_BATCH_SIZE,
  COORDINATOR_MAX_TASK_ATTEMPTS,
  type CoordinatorServerMessage,
} from "../shared/coordinator-protocol";
import type { JobCoordinatorDO } from "./job-coordinator";

let sequence = 0;

async function initializedCoordinator() {
  sequence += 1;
  const jobId = `coordinator-${sequence}`;
  const stub = env.JOB_COORDINATORS.getByName(jobId);
  const now = Date.now();
  await stub.initialize({
    jobId,
    ownerDigest: "11".repeat(32),
    uploadDigest: "22".repeat(32),
    formula: {
      hash: "ab".repeat(32),
      variableCount: 10,
      clauseCount: 1,
      literalCount: 1,
      encodedBytes: 28,
      compressedBytes: 4,
    },
    createdAt: now,
    expiresAt: now + 24 * 60 * 60_000,
    objectKey: `jobs/${jobId}/formula.hivecnf.gz`,
  });
  expect(await stub.completeUpload("22".repeat(32), 4)).toMatchObject({ ok: true });
  return { jobId, stub };
}

async function openSocket(stub: DurableObjectStub<JobCoordinatorDO>): Promise<WebSocket> {
  const response = await stub.fetch("https://hive-sat.test/socket", {
    headers: { upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("Expected a WebSocket response.");
  response.webSocket.accept();
  return response.webSocket;
}

function nextMessage(socket: WebSocket): Promise<CoordinatorServerMessage | "PONG"> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      if (event.data === "PONG") resolve("PONG");
      else resolve(JSON.parse(String(event.data)) as CoordinatorServerMessage);
    }, { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket test connection failed.")), { once: true });
  });
}

async function send(
  socket: WebSocket,
  message: Record<string, unknown>,
): Promise<CoordinatorServerMessage | "PONG"> {
  const response = nextMessage(socket);
  socket.send(JSON.stringify(message));
  return response;
}

async function hello(socket: WebSocket, jobId: string, sessionId: string) {
  return send(socket, {
    type: "HELLO",
    protocolVersion: 1,
    messageId: `hello-${sessionId}`,
    jobId,
    sessionId,
    capabilities: {
      hardwareConcurrency: 8,
      maxWorkers: 2,
      mobile: false,
      solverVersion: "cadical-3.0.1",
    },
  });
}

async function requestWork(socket: WebSocket, jobId: string, messageId: string) {
  return send(socket, { type: "REQUEST_WORK", protocolVersion: 1, messageId, jobId });
}

function expectWork(message: CoordinatorServerMessage | "PONG") {
  if (message === "PONG" || message.type !== "WORK") throw new Error("Expected WORK.");
  return message;
}

describe("JobCoordinatorDO leasing protocol", () => {
  it("persists a lease before delivery and replays duplicate requests idempotently", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const socket = await openSocket(stub);
    await expect(hello(socket, jobId, "session-one")).resolves.toMatchObject({
      type: "WELCOME",
      activeLeases: [],
    });

    const first = expectWork(await requestWork(socket, jobId, "request-one"));
    const duplicate = expectWork(await requestWork(socket, jobId, "request-one"));
    expect(duplicate).toEqual(first);

    await runInDurableObject(stub, (_instance, state) => {
      const lease = state.storage.sql.exec<{
        lease_id: string;
        status: string;
        attempt: number;
      }>("SELECT lease_id, status, attempt FROM leases").one();
      expect(lease).toEqual({ lease_id: first.lease.leaseId, status: "ACTIVE", attempt: 1 });
      expect(state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM leases").one().total).toBe(1);
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM tasks WHERE task_id = 'root'").one().state).toBe("LEASED");

      const serverSocket = state.getWebSockets()[0];
      expect(serverSocket.deserializeAttachment()).toMatchObject({
        jobId,
        sessionId: "session-one",
      });
    });
    socket.close(1000, "done");
  });

  it("restores socket attachments and active leases after hibernation/reconnect", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const firstSocket = await openSocket(stub);
    await hello(firstSocket, jobId, "resumable-session");
    const work = expectWork(await requestWork(firstSocket, jobId, "request-resume"));

    await evictDurableObject(stub);
    const pong = nextMessage(firstSocket);
    firstSocket.send("PING");
    await expect(pong).resolves.toBe("PONG");

    firstSocket.close(1000, "reconnect");
    const secondSocket = await openSocket(stub);
    const welcome = await hello(secondSocket, jobId, "resumable-session");
    expect(welcome).toMatchObject({
      type: "WELCOME",
      activeLeases: [{ lease: { leaseId: work.lease.leaseId }, task: { taskId: "root" } }],
    });
    secondSocket.close(1000, "done");
  });

  it("batches heartbeat progress, extends exceptionally, yields, and splits atomically", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const socket = await openSocket(stub);
    await hello(socket, jobId, "transition-session");
    const first = expectWork(await requestWork(socket, jobId, "transition-work-one"));

    const heartbeat = {
      type: "HEARTBEAT",
      protocolVersion: 1,
      messageId: "heartbeat-batch",
      jobId,
      taskId: "root",
      leaseId: first.lease.leaseId,
      progress: { activeMs: 60_000, conflicts: 10, decisions: 20, propagations: 30 },
    };
    await expect(send(socket, heartbeat)).resolves.toMatchObject({
      type: "ACK",
      action: "HEARTBEAT",
      leaseExpiresAt: first.lease.expiresAt,
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM processed_messages",
      ).one().total).toBe(1);
      state.storage.sql.exec(
        "UPDATE leases SET expires_at = ? WHERE lease_id = ?",
        Date.now() + 60_000,
        first.lease.leaseId,
      );
    });

    const extension = { ...heartbeat, messageId: "heartbeat-extension", requestExtension: true };
    const extended = await send(socket, extension);
    expect(extended).toMatchObject({ type: "ACK", action: "HEARTBEAT" });
    expect(await send(socket, extension)).toEqual(extended);
    await runInDurableObject(stub, (_instance, state) => {
      const lease = state.storage.sql.exec<{ extended: number; expires_at: number }>(
        "SELECT extended, expires_at FROM leases WHERE lease_id = ?",
        first.lease.leaseId,
      ).one();
      expect(lease.extended).toBe(1);
      expect(lease.expires_at).toBeGreaterThan(Date.now() + 60_000);
    });

    await expect(send(socket, {
      type: "YIELD",
      protocolVersion: 1,
      messageId: "yield-one",
      jobId,
      taskId: "root",
      leaseId: first.lease.leaseId,
      reason: "BUDGET",
    })).resolves.toMatchObject({ type: "ACK", action: "YIELD" });
    const second = expectWork(await requestWork(socket, jobId, "transition-work-two"));
    expect(second.queue).toMatchObject({
      activeWorkers: 1,
      lowWatermark: 1,
      targetWatermark: 3,
      highWatermark: 8,
      canSplit: true,
    });
    await expect(send(socket, {
      type: "SPLIT",
      protocolVersion: 1,
      messageId: "split-one",
      jobId,
      taskId: "root",
      leaseId: second.lease.leaseId,
      splitLiteral: 3,
    })).resolves.toMatchObject({ type: "ACK", action: "SPLIT" });

    await runInDurableObject(stub, (_instance, state) => {
      const children = state.storage.sql.exec<{ assumptions_json: string; state: string }>(
        "SELECT assumptions_json, state FROM tasks WHERE parent_task_id = 'root' ORDER BY assumptions_json",
      ).toArray();
      expect(children).toEqual([
        { assumptions_json: "[-3]", state: "READY" },
        { assumptions_json: "[3]", state: "READY" },
      ]);
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM tasks WHERE task_id = 'root'",
      ).one().state).toBe("SPLIT");
      const parent = state.storage.sql.exec<{ assumptions_json: string }>(
        "SELECT assumptions_json FROM tasks WHERE task_id = 'root'",
      ).one();
      expect(JSON.parse(parent.assumptions_json)).toEqual([]);
    });
    socket.close(1000, "done");
  });

  it("expires and reassigns work, rejects stale mutations, and accepts duplicate stale evidence once", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const staleSocket = await openSocket(stub);
    await hello(staleSocket, jobId, "stale-session");
    const first = expectWork(await requestWork(staleSocket, jobId, "first-attempt"));

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE leases SET expires_at = ? WHERE lease_id = ?", Date.now() - 1, first.lease.leaseId);
      return state.storage.setAlarm(Date.now() + 10_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const currentSocket = await openSocket(stub);
    await hello(currentSocket, jobId, "current-session");
    const second = expectWork(await requestWork(currentSocket, jobId, "second-attempt"));
    expect(second.lease.attempt).toBe(2);
    expect(second.lease.leaseId).not.toBe(first.lease.leaseId);

    await expect(send(staleSocket, {
      type: "SPLIT",
      protocolVersion: 1,
      messageId: "stale-split",
      jobId,
      taskId: "root",
      leaseId: first.lease.leaseId,
      splitLiteral: 1,
    })).resolves.toMatchObject({ type: "ERROR", code: "STALE_LEASE" });

    const result = {
      type: "RESULT",
      protocolVersion: 1,
      messageId: "stale-result",
      jobId,
      taskId: "root",
      leaseId: first.lease.leaseId,
      result: "SAT",
      evidenceSha256: "cd".repeat(32),
    };
    const accepted = await send(staleSocket, result);
    expect(accepted).toMatchObject({ type: "ACK", action: "RESULT", staleLease: true });
    expect(await send(staleSocket, result)).toEqual(accepted);

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM tasks WHERE task_id = 'root'").one().state).toBe("SAT_CANDIDATE");
      expect(state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM results").one().total).toBe(1);
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM leases WHERE lease_id = ?", second.lease.leaseId).one().status).toBe("SUPERSEDED");
    });
    staleSocket.close(1000, "done");
    currentSocket.close(1000, "done");
  });

  it("leases exact complementary cubes to separate browser sessions and recovers churn", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const splitterSocket = await openSocket(stub);
    await hello(splitterSocket, jobId, "splitter-session");
    const root = expectWork(await requestWork(splitterSocket, jobId, "root-work"));
    await send(splitterSocket, {
      type: "SPLIT",
      protocolVersion: 1,
      messageId: "split-root",
      jobId,
      taskId: root.task.taskId,
      leaseId: root.lease.leaseId,
      splitLiteral: 4,
    });

    const firstSocket = await openSocket(stub);
    const secondSocket = await openSocket(stub);
    await hello(firstSocket, jobId, "browser-context-a");
    await hello(secondSocket, jobId, "browser-context-b");
    const first = expectWork(await requestWork(firstSocket, jobId, "child-a"));
    const second = expectWork(await requestWork(secondSocket, jobId, "child-b"));
    expect(new Set([
      first.task.assumptions.join(","),
      second.task.assumptions.join(","),
    ])).toEqual(new Set(["4", "-4"]));
    expect(first.task.taskId).not.toBe(second.task.taskId);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE leases SET expires_at = ? WHERE lease_id = ?",
        Date.now() - 1,
        first.lease.leaseId,
      );
      return state.storage.setAlarm(Date.now() + 10_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const replacementSocket = await openSocket(stub);
    await hello(replacementSocket, jobId, "browser-context-c");
    const replacement = expectWork(await requestWork(replacementSocket, jobId, "child-replacement"));
    expect(replacement.task.taskId).toBe(first.task.taskId);
    expect(replacement.task.assumptions).toEqual(first.task.assumptions);
    expect(replacement.lease.attempt).toBe(2);

    splitterSocket.close(1000, "done");
    firstSocket.close(1000, "done");
    secondSocket.close(1000, "done");
    replacementSocket.close(1000, "done");
  });

  it("broadcasts owner cancellation without eagerly recovering disconnected leases", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const socket = await openSocket(stub);
    await hello(socket, jobId, "cancel-session");
    await requestWork(socket, jobId, "cancel-work");

    const cancellation = nextMessage(socket);
    await expect(stub.cancel("11".repeat(32))).resolves.toMatchObject({ ok: true, changed: true });
    await expect(cancellation).resolves.toMatchObject({ type: "JOB_CANCELLED", reason: "OWNER_CANCELLED" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM tasks WHERE task_id = 'root'").one().state).toBe("CANCELLED");
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM leases").one().status).toBe("CANCELLED");
    });
    socket.close(1000, "done");
  });

  it("bounds alarm recovery batches and fails closed after the attempt ceiling", async () => {
    const { stub } = await initializedCoordinator();
    const now = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE tasks SET state = 'UNKNOWN' WHERE task_id = 'root'");
        for (let index = 0; index < COORDINATOR_ALARM_BATCH_SIZE + 1; index += 1) {
          const taskId = `batch-task-${index}`;
          const leaseId = `batch-lease-${index}`;
          state.storage.sql.exec(
            `INSERT INTO tasks (
              task_id, parent_task_id, depth, assumptions_json, state, created_at,
              updated_at, attempt_count, active_lease_id
            ) VALUES (?, 'root', 1, '[]', 'LEASED', ?, ?, 1, ?)`,
            taskId,
            now,
            now,
            leaseId,
          );
          state.storage.sql.exec(
            `INSERT INTO leases (
              lease_id, task_id, session_id, attempt, issued_at, expires_at, status, extended
            ) VALUES (?, ?, 'batch-session', 1, ?, ?, 'ACTIVE', 0)`,
            leaseId,
            taskId,
            now - 2,
            now - 1,
          );
        }
      });
      return state.storage.setAlarm(now + 10_000);
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM leases WHERE status = 'ACTIVE'").one().total).toBe(1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM leases WHERE status = 'ACTIVE'").one().total).toBe(0);
    });

    const ceiling = await initializedCoordinator();
    const socket = await openSocket(ceiling.stub);
    await hello(socket, ceiling.jobId, "ceiling-session");
    const work = expectWork(await requestWork(socket, ceiling.jobId, "ceiling-work"));
    await runInDurableObject(ceiling.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE tasks SET attempt_count = ? WHERE task_id = 'root'",
        COORDINATOR_MAX_TASK_ATTEMPTS,
      );
      state.storage.sql.exec("UPDATE leases SET expires_at = ? WHERE lease_id = ?", Date.now() - 1, work.lease.leaseId);
      return state.storage.setAlarm(Date.now() + 10_000);
    });
    expect(await runDurableObjectAlarm(ceiling.stub)).toBe(true);
    await expect(ceiling.stub.getStatus()).resolves.toMatchObject({ state: "UNKNOWN", rootTaskState: "UNKNOWN" });
    socket.close(1000, "done");
  });
});
