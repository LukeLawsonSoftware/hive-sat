import {
  COORDINATOR_HEARTBEAT_INTERVAL_MS,
  type AckMessage,
  type CoordinatorClientMessage,
  type CoordinatorServerMessage,
  type CubeTask,
  type Lease,
  type ResultMessage,
  type SplitMessage,
  type WorkMessage,
  type YieldMessage,
} from "../../../shared/coordinator-protocol";
import { PUBLIC_JOB_PROTOCOL_VERSION } from "../../../shared/public-jobs";
import { createClauseBatches, decodeHiveCnfV1, sha256Hex, type HiveCnfV1 } from "../formula/hiveCnf";
import { verifySatModel } from "../formula/modelVerifier";
import type { FormulaMetadata } from "../formula/workerProtocol";
import { JobCoordinatorSocket, type CoordinatorWebSocket } from "../jobCoordinatorSocket";
import { loadVerifiedPublicFormula, PublicJobApiError } from "../publicJobs";
import {
  encodeSatModelArtifact,
  MAX_UNSAT_PROOF_COMPRESSED_BYTES,
  MAX_UNSAT_PROOF_DECOMPRESSED_BYTES,
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
  acceptedTasks: number;
  activeComputeMs: number;
  conflicts: number;
  decisions: number;
  propagations: number;
  formulaBytesTransferred: number;
  wasmMemoryBytes: number;
  wasmMemoryHighWaterBytes: number;
  decisiveSatResults: number;
  certifiedUnsatResults: number;
  currentTaskId: string | null;
  message: string | null;
}

