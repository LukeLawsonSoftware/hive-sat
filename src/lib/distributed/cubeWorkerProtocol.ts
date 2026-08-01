import type { CubeTask, Lease } from "../../../shared/coordinator-protocol";
import type { FormulaMetadata, SolverMetrics } from "../formula/workerProtocol";

export type CubeWorkerMode = "SEARCH" | "PROOF_FINISHER";

export type CubeWorkerRequest =
  | { type: "initialize"; requestId: string; metadata: FormulaMetadata; mode?: CubeWorkerMode }
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
      conflictBudget: number;
    }
  | {
      type: "grant-split";
      requestId: string;
      taskId: string;
      leaseId: string;
      permitId: string;
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
      permitId: string;
      splitLiteral: number;
      activeMs: number;
      metrics: SolverMetrics;
    })
  | (CubeResponseBase & {
      type: "yield";
      taskId: string;
      leaseId: string;
      reason: "PAUSED" | "SHUTDOWN" | "UNSUPPORTED";
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
