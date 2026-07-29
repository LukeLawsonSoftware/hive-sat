import type {
  CubeWorkerRequest,
  CubeWorkerResponse,
} from "../lib/distributed/cubeWorkerProtocol";
import type { SolverMetrics } from "../lib/formula/workerProtocol";
import {
  MAX_UNSAT_PROOF_COMPRESSED_BYTES,
  MAX_UNSAT_PROOF_DECOMPRESSED_BYTES,
} from "../../shared/result-manifest";

const UNKNOWN = 0;
const SAT = 10;
const UNSAT = 20;

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
let formulaBatches: Int32Array[] = [];

function send(message: CubeWorkerResponse): void {
  globalThis.postMessage(message);
}

async function loadModule(): Promise<CaDiCaLModule> {
  const moduleUrl = new URL(["solver", "hivesat.mjs"].join("/"), `${globalThis.location.origin}/`).href;
  modulePromise ??= import(/* @vite-ignore */ moduleUrl) as Promise<CaDiCaLModule>;
  return modulePromise;
}

async function readMetrics(): Promise<SolverMetrics> {
  if (!solver) return { conflicts: 0, decisions: 0, propagations: 0 };
  const runtimeModule = await loadModule();
  return {
    conflicts: solver.metric(runtimeModule.SolverMetric.CONFLICTS),
    decisions: solver.metric(runtimeModule.SolverMetric.DECISIONS),
    propagations: solver.metric(runtimeModule.SolverMetric.PROPAGATIONS),
    memoryBytes: solver.metric(runtimeModule.SolverMetric.MEMORY_BYTES),
    memoryHighWaterBytes: solver.metric(runtimeModule.SolverMetric.MEMORY_HIGH_WATER_BYTES),
  };
}

