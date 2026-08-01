import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  COORDINATOR_ALARM_BATCH_SIZE,
  COORDINATOR_MAX_CUBE_DEPTH,
  COORDINATOR_MAX_TASKS,
  COORDINATOR_SPLIT_SEED_MS,
  type CoordinatorServerMessage,
} from "../shared/coordinator-protocol";
import { PUBLIC_JOB_PROTOCOL_VERSION } from "../shared/public-jobs";
import {
  encodeSatModelArtifact,
  resultPathHash,
} from "../shared/result-manifest";
import { ARTIFACT_DELETE_BATCH_SIZE } from "./job-artifacts";
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

type TestSocketMessage = CoordinatorServerMessage | "PONG";

function nextMessages(socket: WebSocket, count: number): Promise<TestSocketMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: TestSocketMessage[] = [];
    const onMessage = (event: MessageEvent) => {
      messages.push(event.data === "PONG"
        ? "PONG"
        : JSON.parse(String(event.data)) as CoordinatorServerMessage);
      if (messages.length !== count) return;
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      resolve(messages);
    };
    const onError = () => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("WebSocket test connection failed."));
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
  });
}

async function nextMessage(socket: WebSocket): Promise<TestSocketMessage> {
  return (await nextMessages(socket, 1))[0]!;
}

async function send(
  socket: WebSocket,
  message: Record<string, unknown>,
): Promise<CoordinatorServerMessage | "PONG"> {
  const response = nextMessage(socket);
  socket.send(JSON.stringify(message));
  return response;
}

async function sendMany(
  socket: WebSocket,
  message: Record<string, unknown>,
  responseCount: number,
): Promise<TestSocketMessage[]> {
  const responses = nextMessages(socket, responseCount);
  socket.send(JSON.stringify(message));
  return responses;
}

async function hello(socket: WebSocket, jobId: string, sessionId: string) {
  const slotIds = [`${sessionId}-slot-0`];
  return send(socket, {
    type: "HELLO",
    protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
    messageId: `hello-${sessionId}`,
    jobId,
    sessionId,
    slotIds,
    capabilities: {
      hardwareConcurrency: 8,
      maxWorkers: slotIds.length,
      mobile: false,
      solverVersion: "cadical-3.0.1",
      proofGeneration: false,
    },
  });
}

async function helloWithSlots(
  socket: WebSocket,
  jobId: string,
  sessionId: string,
  slotIds: string[],
  options: { assignmentId?: string; proofGeneration?: boolean } = {},
) {
  return send(socket, {
    type: "HELLO",
    protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
    messageId: `hello-${sessionId}`,
    jobId,
    sessionId,
    slotIds,
    ...(options.assignmentId ? { assignmentId: options.assignmentId } : {}),
    capabilities: {
      hardwareConcurrency: 8,
      maxWorkers: slotIds.length,
      mobile: false,
      solverVersion: "cadical-3.0.1",
      proofGeneration: options.proofGeneration ?? false,
    },
  });
}

async function helloAndWork(
  socket: WebSocket,
  jobId: string,
  sessionId: string,
  slotIds = [`${sessionId}-slot-0`],
  options: { assignmentId?: string; proofGeneration?: boolean } = {},
) {
  const welcome = await send(socket, {
    type: "HELLO",
    protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
    messageId: `hello-${sessionId}`,
    jobId,
    sessionId,
    slotIds,
    ...(options.assignmentId ? { assignmentId: options.assignmentId } : {}),
    capabilities: {
      hardwareConcurrency: 8,
      maxWorkers: slotIds.length,
      mobile: false,
      solverVersion: "cadical-3.0.1",
      proofGeneration: options.proofGeneration ?? false,
    },
  });
  if (welcome === "PONG" || welcome.type !== "WELCOME" || welcome.activeLeases.length === 0) {
    throw new Error(`Expected WELCOME with an active lease: ${JSON.stringify(welcome)}`);
  }
  return { welcome, work: welcome.activeLeases[0]! };
}

