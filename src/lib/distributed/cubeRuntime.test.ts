import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeHiveCnfV1 } from "../formula/hiveCnf";
import type { CubeWorkerRequest, CubeWorkerResponse } from "./cubeWorkerProtocol";

const mocks = vi.hoisted(() => ({
  loadFormula: vi.fn(),
}));

vi.mock("../publicJobs", async (importOriginal) => ({
  ...await importOriginal<typeof import("../publicJobs")>(),
  loadVerifiedPublicFormula: mocks.loadFormula,
}));

import { DistributedCubeRuntime } from "./cubeRuntime";

class FakeWebSocket extends EventTarget {
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

class FakeWorker {
  onmessage: ((event: MessageEvent<CubeWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: CubeWorkerRequest[] = [];
  terminated = false;

  postMessage(message: CubeWorkerRequest): void {
    this.sent.push(message);
    if (message.type === "initialize") {
      queueMicrotask(() => this.emit({ type: "ready", requestId: message.requestId }));
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: CubeWorkerResponse): void {
    this.onmessage?.(new MessageEvent("message", { data: message }));
  }
}

const encoded = encodeHiveCnfV1({
  variableCount: 1,
  clauseCount: 0,
  literalCount: 0,
  clauses: [],
});

const cachedFormula = {
  hash: "ab".repeat(32),
  encoded: encoded.slice().buffer as ArrayBuffer,
  gzip: new Uint8Array([1]).buffer,
  variableCount: 1,
  clauseCount: 0,
  literalCount: 0,
  verifiedAt: 1,
  cacheHit: true,
  transferredBytes: 0,
};

function task(taskId: string) {
  return { taskId, parentTaskId: null, depth: 0, assumptions: [], purpose: "SEARCH" as const };
}

function lease(leaseId: string, taskId: string) {
  return {
    leaseId,
    taskId,
    slotId: "slot-1",
    leaseCount: 1,
    issuedAt: 1,
    expiresAt: 300_001,
    maximumExpiresAt: 3_600_001,
  };
}

function serverBase(messageId: string) {
  return { protocolVersion: 4, messageId, jobId: "job-one", serverTime: 1 } as const;
}

async function runningRuntime() {
  const workers: FakeWorker[] = [];
  const sockets: FakeWebSocket[] = [];
  const runtime = new DistributedCubeRuntime({
    jobId: "job-one",
    sessionId: "session-one",
    workerPreference: 1,
    hardwareConcurrency: 1,
    mobile: false,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    webSocketFactory: () => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
  });
  await runtime.start();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0]!.open();
  return { runtime, workers, sockets };
}

function welcome(messageId: string, taskId: string, leaseId: string) {
  return {
    ...serverBase(messageId),
    type: "WELCOME",
    heartbeatIntervalMs: 60_000,
    leaseDurationMs: 300_000,
    activeLeases: [{ slotId: "slot-1", task: task(taskId), lease: lease(leaseId, taskId) }],
  };
}

describe("DistributedCubeRuntime protocol-v4 recovery", () => {
  beforeEach(() => {
    mocks.loadFormula.mockReset();
    mocks.loadFormula.mockResolvedValue(cachedFormula);
  });

  it("does not resurrect workers after stop wins a pending formula load", async () => {
    let resolveFormula!: (value: typeof cachedFormula) => void;
    mocks.loadFormula.mockReturnValueOnce(new Promise((resolve) => {
      resolveFormula = resolve;
    }));
    const workers: FakeWorker[] = [];
    const sockets: FakeWebSocket[] = [];
    const runtime = new DistributedCubeRuntime({
      jobId: "job-one",
      workerPreference: 1,
      hardwareConcurrency: 1,
      mobile: false,
      workerFactory: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const starting = runtime.start();
    runtime.stop();
    resolveFormula(cachedFormula);
    await starting;

    expect(runtime.getSnapshot().phase).toBe("idle");
    expect(workers).toHaveLength(0);
    expect(sockets).toHaveLength(0);
  });

  it("reconciles a lost mutation ACK with authoritative fresh WELCOME work", async () => {
    const { runtime, workers, sockets } = await runningRuntime();
    const socket = sockets[0]!;
    const worker = workers[0]!;
    socket.receive(welcome("welcome-one", "task-one", "lease-one"));
    await Promise.resolve();

    const requestId = worker.sent.find((message) => message.type === "run")?.requestId;
    if (!requestId) throw new Error("Expected a worker run request.");
    worker.emit({
      type: "split",
      requestId,
      taskId: "task-one",
      leaseId: "lease-one",
      permitId: "permit-one",
      splitLiteral: 1,
      activeMs: 1_100,
      metrics: { conflicts: 11, decisions: 5, propagations: 20 },
    });
    expect(socket.sent.map((value) => JSON.parse(value).type)).toContain("SPLIT");
    const sentBeforeWelcome = socket.sent.length;

    socket.receive(welcome("welcome-two", "task-two", "lease-two"));
    await Promise.resolve();

    expect(socket.sent.slice(sentBeforeWelcome).map((value) => JSON.parse(value).type)).toEqual([
      "SESSION_HEARTBEAT",
    ]);
    expect(worker.sent.slice(-2).map((message) => message.type)).toEqual(["stop", "run"]);
    expect(worker.sent.at(-1)).toMatchObject({ type: "run", task: { taskId: "task-two" } });
    expect(runtime.getSnapshot()).toMatchObject({ phase: "running", activeWorkers: 1, currentTaskId: "task-two" });
    runtime.stop();
  });

  it("keeps per-lease active time cumulative when a split is rejected", async () => {
    const { runtime, workers, sockets } = await runningRuntime();
    const socket = sockets[0]!;
    const worker = workers[0]!;
    socket.receive(welcome("welcome-one", "task-one", "lease-one"));
    await Promise.resolve();
    const run = worker.sent.find((message) => message.type === "run");
    if (!run || run.type !== "run") throw new Error("Expected a worker run request.");
    worker.emit({
      type: "split",
      requestId: run.requestId,
      taskId: "task-one",
      leaseId: "lease-one",
      permitId: "permit-one",
      splitLiteral: 1,
      activeMs: 1_100,
      metrics: { conflicts: 11, decisions: 5, propagations: 20 },
    });
    const split = socket.sent.map((value) => JSON.parse(value)).find((message) => message.type === "SPLIT");
    socket.receive({
      ...serverBase("split-rejected"),
      type: "ERROR",
      requestMessageId: split.messageId,
      code: "SPLIT_NOT_NEEDED",
      retryable: true,
    });
    await Promise.resolve();
    worker.emit({
      type: "progress",
      requestId: run.requestId,
      taskId: "task-one",
      leaseId: "lease-one",
      activeMs: 100,
      metrics: { conflicts: 12, decisions: 6, propagations: 22 },
      slices: 1,
    });
    socket.receive(welcome("welcome-refresh", "task-one", "lease-one"));
    await Promise.resolve();

    const heartbeat = socket.sent.map((value) => JSON.parse(value)).at(-1);
    expect(heartbeat).toMatchObject({
      type: "SESSION_HEARTBEAT",
      slots: [{ leaseId: "lease-one", activeMs: 1_200 }],
    });
    expect(runtime.getSnapshot().activeComputeMs).toBe(1_200);
    runtime.stop();
  });
});
