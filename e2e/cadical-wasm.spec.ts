import { expect, test } from "@playwright/test";
import { verifyTextLrat } from "../src/lib/lrat";

test.describe("CaDiCaL WebAssembly feasibility gate", () => {
  test("loads the pinned single-threaded ES module and extracts a model", async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const { loadCaDiCaL, SolverMetric, SolverStatus } = await import(
        "/solver/hivesat.mjs"
      );
      const runtime = await loadCaDiCaL();
      const solver = runtime.createSolver();
      try {
        const clauses = [1, 2, 0, -1, 2, 0, 1, -2, 0];
        solver.addClauses(clauses);
        const status = solver.solve(-1);
        const model = solver.model(1, 2);
        const assignment = new Map(
          model.map((literal: number) => [Math.abs(literal), literal > 0]),
        );
        const satisfies = [
          [1, 2],
          [-1, 2],
          [1, -2],
        ].every((clause) =>
          clause.some(
            (literal) => assignment.get(Math.abs(literal)) === literal > 0,
          ),
        );
        return {
          version: runtime.version,
          status,
          expectedStatus: SolverStatus.SAT,
          model,
          satisfies,
          decisions: solver.metric(SolverMetric.DECISIONS),
          propagations: solver.metric(SolverMetric.PROPAGATIONS),
        };
      } finally {
        solver.dispose();
      }
    });

    expect(result.version).toBe("3.0.1");
    expect(result.status).toBe(result.expectedStatus);
    expect(result.model).toHaveLength(2);
    expect(result.satisfies).toBe(true);
    expect(result.decisions).toBeGreaterThanOrEqual(0);
    expect(result.propagations).toBeGreaterThanOrEqual(0);
  });

  test("resumes conflict-bounded solves and resets assumptions", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const { loadCaDiCaL, SolverStatus } = await import("/solver/hivesat.mjs");
      const runtime = await loadCaDiCaL();

      const assumptionSolver = runtime.createSolver();
      assumptionSolver.addClauses([1, 2, 0, -1, 2, 0, 1, -2, 0]);
      assumptionSolver.assume([-2]);
      const underAssumption = assumptionSolver.solve(-1);
      const afterReset = assumptionSolver.solve(-1);
      assumptionSolver.dispose();

      const pigeonhole = (pigeons: number, holes: number) => {
        const literals: number[] = [];
        const variable = (pigeon: number, hole: number) => pigeon * holes + hole + 1;
        for (let pigeon = 0; pigeon < pigeons; pigeon += 1) {
          for (let hole = 0; hole < holes; hole += 1) literals.push(variable(pigeon, hole));
          literals.push(0);
          for (let first = 0; first < holes; first += 1) {
            for (let second = first + 1; second < holes; second += 1) {
              literals.push(-variable(pigeon, first), -variable(pigeon, second), 0);
            }
          }
        }
        for (let hole = 0; hole < holes; hole += 1) {
          for (let first = 0; first < pigeons; first += 1) {
            for (let second = first + 1; second < pigeons; second += 1) {
              literals.push(-variable(first, hole), -variable(second, hole), 0);
            }
          }
        }
        return literals;
      };

      const boundedSolver = runtime.createSolver();
      boundedSolver.addClauses(pigeonhole(7, 6));
      const statuses: number[] = [];
      for (let slice = 0; slice < 5_000; slice += 1) {
        const status = boundedSolver.solve(1);
        statuses.push(status);
        if (status !== SolverStatus.UNKNOWN) break;
      }
      boundedSolver.dispose();
      return {
        underAssumption,
        afterReset,
        statuses,
        unsat: SolverStatus.UNSAT,
        sat: SolverStatus.SAT,
        unknown: SolverStatus.UNKNOWN,
      };
    });

    expect(result.underAssumption).toBe(result.unsat);
    expect(result.afterReset).toBe(result.sat);
    expect(result.statuses).toContain(result.unknown);
    expect(result.statuses.at(-1)).toBe(result.unsat);
  });

  test("supports prompt cancellation between bounded slices and lookahead splitting", async ({
    page,
  }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const { loadCaDiCaL, SolverStatus } = await import("/solver/hivesat.mjs");
      const runtime = await loadCaDiCaL();
      const solver = runtime.createSolver();
      solver.addClauses([
        1, 2, 3, 0, -1, 2, 3, 0, 1, -2, 3, 0, 1, 2, -3, 0,
        -1, -2, 3, 0, -1, 2, -3, 0, 1, -2, -3, 0,
      ]);
      const splitLiteral = solver.lookahead();
      solver.dispose();

      const cancelled = runtime.createSolver();
      cancelled.addClauses([1, 2, 0, -1, 2, 0, 1, -2, 0]);
      cancelled.interrupt();
      const started = performance.now();
      const status = cancelled.solve(1);
      const latencyMs = performance.now() - started;
      cancelled.clearInterrupt();
      const resumedStatus = cancelled.solve(-1);
      cancelled.dispose();

      const workerCancellationMs = await new Promise<number>((resolve, reject) => {
        const moduleUrl = new URL("/solver/hivesat.mjs", location.href).href;
        const source = `
          import { loadCaDiCaL, SolverStatus } from ${JSON.stringify(moduleUrl)};
          let cancelled = false;
          const runtime = await loadCaDiCaL();
          postMessage({ type: "ready" });
          onmessage = async ({ data }) => {
            if (data.type === "cancel") { cancelled = true; return; }
            if (data.type !== "start") return;
            const solver = runtime.createSolver();
            const pigeons = 9, holes = 8, literals = [];
            const variable = (pigeon, hole) => pigeon * holes + hole + 1;
            for (let pigeon = 0; pigeon < pigeons; pigeon += 1) {
              for (let hole = 0; hole < holes; hole += 1) literals.push(variable(pigeon, hole));
              literals.push(0);
              for (let first = 0; first < holes; first += 1)
                for (let second = first + 1; second < holes; second += 1)
                  literals.push(-variable(pigeon, first), -variable(pigeon, second), 0);
            }
            for (let hole = 0; hole < holes; hole += 1)
              for (let first = 0; first < pigeons; first += 1)
                for (let second = first + 1; second < pigeons; second += 1)
                  literals.push(-variable(first, hole), -variable(second, hole), 0);
            solver.addClauses(literals);
            while (!cancelled) {
              const result = solver.solve(1);
              if (result !== SolverStatus.UNKNOWN) {
                postMessage({ type: "finished" });
                solver.dispose();
                return;
              }
              await new Promise((next) => setTimeout(next, 0));
            }
            solver.interrupt();
            postMessage({ type: "cancelled" });
            solver.dispose();
          };
        `;
        const workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const worker = new Worker(workerUrl, { type: "module" });
        const timeout = setTimeout(() => {
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          reject(new Error("worker cancellation timed out"));
        }, 5_000);
        let cancellationStarted = 0;
        worker.onmessage = ({ data }) => {
          if (data.type === "ready") {
            worker.postMessage({ type: "start" });
            setTimeout(() => {
              cancellationStarted = performance.now();
              worker.postMessage({ type: "cancel" });
            }, 10);
          } else if (data.type === "cancelled") {
            clearTimeout(timeout);
            const elapsed = performance.now() - cancellationStarted;
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            resolve(elapsed);
          } else if (data.type === "finished") {
            clearTimeout(timeout);
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            reject(new Error("worker formula finished before cancellation"));
          }
        };
        worker.onerror = (event) => reject(new Error(event.message));
      });
      return {
        splitLiteral,
        status,
        latencyMs,
        workerCancellationMs,
        resumedStatus,
        unknown: SolverStatus.UNKNOWN,
        sat: SolverStatus.SAT,
      };
    });

    expect(result.splitLiteral).not.toBe(0);
    expect(result.status).toBe(result.unknown);
    expect(result.latencyMs).toBeLessThan(50);
    expect(result.workerCancellationMs).toBeLessThan(250);
    expect(result.resumedStatus).toBe(result.sat);
  });

  test("grows linear memory and reports its high-water mark", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const { loadCaDiCaL, SolverMetric } = await import("/solver/hivesat.mjs");
      const runtime = await loadCaDiCaL();
      const solver = runtime.createSolver();
      const initial = solver.metric(SolverMetric.MEMORY_BYTES);
      let variable = 1;
      for (let batch = 0; batch < 80; batch += 1) {
        const literals: number[] = [];
        for (let clause = 0; clause < 2_000; clause += 1) {
          literals.push(variable, variable + 1, variable + 2, 0);
          variable += 3;
        }
        solver.addClauses(literals);
      }
      const current = solver.metric(SolverMetric.MEMORY_BYTES);
      const highWater = solver.metric(SolverMetric.MEMORY_HIGH_WATER_BYTES);
      solver.dispose();
      return { initial, current, highWater };
    });

    expect(result.current).toBeGreaterThan(result.initial);
    expect(result.highWater).toBeGreaterThanOrEqual(result.current);
  });

  test("emits an LRAT proof accepted by an external checker", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const { loadCaDiCaL, SolverStatus } = await import("/solver/hivesat.mjs");
      const runtime = await loadCaDiCaL();
      const solver = runtime.createSolver();
      solver.enableLrat();
      solver.addClauses([1, 0, -1, 0]);
      const status = solver.solve(-1);
      const proof = solver.closeLrat();
      solver.dispose();
      return { status, proof, unsat: SolverStatus.UNSAT };
    });

    expect(result.status).toBe(result.unsat);
    expect(result.proof).not.toBe("");
    expect(verifyTextLrat([[1], [-1]], result.proof)).toMatchObject({ valid: true });
  });
});
