import type {
  SolverMetrics,
  SolverWorkerRequest,
  SolverWorkerResponse,
} from "../lib/formula/workerProtocol";
import { MAX_VARIABLES } from "../lib/formula/limits";

const CONFLICT_BUDGET = 100;
const COMPUTE_BATCH_MS = 16;
const PROGRESS_INTERVAL_MS = 1_000;
const UNKNOWN = 0;
const SAT = 10;
const UNSAT = 20;

interface CaDiCaLSolver {
  addClauses(literals: Int32Array): void;
  solve(conflictBudget: number): number;
  interrupt(): void;
  clearInterrupt(): void;
  model(firstVariable: number, count: number): number[];
  metric(metric: number): number;
  dispose(): void;
}

interface CaDiCaLRuntime {
  createSolver(): CaDiCaLSolver;
}

interface CaDiCaLModule {
  loadCaDiCaL(): Promise<CaDiCaLRuntime>;
  SolverMetric: {
    CONFLICTS: number;
    DECISIONS: number;
    PROPAGATIONS: number;
  };
}

let modulePromise: Promise<CaDiCaLModule> | null = null;
let solver: CaDiCaLSolver | null = null;
let requestId: string | null = null;
let variableCount = 0;
let paused = true;
let solving = false;
let slices = 0;

function send(message: SolverWorkerResponse): void {
  globalThis.postMessage(message);
}

async function loadModule(): Promise<CaDiCaLModule> {
  // Build the public URL at runtime. A literal `/solver/...` dynamic import is
  // intercepted by Vite's dev transform and rejected because public assets are
  // intentionally served as-is rather than treated as source modules.
  const modulePath = ["solver", "hivesat.mjs"].join("/");
  const moduleUrl = new URL(modulePath, `${globalThis.location.origin}/`).href;
  modulePromise ??= import(/* @vite-ignore */ moduleUrl) as Promise<CaDiCaLModule>;
  return modulePromise;
}

async function initialize(message: Extract<SolverWorkerRequest, { type: "initialize" }>): Promise<void> {
  if (
    !Number.isSafeInteger(message.metadata.variableCount) ||
    message.metadata.variableCount < 0 ||
    message.metadata.variableCount > MAX_VARIABLES
  ) {
    throw new Error(`Solver variable count exceeds the supported ${MAX_VARIABLES.toLocaleString("en-US")} limit.`);
  }
  solver?.dispose();
  const runtimeModule = await loadModule();
  const runtime = await runtimeModule.loadCaDiCaL();
  solver = runtime.createSolver();
  requestId = message.requestId;
  variableCount = message.metadata.variableCount;
  paused = true;
  solving = false;
  slices = 0;
  if (message.metadata.clauseCount === 0) send({ type: "ready", requestId: message.requestId });
}

async function metrics(): Promise<SolverMetrics> {
  if (!solver) return { conflicts: 0, decisions: 0, propagations: 0 };
  const runtimeModule = await loadModule();
  return {
    conflicts: solver.metric(runtimeModule.SolverMetric.CONFLICTS),
    decisions: solver.metric(runtimeModule.SolverMetric.DECISIONS),
    propagations: solver.metric(runtimeModule.SolverMetric.PROPAGATIONS),
  };
}

async function solveInSlices(expectedRequestId: string): Promise<void> {
  if (!solver || expectedRequestId !== requestId) return;
  paused = false;
  if (solving) return;
  solving = true;
  solver.clearInterrupt();
  let batchStartedAt = performance.now();
  let lastProgressAt = batchStartedAt;
  try {
    while (!paused && solver && requestId === expectedRequestId) {
      const status = solver.solve(CONFLICT_BUDGET);
      slices += 1;
      if (status === SAT) {
        const model = solver
          .model(1, variableCount)
          .map((literal, index) => literal === 0 ? -(index + 1) : literal);
        send({ type: "result", requestId: expectedRequestId, verdict: "SAT", model, metrics: await metrics(), slices });
        paused = true;
        return;
      }
      if (status === UNSAT) {
        send({ type: "result", requestId: expectedRequestId, verdict: "UNSAT", metrics: await metrics(), slices });
        paused = true;
        return;
      }
      if (status !== UNKNOWN) throw new Error(`CaDiCaL returned unexpected status ${status}.`);
      const now = performance.now();
      if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        send({ type: "progress", requestId: expectedRequestId, metrics: await metrics(), slices });
        lastProgressAt = now;
      }
      if (now - batchStartedAt >= COMPUTE_BATCH_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        batchStartedAt = performance.now();
      }
    }
    if (requestId === expectedRequestId) {
      send({ type: "paused", requestId: expectedRequestId, metrics: await metrics(), slices });
    }
  } finally {
    solving = false;
  }
}

async function handle(message: SolverWorkerRequest): Promise<void> {
  if (message.type === "initialize") {
    await initialize(message);
    return;
  }
  if (message.requestId !== requestId) return;
  if (message.type === "clause-batch") {
    if (!solver) throw new Error("Solver is not initialized.");
    solver.addClauses(message.literals);
    if (message.last) send({ type: "ready", requestId: message.requestId });
    return;
  }
  if (message.type === "solve") {
    void solveInSlices(message.requestId);
    return;
  }
  if (message.type === "pause") {
    paused = true;
    return;
  }
  paused = true;
  solver?.dispose();
  solver = null;
  requestId = null;
}

let operation = Promise.resolve();
globalThis.addEventListener("message", (event: MessageEvent<SolverWorkerRequest>) => {
  // Initialization and clause loading are serialized so transferred batches
  // reach CaDiCaL in exactly the parsed clause order.
  if (event.data.type === "solve" || event.data.type === "pause") {
    void handle(event.data).catch((error) => {
      send({
        type: "error",
        requestId: event.data.requestId,
        message: error instanceof Error ? error.message : "Solver worker failed.",
      });
    });
    return;
  }
  operation = operation.then(() => handle(event.data)).catch((error) => {
    send({
      type: "error",
      requestId: event.data.requestId,
      message: error instanceof Error ? error.message : "Solver worker failed.",
    });
  });
});
