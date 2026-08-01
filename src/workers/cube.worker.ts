import { runCubeSearchLoop } from "../lib/distributed/cubeSearchLoop";
import type {
  CubeWorkerMode,
  CubeWorkerRequest,
  CubeWorkerResponse,
} from "../lib/distributed/cubeWorkerProtocol";
import { MAX_VARIABLES } from "../lib/formula/limits";
import type { SolverMetrics } from "../lib/formula/workerProtocol";
import {
  MAX_UNSAT_PROOF_COMPRESSED_BYTES,
  MAX_UNSAT_PROOF_DECOMPRESSED_BYTES,
} from "../../shared/result-manifest";

interface CaDiCaLSolver {
  addClauses(literals: Int32Array): void;
  assume(literals: readonly number[]): void;
  solve(conflictBudget: number): number;
  lookahead(): number;
  model(firstVariable: number, count: number): number[];
  metric(metric: number): number;
  enableLrat(path?: string): void;
  closeLrat(path?: string): string;
  dispose(): void;
}

interface CaDiCaLModule {
  loadCaDiCaL(): Promise<{ createSolver(): CaDiCaLSolver }>;
  SolverMetric: {
    CONFLICTS: number;
    DECISIONS: number;
    PROPAGATIONS: number;
    MEMORY_BYTES: number;
    MEMORY_HIGH_WATER_BYTES: number;
  };
}

let modulePromise: Promise<CaDiCaLModule> | null = null;
let solver: CaDiCaLSolver | null = null;
let requestId: string | null = null;
let variableCount = 0;
let stopped: "PAUSED" | "SHUTDOWN" | null = null;
let operation = Promise.resolve();
let mode: CubeWorkerMode = "SEARCH";
let activeTaskId: string | null = null;
let activeLeaseId: string | null = null;
let splitPermitId: string | null = null;
let proofTaskId: string | null = null;

function send(message: CubeWorkerResponse): void {
  globalThis.postMessage(message);
}

async function loadModule(): Promise<CaDiCaLModule> {
  const moduleUrl = new URL(["solver", "hivesat.mjs"].join("/"), `${globalThis.location.origin}/`).href;
  modulePromise ??= import(/* @vite-ignore */ moduleUrl) as Promise<CaDiCaLModule>;
  return modulePromise;
}

async function readMetrics(target: CaDiCaLSolver | null = solver): Promise<SolverMetrics> {
  if (!target) return { conflicts: 0, decisions: 0, propagations: 0 };
  const runtimeModule = await loadModule();
  return {
    conflicts: target.metric(runtimeModule.SolverMetric.CONFLICTS),
    decisions: target.metric(runtimeModule.SolverMetric.DECISIONS),
    propagations: target.metric(runtimeModule.SolverMetric.PROPAGATIONS),
    memoryBytes: target.metric(runtimeModule.SolverMetric.MEMORY_BYTES),
    memoryHighWaterBytes: target.metric(runtimeModule.SolverMetric.MEMORY_HIGH_WATER_BYTES),
  };
}

async function initialize(message: Extract<CubeWorkerRequest, { type: "initialize" }>): Promise<void> {
  if (
    !Number.isSafeInteger(message.metadata.variableCount) ||
    message.metadata.variableCount < 0 ||
    message.metadata.variableCount > MAX_VARIABLES
  ) {
    throw new Error(`Cube solver variable count exceeds the supported ${MAX_VARIABLES.toLocaleString("en-US")} limit.`);
  }

  solver?.dispose();
  const runtime = await (await loadModule()).loadCaDiCaL();
  solver = runtime.createSolver();
  mode = message.mode ?? "SEARCH";
  if (mode === "PROOF_FINISHER") solver.enableLrat("/proof.lrat");
  requestId = message.requestId;
  variableCount = message.metadata.variableCount;
  stopped = null;
  activeTaskId = null;
  activeLeaseId = null;
  splitPermitId = null;
  proofTaskId = null;
  if (message.metadata.clauseCount === 0) send({ type: "ready", requestId });
}

