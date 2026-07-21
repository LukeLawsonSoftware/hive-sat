export type SolverPhase =
  | "empty"
  | "ready"
  | "queued"
  | "distributing"
  | "solving"
  | "result"
  | "error";

export type SimulatedVerdict = "SAT" | "UNSAT";

export interface SelectedFile {
  name: string;
  size: number;
  lastModified: number;
}

export interface SimulatedResult {
  verdict: SimulatedVerdict;
  elapsedMs: number;
  fingerprint: string;
}

export interface SolverSnapshot {
  phase: SolverPhase;
  file: SelectedFile | null;
  result: SimulatedResult | null;
  message: string | null;
}

export type SolverListener = (snapshot: SolverSnapshot) => void;

export interface SolverClient {
  getSnapshot(): SolverSnapshot;
  select(file: SelectedFile): void;
  start(): void;
  cancel(): void;
  reset(): void;
  subscribe(listener: SolverListener): () => void;
}

const EMPTY_SNAPSHOT: SolverSnapshot = {
  phase: "empty",
  file: null,
  result: null,
  message: null,
};

export function resultForFilename(filename: string): SimulatedVerdict {
  let hash = 2166136261;

  for (const character of filename.toLowerCase()) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) % 2 === 0 ? "SAT" : "UNSAT";
}

export function fingerprintForFilename(filename: string): string {
  let hash = 0;

  for (const character of filename.toLowerCase()) {
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  }

  return hash.toString(16).padStart(8, "0").toUpperCase();
}

export class MockSolverClient implements SolverClient {
  private snapshot: SolverSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<SolverListener>();
  private timers: Array<ReturnType<typeof setTimeout>> = [];

  getSnapshot = (): SolverSnapshot => this.snapshot;

  subscribe = (listener: SolverListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  select(file: SelectedFile): void {
    this.clearTimers();
    this.update({ phase: "ready", file, result: null, message: null });
  }

  start(): void {
    if (!this.snapshot.file || this.snapshot.phase !== "ready") return;

    const file = this.snapshot.file;
    this.clearTimers();
    this.update({ phase: "queued", file, result: null, message: null });

    this.schedule(650, () => {
      this.update({ phase: "distributing", file, result: null, message: null });
    });

    this.schedule(1_650, () => {
      this.update({ phase: "solving", file, result: null, message: null });
    });

    this.schedule(4_250, () => {
      if (file.name.toLowerCase().includes("error")) {
        this.update({
          phase: "error",
          file,
          result: null,
          message: "The demo worker lost contact with its simulated coordinator.",
        });
        return;
      }

      this.update({
        phase: "result",
        file,
        result: {
          verdict: resultForFilename(file.name),
          elapsedMs: 4_250,
          fingerprint: fingerprintForFilename(file.name),
        },
        message: null,
      });
    });
  }

  cancel(): void {
    if (!this.snapshot.file) return;
    this.clearTimers();
    this.update({
      phase: "ready",
      file: this.snapshot.file,
      result: null,
      message: "Demo solve cancelled. Your file is still ready.",
    });
  }

  reset(): void {
    this.clearTimers();
    this.update(EMPTY_SNAPSHOT);
  }

  private schedule(delay: number, callback: () => void): void {
    this.timers.push(setTimeout(callback, delay));
  }

  private clearTimers(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  private update(snapshot: SolverSnapshot): void {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

export function validateCnfFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(".cnf")) {
    return "Choose a DIMACS file with a .cnf extension.";
  }

  if (file.size === 0) {
    return "That file is empty. Choose a non-empty DIMACS CNF file.";
  }

  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
