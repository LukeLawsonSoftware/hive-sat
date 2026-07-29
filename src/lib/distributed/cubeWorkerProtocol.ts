import type { CubeTask, Lease } from "../../../shared/coordinator-protocol";
import type { FormulaMetadata, SolverMetrics } from "../formula/workerProtocol";

export type CubeWorkerRequest =
  | { type: "initialize"; requestId: string; metadata: FormulaMetadata }
  | {
      type: "clause-batch";
      requestId: string;
      sequence: number;
      last: boolean;
      literals: Int32Array;
    }
  | {
      type: "run";
      requestId: string;
      task: CubeTask;
      lease: Lease;
      allowSplit: boolean;
      maxSlices: number;
      conflictBudget: number;
    }
  | { type: "stop"; requestId: string; reason: "PAUSED" | "SHUTDOWN" };

interface CubeResponseBase {
  requestId: string;
}

export type CubeWorkerResponse =
  | (CubeResponseBase & { type: "ready" })
  | (CubeResponseBase & {
      type: "progress";
      taskId: string;
      leaseId: string;
      activeMs: number;
      metrics: SolverMetrics;
      slices: number;
    })
  | (CubeResponseBase & {
      type: "split";
      taskId: string;
      leaseId: string;
      splitLiteral: number;
      activeMs: number;
      metrics: SolverMetrics;
    })
  | (CubeResponseBase & {
      type: "yield";
      taskId: string;
      leaseId: string;
      reason: "BUDGET" | "PAUSED" | "SHUTDOWN" | "UNSUPPORTED";
      activeMs: number;
      metrics: SolverMetrics;
    })
  | (CubeResponseBase & {
      type: "result";
      taskId: string;
      leaseId: string;
      verdict: "SAT";
      model: number[];
      activeMs: number;
      metrics: SolverMetrics;
    })
  | (CubeResponseBase & {
      type: "result";
      taskId: string;
      leaseId: string;
      verdict: "UNSAT";
      proof?: Uint8Array;
      proofBytes?: number;
      activeMs: number;
      metrics: SolverMetrics;
    })
  | (CubeResponseBase & { type: "error"; message: string });
