import {
  COORDINATOR_HEARTBEAT_INTERVAL_MS,
  type CoordinatorServerMessage,
  type CubeTask,
  type Lease,
  type WorkMessage,
} from "../../../shared/coordinator-protocol";
import { PUBLIC_JOB_PROTOCOL_VERSION } from "../../../shared/public-jobs";
import { createClauseBatches, decodeHiveCnfV1, sha256Hex, type HiveCnfV1 } from "../formula/hiveCnf";
import { verifySatModel } from "../formula/modelVerifier";
import type { FormulaMetadata } from "../formula/workerProtocol";
import { JobCoordinatorSocket, type CoordinatorWebSocket } from "../jobCoordinatorSocket";
import { loadVerifiedPublicFormula } from "../publicJobs";
import {
  encodeSatModelArtifact,
  resultPathHash,
  type ResultManifest,
} from "../../../shared/result-manifest";
import type { CubeWorkerRequest, CubeWorkerResponse } from "./cubeWorkerProtocol";
import { conservativeWorkerCapacity, isLikelyMobile } from "./workerCapacity";

export type CubeRuntimePhase =
  | "idle"
  | "loading"
  | "connecting"
  | "running"
  | "paused"
  | "complete"
  | "error";

export interface CubeRuntimeSnapshot {
  phase: CubeRuntimePhase;
  jobId: string;
  capacity: number;
  activeWorkers: number;
  completedTasks: number;
  splitTasks: number;
  yieldedTasks: number;
  message: string | null;
}

