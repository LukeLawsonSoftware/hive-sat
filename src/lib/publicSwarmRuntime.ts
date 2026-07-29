import type { PreviousSwarmAssignment, SwarmSnapshot } from "../../shared/swarm-protocol";
import { DistributedCubeRuntime, type CubeRuntimeOptions } from "./distributed/cubeRuntime";
import type { CoordinatorWebSocket } from "./jobCoordinatorSocket";
import { SwarmDirectorySocket } from "./swarmDirectorySocket";

export type PublicSwarmPhase =
  | "idle"
  | "directory"
  | "computing"
  | "no-work"
  | "paused"
  | "error";

export interface PublicSwarmSnapshot {
  phase: PublicSwarmPhase;
  jobId: string | null;
  activeWorkers: number;
  activeWorkerMs: number;
  global: SwarmSnapshot;
  message: string | null;
}

export interface PublicSwarmRuntimeOptions {
  sessionId?: string;
  workerPreference?: number;
  hardwareConcurrency?: number;
  mobile?: boolean;
  fetcher?: typeof fetch;
  workerFactory?: CubeRuntimeOptions["workerFactory"];
  directoryWebSocketFactory?: (url: string) => CoordinatorWebSocket;
  coordinatorWebSocketFactory?: (url: string) => CoordinatorWebSocket;
  now?: () => number;
  calibratedConflictsPerSecond?: number;
}

type Listener = () => void;

export class PublicSwarmRuntime {
  private readonly listeners = new Set<Listener>();
  private readonly sessionId: string;
  private readonly now: () => number;
  private snapshot: PublicSwarmSnapshot = {
    phase: "idle",
    jobId: null,
    activeWorkers: 0,
    activeWorkerMs: 0,
    global: { activeJobs: 0, activeWorkers: 0 },
    message: null,
  };
  private directory: SwarmDirectorySocket | null = null;
  private cube: DistributedCubeRuntime | null = null;
  private unsubscribeCube: (() => void) | null = null;
  private assignmentTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private previousAssignment: PreviousSwarmAssignment | undefined;
  private lastIntegratedAt = 0;
  private lastActiveWorkers = 0;
  private assignmentWorkerMs = 0;

  constructor(private readonly options: PublicSwarmRuntimeOptions = {}) {
    this.sessionId = options.sessionId ?? crypto.randomUUID();
    this.now = options.now ?? Date.now;
  }