async function gzipText(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_UNSAT_PROOF_DECOMPRESSED_BYTES) {
    throw new Error("The LRAT proof exceeds the decompressed job limit.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  if (compressed.byteLength > MAX_UNSAT_PROOF_COMPRESSED_BYTES) {
    throw new Error("The LRAT proof exceeds the compressed job limit.");
  }
  return compressed;
}

async function runProofFinisher(
  message: Extract<CubeWorkerRequest, { type: "run" }>,
): Promise<void> {
  if (!solver || mode !== "PROOF_FINISHER") {
    send({
      type: "yield",
      requestId: message.requestId,
      taskId: message.task.taskId,
      leaseId: message.lease.leaseId,
      reason: "UNSUPPORTED",
      activeMs: 0,
      metrics: await readMetrics(),
    });
    return;
  }

  try {
    if (proofTaskId && proofTaskId !== message.task.taskId) {
      throw new Error("A proof worker must be reinitialized before it can accept another proof task.");
    }
    if (!proofTaskId) {
      for (const literal of message.task.assumptions) {
        solver.addClauses(Int32Array.of(literal, 0));
      }
      proofTaskId = message.task.taskId;
    }

    const outcome = await runCubeSearchLoop({
      solver,
      assumptions: [],
      conflictBudget: message.conflictBudget,
      stopped: () => stopped,
      splitRequested: () => false,
      clearSplitRequest: () => undefined,
      onProgress: async ({ activeMs, slices }) => {
        send({
          type: "progress",
          requestId: message.requestId,
          taskId: message.task.taskId,
          leaseId: message.lease.leaseId,
          activeMs,
          metrics: await readMetrics(),
          slices,
        });
      },
    });

    if (outcome.kind === "STOPPED") {
      send({
        type: "yield",
        requestId: message.requestId,
        taskId: message.task.taskId,
        leaseId: message.lease.leaseId,
        reason: outcome.reason,
        activeMs: outcome.activeMs,
        metrics: await readMetrics(),
      });
      return;
    }
    if (outcome.kind === "SAT") {
      const model = solver.model(1, variableCount)
        .map((literal, index) => literal === 0 ? -(index + 1) : literal);
      send({
        type: "result",
        requestId: message.requestId,
        taskId: message.task.taskId,
        leaseId: message.lease.leaseId,
        verdict: "SAT",
        model,
        activeMs: outcome.activeMs,
        metrics: await readMetrics(),
      });
      return;
    }
    if (outcome.kind === "SPLIT") throw new Error("A proof worker unexpectedly attempted to split.");

    const text = solver.closeLrat("/proof.lrat");
    const proof = await gzipText(text);
    send({
      type: "result",
      requestId: message.requestId,
      taskId: message.task.taskId,
      leaseId: message.lease.leaseId,
      verdict: "UNSAT",
      proof,
      proofBytes: new TextEncoder().encode(text).byteLength,
      activeMs: outcome.activeMs,
      metrics: await readMetrics(),
    });
  } catch (error) {
    send({
      type: "yield",
      requestId: message.requestId,
      taskId: message.task.taskId,
      leaseId: message.lease.leaseId,
      reason: "UNSUPPORTED",
      activeMs: 0,
      metrics: await readMetrics(),
    });
    console.error(error);
  }
}