function expectWork(message: CoordinatorServerMessage | "PONG") {
  if (message === "PONG" || message.type !== "WORK") throw new Error("Expected WORK.");
  return message;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function gzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  return new Response(
    new Blob([bytes.slice().buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
}

describe("JobCoordinatorDO leasing protocol", () => {
  it("persists an initial slot lease in WELCOME", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const socket = await openSocket(stub);
    const slotId = "session-one-slot";
    const { welcome, work } = await helloAndWork(socket, jobId, "session-one", [slotId]);
    expect(welcome).toMatchObject({
      type: "WELCOME",
      activeLeases: [{ slotId, task: { taskId: "root" }, lease: { slotId } }],
    });
    expect(work).toMatchObject({
      slotId,
      task: { taskId: "root", purpose: "SEARCH" },
      lease: { slotId, taskId: "root", leaseCount: 1 },
    });

    await runInDurableObject(stub, (_instance, state) => {
      const lease = state.storage.sql.exec<{
        lease_id: string;
        slot_id: string;
        status: string;
        lease_count: number;
      }>("SELECT lease_id, slot_id, status, lease_count FROM leases").one();
      expect(lease).toEqual({
        lease_id: work.lease.leaseId,
        slot_id: slotId,
        status: "ACTIVE",
        lease_count: 1,
      });
      expect(state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM leases").one().total).toBe(1);
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM tasks WHERE task_id = 'root'").one().state).toBe("LEASED");

      const serverSocket = state.getWebSockets()[0];
      expect(serverSocket.deserializeAttachment()).toMatchObject({
        jobId,
        sessionId: "session-one",
        assignmentId: null,
        slotIds: [slotId],
      });
    });
    socket.close(1000, "done");
  });

  it("activates a pending directory reservation during HELLO", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const directory = env.SWARM_DIRECTORY.getByName("global-v1");
    const now = Date.now();
    await expect(directory.admit({
      jobId,
      deviceDigest: "activation-device",
      networkDigest: "activation-network",
      createdAt: now - 10,
      expiresAt: now + 24 * 60 * 60_000,
      globalCeiling: 100,
    })).resolves.toEqual({ ok: true });
    expect(await directory.markReady(jobId, now - 10)).toBe(true);
    const assignment = await directory.assign("reserved-session", {
      hardwareConcurrency: 8,
      maxWorkers: 1,
      mobile: false,
      solverVersion: "cadical-3.0.1",
      proofGeneration: false,
    }, undefined, now - 1);
    expect(assignment).toMatchObject({ ok: true, jobId, workers: 1 });
    if (!assignment.ok) throw new Error("Expected a pending directory assignment.");
    await runInDurableObject(directory, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM assignments WHERE assignment_id = ?",
        assignment.assignmentId,
      ).one().status).toBe("PENDING");
    });

    const socket = await openSocket(stub);
    const { welcome, work } = await helloAndWork(socket, jobId, "reserved-session", ["reserved-slot"], {
      assignmentId: assignment.assignmentId,
    });
    expect(welcome).toMatchObject({ type: "WELCOME" });
    expect(work).toMatchObject({ slotId: "reserved-slot", task: { taskId: "root" } });
    await runInDurableObject(directory, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM assignments WHERE assignment_id = ?",
        assignment.assignmentId,
      ).one().status).toBe("ACTIVE");
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.getWebSockets()[0]?.deserializeAttachment()).toMatchObject({
        sessionId: "reserved-session",
        assignmentId: assignment.assignmentId,
      });
    });
    socket.close(1000, "done");
  });

  it("restores socket attachments and active leases after hibernation/reconnect", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const firstSocket = await openSocket(stub);
    const slotId = "resumable-slot";
    const { work } = await helloAndWork(firstSocket, jobId, "resumable-session", [slotId]);

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ id: number }>(
        "SELECT id FROM _sql_schema_migrations ORDER BY id",
      ).toArray().map((row) => row.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    await evictDurableObject(stub);
    const pong = nextMessage(firstSocket);
    firstSocket.send("PING");
    await expect(pong).resolves.toBe("PONG");

    firstSocket.close(1000, "reconnect");
    const secondSocket = await openSocket(stub);
    const welcome = await helloWithSlots(secondSocket, jobId, "resumable-session", [slotId]);
    expect(welcome).toMatchObject({
      type: "WELCOME",
      activeLeases: [{
        slotId,
        lease: { leaseId: work.lease.leaseId, slotId },
        task: { taskId: "root" },
      }],
    });
    secondSocket.close(1000, "done");
  });

  it("renews a session heartbeat, splits only with a permit, and requeues a yielded slot", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const socket = await openSocket(stub);
    const slotIds = ["transition-slot-a", "transition-slot-b"];
    const { work: first } = await helloAndWork(socket, jobId, "transition-session", slotIds);
    expect(first.slotId).toBe(slotIds[0]);

    await expect(send(socket, {
      type: "SPLIT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "split-without-permit",
      jobId,
      slotId: first.slotId,
      taskId: first.task.taskId,
      leaseId: first.lease.leaseId,
      permitId: "forged-permit",
      splitLiteral: 3,
    })).resolves.toMatchObject({
      type: "ERROR",
      code: "SPLIT_NOT_NEEDED",
      retryable: true,
    });

    const heartbeat = {
      type: "SESSION_HEARTBEAT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "heartbeat-batch",
      jobId,
      slots: [
        {
          slotId: first.slotId,
          leaseId: first.lease.leaseId,
          activeMs: COORDINATOR_SPLIT_SEED_MS,
          conflicts: 10,
          decisions: 20,
          propagations: 30,
        },
        {
          slotId: slotIds[1],
          leaseId: null,
          activeMs: 0,
          conflicts: 0,
          decisions: 0,
          propagations: 0,
        },
      ],
    };
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE leases SET expires_at = ? WHERE lease_id = ?",
        Date.now() + 60_000,
        first.lease.leaseId,
      );
    });
    const [heartbeatAck, permit] = await sendMany(socket, heartbeat, 2);
    expect(heartbeatAck).toMatchObject({
      type: "ACK",
      action: "SESSION_HEARTBEAT",
    });
    expect(permit).toMatchObject({
      type: "SPLIT_PERMIT",
      slotId: first.slotId,
      taskId: "root",
      leaseId: first.lease.leaseId,
    });
    if (permit === "PONG" || permit.type !== "SPLIT_PERMIT") {
      throw new Error("Expected SPLIT_PERMIT.");
    }
    await runInDurableObject(stub, (_instance, state) => {
      const lease = state.storage.sql.exec<{ last_active_ms: number; expires_at: number }>(
        "SELECT last_active_ms, expires_at FROM leases WHERE lease_id = ?",
        first.lease.leaseId,
      ).one();
      expect(lease.last_active_ms).toBe(COORDINATOR_SPLIT_SEED_MS);
      expect(lease.expires_at).toBeGreaterThan(Date.now() + 60_000);
    });

    const [splitAck, childAMessage, childBMessage] = await sendMany(socket, {
      type: "SPLIT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "split-one",
      jobId,
      slotId: first.slotId,
      taskId: "root",
      leaseId: first.lease.leaseId,
      permitId: permit.permitId,
      splitLiteral: 3,
    }, 3);
    expect(splitAck).toMatchObject({ type: "ACK", action: "SPLIT" });
    const childA = expectWork(childAMessage!);
    const childB = expectWork(childBMessage!);
    expect(new Set([childA.task.assumptions.join(","), childB.task.assumptions.join(",")]))
      .toEqual(new Set(["3", "-3"]));
    expect(new Set([childA.slotId, childB.slotId])).toEqual(new Set(slotIds));

    await runInDurableObject(stub, (_instance, state) => {
      const children = state.storage.sql.exec<{ assumptions_json: string; state: string }>(
        "SELECT assumptions_json, state FROM tasks WHERE parent_task_id = 'root' ORDER BY assumptions_json",
      ).toArray();
      expect(children).toEqual([
        { assumptions_json: "[-3]", state: "LEASED" },
        { assumptions_json: "[3]", state: "LEASED" },
      ]);
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM tasks WHERE task_id = 'root'",
      ).one().state).toBe("SPLIT");
      const parent = state.storage.sql.exec<{ assumptions_json: string }>(
        "SELECT assumptions_json FROM tasks WHERE task_id = 'root'",
      ).one();
      expect(JSON.parse(parent.assumptions_json)).toEqual([]);
    });

    const [yieldAck, reassignedMessage] = await sendMany(socket, {
      type: "YIELD",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "yield-one",
      jobId,
      slotId: childA.slotId,
      taskId: childA.task.taskId,
      leaseId: childA.lease.leaseId,
      reason: "PAUSED",
    }, 2);
    expect(yieldAck).toMatchObject({ type: "ACK", action: "YIELD" });
    const reassigned = expectWork(reassignedMessage!);
    expect(reassigned).toMatchObject({
      slotId: childA.slotId,
      task: { taskId: childA.task.taskId, assumptions: childA.task.assumptions },
      lease: { leaseCount: 2 },
    });
    socket.close(1000, "done");
  });

  it("withholds split permits at the maximum cube depth without abandoning the lease", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const socket = await openSocket(stub);
    const slotIds = ["depth-slot-a", "depth-slot-b"];
    const { work } = await helloAndWork(socket, jobId, "depth-session", slotIds);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE tasks SET depth = ? WHERE task_id = ?",
        COORDINATOR_MAX_CUBE_DEPTH,
        work.task.taskId,
      );
    });

    await expect(send(socket, {
      type: "SESSION_HEARTBEAT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "depth-heartbeat",
      jobId,
      slots: slotIds.map((slotId) => ({
        slotId,
        leaseId: slotId === work.slotId ? work.lease.leaseId : null,
        activeMs: slotId === work.slotId ? COORDINATOR_SPLIT_SEED_MS : 0,
        conflicts: 0,
        decisions: 0,
        propagations: 0,
      })),
    })).resolves.toMatchObject({ type: "ACK", action: "SESSION_HEARTBEAT" });

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM split_permits",
      ).one().total).toBe(0);
      expect(state.storage.sql.exec<{ state: string; active_lease_id: string | null }>(
        "SELECT state, active_lease_id FROM tasks WHERE task_id = ?",
        work.task.taskId,
      ).one()).toEqual({ state: "LEASED", active_lease_id: work.lease.leaseId });
      expect(state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM leases WHERE lease_id = ?",
        work.lease.leaseId,
      ).one().status).toBe("ACTIVE");
    });
    socket.close(1000, "done");
  });

  it("withholds split permits at the task ceiling without abandoning the lease", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const socket = await openSocket(stub);
    const slotIds = ["ceiling-slot-a", "ceiling-slot-b"];
    const { work } = await helloAndWork(socket, jobId, "task-ceiling-session", slotIds);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `WITH digits(value) AS (
           VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
         ), numbers(value) AS (
           SELECT ones.value + tens.value * 10 + hundreds.value * 100 + thousands.value * 1000
           FROM digits AS ones
           CROSS JOIN digits AS tens
           CROSS JOIN digits AS hundreds
           CROSS JOIN digits AS thousands
           ORDER BY 1
           LIMIT ?
         )
         INSERT INTO tasks (
           task_id, parent_task_id, depth, assumptions_json, state, created_at, updated_at
         )
         SELECT 'ceiling-' || value, 'root', 1, '[]', 'SPLIT', ?, ? FROM numbers`,
        COORDINATOR_MAX_TASKS - 1,
        Date.now(),
        Date.now(),
      );
      expect(state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM tasks",
      ).one().total).toBe(COORDINATOR_MAX_TASKS);
    });

    await expect(send(socket, {
      type: "SESSION_HEARTBEAT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "task-ceiling-heartbeat",
      jobId,
      slots: slotIds.map((slotId) => ({
        slotId,
        leaseId: slotId === work.slotId ? work.lease.leaseId : null,
        activeMs: slotId === work.slotId ? COORDINATOR_SPLIT_SEED_MS : 0,
        conflicts: 0,
        decisions: 0,
        propagations: 0,
      })),
    })).resolves.toMatchObject({ type: "ACK", action: "SESSION_HEARTBEAT" });

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM split_permits",
      ).one().total).toBe(0);
      expect(state.storage.sql.exec<{ state: string; active_lease_id: string | null }>(
        "SELECT state, active_lease_id FROM tasks WHERE task_id = ?",
        work.task.taskId,
      ).one()).toEqual({ state: "LEASED", active_lease_id: work.lease.leaseId });
      expect(state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM leases WHERE lease_id = ?",
        work.lease.leaseId,
      ).one().status).toBe("ACTIVE");
    });
    socket.close(1000, "done");
  });

  it("expires and reassigns work, rejects stale mutations, and accepts duplicate stale evidence once", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const firstSocket = await openSocket(stub);
    const staleSlotId = "stale-slot";
    const { work: first } = await helloAndWork(firstSocket, jobId, "stale-session", [staleSlotId]);
    firstSocket.close(1000, "network churn");

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE leases SET expires_at = ? WHERE lease_id = ?", Date.now() - 1, first.lease.leaseId);
      return state.storage.setAlarm(Date.now() + 10_000);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const currentSocket = await openSocket(stub);
    const { work: second } = await helloAndWork(currentSocket, jobId, "current-session");
    expect(second.lease.leaseCount).toBe(2);
    expect(second.lease.leaseId).not.toBe(first.lease.leaseId);

    const staleSocket = await openSocket(stub);
    await helloWithSlots(staleSocket, jobId, "stale-session", [staleSlotId]);
    await expect(send(staleSocket, {
      type: "SPLIT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "stale-split",
      jobId,
      slotId: staleSlotId,
      taskId: "root",
      leaseId: first.lease.leaseId,
      permitId: "stale-permit",
      splitLiteral: 1,
    })).resolves.toMatchObject({ type: "ERROR", code: "STALE_LEASE" });

    const result = {
      type: "RESULT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "stale-result",
      jobId,
      slotId: staleSlotId,
      taskId: "root",
      leaseId: first.lease.leaseId,
      result: "UNSAT",
      evidenceSha256: "cd".repeat(32),
      manifest: {
        kind: "UNSAT_CANDIDATE_V1",
        formulaHash: "ab".repeat(32),
        taskId: "root",
        cube: [],
        pathHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        solverVersion: "cadical-3.0.1",
      },
    };
    const accepted = await send(staleSocket, result);
    expect(accepted).toMatchObject({ type: "ACK", action: "RESULT", staleLease: true });
    expect(await send(staleSocket, result)).toEqual(accepted);

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM tasks WHERE task_id = 'root'").one().state).toBe("LEASED");
      expect(state.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM results").one().total).toBe(1);
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM leases WHERE lease_id = ?", second.lease.leaseId).one().status).toBe("ACTIVE");
    });
    staleSocket.close(1000, "done");
    currentSocket.close(1000, "done");
  });

  it("leases exact complementary cubes to separate slots and recovers browser churn", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const splitterSocket = await openSocket(stub);
    const splitSlots = ["splitter-slot-a", "splitter-slot-b"];
    const { work: root } = await helloAndWork(splitterSocket, jobId, "splitter-session", splitSlots);
    const [heartbeatAck, permit] = await sendMany(splitterSocket, {
      type: "SESSION_HEARTBEAT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "split-heartbeat",
      jobId,
      slots: splitSlots.map((slotId) => ({
        slotId,
        leaseId: slotId === root.slotId ? root.lease.leaseId : null,
        activeMs: slotId === root.slotId ? COORDINATOR_SPLIT_SEED_MS : 0,
        conflicts: 0,
        decisions: 0,
        propagations: 0,
      })),
    }, 2);
    expect(heartbeatAck).toMatchObject({ type: "ACK", action: "SESSION_HEARTBEAT" });
    if (permit === "PONG" || permit.type !== "SPLIT_PERMIT") {
      throw new Error("Expected SPLIT_PERMIT.");
    }
    const [splitAck, firstMessage, secondMessage] = await sendMany(splitterSocket, {
      type: "SPLIT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "split-root",
      jobId,
      slotId: root.slotId,
      taskId: root.task.taskId,
      leaseId: root.lease.leaseId,
      permitId: permit.permitId,
      splitLiteral: 4,
    }, 3);
    expect(splitAck).toMatchObject({ type: "ACK", action: "SPLIT" });
    const first = expectWork(firstMessage!);
    const second = expectWork(secondMessage!);

    expect(new Set([
      first.task.assumptions.join(","),
      second.task.assumptions.join(","),
    ])).toEqual(new Set(["4", "-4"]));
    expect(first.task.taskId).not.toBe(second.task.taskId);
    expect(first.slotId).not.toBe(second.slotId);

    const replacementSocket = await openSocket(stub);
    await hello(replacementSocket, jobId, "browser-context-c");
    splitterSocket.close(1000, "network churn");

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE leases SET expires_at = ? WHERE lease_id = ?",
        Date.now() - 1,
        first.lease.leaseId,
      );
      return state.storage.setAlarm(Date.now() + 10_000);
    });
    const replacementMessage = nextMessage(replacementSocket);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const replacement = expectWork(await replacementMessage);
    expect(replacement.task.taskId).toBe(first.task.taskId);
    expect(replacement.task.assumptions).toEqual(first.task.assumptions);
    expect(replacement.lease.leaseCount).toBe(2);

    replacementSocket.close(1000, "done");
  });

  it("promotes each UNSAT candidate directly to proof-finisher work", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const splitter = await openSocket(stub);
    const coverageSlots = ["coverage-slot-a", "coverage-slot-b"];
    const { work: root } = await helloAndWork(splitter, jobId, "coverage-splitter", coverageSlots);
    const [heartbeatAck, permit] = await sendMany(splitter, {
      type: "SESSION_HEARTBEAT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "coverage-heartbeat",
      jobId,
      slots: coverageSlots.map((slotId) => ({
        slotId,
        leaseId: slotId === root.slotId ? root.lease.leaseId : null,
        activeMs: slotId === root.slotId ? COORDINATOR_SPLIT_SEED_MS : 0,
        conflicts: 0,
        decisions: 0,
        propagations: 0,
      })),
    }, 2);
    expect(heartbeatAck).toMatchObject({ type: "ACK", action: "SESSION_HEARTBEAT" });
    if (permit === "PONG" || permit.type !== "SPLIT_PERMIT") {
      throw new Error("Expected SPLIT_PERMIT.");
    }
    const [splitAck, firstChild, secondChild] = await sendMany(splitter, {
      type: "SPLIT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "coverage-split",
      jobId,
      slotId: root.slotId,
      taskId: root.task.taskId,
      leaseId: root.lease.leaseId,
      permitId: permit.permitId,
      splitLiteral: 1,
    }, 3);
    expect(splitAck).toMatchObject({ type: "ACK", action: "SPLIT" });
    const children = [
      expectWork(firstChild!),
      expectWork(secondChild!),
    ];

    for (const [index, work] of children.entries()) {
      const manifest = {
        kind: "UNSAT_CANDIDATE_V1",
        formulaHash: "ab".repeat(32),
        taskId: work.task.taskId,
        cube: work.task.assumptions,
        pathHash: await resultPathHash(work.task.assumptions),
        solverVersion: "cadical-3.0.1",
      };
      await expect(send(splitter, {
        type: "RESULT",
        protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
        messageId: `coverage-result-${index}`,
        jobId,
        slotId: work.slotId,
        taskId: work.task.taskId,
        leaseId: work.lease.leaseId,
        result: "UNSAT",
        evidenceSha256: `${index + 1}`.repeat(64),
        manifest,
      })).resolves.toMatchObject({ type: "ACK", action: "RESULT" });
    }

    await runInDurableObject(stub, (_instance, state) => {
      const tasks = state.storage.sql.exec<{ task_id: string; state: string; proof_required: number }>(
        "SELECT task_id, state, proof_required FROM tasks ORDER BY depth, task_id",
      ).toArray();
      expect(tasks).toHaveLength(3);
      expect(tasks[0]).toMatchObject({ task_id: "root", state: "SPLIT", proof_required: 0 });
      expect(tasks.slice(1).every((task) => task.state === "READY" && task.proof_required === 1)).toBe(true);
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM jobs").one().state)
        .toBe("RUNNING");
    });
    const finisherSocket = await openSocket(stub);
    const { work: finisher } = await helloAndWork(finisherSocket, jobId, "fresh-proof-finisher", ["proof-slot"], {
      proofGeneration: true,
    });
    expect(finisher.task.purpose).toBe("PROOF_FINISHER");
    finisherSocket.close(1000, "done");
    splitter.close(1000, "done");
  });

  it("re-enables a nonterminal job after owner proof confirmation", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const directory = env.SWARM_DIRECTORY.getByName("global-v1");
    const now = Date.now();
    const artifactId = "owner-proof-artifact";
    const artifactSha256 = "ef".repeat(32);
    await expect(directory.admit({
      jobId,
      deviceDigest: "owner-proof-device",
      networkDigest: "owner-proof-network",
      createdAt: now,
      expiresAt: now + 24 * 60 * 60_000,
      globalCeiling: 100,
    })).resolves.toEqual({ ok: true });
    expect(await directory.markReady(jobId, now)).toBe(true);
    expect(await directory.setEligible(jobId, false, now + 1)).toBe(true);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE jobs SET state = 'RUNNING'");
        state.storage.sql.exec(
          "UPDATE tasks SET state = 'SPLIT', active_lease_id = NULL, updated_at = ? WHERE task_id = 'root'",
          now,
        );
        state.storage.sql.exec(
          `INSERT INTO tasks (
            task_id, parent_task_id, depth, assumptions_json, state, created_at,
            updated_at, proof_required
          ) VALUES
            ('owner-child', 'root', 1, '[1]', 'VERIFYING_UNSAT', ?, ?, 1),
            ('open-sibling', 'root', 1, '[-1]', 'READY', ?, ?, 0)`,
          now,
          now,
          now,
          now,
        );
        state.storage.sql.exec(
          `INSERT INTO proof_artifacts (
            artifact_id, task_id, lease_id, artifact_sha256, compressed_bytes,
            decompressed_bytes, verification_status, created_at, object_key
          ) VALUES (?, 'owner-child', 'owner-proof-lease', ?, 10, 20,
            'OWNER_CHECK_REQUIRED', ?, 'proof/owner-check')`,
          artifactId,
          artifactSha256,
          now,
        );
      });
    });

    await expect(stub.confirmOwnerProof(
      "11".repeat(32),
      artifactId,
      artifactSha256,
    )).resolves.toEqual({ ok: true, state: "RUNNING" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM tasks WHERE task_id = 'owner-child'",
      ).one().state).toBe("UNSAT_OWNER_VERIFIED");
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM tasks WHERE task_id = 'root'",
      ).one().state).toBe("SPLIT");
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM jobs",
      ).one().state).toBe("RUNNING");
    });
    await runInDurableObject(directory, (_instance, state) => {
      expect(state.storage.sql.exec<{ eligible: number }>(
        "SELECT eligible FROM active_jobs WHERE job_id = ?",
        jobId,
      ).one().eligible).toBe(1);
    });
  });

  it("quarantines an invalid-model session and requeues without a terminal verdict", async () => {
    const jobId = `invalid-model-${++sequence}`;
    const stub = env.JOB_COORDINATORS.getByName(jobId);
    const encoded = new Uint8Array(28);
    encoded.set([0x48, 0x49, 0x56, 0x45, 0x43, 0x4e, 0x46, 0x31]);
    const view = new DataView(encoded.buffer);
    view.setUint32(8, 1, true);
    view.setUint32(12, 1, true);
    view.setUint32(16, 1, true);
    view.setInt32(20, 1, true);
    const compressed = await gzip(encoded);
    const formulaHash = await digest(encoded);
    const now = Date.now();
    await stub.initialize({
      jobId,
      ownerDigest: "11".repeat(32),
      uploadDigest: "22".repeat(32),
      formula: {
        hash: formulaHash,
        variableCount: 1,
        clauseCount: 1,
        literalCount: 1,
        encodedBytes: encoded.byteLength,
        compressedBytes: compressed.byteLength,
      },
      createdAt: now,
      expiresAt: now + 24 * 60 * 60_000,
    });
    expect(await stub.storeFormula(
      "22".repeat(32),
      new Response(compressed).body!,
      compressed.byteLength,
    )).toMatchObject({ ok: true });

    const socket = await openSocket(stub);
    const { work } = await helloAndWork(socket, jobId, "dishonest-session");
    const pathHash = await resultPathHash([]);
    const artifact = encodeSatModelArtifact({
      version: 1,
      formulaHash,
      taskId: "root",
      cube: [],
      pathHash,
      solverVersion: "cadical-3.0.1",
      variableCount: 1,
    }, [-1]);
    const artifactSha256 = await digest(artifact);
    const storedModel = await stub.storeModel(
      work.lease.leaseId,
      new Response(artifact.slice().buffer as ArrayBuffer).body!,
      artifact.byteLength,
    );
    const storedModels = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ lease_id: string; object_key: string }>(
        "SELECT lease_id, object_key FROM model_artifacts",
      ).toArray());
    expect({ storedModel, storedModels }).toEqual({
      storedModel: { ok: true, taskId: "root", bytes: artifact.byteLength },
      storedModels: [{ lease_id: work.lease.leaseId, object_key: expect.any(String) }],
    });
    const storedModelMetadata = await env.JOB_ARTIFACTS.getWithMetadata<{
      kind: string;
      taskId: string;
      formulaHash: string;
      bytes: number;
    }>(storedModels[0]!.object_key, "arrayBuffer");
    expect(storedModelMetadata.metadata).toMatchObject({
      kind: "sat-model",
      taskId: "root",
      formulaHash,
      bytes: artifact.byteLength,
    });
    await expect(send(socket, {
      type: "RESULT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "invalid-model-result",
      jobId,
      slotId: work.slotId,
      taskId: "root",
      leaseId: work.lease.leaseId,
      result: "SAT",
      evidenceSha256: artifactSha256,
      manifest: {
        kind: "SAT_MODEL_V1",
        version: 1,
        formulaHash,
        taskId: "root",
        cube: [],
        pathHash,
        solverVersion: "cadical-3.0.1",
        variableCount: 1,
        artifactId: work.lease.leaseId,
        artifactSha256,
        artifactBytes: artifact.byteLength,
      },
    })).resolves.toMatchObject({ type: "ACK", action: "RESULT" });

    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM jobs").one().state).toBe("RUNNING");
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM tasks WHERE task_id = 'root'").one().state)
        .toBe("READY");
      expect(state.storage.sql.exec<{ quarantined: number }>(
        "SELECT quarantined FROM session_reliability WHERE session_id = 'dishonest-session'",
      ).one().quarantined).toBe(1);
      expect(state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM leases WHERE session_id = 'dishonest-session' AND status = 'ACTIVE'",
      ).one().total).toBe(0);
      expect(state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM model_artifacts",
      ).one().total).toBe(0);
    });

    const reconnect = await openSocket(stub);
    await expect(hello(reconnect, jobId, "dishonest-session"))
      .resolves.toMatchObject({ type: "ERROR", code: "SESSION_QUARANTINED" });
    socket.close(1000, "done");
    reconnect.close(1000, "done");
  });

  it("requeues verification when committed KV data is temporarily missing without penalizing the session", async () => {
    const { jobId, stub } = await initializedCoordinator();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE jobs SET object_key = ?", `jobs/${jobId}/formula/missing.hivecnf.gz`);
    });
    const socket = await openSocket(stub);
    const { work } = await helloAndWork(socket, jobId, "kv-miss-session");
    const pathHash = await resultPathHash([]);
    const artifact = encodeSatModelArtifact({
      version: 1,
      formulaHash: "ab".repeat(32),
      taskId: "root",
      cube: [],
      pathHash,
      solverVersion: "cadical-3.0.1",
      variableCount: 10,
    }, Array.from({ length: 10 }, (_, index) => -(index + 1)));
    const artifactSha256 = await digest(artifact);
    await expect(stub.storeModel(
      work.lease.leaseId,
      new Response(artifact.slice().buffer as ArrayBuffer).body!,
      artifact.byteLength,
    )).resolves.toMatchObject({ ok: true });

    const [resultAck, retryMessage] = await sendMany(socket, {
      type: "RESULT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: "kv-miss-result",
      jobId,
      slotId: work.slotId,
      taskId: "root",
      leaseId: work.lease.leaseId,
      result: "SAT",
      evidenceSha256: artifactSha256,
      manifest: {
        kind: "SAT_MODEL_V1",
        version: 1,
        formulaHash: "ab".repeat(32),
        taskId: "root",
        cube: [],
        pathHash,
        solverVersion: "cadical-3.0.1",
        variableCount: 10,
        artifactId: work.lease.leaseId,
        artifactSha256,
        artifactBytes: artifact.byteLength,
      },
    }, 2);
    expect(resultAck).toMatchObject({ type: "ACK", action: "RESULT" });

    const retry = expectWork(retryMessage!);
    expect(retry).toMatchObject({
      slotId: work.slotId,
      task: { taskId: "root" },
      lease: { leaseCount: 2 },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM tasks WHERE task_id = 'root'",
      ).one().state).toBe("LEASED");
      expect(state.storage.sql.exec<{
        invalid_results: number;
        verification_timeouts: number;
        quarantined: number;
      }>(
        `SELECT invalid_results, verification_timeouts, quarantined
         FROM session_reliability WHERE session_id = 'kv-miss-session'`,
      ).one()).toEqual({ invalid_results: 0, verification_timeouts: 1, quarantined: 0 });
      expect(state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM model_artifacts",
      ).one().total).toBe(1);
    });
    socket.close(1000, "done");
  });

  it("broadcasts owner cancellation and cancels active slot leases", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const socket = await openSocket(stub);
    await helloAndWork(socket, jobId, "cancel-session");

    const cancellation = nextMessage(socket);
    await expect(stub.cancel("11".repeat(32))).resolves.toMatchObject({ ok: true, changed: true });
    await expect(cancellation).resolves.toMatchObject({ type: "JOB_CANCELLED", reason: "OWNER_CANCELLED" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM tasks WHERE task_id = 'root'").one().state).toBe("CANCELLED");
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM leases").one().status).toBe("CANCELLED");
    });
    socket.close(1000, "done");
  });

  it("continues bounded cancellation cleanup across formula, model, and proof keys", async () => {
    const { stub } = await initializedCoordinator();
    const formulaKey = `cleanup/formula-${sequence}`;
    const modelKeys = Array.from(
      { length: ARTIFACT_DELETE_BATCH_SIZE - 1 },
      (_, index) => `cleanup/model-${sequence}-${index}`,
    );
    const proofKeys = [`cleanup/proof-${sequence}-0`, `cleanup/proof-${sequence}-1`];
    const keys = [formulaKey, ...modelKeys, ...proofKeys];
    await Promise.all(keys.map((key) => env.JOB_ARTIFACTS.put(key, "x")));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE jobs SET object_key = ?", formulaKey);
        modelKeys.forEach((key, index) => state.storage.sql.exec(
          "INSERT INTO model_artifacts (lease_id, object_key, artifact_bytes, created_at) VALUES (?, ?, 1, ?)",
          `cleanup-model-lease-${index}`,
          key,
          index,
        ));
        proofKeys.forEach((key, index) => state.storage.sql.exec(
          `INSERT INTO proof_artifacts (
            artifact_id, task_id, lease_id, artifact_sha256, compressed_bytes,
            decompressed_bytes, verification_status, created_at, object_key
          ) VALUES (?, 'root', ?, ?, 1, 1, 'UPLOADED', ?, ?)`,
          `cleanup-proof-${index}`,
          `cleanup-proof-lease-${index}`,
          "cd".repeat(32),
          index,
          key,
        ));
      });
    });

    await expect(stub.cancel("11".repeat(32))).resolves.toMatchObject({ ok: true, changed: true });
    expect((await env.JOB_ARTIFACTS.list({ prefix: "cleanup/" })).keys).toHaveLength(2);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await env.JOB_ARTIFACTS.list({ prefix: "cleanup/" })).keys).toHaveLength(0);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ object_key: string }>("SELECT object_key FROM jobs").one().object_key).toBe("");
      expect(state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM model_artifacts",
      ).one().total).toBe(0);
      expect(state.storage.sql.exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM proof_artifacts WHERE object_key != ''",
      ).one().total).toBe(0);
    });
  });

  it("bounds alarm recovery batches and keeps retrying after arbitrarily many leases", async () => {
    const { stub } = await initializedCoordinator();
    const now = Date.now();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE tasks SET state = 'SPLIT' WHERE task_id = 'root'");
        for (let index = 0; index < COORDINATOR_ALARM_BATCH_SIZE + 1; index += 1) {
          const taskId = `batch-task-${index}`;
          const leaseId = `batch-lease-${index}`;
          state.storage.sql.exec(
            `INSERT INTO tasks (
              task_id, parent_task_id, depth, assumptions_json, state, created_at,
              updated_at, lease_count, active_lease_id
            ) VALUES (?, 'root', 1, '[]', 'LEASED', ?, ?, 1, ?)`,
            taskId,
            now,
            now,
            leaseId,
          );
          state.storage.sql.exec(
            `INSERT INTO leases (
              lease_id, task_id, session_id, slot_id, attempt, lease_count,
              issued_at, expires_at, maximum_expires_at, last_active_ms, status, extended
            ) VALUES (?, ?, 'batch-session', ?, 1, 1, ?, ?, ?, 0, 'ACTIVE', 0)`,
            leaseId,
            taskId,
            `batch-slot-${index}`,
            now - 2,
            now - 1,
            now + 60_000,
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

    const recovery = await initializedCoordinator();
    const socket = await openSocket(recovery.stub);
    const { work } = await helloAndWork(socket, recovery.jobId, "long-running-session");
    await runInDurableObject(recovery.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE tasks SET lease_count = 1000000 WHERE task_id = 'root'",
      );
      state.storage.sql.exec("UPDATE leases SET expires_at = ? WHERE lease_id = ?", Date.now() - 1, work.lease.leaseId);
      return state.storage.setAlarm(Date.now() + 10_000);
    });
    const retriedMessage = nextMessage(socket);
    expect(await runDurableObjectAlarm(recovery.stub)).toBe(true);
    const retried = expectWork(await retriedMessage);
    expect(retried).toMatchObject({
      slotId: work.slotId,
      task: { taskId: "root" },
      lease: { leaseCount: 1_000_001 },
    });
    expect(retried.lease.leaseId).not.toBe(work.lease.leaseId);
    await expect(recovery.stub.getStatus()).resolves.toMatchObject({ state: "RUNNING", rootTaskState: "LEASED" });
    socket.close(1000, "done");
  });

  it("immediately requeues slots when a client closes cleanly", async () => {
    const { jobId, stub } = await initializedCoordinator();
    const firstSocket = await openSocket(stub);
    const { work: first } = await helloAndWork(firstSocket, jobId, "stopping-session");

    const waitingSocket = await openSocket(stub);
    await hello(waitingSocket, jobId, "waiting-session");
    const reassignedMessage = nextMessage(waitingSocket);
    firstSocket.close(1000, "Client stopped");

    const reassigned = expectWork(await reassignedMessage);
    expect(reassigned).toMatchObject({
      task: { taskId: first.task.taskId, assumptions: first.task.assumptions },
      lease: { leaseCount: 2 },
    });
    expect(reassigned.lease.leaseId).not.toBe(first.lease.leaseId);
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM leases WHERE lease_id = ?",
        first.lease.leaseId,
      ).one().status).toBe("YIELDED");
      expect(state.storage.sql.exec<{ state: string }>(
        "SELECT state FROM tasks WHERE task_id = 'root'",
      ).one().state).toBe("LEASED");
    });
    waitingSocket.close(1000, "done");
  });

  it("fails closed at the configured per-job WebSocket ceiling", async () => {
    const { stub } = await initializedCoordinator();
    const sockets: WebSocket[] = [];
    for (let index = 0; index < 32; index += 1) {
      const response = await stub.fetch("https://hive-sat.test/socket", {
        headers: { upgrade: "websocket" },
      });
      expect(response.status).toBe(101);
      if (!response.webSocket) throw new Error("Expected a WebSocket response.");
      response.webSocket.accept();
      sockets.push(response.webSocket);
    }
    const rejected = await stub.fetch("https://hive-sat.test/socket", {
      headers: { upgrade: "websocket" },
    });
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get("retry-after")).toBe("30");
    sockets.forEach((socket) => socket.close(1000, "done"));
  });
});