  getSnapshot = (): PublicSwarmSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    if (!["idle", "paused", "error", "no-work"].includes(this.snapshot.phase)) return;
    this.clearRetry();
    this.connectDirectory();
  }

  pause(): void {
    this.integrateWorkerTime();
    this.directory?.stop();
    this.directory = null;
    this.finishCube(false);
    this.clearRetry();
    this.update({
      ...this.snapshot,
      phase: "paused",
      activeWorkers: 0,
      jobId: null,
      message: "Public contribution is paused.",
    });
  }

  stop(): void {
    this.pause();
    this.previousAssignment = undefined;
    this.assignmentWorkerMs = 0;
    this.update({ ...this.snapshot, phase: "idle", activeWorkerMs: 0, message: null });
  }

  private connectDirectory(): void {
    this.finishCube(false);
    this.update({
      ...this.snapshot,
      phase: "directory",
      jobId: null,
      activeWorkers: 0,
      message: "Requesting a fair public assignment…",
    });
    this.directory = new SwarmDirectorySocket({
      sessionId: this.sessionId,
      capabilities: {
        hardwareConcurrency: this.options.hardwareConcurrency ?? navigator.hardwareConcurrency ?? 1,
        maxWorkers: Math.max(1, Math.floor(this.options.workerPreference ?? 1)),
        mobile: this.options.mobile ?? false,
        solverVersion: "cadical-3.0.1",
        ...(this.options.calibratedConflictsPerSecond
          ? { calibratedConflictsPerSecond: this.options.calibratedConflictsPerSecond }
          : {}),
      },
      previousAssignment: this.previousAssignment,
      webSocketFactory: this.options.directoryWebSocketFactory,
      onAssignment: (assignment) => {
        this.directory = null;
        this.previousAssignment = undefined;
        this.snapshot.global = assignment.snapshot;
        this.beginAssignment(assignment);
      },
      onNoWork: (message) => {
        this.directory = null;
        this.previousAssignment = undefined;
        this.update({
          ...this.snapshot,
          phase: "no-work",
          global: message.snapshot,
          message: "No eligible public job is waiting.",
        });
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.snapshot.phase === "no-work") this.connectDirectory();
        }, message.retryAfterMs);
      },
      onProtocolError: (code) => {
        this.directory = null;
        this.update({ ...this.snapshot, phase: "error", message: `Directory protocol error: ${code}.` });
      },
    });
    this.directory.start();
  }

  private beginAssignment(assignment: {
    assignmentId: string;
    jobId: string;
    workers: number;
    quantumMs: number;
    conflictBudget: number;
  }): void {
    this.assignmentWorkerMs = 0;
    this.lastIntegratedAt = this.now();
    this.lastActiveWorkers = 0;
    const cube = new DistributedCubeRuntime({
      jobId: assignment.jobId,
      sessionId: this.sessionId,
      workerPreference: assignment.workers,
      hardwareConcurrency: this.options.hardwareConcurrency,
      mobile: this.options.mobile,
      fetcher: this.options.fetcher,
      workerFactory: this.options.workerFactory,
      webSocketFactory: this.options.coordinatorWebSocketFactory,
      now: this.now,
      conflictBudget: assignment.conflictBudget,
      calibratedConflictsPerSecond: this.options.calibratedConflictsPerSecond,
    });
    this.cube = cube;
    this.unsubscribeCube = cube.subscribe(() => {
      if (this.cube !== cube) return;
      this.integrateWorkerTime();
      const value = cube.getSnapshot();
      this.lastActiveWorkers = value.activeWorkers;
      this.update({
        ...this.snapshot,
        phase: "computing",
        jobId: assignment.jobId,
        activeWorkers: value.activeWorkers,
        message: value.message,
      });
      if (value.phase === "complete" || value.phase === "error") {
        this.completeAssignment(assignment.assignmentId);
      }
    });
    this.update({
      ...this.snapshot,
      phase: "computing",
      jobId: assignment.jobId,
      message: "Loading the assigned public formula…",
    });
    this.assignmentTimer = setTimeout(
      () => this.completeAssignment(assignment.assignmentId),
      assignment.quantumMs,
    );
    void cube.start();
  }

  private completeAssignment(assignmentId: string): void {
    if (!this.cube) return;
    this.integrateWorkerTime();
    this.previousAssignment = {
      assignmentId,
      activeWorkerMs: Math.round(this.assignmentWorkerMs),
    };
    this.finishCube(true);
    if (this.snapshot.phase !== "paused") this.connectDirectory();
  }

  private integrateWorkerTime(): void {
    if (this.lastIntegratedAt === 0) return;
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastIntegratedAt);
    const workerMs = elapsed * this.lastActiveWorkers;
    this.assignmentWorkerMs += workerMs;
    this.lastIntegratedAt = now;
    if (workerMs > 0) {
      this.snapshot = {
        ...this.snapshot,
        activeWorkerMs: this.snapshot.activeWorkerMs + workerMs,
      };
    }
  }

  private finishCube(stop: boolean): void {
    if (this.assignmentTimer !== null) clearTimeout(this.assignmentTimer);
    this.assignmentTimer = null;
    this.unsubscribeCube?.();
    this.unsubscribeCube = null;
    if (stop) this.cube?.stop();
    else this.cube?.pause();
    this.cube = null;
    this.lastActiveWorkers = 0;
    this.lastIntegratedAt = 0;
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private update(snapshot: PublicSwarmSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