async function runSearch(message: Extract<CubeWorkerRequest, { type: "run" }>): Promise<void> {
  if (!solver || mode !== "SEARCH") {
    send({
      type: "yield",
      requestId: message.requestId,
      taskId: message.task.taskId,
      leaseId: message.lease.leaseId,
      reason: "UNSUPPORTED",
      activeMs: 0,
      metrics: await readMetrics(),
    });
    return;
  }

  let consumedSplitPermitId: string | null = null;
  const outcome = await runCubeSearchLoop({
    solver,
    assumptions: message.task.assumptions,
    conflictBudget: message.conflictBudget,
    stopped: () => stopped,
    splitRequested: () => splitPermitId !== null,
    clearSplitRequest: () => {
      consumedSplitPermitId = splitPermitId;
      splitPermitId = null;
    },
    onProgress: async ({ activeMs, slices }) => {
      send({
        type: "progress",
        requestId: message.requestId,
        taskId: message.task.taskId,
        leaseId: message.lease.leaseId,
        activeMs,
        metrics: await readMetrics(),
        slices,
      });
    },
  });

  if (outcome.kind === "STOPPED") {
    send({
      type: "yield",
      requestId: message.requestId,
      taskId: message.task.taskId,
      leaseId: message.lease.leaseId,
      reason: outcome.reason,
      activeMs: outcome.activeMs,
      metrics: await readMetrics(),
    });
    return;
  }
  if (outcome.kind === "SPLIT") {
    if (!consumedSplitPermitId) throw new Error("A split result is missing its coordinator permit.");
    send({
      type: "split",
      requestId: message.requestId,
      taskId: message.task.taskId,
      leaseId: message.lease.leaseId,
      permitId: consumedSplitPermitId,
      splitLiteral: outcome.splitLiteral,
      activeMs: outcome.activeMs,
      metrics: await readMetrics(),
    });
    return;
  }
  if (outcome.kind === "SAT") {
    const model = solver.model(1, variableCount)
      .map((literal, index) => literal === 0 ? -(index + 1) : literal);
    send({
      type: "result",
      requestId: message.requestId,
      taskId: message.task.taskId,
      leaseId: message.lease.leaseId,
      verdict: "SAT",
      model,
      activeMs: outcome.activeMs,
      metrics: await readMetrics(),
    });
    return;
  }
  send({
    type: "result",
    requestId: message.requestId,
    taskId: message.task.taskId,
    leaseId: message.lease.leaseId,
    verdict: "UNSAT",
    activeMs: outcome.activeMs,
    metrics: await readMetrics(),
  });
}

async function runCube(message: Extract<CubeWorkerRequest, { type: "run" }>): Promise<void> {
  if (!solver || requestId !== message.requestId) return;
  stopped = null;
  activeTaskId = message.task.taskId;
  activeLeaseId = message.lease.leaseId;
  splitPermitId = null;
  try {
    if (message.task.purpose === "PROOF_FINISHER") await runProofFinisher(message);
    else await runSearch(message);
  } finally {
    if (activeTaskId === message.task.taskId && activeLeaseId === message.lease.leaseId) {
      activeTaskId = null;
      activeLeaseId = null;
      splitPermitId = null;
    }
  }
}

async function handle(message: CubeWorkerRequest): Promise<void> {
  if (message.type === "initialize") return initialize(message);
  if (message.requestId !== requestId) return;
  if (message.type === "clause-batch") {
    if (!solver) throw new Error("Cube solver is not initialized.");
    solver.addClauses(message.literals);
    if (message.last) send({ type: "ready", requestId: message.requestId });
    return;
  }
  if (message.type === "stop") {
    stopped = message.reason;
    return;
  }
  if (message.type === "grant-split") {
    if (
      mode === "SEARCH" &&
      message.taskId === activeTaskId &&
      message.leaseId === activeLeaseId
    ) splitPermitId = message.permitId;
    return;
  }
  return runCube(message);
}

globalThis.addEventListener("message", (event: MessageEvent<CubeWorkerRequest>) => {
  // Control messages must be observed while a long-lived run owns the serialized
  // operation chain. The search loop yields browser control at most every 16 ms.
  if (event.data.type === "stop" || event.data.type === "grant-split") {
    void handle(event.data);
    return;
  }
  operation = operation.then(() => handle(event.data)).catch((error) => {
    send({
      type: "error",
      requestId: event.data.requestId,
      message: error instanceof Error ? error.message : "Cube worker failed.",
    });
  });
});
