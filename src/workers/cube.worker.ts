import type {
  CubeWorkerRequest,
  CubeWorkerResponse,
} from "../lib/distributed/cubeWorkerProtocol";
import type { SolverMetrics } from "../lib/formula/workerProtocol";

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
  dispose(): void;
}

interface CaDiCaLModule {
  loadCaDiCaL(): Promise<{ createSolver(): CaDiCaLSolver }>;
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
let stopped: "PAUSED" | "SHUTDOWN" | null = null;
let operation = Promise.resolve();

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
  };
}

async function initialize(message: Extract<CubeWorkerRequest, { type: "initialize" }>): Promise<void> {
  solver?.dispose();
  const runtime = await (await loadModule()).loadCaDiCaL();
  solver = runtime.createSolver();
  requestId = message.requestId;
  variableCount = message.metadata.variableCount;
  stopped = null;
  if (message.metadata.clauseCount === 0) send({ type: "ready", requestId });
}

async function runCube(message: Extract<CubeWorkerRequest, { type: "run" }>): Promise<void> {
  if (!solver || requestId !== message.requestId) return;
  stopped = null;
  const startedAt = performance.now();
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
