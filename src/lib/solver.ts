import { decodeHiveCnfV1, sha256Hex, type HiveCnfV1 } from "./formula/hiveCnf";
import {
  MAX_COMPRESSED_FORMULA_BYTES,
  MAX_DECOMPRESSED_DIMACS_BYTES,
} from "./formula/limits";
import { verifySatModel } from "./formula/modelVerifier";
import type {
  FormulaMetadata,
  FormulaWorkerRequest,
  FormulaWorkerResponse,
  SolverMetrics,
  SolverWorkerRequest,
  SolverWorkerResponse,
} from "./formula/workerProtocol";

export type SolverPhase =
  | "empty"
  | "ready"
  | "queued"
  | "distributing"
  | "solving"
  | "result"
  | "error";

export interface SelectedFile {
  name: string;
  size: number;
  lastModified: number;
}

export interface SolverResult {
  verdict: "SAT" | "UNSAT";
  elapsedMs: number;
  fingerprint: string;
  formulaHash: string;
  variableCount: number;
  clauseCount: number;
  modelVerified: boolean;
  model: number[] | null;
  cacheHit: boolean;
  metrics: SolverMetrics;
}

export interface SolverProgress {
  stage: "reading" | "encoding" | "compressing" | "caching" | "loading" | "solving";
  bytesRead?: number;
  totalBytes?: number;
  line?: number;
  slices?: number;
  metrics?: SolverMetrics;
}

export interface SolverSnapshot {
  phase: SolverPhase;
  file: SelectedFile | null;
  result: SolverResult | null;
  message: string | null;
  progress: SolverProgress | null;
}

export type SolverListener = () => void;

export interface SolverClient {
  getSnapshot(): SolverSnapshot;
  select(file: File): void;
  start(): void;
  cancel(): void;
  reset(): void;
  subscribe(listener: SolverListener): () => void;
}

interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export type SolverWorkerFactory = (kind: "formula" | "solver") => WorkerLike;

const EMPTY_SNAPSHOT: SolverSnapshot = {
  phase: "empty",
  file: null,
  result: null,
  message: null,
  progress: null,
};

function defaultWorkerFactory(kind: "formula" | "solver"): WorkerLike {
  if (kind === "formula") {
    return new Worker(new URL("../workers/formula.worker.ts", import.meta.url), {
      type: "module",
      name: "hivesat-formula",
    });
  }
  return new Worker(new URL("../workers/solver.worker.ts", import.meta.url), {
    type: "module",
    name: "hivesat-solver",
  });
}

function selectedFile(file: File): SelectedFile {
  return { name: file.name, size: file.size, lastModified: file.lastModified };
}

export class BrowserSolverClient implements SolverClient {
  private snapshot: SolverSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<SolverListener>();
  private readonly workerFactory: SolverWorkerFactory;
  private file: File | null = null;
  private formulaWorker: WorkerLike | null = null;
  private solverWorker: WorkerLike | null = null;
  private formula: HiveCnfV1 | null = null;
  private metadata: FormulaMetadata | null = null;
  private solverLoaded = false;
  private solverFinished = false;
  private requestSequence = 0;
  private requestId: string | null = null;
  private solveStartedAt = 0;

  constructor(workerFactory: SolverWorkerFactory = defaultWorkerFactory) {
    this.workerFactory = workerFactory;
  }

  getSnapshot = (): SolverSnapshot => this.snapshot;

