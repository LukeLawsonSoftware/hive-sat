import type { PreviousSwarmAssignment, SwarmSnapshot } from "../../shared/swarm-protocol";
import { DistributedCubeRuntime, type CubeRuntimeOptions } from "./distributed/cubeRuntime";
import type { CoordinatorWebSocket } from "./jobCoordinatorSocket";
import { SwarmDirectorySocket } from "./swarmDirectorySocket";

export type PublicSwarmPhase =
  | "idle"
  | "directory"
  | "reconnecting"
  | "computing"
  | "no-work"
  | "paused"
  | "error";

export interface PublicSwarmSnapshot {
  phase: PublicSwarmPhase;
  jobId: string | null;
  activeWorkers: number;
  activeWorkerMs: number;
  capacity: number;
  currentTaskId: string | null;
  acceptedCubes: number;
  completedCubes: number;
  conflicts: number;
  decisions: number;
  propagations: number;
  uniqueJobsHelped: number;
  decisiveSatResults: number;
  certifiedUnsatResults: number;
  formulaBytesTransferred: number;
  wasmMemoryBytes: number;
  wasmMemoryHighWaterBytes: number;
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
    capacity: 1,
    currentTaskId: null,
    acceptedCubes: 0,
    completedCubes: 0,
    conflicts: 0,
    decisions: 0,
    propagations: 0,
    uniqueJobsHelped: 0,
    decisiveSatResults: 0,
    certifiedUnsatResults: 0,
    formulaBytesTransferred: 0,
    wasmMemoryBytes: 0,
    wasmMemoryHighWaterBytes: 0,
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
  private currentAssignmentId: string | null = null;
  private readonly helpedJobs = new Set<string>();
  private observedCube = {
    acceptedTasks: 0,
    completedTasks: 0,
    conflicts: 0,
    decisions: 0,
    propagations: 0,
    decisiveSatResults: 0,
    certifiedUnsatResults: 0,
    formulaBytesTransferred: 0,
  };

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

  reconfigureWorkers(workerPreference: number): void {
    const workers = Math.min(32, Math.max(1, Math.floor(workerPreference)));
    if (workers === this.options.workerPreference) return;
    const wasActive = ["directory", "reconnecting", "computing", "no-work"].includes(this.snapshot.phase);
    if (wasActive) this.pause();
    this.options.workerPreference = workers;
    this.update({ ...this.snapshot, capacity: workers });
    if (wasActive) this.start();
  }

  pause(): void {
    this.integrateWorkerTime();
    if (this.currentAssignmentId) {
      this.previousAssignment = {
        assignmentId: this.currentAssignmentId,
        activeWorkerMs: Math.round(this.assignmentWorkerMs),
      };
      this.currentAssignmentId = null;
    }
    this.directory?.stop();
    this.directory = null;
    this.finishCube();
    this.clearRetry();
    this.update({
      ...this.snapshot,
      phase: "paused",
      activeWorkers: 0,
      currentTaskId: null,
      wasmMemoryBytes: 0,
      jobId: null,
      message: "Public contribution is paused.",
    });
  }

  stop(): void {
    this.pause();
    this.previousAssignment = undefined;
    this.assignmentWorkerMs = 0;
    this.currentAssignmentId = null;
    this.update({ ...this.snapshot, phase: "idle", activeWorkerMs: 0, message: null });
  }