async function initialize(message: Extract<CubeWorkerRequest, { type: "initialize" }>): Promise<void> {
  solver?.dispose();
  const runtime = await (await loadModule()).loadCaDiCaL();
  solver = runtime.createSolver();
  requestId = message.requestId;
  variableCount = message.metadata.variableCount;
  stopped = null;
  formulaBatches = [];
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
  startedAt: number,
): Promise<void> {
  const runtime = await (await loadModule()).loadCaDiCaL();
  const proofSolver = runtime.createSolver();
  try {
    proofSolver.enableLrat("/proof.lrat");
    for (const batch of formulaBatches) proofSolver.addClauses(batch);
    for (const literal of message.task.assumptions) {
      proofSolver.addClauses(Int32Array.of(literal, 0));
    }
    for (let slices = 1; slices <= message.maxSlices; slices += 1) {
      if (stopped) {
        send({
          type: "yield",
          requestId: message.requestId,
          taskId: message.task.taskId,
          leaseId: message.lease.leaseId,
          reason: stopped,
          activeMs: Math.max(0, performance.now() - startedAt),
          metrics: await readMetrics(),
        });
        return;
      }
      const status = proofSolver.solve(message.conflictBudget);
      if (status === SAT) {
        const model = proofSolver.model(1, variableCount)
          .map((literal, index) => literal === 0 ? -(index + 1) : literal);
        send({
          type: "result",
          requestId: message.requestId,
          taskId: message.task.taskId,
          leaseId: message.lease.leaseId,
          verdict: "SAT",
          model,
          activeMs: Math.max(0, performance.now() - startedAt),
          metrics: await readMetrics(),
        });
        return;
      }
      if (status === UNSAT) {
        const text = proofSolver.closeLrat("/proof.lrat");
        const proof = await gzipText(text);
        send({
          type: "result",
          requestId: message.requestId,
          taskId: message.task.taskId,
          leaseId: message.lease.leaseId,
          verdict: "UNSAT",
          proof,
          proofBytes: new TextEncoder().encode(text).byteLength,
          activeMs: Math.max(0, performance.now() - startedAt),
          metrics: await readMetrics(),
        });
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    send({
      type: "yield",
      requestId: message.requestId,
      taskId: message.task.taskId,
      leaseId: message.lease.leaseId,
      reason: "BUDGET",
      activeMs: Math.max(0, performance.now() - startedAt),
      metrics: await readMetrics(),
    });
  } catch (error) {
    send({
      type: "yield",
      requestId: message.requestId,
      taskId: message.task.taskId,
      leaseId: message.lease.leaseId,
      reason: "UNSUPPORTED",
      activeMs: Math.max(0, performance.now() - startedAt),
      metrics: await readMetrics(),
    });
    console.error(error);
  } finally {
    proofSolver.dispose();
  }
}

async function runCube(message: Extract<CubeWorkerRequest, { type: "run" }>): Promise<void> {
  if (!solver || requestId !== message.requestId) return;
  stopped = null;
  const startedAt = performance.now();
  if (message.task.purpose === "PROOF_FINISHER") {
    await runProofFinisher(message, startedAt);
    return;
  }
  for (let slices = 1; slices <= message.maxSlices; slices += 1) {
    if (stopped) {
      send({
        type: "yield",
        requestId: message.requestId,
        taskId: message.task.taskId,
        leaseId: message.lease.leaseId,
        reason: stopped,
        activeMs: Math.max(0, performance.now() - startedAt),
        metrics: await readMetrics(),
      });
      return;
    }
    solver.assume(message.task.assumptions);
    const status = solver.solve(message.conflictBudget);
    if (status === SAT) {
      const model = solver.model(1, variableCount)
        .map((literal, index) => literal === 0 ? -(index + 1) : literal);
      send({
        type: "result",
        requestId: message.requestId,
        taskId: message.task.taskId,
        leaseId: message.lease.leaseId,
        verdict: "SAT",
        model,
        activeMs: Math.max(0, performance.now() - startedAt),
        metrics: await readMetrics(),
      });
      return;
    }
    if (status === UNSAT) {
      send({
        type: "result",
        requestId: message.requestId,
        taskId: message.task.taskId,
        leaseId: message.lease.leaseId,
        verdict: "UNSAT",
        activeMs: Math.max(0, performance.now() - startedAt),
        metrics: await readMetrics(),
      });
      return;
    }
    if (status !== UNKNOWN) throw new Error(`CaDiCaL returned unexpected status ${status}.`);
    if (slices === 1 || slices % 8 === 0) {
      send({
        type: "progress",
        requestId: message.requestId,
        taskId: message.task.taskId,
        leaseId: message.lease.leaseId,
        activeMs: Math.max(0, performance.now() - startedAt),
        metrics: await readMetrics(),
        slices,
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  if (message.allowSplit) {
    solver.assume(message.task.assumptions);
    const splitLiteral = solver.lookahead();
    const alreadyAssigned = message.task.assumptions.some(
      (literal) => Math.abs(literal) === Math.abs(splitLiteral),
    );
    if (splitLiteral !== 0 && !alreadyAssigned) {
      send({
        type: "split",
        requestId: message.requestId,
        taskId: message.task.taskId,
        leaseId: message.lease.leaseId,
        splitLiteral,
        activeMs: Math.max(0, performance.now() - startedAt),
        metrics: await readMetrics(),
      });
      return;
    }
  }

  send({
    type: "yield",
    requestId: message.requestId,
    taskId: message.task.taskId,
    leaseId: message.lease.leaseId,
    reason: "BUDGET",
    activeMs: Math.max(0, performance.now() - startedAt),
    metrics: await readMetrics(),
  });
}

async function handle(message: CubeWorkerRequest): Promise<void> {
  if (message.type === "initialize") return initialize(message);
  if (message.requestId !== requestId) return;
  if (message.type === "clause-batch") {
    if (!solver) throw new Error("Cube solver is not initialized.");
    solver.addClauses(message.literals);
    formulaBatches.push(message.literals.slice());
    if (message.last) send({ type: "ready", requestId: message.requestId });
    return;
  }
  if (message.type === "stop") {
    stopped = message.reason;
    return;
  }
  return runCube(message);
}

globalThis.addEventListener("message", (event: MessageEvent<CubeWorkerRequest>) => {
  if (event.data.type === "stop") {
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
