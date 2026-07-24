export interface FormulaMetadata {
  hash: string;
  variableCount: number;
  clauseCount: number;
  literalCount: number;
  encodedBytes: number;
  compressedBytes: number;
  cacheHit: boolean;
}

export type FormulaWorkerRequest =
  | { type: "parse"; requestId: string; file: File }
  | { type: "cancel"; requestId: string };

export type FormulaWorkerResponse =
  | {
      type: "progress";
      requestId: string;
      stage: "reading" | "encoding" | "compressing" | "caching";
      bytesRead?: number;
      totalBytes?: number;
      line?: number;
    }
  | {
      type: "completed";
      requestId: string;
      metadata: FormulaMetadata;
      encoded: ArrayBuffer;
      batches: Int32Array[];
    }
  | { type: "cancelled"; requestId: string }
  | {
      type: "error";
      requestId: string;
      message: string;
      line?: number;
      column?: number;
      byteOffset?: number;
    };

export interface SolverMetrics {
  conflicts: number;
  decisions: number;
  propagations: number;
  memoryBytes?: number;
  memoryHighWaterBytes?: number;
}

export type SolverWorkerRequest =
  | { type: "initialize"; requestId: string; metadata: FormulaMetadata }
  | { type: "clause-batch"; requestId: string; sequence: number; last: boolean; literals: Int32Array }
  | { type: "solve"; requestId: string }
  | { type: "pause"; requestId: string }
  | { type: "dispose"; requestId: string };

export type SolverWorkerResponse =
  | { type: "ready"; requestId: string }
  | { type: "progress"; requestId: string; metrics: SolverMetrics; slices: number }
  | { type: "paused"; requestId: string; metrics: SolverMetrics; slices: number }
  | {
      type: "result";
      requestId: string;
      verdict: "SAT";
      model: number[];
      metrics: SolverMetrics;
      slices: number;
    }
  | {
      type: "result";
      requestId: string;
      verdict: "UNSAT";
      metrics: SolverMetrics;
      slices: number;
    }
  | { type: "error"; requestId: string; message: string };