interface WorkerLike {
  onmessage: ((event: MessageEvent<CubeWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: CubeWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

interface WorkerSlot {
  worker: WorkerLike;
  ready: boolean;
  task: CubeTask | null;
  lease: Lease | null;
  lastHeartbeatAt: number;
  pendingRequestId: string | null;
}

export interface CubeRuntimeOptions {
  jobId: string;
  sessionId?: string;
  workerPreference?: number;
  hardwareConcurrency?: number;
  mobile?: boolean;
  fetcher?: typeof fetch;
  workerFactory?: (index: number) => WorkerLike;
  webSocketFactory?: (url: string) => CoordinatorWebSocket;
  now?: () => number;
}

type Listener = () => void;
type RuntimeAction =
  | {
      type: "HEARTBEAT";
      taskId: string;
      leaseId: string;
      progress: { activeMs: number; conflicts: number; decisions: number; propagations: number };
    }
  | { type: "SPLIT"; taskId: string; leaseId: string; splitLiteral: number }
  | {
      type: "YIELD";
      taskId: string;
      leaseId: string;
      reason: "BUDGET" | "PAUSED" | "SHUTDOWN" | "UNSUPPORTED";
    }
  | {
      type: "RESULT";
      taskId: string;
      leaseId: string;
      result: "SAT" | "UNSAT";
      evidenceSha256: string;
      manifest: ResultManifest;
    };

function defaultWorkerFactory(index: number): WorkerLike {
  return new Worker(new URL("../../workers/cube.worker.ts", import.meta.url), {
    type: "module",
    name: `hivesat-cube-${index + 1}`,
  });
}

export class DistributedCubeRuntime {
  private readonly listeners = new Set<Listener>();
  private readonly options: CubeRuntimeOptions;
  private readonly capacity: number;
  private readonly requestId: string;
  private readonly sessionId: string;
  private readonly now: () => number;
  private snapshot: CubeRuntimeSnapshot;
  private formula: HiveCnfV1 | null = null;
  private formulaHash: string | null = null;
  private slots: WorkerSlot[] = [];
  private socket: JobCoordinatorSocket | null = null;
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: CubeRuntimeOptions) {
    this.options = options;
    const mobile = options.mobile ?? isLikelyMobile();
    this.capacity = conservativeWorkerCapacity({
      mobile,
      hardwareConcurrency: options.hardwareConcurrency ?? navigator.hardwareConcurrency,
      preference: options.workerPreference,
    });
    this.requestId = `cube-${options.jobId}-${crypto.randomUUID()}`;
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.now = options.now ?? Date.now;
    this.snapshot = {
      phase: "idle",
      jobId: options.jobId,
      capacity: this.capacity,
      activeWorkers: 0,
      completedTasks: 0,
      splitTasks: 0,
      yieldedTasks: 0,
      message: null,
    };
  }

  getSnapshot = (): CubeRuntimeSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async start(): Promise<void> {
    if (!["idle", "paused", "error"].includes(this.snapshot.phase)) return;
    if (this.snapshot.phase === "paused" && this.slots.length > 0) {
      const ready = this.slots.every((slot) => slot.ready);
      this.update({
        ...this.snapshot,
        phase: ready ? "running" : "loading",
        message: ready ? null : "Finishing local worker initialization…",
      });
      if (ready) this.connect();
      return;
    }
    this.dispose();
    this.update({ ...this.snapshot, phase: "loading", message: "Verifying and caching the public formula…" });
    try {
      const cached = await loadVerifiedPublicFormula(this.options.jobId, this.options.fetcher);
      const encoded = new Uint8Array(cached.encoded);
      this.formula = decodeHiveCnfV1(encoded);
      this.formulaHash = cached.hash;
      const metadata: FormulaMetadata = {
        hash: cached.hash,
        variableCount: cached.variableCount,
        clauseCount: cached.clauseCount,
        literalCount: cached.literalCount,
        encodedBytes: cached.encoded.byteLength,
        compressedBytes: cached.gzip.byteLength,
        cacheHit: true,
      };
      const batches = createClauseBatches(this.formula.clauses);
      for (let index = 0; index < this.capacity; index += 1) {
        const worker = (this.options.workerFactory ?? defaultWorkerFactory)(index);
        const slot: WorkerSlot = {
          worker,
          ready: false,
          task: null,
          lease: null,
          lastHeartbeatAt: 0,
          pendingRequestId: null,
        };
        worker.onmessage = (event) => void this.onWorkerMessage(index, event.data);
        worker.onerror = (event) => this.fail(event.message || "A cube worker failed.");
        this.slots.push(slot);
        worker.postMessage({ type: "initialize", requestId: this.requestId, metadata });
        if (batches.length === 0) {
          worker.postMessage({
            type: "clause-batch",
            requestId: this.requestId,
            sequence: 0,
            last: true,
            literals: new Int32Array(),
          });
        } else {
          batches.forEach((batch, sequence) => {
            const copy = batch.slice();
            worker.postMessage({
              type: "clause-batch",
              requestId: this.requestId,
              sequence,
              last: sequence === batches.length - 1,
              literals: copy,
            }, [copy.buffer as ArrayBuffer]);
          });
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "The distributed runtime could not start.");
    }
  }

  pause(): void {
    if (!["loading", "connecting", "running"].includes(this.snapshot.phase)) return;
    for (const slot of this.slots) {
      if (slot.task && slot.lease) {
        this.send({
          type: "YIELD",
          taskId: slot.task.taskId,
          leaseId: slot.lease.leaseId,
          reason: "PAUSED",
        });
        slot.worker.postMessage({ type: "stop", requestId: this.requestId, reason: "PAUSED" });
        this.release(slot);
      }
    }
    this.socket?.stop();
    this.socket = null;
    this.clearRetryTimers();
    this.update({ ...this.snapshot, phase: "paused", message: "Contribution paused." });
  }

  stop(): void {
    this.dispose();
    this.update({
      ...this.snapshot,
      phase: "idle",
      activeWorkers: 0,
      message: null,
    });
  }

  private connect(): void {
    if (this.socket || this.snapshot.phase === "paused") return;
    this.update({ ...this.snapshot, phase: "connecting", message: "Connecting to the job coordinator…" });
    const mobile = this.options.mobile ?? isLikelyMobile();
    this.socket = new JobCoordinatorSocket({
      jobId: this.options.jobId,
      sessionId: this.sessionId,
      capabilities: {
        hardwareConcurrency: this.options.hardwareConcurrency ?? navigator.hardwareConcurrency ?? 1,
        maxWorkers: this.capacity,
        mobile,
        solverVersion: "cadical-3.0.1",
      },
      webSocketFactory: this.options.webSocketFactory,
      onStateChange: (state) => {
        if (state === "connected") {
          this.update({ ...this.snapshot, phase: "running", message: null });
        } else if (state === "reconnecting") {
          this.update({ ...this.snapshot, phase: "connecting", message: "Reconnecting to the job coordinator…" });
        }
      },
      onMessage: (message) => this.onCoordinatorMessage(message),
      onProtocolError: (code) => this.fail(`Coordinator protocol error: ${code}.`),
    });
    this.socket.start();
  }

  private onCoordinatorMessage(message: CoordinatorServerMessage): void {
    if (message.type === "WELCOME") {
      for (const active of message.activeLeases) {
        const slot = this.slots.find((candidate) => candidate.ready && !candidate.task);
        if (!slot) break;
        this.runTask(slot, {
          ...message,
          type: "WORK",
          requestMessageId: crypto.randomUUID(),
          task: active.task,
          lease: active.lease,
          queue: {
            readyTasks: 0,
            activeWorkers: 1,
            lowWatermark: 1,
            targetWatermark: 3,
            highWatermark: 8,
            taskCount: 1,
            canSplit: active.task.depth < 64,
          },
        });
      }
      this.requestForIdleWorkers();
      return;
    }
    if (message.type === "WORK") {
      const slot = this.slots.find((candidate) => candidate.pendingRequestId === message.requestMessageId);
      if (slot) this.runTask(slot, message);
      return;
    }
    if (message.type === "NO_WORK") {
      const slot = this.slots.find((candidate) => candidate.pendingRequestId === message.requestMessageId);
      if (!slot) return;
      slot.pendingRequestId = null;
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        this.requestWork(slot);
      }, message.retryAfterMs);
      this.retryTimers.add(timer);
      return;
    }
    if (message.type === "ACK" && message.action !== "HEARTBEAT") {
      const slot = this.slots.find((candidate) => candidate.task === null && candidate.pendingRequestId === null);
      if (slot) this.requestWork(slot);
      return;
    }
    if (message.type === "JOB_CANCELLED") {
      this.stop();
      this.update({ ...this.snapshot, phase: "complete", message: "The job is no longer active." });
      return;
    }
    if (message.type === "JOB_RESULT") {
      this.dispose();
      this.update({
        ...this.snapshot,
        phase: "complete",
        activeWorkers: 0,
        message: "The SAT model passed independent server verification.",
      });
    }
  }

  private runTask(slot: WorkerSlot, work: WorkMessage): void {
    slot.pendingRequestId = null;
    slot.task = work.task;
    slot.lease = work.lease;
    slot.lastHeartbeatAt = this.now();
    this.refreshActiveWorkers();
    slot.worker.postMessage({
      type: "run",
      requestId: this.requestId,
      task: work.task,
      lease: work.lease,
      allowSplit: work.queue.canSplit && work.queue.readyTasks < work.queue.targetWatermark,
      maxSlices: 64,
      conflictBudget: 100,
    });
  }

  private async onWorkerMessage(index: number, message: CubeWorkerResponse): Promise<void> {
    if (message.requestId !== this.requestId) return;
    const slot = this.slots[index];
    if (!slot) return;
    if (message.type === "ready") {
      slot.ready = true;
      if (this.slots.every((candidate) => candidate.ready)) this.connect();
      return;
    }
    if (message.type === "error") {
      this.fail(message.message);
      return;
    }
    if (!slot.task || !slot.lease || message.taskId !== slot.task.taskId || message.leaseId !== slot.lease.leaseId) {
      return;
    }
    if (message.type === "progress") {
      if (this.now() - slot.lastHeartbeatAt >= COORDINATOR_HEARTBEAT_INTERVAL_MS) {
        slot.lastHeartbeatAt = this.now();
        this.send({
          type: "HEARTBEAT",
          taskId: message.taskId,
          leaseId: message.leaseId,
          progress: {
            activeMs: Math.round(message.activeMs),
            ...message.metrics,
          },
        });
      }
      return;
    }
    if (message.type === "split") {
      this.release(slot);
      this.send({
        type: "SPLIT",
        taskId: message.taskId,
        leaseId: message.leaseId,
        splitLiteral: message.splitLiteral,
      });
      this.update({ ...this.snapshot, splitTasks: this.snapshot.splitTasks + 1 });
      return;
    }
    if (message.type === "yield") {
      this.release(slot);
      this.send({
        type: "YIELD",
        taskId: message.taskId,
        leaseId: message.leaseId,
        reason: message.reason,
      });
      this.update({ ...this.snapshot, yieldedTasks: this.snapshot.yieldedTasks + 1 });
      return;
    }

    if (message.verdict === "SAT") {
      if (!this.formula) return this.fail("A SAT result arrived without a verified formula.");
      const verification = verifySatModel(this.formula, message.model);
      const satisfiesCube = slot.task.assumptions.every(
        (assumption) => message.model[Math.abs(assumption) - 1] === assumption,
      );
      if (!verification.valid || !satisfiesCube) {
        return this.fail("A cube worker returned an invalid SAT model.");
      }
    }
    if (!this.formulaHash) return this.fail("A result arrived without a verified formula hash.");
    const pathHash = await resultPathHash(slot.task.assumptions);
    let manifest: ResultManifest;
    let evidenceSha256: string;
    if (message.verdict === "SAT") {
      const artifact = encodeSatModelArtifact({
        version: 1,
        formulaHash: this.formulaHash,
        taskId: message.taskId,
        cube: slot.task.assumptions,
        pathHash,
        solverVersion: "cadical-3.0.1",
        variableCount: message.model.length,
      }, message.model);
      evidenceSha256 = await sha256Hex(artifact);
      manifest = {
        kind: "SAT_MODEL_V1",
        version: 1,
        formulaHash: this.formulaHash,
        taskId: message.taskId,
        cube: [...slot.task.assumptions],
        pathHash,
        solverVersion: "cadical-3.0.1",
        variableCount: message.model.length,
        artifactId: message.leaseId,
        artifactSha256: evidenceSha256,
        artifactBytes: artifact.byteLength,
      };
      const fetcher = this.options.fetcher ?? fetch;
      const response = await fetcher(
        `/api/v1/jobs/${encodeURIComponent(this.options.jobId)}/results/${encodeURIComponent(message.leaseId)}/model`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${message.leaseId}`,
            "content-type": "application/vnd.hivesat.model",
            "x-hivesat-content-length": String(artifact.byteLength),
          },
          body: artifact.slice().buffer as ArrayBuffer,
        },
      );
      if (!response.ok) return this.fail(`SAT model upload failed with HTTP ${response.status}.`);
    } else {
      manifest = {
        kind: "UNSAT_CANDIDATE_V1",
        formulaHash: this.formulaHash,
        taskId: message.taskId,
        cube: [...slot.task.assumptions],
        pathHash,
        solverVersion: "cadical-3.0.1",
      };
      evidenceSha256 = await sha256Hex(new TextEncoder().encode(JSON.stringify(manifest)));
    }
    this.release(slot);
    this.send({
      type: "RESULT",
      taskId: message.taskId,
      leaseId: message.leaseId,
      result: message.verdict,
      evidenceSha256,
      manifest,
    });
    this.update({ ...this.snapshot, completedTasks: this.snapshot.completedTasks + 1 });
    if (message.verdict === "SAT") {
      this.dispose();
      this.update({
        ...this.snapshot,
        phase: "complete",
        activeWorkers: 0,
        message: "A SAT model is awaiting independent server verification.",
      });
    }
  }

  private requestForIdleWorkers(): void {
    for (const slot of this.slots) {
      if (slot.ready && !slot.task && !slot.pendingRequestId) this.requestWork(slot);
    }
  }

  private requestWork(slot: WorkerSlot): void {
    if (this.snapshot.phase !== "running" || !this.socket) return;
    const messageId = crypto.randomUUID();
    slot.pendingRequestId = messageId;
    if (!this.socket.send({
      type: "REQUEST_WORK",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId,
      jobId: this.options.jobId,
    })) slot.pendingRequestId = null;
  }

  private send(message: RuntimeAction): void {
    const outgoing = {
      ...message,
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: crypto.randomUUID(),
      jobId: this.options.jobId,
    };
    this.socket?.send(outgoing);
  }

  private release(slot: WorkerSlot): void {
    slot.task = null;
    slot.lease = null;
    this.refreshActiveWorkers();
  }

  private refreshActiveWorkers(): void {
    this.update({
      ...this.snapshot,
      activeWorkers: this.slots.filter((slot) => slot.task !== null).length,
    });
  }

  private fail(message: string): void {
    this.dispose();
    this.update({ ...this.snapshot, phase: "error", activeWorkers: 0, message });
  }

  private dispose(): void {
    this.socket?.stop();
    this.socket = null;
    this.clearRetryTimers();
    for (const slot of this.slots) {
      slot.worker.postMessage({ type: "stop", requestId: this.requestId, reason: "SHUTDOWN" });
      slot.worker.terminate();
    }
    this.slots = [];
    this.formula = null;
  }

  private clearRetryTimers(): void {
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private update(snapshot: CubeRuntimeSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
