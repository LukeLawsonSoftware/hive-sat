export const CUBE_COMPUTE_BATCH_MS = 16;
export const CUBE_PROGRESS_INTERVAL_MS = 1_000;
export const CUBE_MIN_SPLIT_COMPUTE_MS = 1_000;

const UNKNOWN = 0;
const SAT = 10;
const UNSAT = 20;

export interface CubeSearchSolver {
  assume(literals: readonly number[]): void;
  solve(conflictBudget: number): number;
  lookahead(): number;
}

export type CubeSearchStopReason = "PAUSED" | "SHUTDOWN";

export type CubeSearchLoopResult =
  | { kind: "SAT"; activeMs: number; slices: number }
  | { kind: "UNSAT"; activeMs: number; slices: number }
  | { kind: "SPLIT"; splitLiteral: number; activeMs: number; slices: number }
  | { kind: "STOPPED"; reason: CubeSearchStopReason; activeMs: number; slices: number };

export interface CubeSearchLoopOptions {
  solver: CubeSearchSolver;
  assumptions: readonly number[];
  conflictBudget: number;
  stopped: () => CubeSearchStopReason | null;
  splitRequested: () => boolean;
  clearSplitRequest: () => void;
  onProgress?: (progress: { activeMs: number; slices: number }) => void | Promise<void>;
  now?: () => number;
  yieldControl?: () => Promise<void>;
  computeBatchMs?: number;
  progressIntervalMs?: number;
  minSplitComputeMs?: number;
}

function defaultYieldControl(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Keeps a cube in the same incremental solver until it is decided, explicitly
 * selected for splitting, or stopped. Local conflict slices are only a browser
 * responsiveness boundary; exhausting a slice never yields network ownership.
 */
export async function runCubeSearchLoop(options: CubeSearchLoopOptions): Promise<CubeSearchLoopResult> {
  const now = options.now ?? performance.now.bind(performance);
  const yieldControl = options.yieldControl ?? defaultYieldControl;
  const computeBatchMs = options.computeBatchMs ?? CUBE_COMPUTE_BATCH_MS;
  const progressIntervalMs = options.progressIntervalMs ?? CUBE_PROGRESS_INTERVAL_MS;
  const minSplitComputeMs = options.minSplitComputeMs ?? CUBE_MIN_SPLIT_COMPUTE_MS;
  let activeMs = 0;
  let slices = 0;
  let batchStartedAt = now();
  let lastProgressAt = batchStartedAt;

  for (;;) {
    const stopReason = options.stopped();
    if (stopReason) return { kind: "STOPPED", reason: stopReason, activeMs, slices };

    options.solver.assume(options.assumptions);
    const solveStartedAt = now();
    const status = options.solver.solve(options.conflictBudget);
    const solvedAt = now();
    activeMs += Math.max(0, solvedAt - solveStartedAt);
    slices += 1;

    if (status === SAT) return { kind: "SAT", activeMs, slices };
    if (status === UNSAT) return { kind: "UNSAT", activeMs, slices };
    if (status !== UNKNOWN) throw new Error(`CaDiCaL returned unexpected status ${status}.`);

    if (options.splitRequested() && activeMs >= minSplitComputeMs) {
      options.clearSplitRequest();
      options.solver.assume(options.assumptions);
      const lookaheadStartedAt = now();
      const splitLiteral = options.solver.lookahead();
      activeMs += Math.max(0, now() - lookaheadStartedAt);
      const alreadyAssigned = options.assumptions.some(
        (literal) => Math.abs(literal) === Math.abs(splitLiteral),
      );
      if (splitLiteral !== 0 && !alreadyAssigned) {
        return { kind: "SPLIT", splitLiteral, activeMs, slices };
      }
    }

    if (solvedAt - lastProgressAt >= progressIntervalMs) {
      await options.onProgress?.({ activeMs, slices });
      lastProgressAt = solvedAt;
    }

    if (solvedAt - batchStartedAt >= computeBatchMs) {
      await yieldControl();
      batchStartedAt = now();
    }
  }
}