  private connectDirectory(): void {
    this.finishCube();
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
        maxWorkers: Math.min(32, Math.max(1, Math.floor(this.options.workerPreference ?? 1))),
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
        if (code === "UPGRADE_REQUIRED" || code === "INVALID_ASSIGNMENT") {
          this.update({ ...this.snapshot, phase: "error", message: `Directory protocol error: ${code}.` });
          return;
        }
        this.update({ ...this.snapshot, phase: "reconnecting", message: "Reconnecting to the swarm directory…" });
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.snapshot.phase === "reconnecting") this.connectDirectory();
        }, 3_000);
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
    this.currentAssignmentId = assignment.assignmentId;
    this.observedCube = {
      acceptedTasks: 0,
      completedTasks: 0,
      conflicts: 0,
      decisions: 0,
      propagations: 0,
      decisiveSatResults: 0,
      certifiedUnsatResults: 0,
      formulaBytesTransferred: 0,
    };
    this.helpedJobs.add(assignment.jobId);
    this.lastIntegratedAt = this.now();
    this.lastActiveWorkers = 0;
    const cube = new DistributedCubeRuntime({
      jobId: assignment.jobId,
      sessionId: this.sessionId,
      assignmentId: assignment.assignmentId,
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
      const acceptedCubes = this.snapshot.acceptedCubes +
        Math.max(0, value.acceptedTasks - this.observedCube.acceptedTasks);
      const completedCubes = this.snapshot.completedCubes +
        Math.max(0, value.completedTasks - this.observedCube.completedTasks);
      const conflicts = this.snapshot.conflicts +
        Math.max(0, value.conflicts - this.observedCube.conflicts);
      const decisions = this.snapshot.decisions +
        Math.max(0, value.decisions - this.observedCube.decisions);
      const propagations = this.snapshot.propagations +
        Math.max(0, value.propagations - this.observedCube.propagations);
      const decisiveSatResults = this.snapshot.decisiveSatResults +
        Math.max(0, value.decisiveSatResults - this.observedCube.decisiveSatResults);
      const certifiedUnsatResults = this.snapshot.certifiedUnsatResults +
        Math.max(0, value.certifiedUnsatResults - this.observedCube.certifiedUnsatResults);
      const formulaBytesTransferred = this.snapshot.formulaBytesTransferred +
        Math.max(0, value.formulaBytesTransferred - this.observedCube.formulaBytesTransferred);
      this.observedCube = {
        acceptedTasks: value.acceptedTasks,
        completedTasks: value.completedTasks,
        conflicts: value.conflicts,
        decisions: value.decisions,
        propagations: value.propagations,
        decisiveSatResults: value.decisiveSatResults,
        certifiedUnsatResults: value.certifiedUnsatResults,
        formulaBytesTransferred: value.formulaBytesTransferred,
      };
      this.update({
        ...this.snapshot,
        phase: "computing",
        jobId: assignment.jobId,
        activeWorkers: value.activeWorkers,
        capacity: value.capacity,
        currentTaskId: value.currentTaskId,
        acceptedCubes,
        completedCubes,
        conflicts,
        decisions,
        propagations,
        uniqueJobsHelped: this.helpedJobs.size,
        decisiveSatResults,
        certifiedUnsatResults,
        formulaBytesTransferred,
        wasmMemoryBytes: value.wasmMemoryBytes,
        wasmMemoryHighWaterBytes: Math.max(
          this.snapshot.wasmMemoryHighWaterBytes,
          value.wasmMemoryHighWaterBytes,
        ),
        message: value.message,
      });
      if (value.phase === "complete" || value.phase === "error") {
        this.completeAssignment(
          assignment.assignmentId,
          value.phase === "error" ? value.message ?? "The assigned solver failed." : null,
        );
      }
    });
    this.update({
      ...this.snapshot,
      phase: "computing",
      jobId: assignment.jobId,
      capacity: assignment.workers,
      uniqueJobsHelped: this.helpedJobs.size,
      message: "Loading the assigned public formula…",
    });
    this.assignmentTimer = setTimeout(
      () => this.completeAssignment(assignment.assignmentId),
      assignment.quantumMs,
    );
    void cube.start();
  }

  private completeAssignment(assignmentId: string, failureMessage: string | null = null): void {
    if (!this.cube) return;
    this.integrateWorkerTime();
    this.previousAssignment = {
      assignmentId,
      activeWorkerMs: Math.round(this.assignmentWorkerMs),
    };
    this.currentAssignmentId = null;
    this.finishCube();
    if (this.snapshot.phase === "paused") return;
    if (!failureMessage) {
      this.connectDirectory();
      return;
    }
    this.update({
      ...this.snapshot,
      phase: "reconnecting",
      jobId: null,
      activeWorkers: 0,
      currentTaskId: null,
      message: `${failureMessage} Retrying in 30 seconds…`,
    });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.snapshot.phase === "reconnecting") this.connectDirectory();
    }, 30_000);
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

  private finishCube(): void {
    if (this.assignmentTimer !== null) clearTimeout(this.assignmentTimer);
    this.assignmentTimer = null;
    this.unsubscribeCube?.();
    this.unsubscribeCube = null;
    // PublicSwarmRuntime never reuses a completed assignment runtime. Yield
    // leased tasks first, then terminate its workers so pausing/reconfiguring
    // cannot leak Web Workers or Wasm memories in the background.
    this.cube?.pause();
    this.cube?.stop();
    this.cube = null;
    this.lastActiveWorkers = 0;
    this.lastIntegratedAt = 0;
    if (this.snapshot.wasmMemoryBytes !== 0 || this.snapshot.currentTaskId !== null) {
      this.snapshot = { ...this.snapshot, wasmMemoryBytes: 0, currentTaskId: null };
    }
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