interface WorkerLike {
  onmessage: ((event: MessageEvent<CubeWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: CubeWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

interface WorkerSlot {
  slotId: string;
  worker: WorkerLike;
  ready: boolean;
  mode: "SEARCH" | "PROOF_FINISHER";
  task: CubeTask | null;
  lease: Lease | null;
  pendingWork: WorkMessage | null;
  pendingMutationId: string | null;
  runActiveBaseMs: number;
  lastActiveMs: number;
  lastMetrics: { conflicts: number; decisions: number; propagations: number };
  memoryBytes: number;
  memoryHighWaterBytes: number;
}

export interface CubeRuntimeOptions {
  jobId: string;
  sessionId?: string;
  assignmentId?: string;
  workerPreference?: number;
  hardwareConcurrency?: number;
  mobile?: boolean;
  fetcher?: typeof fetch;
  workerFactory?: (index: number) => WorkerLike;
  webSocketFactory?: (url: string) => CoordinatorWebSocket;
  now?: () => number;
  conflictBudget?: number;
  calibratedConflictsPerSecond?: number;
}

type Listener = () => void;
type WithoutMessageBase<T> = T extends unknown
  ? Omit<T, "protocolVersion" | "messageId" | "jobId">
  : never;
type RuntimeMutation = WithoutMessageBase<SplitMessage | YieldMessage | ResultMessage>;

interface PendingMutation {
  message: Exclude<CoordinatorClientMessage, { type: "HELLO" }>;
  slotId: string;
  leaseId: string;
  action: Extract<AckMessage["action"], "SPLIT" | "YIELD" | "RESULT">;
}

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
  private formulaMetadata: FormulaMetadata | null = null;
  private slots: WorkerSlot[] = [];
  private socket: JobCoordinatorSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly outbox = new Map<string, PendingMutation>();
  private lifecycle = 0;

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
      acceptedTasks: 0,
      activeComputeMs: 0,
      conflicts: 0,
      decisions: 0,
      propagations: 0,
      formulaBytesTransferred: 0,
      wasmMemoryBytes: 0,
      wasmMemoryHighWaterBytes: 0,
      decisiveSatResults: 0,
      certifiedUnsatResults: 0,
      currentTaskId: null,
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
    if (this.snapshot.phase === "paused" && this.formula && this.formulaMetadata) {
      this.lifecycle += 1;
      this.update({ ...this.snapshot, phase: "loading", message: "Restarting local workers…" });
      try {
        this.createSlots();
      } catch (error) {
        this.fail(error instanceof Error ? error.message : "The distributed runtime could not restart.");
      }
      return;
    }
    this.dispose();
    const lifecycle = this.lifecycle;
    this.update({ ...this.snapshot, phase: "loading", message: "Verifying and caching the public formula…" });
    try {
      const cached = await this.loadFormula(lifecycle);
      if (lifecycle !== this.lifecycle || this.snapshot.phase !== "loading") return;
      this.update({
        ...this.snapshot,
        formulaBytesTransferred: this.snapshot.formulaBytesTransferred + cached.transferredBytes,
      });
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
      this.formulaMetadata = metadata;
      this.createSlots();
    } catch (error) {
      if (lifecycle !== this.lifecycle) return;
      this.fail(error instanceof Error ? error.message : "The distributed runtime could not start.");
    }
  }

  pause(): void {
    if (!["loading", "connecting", "running"].includes(this.snapshot.phase)) return;
    this.lifecycle += 1;
    for (const slot of this.slots) {
      slot.worker.postMessage({ type: "stop", requestId: this.requestId, reason: "PAUSED" });
      slot.worker.terminate();
    }
    this.slots = [];
    this.outbox.clear();
    this.socket?.stop();
    this.socket = null;
    this.stopHeartbeat();
    this.update({
      ...this.snapshot,
      phase: "paused",
      activeWorkers: 0,
      currentTaskId: null,
      wasmMemoryBytes: 0,
      message: "Contribution paused.",
    });
  }

  stop(): void {
    this.dispose();
    this.update({
      ...this.snapshot,
      phase: "idle",
      activeWorkers: 0,
      currentTaskId: null,
      wasmMemoryBytes: 0,
      message: null,
    });
  }

  private async loadFormula(lifecycle: number) {
    const maximumAttempts = 4;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      if (lifecycle !== this.lifecycle) throw new DOMException("Formula loading was cancelled.", "AbortError");
      try {
        return await loadVerifiedPublicFormula(this.options.jobId, this.options.fetcher);
      } catch (error) {
        if (lifecycle !== this.lifecycle) throw new DOMException("Formula loading was cancelled.", "AbortError");
        const retryable = error instanceof TypeError ||
          (error instanceof PublicJobApiError &&
            (error.status === 503 || error.code === "ARTIFACT_UNAVAILABLE"));
        if (!retryable || attempt === maximumAttempts - 1) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw new Error("The public formula could not be downloaded.");
  }

  private connect(): void {
    if (this.socket || !["loading", "connecting", "running"].includes(this.snapshot.phase)) return;
    this.update({ ...this.snapshot, phase: "connecting", message: "Connecting to the job coordinator…" });
    const mobile = this.options.mobile ?? isLikelyMobile();
    this.socket = new JobCoordinatorSocket({
      jobId: this.options.jobId,
      sessionId: this.sessionId,
      assignmentId: this.options.assignmentId,
      slotIds: this.slots.map((slot) => slot.slotId),
      capabilities: {
        hardwareConcurrency: this.options.hardwareConcurrency ?? navigator.hardwareConcurrency ?? 1,
        maxWorkers: this.capacity,
        mobile,
        solverVersion: "cadical-3.0.1",
        proofGeneration: true,
        ...(this.options.calibratedConflictsPerSecond
          ? { calibratedConflictsPerSecond: this.options.calibratedConflictsPerSecond }
          : {}),
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
      this.startHeartbeat(message.heartbeatIntervalMs);
      const activeBySlot = new Map(message.activeLeases.map((active) => [active.slotId, active]));
      for (const slot of this.slots) {
        const active = activeBySlot.get(slot.slotId);
        if (!active) {
          this.clearPendingMutation(slot);
          this.stopAndRelease(slot);
          continue;
        }
        const pending = slot.pendingMutationId ? this.outbox.get(slot.pendingMutationId) : undefined;
        if (pending && pending.leaseId !== active.lease.leaseId) this.clearPendingMutation(slot);
        if (slot.pendingMutationId) continue;
        if (slot.lease?.leaseId === active.lease.leaseId && slot.task?.taskId === active.task.taskId) continue;
        this.replaceSlotWork(slot, this.resumedWork(message, active));
      }
      this.sendHeartbeat();
      this.flushOutbox();
      return;
    }
    if (message.type === "WORK") {
      const slot = this.slots.find((candidate) => candidate.slotId === message.slotId);
      if (!slot || message.lease.slotId !== message.slotId) {
        this.fail("The coordinator assigned work to an unknown browser slot.");
        return;
      }
      if (slot.lease?.leaseId === message.lease.leaseId) return;
      this.replaceSlotWork(slot, message);
      return;
    }
    if (message.type === "SPLIT_PERMIT") {
      const slot = this.slots.find((candidate) =>
        candidate.slotId === message.slotId &&
        candidate.task?.taskId === message.taskId &&
        candidate.lease?.leaseId === message.leaseId &&
        !candidate.pendingMutationId);
      slot?.worker.postMessage({
        type: "grant-split",
        requestId: this.requestId,
        taskId: message.taskId,
        leaseId: message.leaseId,
        permitId: message.permitId,
      });
      return;
    }
    if (message.type === "ACK") {
      if (message.action === "SESSION_HEARTBEAT") return;
      this.acknowledgeMutation(message);
      return;
    }
    if (message.type === "ERROR") {
      this.handleMutationError(message.requestMessageId, message.code, message.retryable);
      return;
    }
    if (message.type === "JOB_CANCELLED") {
      this.dispose();
      this.update({
        ...this.snapshot,
        phase: "complete",
        activeWorkers: 0,
        currentTaskId: null,
        wasmMemoryBytes: 0,
        message: "The job is no longer active.",
      });
      return;
    }
    if (message.type === "JOB_SUSPENDED") {
      this.dispose();
      this.update({
        ...this.snapshot,
        phase: "complete",
        activeWorkers: 0,
        currentTaskId: null,
        wasmMemoryBytes: 0,
        message: "This job is waiting for its owner to verify the final proof.",
      });
      return;
    }
    if (message.type === "JOB_RESULT") {
      const sat = message.result === "SAT_VERIFIED";
      this.dispose();
      this.update({
        ...this.snapshot,
        phase: "complete",
        activeWorkers: 0,
        currentTaskId: null,
        wasmMemoryBytes: 0,
        decisiveSatResults: this.snapshot.decisiveSatResults + (sat ? 1 : 0),
        certifiedUnsatResults: this.snapshot.certifiedUnsatResults + (sat ? 0 : 1),
        message: sat
          ? "The SAT model passed independent server verification."
          : "The UNSAT result is certified.",
      });
    }
  }

  private resumedWork(
    welcome: Extract<CoordinatorServerMessage, { type: "WELCOME" }>,
    active: Extract<CoordinatorServerMessage, { type: "WELCOME" }>["activeLeases"][number],
  ): WorkMessage {
    return {
      ...welcome,
      type: "WORK",
      slotId: active.slotId,
      task: active.task,
      lease: active.lease,
    };
  }

  private runTask(slot: WorkerSlot, work: WorkMessage): void {
    slot.task = work.task;
    slot.lease = work.lease;
    slot.runActiveBaseMs = 0;
    slot.lastActiveMs = 0;
    slot.pendingWork = null;
    this.refreshActiveWorkers();
    this.update({
      ...this.snapshot,
      acceptedTasks: this.snapshot.acceptedTasks + 1,
      currentTaskId: work.task.taskId,
    });
    const requiredMode = work.task.purpose;
    if (requiredMode === "PROOF_FINISHER" || slot.mode !== requiredMode || !slot.ready) {
      slot.pendingWork = work;
      this.initializeSlot(this.slots.indexOf(slot), requiredMode);
      return;
    }
    this.startWorkerTask(slot);
  }

  private startWorkerTask(slot: WorkerSlot): void {
    if (!slot.ready || !slot.task || !slot.lease) return;
    slot.worker.postMessage({
      type: "run",
      requestId: this.requestId,
      task: slot.task,
      lease: slot.lease,
      conflictBudget: this.options.conflictBudget ?? 100,
    });
  }

  private async onWorkerMessage(index: number, message: CubeWorkerResponse): Promise<void> {
    if (message.requestId !== this.requestId) return;
    const slot = this.slots[index];
    if (!slot) return;
    if (message.type === "ready") {
      slot.ready = true;
      if (slot.pendingWork) {
        slot.pendingWork = null;
        this.startWorkerTask(slot);
        return;
      }
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
    this.recordTelemetry(slot, slot.runActiveBaseMs + message.activeMs, message.metrics);
    if (message.type === "progress") return;
    if (message.type === "split") {
      if (slot.pendingMutationId) return;
      this.sendMutation(slot, {
        type: "SPLIT",
        slotId: slot.slotId,
        taskId: message.taskId,
        leaseId: message.leaseId,
        permitId: message.permitId,
        splitLiteral: message.splitLiteral,
      });
      return;
    }
    if (message.type === "yield") {
      if (slot.pendingMutationId) return;
      this.sendMutation(slot, {
        type: "YIELD",
        slotId: slot.slotId,
        taskId: message.taskId,
        leaseId: message.leaseId,
        reason: message.reason,
      });
      return;
    }

    const resultLifecycle = this.lifecycle;
    const resultTask = slot.task;
    const resultFormula = this.formula;
    const resultFormulaHash = this.formulaHash;
    if (message.verdict === "SAT") {
      if (!resultFormula) return this.fail("A SAT result arrived without a verified formula.");
      const verification = verifySatModel(resultFormula, message.model);
      const satisfiesCube = resultTask.assumptions.every(
        (assumption) => message.model[Math.abs(assumption) - 1] === assumption,
      );
      if (!verification.valid || !satisfiesCube) {
        return this.fail("A cube worker returned an invalid SAT model.");
      }
    }
    if (!resultFormulaHash) return this.fail("A result arrived without a verified formula hash.");
    const pathHash = await resultPathHash(resultTask.assumptions);
    if (!this.isCurrentResult(slot, resultLifecycle, message.taskId, message.leaseId)) return;
    let manifest: ResultManifest;
    let evidenceSha256: string;
    if (message.verdict === "SAT") {
      const artifact = encodeSatModelArtifact({
        version: 1,
        formulaHash: resultFormulaHash,
        taskId: message.taskId,
        cube: resultTask.assumptions,
        pathHash,
        solverVersion: "cadical-3.0.1",
        variableCount: message.model.length,
      }, message.model);
      evidenceSha256 = await sha256Hex(artifact);
      if (!this.isCurrentResult(slot, resultLifecycle, message.taskId, message.leaseId)) return;
      manifest = {
        kind: "SAT_MODEL_V1",
        version: 1,
        formulaHash: resultFormulaHash,
        taskId: message.taskId,
        cube: [...resultTask.assumptions],
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
      if (!this.isCurrentResult(slot, resultLifecycle, message.taskId, message.leaseId)) return;
      if (!response.ok) return this.fail(`SAT model upload failed with HTTP ${response.status}.`);
    } else if (resultTask.purpose === "PROOF_FINISHER") {
      if (!message.proof || !message.proofBytes ||
        message.proof.byteLength > MAX_UNSAT_PROOF_COMPRESSED_BYTES ||
        message.proofBytes > MAX_UNSAT_PROOF_DECOMPRESSED_BYTES || !resultFormula) {
        return this.fail("A proof-finisher returned missing or oversized LRAT evidence.");
      }
      evidenceSha256 = await sha256Hex(message.proof);
      if (!this.isCurrentResult(slot, resultLifecycle, message.taskId, message.leaseId)) return;
      manifest = {
        kind: "UNSAT_PROOF_V1",
        version: 1,
        formulaHash: resultFormulaHash,
        taskId: message.taskId,
        cube: [...resultTask.assumptions],
        pathHash,
        solverVersion: "cadical-3.0.1",
        artifactId: message.leaseId,
        artifactSha256: evidenceSha256,
        compressedBytes: message.proof.byteLength,
        decompressedBytes: message.proofBytes,
        originalClauseCount: resultFormula.clauseCount,
        cubeClauseIds: resultTask.assumptions.map((_, index) => resultFormula.clauseCount + index + 1),
        checker: "drat-trim-lrat-check",
      };
      const fetcher = this.options.fetcher ?? fetch;
      const response = await fetcher(
        `/api/v1/jobs/${encodeURIComponent(this.options.jobId)}/proofs/${encodeURIComponent(message.leaseId)}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${message.leaseId}`,
            "content-type": "application/vnd.hivesat.lrat+gzip",
            "x-hivesat-content-length": String(message.proof.byteLength),
            "x-hivesat-decompressed-length": String(message.proofBytes),
            "x-hivesat-sha256": evidenceSha256,
          },
          body: message.proof.slice().buffer as ArrayBuffer,
        },
      );
      if (!this.isCurrentResult(slot, resultLifecycle, message.taskId, message.leaseId)) return;
      if (!response.ok) return this.fail(`UNSAT proof upload failed with HTTP ${response.status}.`);
    } else {
      manifest = {
        kind: "UNSAT_CANDIDATE_V1",
        formulaHash: resultFormulaHash,
        taskId: message.taskId,
        cube: [...resultTask.assumptions],
        pathHash,
        solverVersion: "cadical-3.0.1",
      };
      evidenceSha256 = await sha256Hex(new TextEncoder().encode(JSON.stringify(manifest)));
      if (!this.isCurrentResult(slot, resultLifecycle, message.taskId, message.leaseId)) return;
    }
    this.sendMutation(slot, {
      type: "RESULT",
      slotId: slot.slotId,
      taskId: message.taskId,
      leaseId: message.leaseId,
      result: message.verdict,
      evidenceSha256,
      manifest,
    });
    if (message.verdict === "SAT") {
      this.update({
        ...this.snapshot,
        message: "A SAT model is awaiting independent server verification.",
      });
    }
  }

  private initializeSlot(index: number, mode: WorkerSlot["mode"]): void {
    const slot = this.slots[index];
    if (!slot || !this.formula || !this.formulaMetadata) {
      this.fail("A cube worker could not be initialized without a verified formula.");
      return;
    }
    slot.ready = false;
    slot.mode = mode;
    slot.lastMetrics = { conflicts: 0, decisions: 0, propagations: 0 };
    slot.worker.postMessage({
      type: "initialize",
      requestId: this.requestId,
      metadata: this.formulaMetadata,
      mode,
    });
    const batches = createClauseBatches(this.formula.clauses);
    batches.forEach((batch, sequence) => {
      slot.worker.postMessage({
        type: "clause-batch",
        requestId: this.requestId,
        sequence,
        last: sequence === batches.length - 1,
        literals: batch,
      }, [batch.buffer as ArrayBuffer]);
    });
  }

  private createSlots(): void {
    if (!this.formula || !this.formulaMetadata || this.slots.length > 0) return;
    for (let index = 0; index < this.capacity; index += 1) {
      const worker = (this.options.workerFactory ?? defaultWorkerFactory)(index);
      const slot: WorkerSlot = {
        slotId: `slot-${index + 1}`,
        worker,
        ready: false,
        mode: "SEARCH",
        task: null,
        lease: null,
        pendingWork: null,
        pendingMutationId: null,
        runActiveBaseMs: 0,
        lastActiveMs: 0,
        lastMetrics: { conflicts: 0, decisions: 0, propagations: 0 },
        memoryBytes: 0,
        memoryHighWaterBytes: 0,
      };
      worker.onmessage = (event) => void this.onWorkerMessage(index, event.data);
      worker.onerror = (event) => this.fail(event.message || "A cube worker failed.");
      this.slots.push(slot);
      this.initializeSlot(index, "SEARCH");
    }
  }

  private sendMutation(slot: WorkerSlot, mutation: RuntimeMutation): void {
    if (slot.pendingMutationId) return;
    const messageId = crypto.randomUUID();
    const outgoing = {
      ...mutation,
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId,
      jobId: this.options.jobId,
    } as Exclude<CoordinatorClientMessage, { type: "HELLO" }>;
    const pending: PendingMutation = {
      message: outgoing,
      slotId: slot.slotId,
      leaseId: mutation.leaseId,
      action: mutation.type,
    };
    slot.pendingMutationId = messageId;
    this.outbox.set(messageId, pending);
    this.socket?.send(outgoing);
  }

  private flushOutbox(): void {
    for (const pending of this.outbox.values()) this.socket?.send(pending.message);
  }

  private acknowledgeMutation(message: AckMessage): void {
    const pending = this.outbox.get(message.requestMessageId);
    if (!pending || pending.action !== message.action) return;
    const slot = this.slots.find((candidate) => candidate.slotId === pending.slotId);
    this.outbox.delete(message.requestMessageId);
    if (!slot) return;
    if (slot.pendingMutationId === message.requestMessageId) slot.pendingMutationId = null;
    const counters = message.action === "SPLIT"
      ? { splitTasks: this.snapshot.splitTasks + 1 }
      : message.action === "YIELD"
        ? { yieldedTasks: this.snapshot.yieldedTasks + 1 }
        : { completedTasks: this.snapshot.completedTasks + 1 };
    this.release(slot);
    this.update({ ...this.snapshot, ...counters });
  }

  private handleMutationError(
    requestMessageId: string | undefined,
    code: string,
    retryable: boolean,
  ): void {
    if (!requestMessageId) {
      if (!retryable) this.fail(`Coordinator error: ${code}.`);
      return;
    }
    const pending = this.outbox.get(requestMessageId);
    if (!pending) {
      if (!retryable) this.fail(`Coordinator error: ${code}.`);
      return;
    }
    const slot = this.slots.find((candidate) => candidate.slotId === pending.slotId);
    this.outbox.delete(requestMessageId);
    if (!slot) return;
    if (slot.pendingMutationId === requestMessageId) slot.pendingMutationId = null;
    if (pending.action === "SPLIT" && (code === "SPLIT_NOT_NEEDED" || code === "TASK_LIMIT")) {
      slot.runActiveBaseMs = slot.lastActiveMs;
      this.startWorkerTask(slot);
      return;
    }
    this.release(slot);
    if (!retryable && code !== "STALE_LEASE" && code !== "INVALID_STATE") {
      this.fail(`Coordinator rejected ${pending.action.toLowerCase()}: ${code}.`);
    }
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    const interval = Math.max(COORDINATOR_HEARTBEAT_INTERVAL_MS, intervalMs);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), interval);
  }

  private sendHeartbeat(): void {
    this.socket?.send({
      type: "SESSION_HEARTBEAT",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: crypto.randomUUID(),
      jobId: this.options.jobId,
      slots: this.slots.map((slot) => ({
        slotId: slot.slotId,
        leaseId: slot.lease?.leaseId ?? null,
        activeMs: Math.round(slot.lastActiveMs),
        conflicts: Math.round(slot.lastMetrics.conflicts),
        decisions: Math.round(slot.lastMetrics.decisions),
        propagations: Math.round(slot.lastMetrics.propagations),
      })),
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private release(slot: WorkerSlot): void {
    slot.task = null;
    slot.lease = null;
    slot.pendingWork = null;
    this.refreshActiveWorkers();
  }

  private clearPendingMutation(slot: WorkerSlot): void {
    if (slot.pendingMutationId) this.outbox.delete(slot.pendingMutationId);
    slot.pendingMutationId = null;
  }

  private stopAndRelease(slot: WorkerSlot): void {
    if (slot.task) {
      slot.worker.postMessage({ type: "stop", requestId: this.requestId, reason: "SHUTDOWN" });
    }
    this.release(slot);
  }

  private replaceSlotWork(slot: WorkerSlot, work: WorkMessage): void {
    this.clearPendingMutation(slot);
    if (slot.task) {
      slot.worker.postMessage({ type: "stop", requestId: this.requestId, reason: "SHUTDOWN" });
    }
    slot.task = null;
    slot.lease = null;
    slot.pendingWork = null;
    this.runTask(slot, work);
  }

  private isCurrentResult(slot: WorkerSlot, lifecycle: number, taskId: string, leaseId: string): boolean {
    return this.lifecycle === lifecycle && this.slots.includes(slot) &&
      slot.task?.taskId === taskId && slot.lease?.leaseId === leaseId;
  }

  private refreshActiveWorkers(): void {
    this.update({
      ...this.snapshot,
      activeWorkers: this.slots.filter((slot) => slot.task !== null).length,
      currentTaskId: this.slots.find((slot) => slot.task)?.task?.taskId ?? null,
    });
  }

  private recordTelemetry(
    slot: WorkerSlot,
    activeMs: number,
    metrics: { conflicts: number; decisions: number; propagations: number; memoryBytes?: number; memoryHighWaterBytes?: number },
  ): void {
    const activeDelta = Math.max(0, activeMs - slot.lastActiveMs);
    const conflicts = Math.max(0, metrics.conflicts - slot.lastMetrics.conflicts);
    const decisions = Math.max(0, metrics.decisions - slot.lastMetrics.decisions);
    const propagations = Math.max(0, metrics.propagations - slot.lastMetrics.propagations);
    slot.lastActiveMs = Math.max(slot.lastActiveMs, activeMs);
    slot.lastMetrics = {
      conflicts: Math.max(slot.lastMetrics.conflicts, metrics.conflicts),
      decisions: Math.max(slot.lastMetrics.decisions, metrics.decisions),
      propagations: Math.max(slot.lastMetrics.propagations, metrics.propagations),
    };
    slot.memoryBytes = Math.max(0, metrics.memoryBytes ?? slot.memoryBytes);
    slot.memoryHighWaterBytes = Math.max(
      slot.memoryHighWaterBytes,
      metrics.memoryHighWaterBytes ?? slot.memoryHighWaterBytes,
    );
    const currentMemory = this.slots.reduce((total, candidate) => total + candidate.memoryBytes, 0);
    const highWater = this.slots.reduce((total, candidate) => total + candidate.memoryHighWaterBytes, 0);
    this.update({
      ...this.snapshot,
      activeComputeMs: this.snapshot.activeComputeMs + activeDelta,
      conflicts: this.snapshot.conflicts + conflicts,
      decisions: this.snapshot.decisions + decisions,
      propagations: this.snapshot.propagations + propagations,
      wasmMemoryBytes: currentMemory,
      wasmMemoryHighWaterBytes: Math.max(this.snapshot.wasmMemoryHighWaterBytes, highWater),
    });
  }

  private fail(message: string): void {
    this.dispose();
    this.update({
      ...this.snapshot,
      phase: "error",
      activeWorkers: 0,
      currentTaskId: null,
      wasmMemoryBytes: 0,
      message,
    });
  }

  private dispose(): void {
    this.lifecycle += 1;
    this.socket?.stop();
    this.socket = null;
    this.stopHeartbeat();
    for (const slot of this.slots) {
      slot.worker.postMessage({ type: "stop", requestId: this.requestId, reason: "SHUTDOWN" });
      slot.worker.terminate();
    }
    this.slots = [];
    this.outbox.clear();
    this.formula = null;
    this.formulaHash = null;
    this.formulaMetadata = null;
  }

  private update(snapshot: CubeRuntimeSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