  subscribe = (listener: SolverListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  select(file: File): void {
    this.disposeRuntime();
    this.file = file;
    this.update({
      phase: "ready",
      file: selectedFile(file),
      result: null,
      message: null,
      progress: null,
    });
  }

  start(): void {
    if (!this.file || !["ready", "result", "error"].includes(this.snapshot.phase)) return;

    if (this.solverWorker && this.solverLoaded && !this.solverFinished && this.requestId) {
      this.solveStartedAt ||= performance.now();
      this.update({
        ...this.snapshot,
        phase: "solving",
        result: null,
        message: null,
        progress: { stage: "solving" },
      });
      this.postSolver({ type: "solve", requestId: this.requestId });
      return;
    }

    this.disposeRuntime();
    const requestId = `local-${Date.now().toString(36)}-${++this.requestSequence}`;
    this.requestId = requestId;
    this.solveStartedAt = performance.now();
    this.update({
      phase: "queued",
      file: selectedFile(this.file),
      result: null,
      message: "Reading and validating DIMACS input…",
      progress: { stage: "reading", bytesRead: 0, totalBytes: this.file.size },
    });

    try {
      const worker = this.workerFactory("formula");
      this.formulaWorker = worker;
      worker.onmessage = (event) => void this.onFormulaMessage(event.data as FormulaWorkerResponse);
      worker.onerror = (event) => this.fail(event.message || "Formula worker failed.");
      const message: FormulaWorkerRequest = { type: "parse", requestId, file: this.file };
      worker.postMessage(message);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Unable to start the formula worker.");
    }
  }

  cancel(): void {
    if (!this.file) return;
    if (this.requestId && this.formulaWorker) {
      const message: FormulaWorkerRequest = { type: "cancel", requestId: this.requestId };
      this.formulaWorker.postMessage(message);
      this.formulaWorker.terminate();
      this.formulaWorker = null;
      this.requestId = null;
      this.update({
        phase: "ready",
        file: selectedFile(this.file),
        result: null,
        message: "Formula processing cancelled. The file is still ready.",
        progress: null,
      });
      return;
    }

    if (this.requestId && this.solverWorker && !this.solverFinished) {
      this.postSolver({ type: "pause", requestId: this.requestId });
      this.update({
        phase: "ready",
        file: selectedFile(this.file),
        result: null,
        message: "Solve paused. Resume continues the current bounded CaDiCaL search.",
        progress: null,
      });
      return;
    }

    if (this.snapshot.phase === "result" || this.snapshot.phase === "error") {
      this.disposeRuntime();
      this.update({
        phase: "ready",
        file: selectedFile(this.file),
        result: null,
        message: null,
        progress: null,
      });
    }
  }

  reset(): void {
    this.disposeRuntime();
    this.file = null;
    this.update(EMPTY_SNAPSHOT);
  }

  private async onFormulaMessage(message: FormulaWorkerResponse): Promise<void> {
    if (message.requestId !== this.requestId) return;
    if (message.type === "progress") {
      if (this.snapshot.phase !== "queued") return;
      const labels = {
        reading: "Reading and validating DIMACS input…",
        encoding: "Creating deterministic HiveCnfV1 bytes…",
        compressing: "Compressing the verified formula…",
        caching: "Checking the verified formula cache…",
      } as const;
      this.update({
        ...this.snapshot,
        message: labels[message.stage],
        progress: {
          stage: message.stage,
          bytesRead: message.bytesRead,
          totalBytes: message.totalBytes,
          line: message.line,
        },
      });
      return;
    }
    if (message.type === "cancelled") return;
    if (message.type === "error") {
      this.fail(message.message);
      return;
    }

    try {
      const encoded = new Uint8Array(message.encoded);
      if (await sha256Hex(encoded) !== message.metadata.hash) {
        throw new Error("Formula worker returned a mismatched SHA-256 digest.");
      }
      this.formula = decodeHiveCnfV1(encoded);
      this.metadata = message.metadata;
      this.formulaWorker?.terminate();
      this.formulaWorker = null;
      this.update({
        ...this.snapshot,
        phase: "distributing",
        message: message.metadata.cacheHit
          ? "Verified cache hit. Loading CaDiCaL…"
          : "Formula verified and cached. Loading CaDiCaL…",
        progress: { stage: "loading" },
      });

      const worker = this.workerFactory("solver");
      this.solverWorker = worker;
      worker.onmessage = (event) => this.onSolverMessage(event.data as SolverWorkerResponse);
      worker.onerror = (event) => this.fail(event.message || "Solver worker failed.");
      this.postSolver({ type: "initialize", requestId: message.requestId, metadata: message.metadata });
      message.batches.forEach((batch, sequence) => {
        this.postSolver(
          {
            type: "clause-batch",
            requestId: message.requestId,
            sequence,
            last: sequence === message.batches.length - 1,
            literals: batch,
          },
          [batch.buffer as ArrayBuffer],
        );
      });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "Formula verification failed.");
    }
  }

