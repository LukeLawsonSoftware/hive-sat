import { describe, expect, it, vi } from "vitest";
import { runCubeSearchLoop, type CubeSearchSolver } from "./cubeSearchLoop";

function solverFixture(solve: () => number, lookahead = () => 0): CubeSearchSolver {
  return {
    assume: vi.fn(),
    solve,
    lookahead,
  };
}

describe("long-lived cube search", () => {
  it("continues beyond the former 64-slice handoff until a result", async () => {
    let calls = 0;
    const solver = solverFixture(() => ++calls > 70 ? 10 : 0);

    const result = await runCubeSearchLoop({
      solver,
      assumptions: [],
      conflictBudget: 100,
      stopped: () => null,
      splitRequested: () => false,
      clearSplitRequest: vi.fn(),
      computeBatchMs: Number.POSITIVE_INFINITY,
    });

    expect(result).toMatchObject({ kind: "SAT", slices: 71 });
    expect(calls).toBe(71);
  });

  it("honors a split request only after one second of active solver compute", async () => {
    let clock = 0;
    const solver = solverFixture(() => {
      clock += 250;
      return 0;
    }, () => 7);
    const clearSplitRequest = vi.fn();

    const result = await runCubeSearchLoop({
      solver,
      assumptions: [-2],
      conflictBudget: 100,
      stopped: () => null,
      splitRequested: () => true,
      clearSplitRequest,
      now: () => clock,
      computeBatchMs: Number.POSITIVE_INFINITY,
    });

    expect(result).toMatchObject({ kind: "SPLIT", splitLiteral: 7, activeMs: 1_000, slices: 4 });
    expect(clearSplitRequest).toHaveBeenCalledOnce();
  });

  it("consumes an unusable split request and keeps solving the same cube", async () => {
    let clock = 0;
    let calls = 0;
    let requested = true;
    const solver = solverFixture(() => {
      clock += 500;
      calls += 1;
      return calls === 3 ? 10 : 0;
    }, () => 2);

    const result = await runCubeSearchLoop({
      solver,
      assumptions: [-2],
      conflictBudget: 100,
      stopped: () => null,
      splitRequested: () => requested,
      clearSplitRequest: () => { requested = false; },
      now: () => clock,
      computeBatchMs: Number.POSITIVE_INFINITY,
    });

    expect(result).toMatchObject({ kind: "SAT", slices: 3 });
    expect(requested).toBe(false);
  });

  it("coalesces progress while yielding browser control in bounded batches", async () => {
    let clock = 0;
    let calls = 0;
    const progress = vi.fn();
    const yieldControl = vi.fn(async () => undefined);
    const solver = solverFixture(() => {
      clock += 250;
      calls += 1;
      return calls === 5 ? 20 : 0;
    });

    const result = await runCubeSearchLoop({
      solver,
      assumptions: [],
      conflictBudget: 100,
      stopped: () => null,
      splitRequested: () => false,
      clearSplitRequest: vi.fn(),
      onProgress: progress,
      now: () => clock,
      yieldControl,
      computeBatchMs: 16,
    });

    expect(result).toMatchObject({ kind: "UNSAT", activeMs: 1_250, slices: 5 });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({ activeMs: 1_000, slices: 4 });
    expect(yieldControl).toHaveBeenCalledTimes(4);
  });
});