  private onSolverMessage(message: SolverWorkerResponse): void {
    if (message.requestId !== this.requestId) return;
    if (message.type === "ready") {
      this.solverLoaded = true;
      this.update({
        ...this.snapshot,
        phase: "solving",
        message: "Running CaDiCaL in resumable conflict-bounded slices…",
        progress: { stage: "solving", slices: 0 },
      });
      this.postSolver({ type: "solve", requestId: message.requestId });
      return;
    }
    if (message.type === "progress") {
      if (this.snapshot.phase !== "solving") return;
      this.update({
        ...this.snapshot,
        progress: { stage: "solving", slices: message.slices, metrics: message.metrics },
      });
      return;
    }
    if (message.type === "paused") return;
    if (message.type === "error") {
      this.fail(message.message);
      return;
    }

    if (!this.formula || !this.metadata) {
      this.fail("Solver returned a result without a verified formula.");
      return;
    }
    let modelVerified = false;
    let model: number[] | null = null;
    if (message.verdict === "SAT") {
      const verification = verifySatModel(this.formula, message.model);
      if (!verification.valid) {
        this.fail(`CaDiCaL model verification failed: ${verification.reason}`);
        return;
      }
      modelVerified = true;
      model = message.model;
    }

    this.solverFinished = true;
    this.update({
      phase: "result",
      file: this.snapshot.file,
      result: {
        verdict: message.verdict,
        elapsedMs: Math.max(0, performance.now() - this.solveStartedAt),
        fingerprint: this.metadata.hash.slice(0, 12).toUpperCase(),
        formulaHash: this.metadata.hash,
        variableCount: this.metadata.variableCount,
        clauseCount: this.metadata.clauseCount,
        modelVerified,
        model,
        cacheHit: this.metadata.cacheHit,
        metrics: message.metrics,
      },
      message: null,
      progress: null,
    });
  }

  private postSolver(message: SolverWorkerRequest, transfer: Transferable[] = []): void {
    this.solverWorker?.postMessage(message, transfer);
  }

  private fail(message: string): void {
    this.formulaWorker?.terminate();
    this.formulaWorker = null;
    this.solverWorker?.terminate();
    this.solverWorker = null;
    this.solverLoaded = false;
    this.solverFinished = false;
    this.requestId = null;
    this.update({
      phase: "error",
      file: this.file ? selectedFile(this.file) : this.snapshot.file,
      result: null,
      message,
      progress: null,
    });
  }

  private disposeRuntime(): void {
    if (this.requestId && this.solverWorker) {
      this.postSolver({ type: "dispose", requestId: this.requestId });
    }
    this.formulaWorker?.terminate();
    this.solverWorker?.terminate();
    this.formulaWorker = null;
    this.solverWorker = null;
    this.formula = null;
    this.metadata = null;
    this.solverLoaded = false;
    this.solverFinished = false;
    this.requestId = null;
    this.solveStartedAt = 0;
  }

  private update(snapshot: SolverSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }
}

export function validateCnfFile(file: File): string | null {
  const lowerName = file.name.toLowerCase();
  if (!lowerName.endsWith(".cnf") && !lowerName.endsWith(".cnf.gz")) {
    return "Choose a DIMACS file with a .cnf or .cnf.gz extension.";
  }
  if (file.size === 0) return "That file is empty. Choose a non-empty DIMACS CNF file.";
  if (lowerName.endsWith(".gz") && file.size > MAX_COMPRESSED_FORMULA_BYTES) {
    return `Compressed formulas are limited to ${formatFileSize(MAX_COMPRESSED_FORMULA_BYTES)}.`;
  }
  if (!lowerName.endsWith(".gz") && file.size > MAX_DECOMPRESSED_DIMACS_BYTES) {
    return `DIMACS input is limited to ${formatFileSize(MAX_DECOMPRESSED_DIMACS_BYTES)}.`;
  }
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
