import { PUBLIC_JOB_PROTOCOL_VERSION } from "./public-jobs";
import { parseResultManifest, type ResultManifest } from "./result-manifest";

export const COORDINATOR_HEARTBEAT_INTERVAL_MS = 60_000;
export const COORDINATOR_LEASE_DURATION_MS = 15 * 60_000;
export const COORDINATOR_LEASE_EXTENSION_MS = 5 * 60_000;
export const COORDINATOR_MAX_MESSAGE_BYTES = 16 * 1024;
export const COORDINATOR_MAX_TASK_ATTEMPTS = 5;
export const COORDINATOR_ALARM_BATCH_SIZE = 64;
export const COORDINATOR_MAX_CUBE_DEPTH = 64;
export const COORDINATOR_MAX_TASKS = 10_000;

export type TaskState =
  | "READY"
  | "LEASED"
  | "SPLIT"
  | "YIELDED"
  | "SAT_CANDIDATE"
  | "VERIFYING_SAT"
  | "SAT_VERIFIED"
  | "UNSAT_CANDIDATE"
  | "PROOF_PENDING"
  | "VERIFYING_UNSAT"
  | "UNSAT_CERTIFIED"
  | "UNSAT_OWNER_VERIFIED"
  | "UNKNOWN"
  | "CANCELLED";

export interface WorkerCapabilities {
  hardwareConcurrency: number;
  maxWorkers: number;
  mobile: boolean;
  solverVersion: string;
  calibratedConflictsPerSecond?: number;
}

export interface CubeTask {
  taskId: string;
  parentTaskId: string | null;
  depth: number;
  assumptions: number[];
  purpose: "SEARCH" | "PROOF_FINISHER";
}

export interface Lease {
  leaseId: string;
  taskId: string;
  attempt: number;
  issuedAt: number;
  expiresAt: number;
}

export interface CubeQueueSnapshot {
  readyTasks: number;
  activeWorkers: number;
  lowWatermark: number;
  targetWatermark: number;
  highWatermark: number;
  taskCount: number;
  canSplit: boolean;
}

export function cubeQueueWatermarks(activeWorkers: number): Pick<
  CubeQueueSnapshot,
  "lowWatermark" | "targetWatermark" | "highWatermark"
> {
  const workers = Math.max(1, Math.floor(activeWorkers));
  return {
    lowWatermark: workers,
    targetWatermark: workers * 3,
    highWatermark: workers * 8,
  };
}

interface MessageBase {
  protocolVersion: typeof PUBLIC_JOB_PROTOCOL_VERSION;
  messageId: string;
  jobId: string;
}

export interface HelloMessage extends MessageBase {
  type: "HELLO";
  sessionId: string;
  capabilities: WorkerCapabilities;
}

export interface RequestWorkMessage extends MessageBase {
  type: "REQUEST_WORK";
}

export interface HeartbeatMessage extends MessageBase {
  type: "HEARTBEAT";
  taskId: string;
  leaseId: string;
  progress: {
    activeMs: number;
    conflicts: number;
    decisions: number;
    propagations: number;
  };
  requestExtension?: true;
}

export interface SplitMessage extends MessageBase {
  type: "SPLIT";
  taskId: string;
  leaseId: string;
  splitLiteral: number;
}

export interface YieldMessage extends MessageBase {
  type: "YIELD";
  taskId: string;
  leaseId: string;
  reason: "BUDGET" | "PAUSED" | "SHUTDOWN" | "UNSUPPORTED";
}

export interface ResultMessage extends MessageBase {
  type: "RESULT";
  taskId: string;
  leaseId: string;
  result: "SAT" | "UNSAT";
  evidenceSha256: string;
  manifest: ResultManifest;
}

export type CoordinatorClientMessage =
  | HelloMessage
  | RequestWorkMessage
  | HeartbeatMessage
  | SplitMessage
  | YieldMessage
  | ResultMessage;

interface ServerMessageBase extends MessageBase {
  serverTime: number;
}

export interface WelcomeMessage extends ServerMessageBase {
  type: "WELCOME";
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
  activeLeases: Array<{ task: CubeTask; lease: Lease }>;
}

export interface WorkMessage extends ServerMessageBase {
  type: "WORK";
  requestMessageId: string;
  task: CubeTask;
  lease: Lease;
  queue: CubeQueueSnapshot;
}

export interface NoWorkMessage extends ServerMessageBase {
  type: "NO_WORK";
  requestMessageId: string;
  retryAfterMs: number;
}

export interface AckMessage extends ServerMessageBase {
  type: "ACK";
  requestMessageId: string;
  action: "HEARTBEAT" | "SPLIT" | "YIELD" | "RESULT";
  leaseExpiresAt?: number;
  staleLease?: boolean;
}

export interface CoordinatorErrorMessage extends ServerMessageBase {
  type: "ERROR";
  requestMessageId?: string;
  code:
    | "INVALID_MESSAGE"
    | "UPGRADE_REQUIRED"
    | "JOB_MISMATCH"
    | "HELLO_REQUIRED"
    | "INVALID_STATE"
    | "STALE_LEASE"
    | "SESSION_QUARANTINED"
    | "ATTEMPTS_EXHAUSTED"
    | "TASK_LIMIT";
  retryable: boolean;
}

export interface JobCancelledMessage extends ServerMessageBase {
  type: "JOB_CANCELLED";
  reason: "OWNER_CANCELLED" | "EXPIRED";
}

export interface JobResultMessage extends ServerMessageBase {
  type: "JOB_RESULT";
  result: "SAT_VERIFIED" | "UNSAT_CERTIFIED" | "UNSAT_OWNER_VERIFIED";
  taskId: string;
}

export type CoordinatorServerMessage =
  | WelcomeMessage
  | WorkMessage
  | NoWorkMessage
  | AckMessage
  | CoordinatorErrorMessage
  | JobCancelledMessage
  | JobResultMessage;

export type CoordinatorMessageParseResult =
  | { ok: true; message: CoordinatorClientMessage }
  | { ok: false; code: "INVALID_MESSAGE" | "UPGRADE_REQUIRED" };

export type CoordinatorServerMessageParseResult =
  | { ok: true; message: CoordinatorServerMessage }
  | { ok: false; code: "INVALID_MESSAGE" | "UPGRADE_REQUIRED" };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function hasBase(value: Record<string, unknown>): boolean {
  return isId(value.messageId) && isId(value.jobId);
}

export function parseWorkerCapabilities(value: unknown): WorkerCapabilities | null {
  if (!isRecord(value)) return null;
  if (
    !isBoundedInteger(value.hardwareConcurrency, 1, 256) ||
    !isBoundedInteger(value.maxWorkers, 1, 32) ||
    typeof value.mobile !== "boolean" ||
    typeof value.solverVersion !== "string" ||
    value.solverVersion.length < 1 ||
    value.solverVersion.length > 64 ||
    (value.calibratedConflictsPerSecond !== undefined &&
      !isBoundedInteger(value.calibratedConflictsPerSecond, 1, 10_000_000))
  ) return null;
  return {
    hardwareConcurrency: value.hardwareConcurrency,
    maxWorkers: value.maxWorkers,
    mobile: value.mobile,
    solverVersion: value.solverVersion,
    ...(typeof value.calibratedConflictsPerSecond === "number"
      ? { calibratedConflictsPerSecond: value.calibratedConflictsPerSecond }
      : {}),
  };
}

export function parseCoordinatorClientMessage(value: unknown): CoordinatorMessageParseResult {
  if (!isRecord(value)) return { ok: false, code: "INVALID_MESSAGE" };
  if (value.protocolVersion !== PUBLIC_JOB_PROTOCOL_VERSION) {
    return { ok: false, code: "UPGRADE_REQUIRED" };
  }
  if (!hasBase(value) || typeof value.type !== "string") {
    return { ok: false, code: "INVALID_MESSAGE" };
  }
  const base = {
    protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
    messageId: value.messageId as string,
    jobId: value.jobId as string,
  };
  if (value.type === "HELLO") {
    const capabilities = parseWorkerCapabilities(value.capabilities);
    if (!isId(value.sessionId) || !capabilities) return { ok: false, code: "INVALID_MESSAGE" };
    return { ok: true, message: { ...base, type: "HELLO", sessionId: value.sessionId, capabilities } };
  }
  if (value.type === "REQUEST_WORK") {
    return { ok: true, message: { ...base, type: "REQUEST_WORK" } };
  }
  if (!isId(value.taskId) || !isId(value.leaseId)) return { ok: false, code: "INVALID_MESSAGE" };
  if (value.type === "HEARTBEAT") {
    if (!isRecord(value.progress)) return { ok: false, code: "INVALID_MESSAGE" };
    const progress = value.progress;
    if (
      !isBoundedInteger(progress.activeMs, 0, 3_600_000) ||
      !isBoundedInteger(progress.conflicts, 0, Number.MAX_SAFE_INTEGER) ||
      !isBoundedInteger(progress.decisions, 0, Number.MAX_SAFE_INTEGER) ||
      !isBoundedInteger(progress.propagations, 0, Number.MAX_SAFE_INTEGER) ||
      (value.requestExtension !== undefined && value.requestExtension !== true)
    ) return { ok: false, code: "INVALID_MESSAGE" };
    return {
      ok: true,
      message: {
        ...base,
        type: "HEARTBEAT",
        taskId: value.taskId,
        leaseId: value.leaseId,
        progress: {
          activeMs: progress.activeMs,
          conflicts: progress.conflicts,
          decisions: progress.decisions,
          propagations: progress.propagations,
        },
        ...(value.requestExtension === true ? { requestExtension: true as const } : {}),
      },
    };
  }
  if (value.type === "SPLIT") {
    if (!isBoundedInteger(value.splitLiteral, -0x7fff_ffff, 0x7fff_ffff) || value.splitLiteral === 0) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    return { ok: true, message: { ...base, type: "SPLIT", taskId: value.taskId, leaseId: value.leaseId, splitLiteral: value.splitLiteral } };
  }
  if (value.type === "YIELD") {
    if (!(["BUDGET", "PAUSED", "SHUTDOWN", "UNSUPPORTED"] as const).includes(value.reason as YieldMessage["reason"])) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    return { ok: true, message: { ...base, type: "YIELD", taskId: value.taskId, leaseId: value.leaseId, reason: value.reason as YieldMessage["reason"] } };
  }
  if (value.type === "RESULT") {
    const manifest = parseResultManifest(value.manifest);
    if ((value.result !== "SAT" && value.result !== "UNSAT") ||
      typeof value.evidenceSha256 !== "string" ||
      !SHA256_PATTERN.test(value.evidenceSha256) ||
      !manifest ||
      manifest.taskId !== value.taskId ||
      (value.result === "SAT" && manifest.kind !== "SAT_MODEL_V1") ||
      (value.result === "UNSAT" && manifest.kind !== "UNSAT_CANDIDATE_V1" && manifest.kind !== "UNSAT_PROOF_V1") ||
      (manifest.kind === "SAT_MODEL_V1" && manifest.artifactSha256 !== value.evidenceSha256)
      || (manifest.kind === "UNSAT_PROOF_V1" && manifest.artifactSha256 !== value.evidenceSha256)
    ) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    return {
      ok: true,
      message: {
        ...base,
        type: "RESULT",
        taskId: value.taskId,
        leaseId: value.leaseId,
        result: value.result,
        evidenceSha256: value.evidenceSha256,
        manifest,
      },
    };
  }
  return { ok: false, code: "INVALID_MESSAGE" };
}

function parseCubeTask(value: unknown): CubeTask | null {
  if (!isRecord(value) || !isId(value.taskId) ||
    (value.parentTaskId !== null && !isId(value.parentTaskId)) ||
    !isBoundedInteger(value.depth, 0, 64) || !Array.isArray(value.assumptions) ||
    value.assumptions.length > 64 ||
    (value.purpose !== "SEARCH" && value.purpose !== "PROOF_FINISHER") ||
    !value.assumptions.every((literal) => isBoundedInteger(literal, -0x7fff_ffff, 0x7fff_ffff) && literal !== 0)
  ) return null;
  return {
    taskId: value.taskId,
    parentTaskId: value.parentTaskId,
    depth: value.depth,
    assumptions: [...value.assumptions] as number[],
    purpose: value.purpose,
  };
}

function parseLease(value: unknown): Lease | null {
  if (!isRecord(value) || !isId(value.leaseId) || !isId(value.taskId) ||
    !isBoundedInteger(value.attempt, 1, COORDINATOR_MAX_TASK_ATTEMPTS) ||
    !isBoundedInteger(value.issuedAt, 0, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.expiresAt, 0, Number.MAX_SAFE_INTEGER) ||
    value.expiresAt < value.issuedAt
  ) return null;
  return {
    leaseId: value.leaseId,
    taskId: value.taskId,
    attempt: value.attempt,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
}

function parseQueueSnapshot(value: unknown): CubeQueueSnapshot | null {
  if (!isRecord(value) ||
    !isBoundedInteger(value.readyTasks, 0, COORDINATOR_MAX_TASKS) ||
    !isBoundedInteger(value.activeWorkers, 1, 32) ||
    !isBoundedInteger(value.lowWatermark, 1, COORDINATOR_MAX_TASKS) ||
    !isBoundedInteger(value.targetWatermark, 1, COORDINATOR_MAX_TASKS) ||
    !isBoundedInteger(value.highWatermark, 1, COORDINATOR_MAX_TASKS) ||
    !isBoundedInteger(value.taskCount, 1, COORDINATOR_MAX_TASKS) ||
    typeof value.canSplit !== "boolean" ||
    value.lowWatermark > value.targetWatermark ||
    value.targetWatermark > value.highWatermark
  ) return null;
  return {
    readyTasks: value.readyTasks,
    activeWorkers: value.activeWorkers,
    lowWatermark: value.lowWatermark,
    targetWatermark: value.targetWatermark,
    highWatermark: value.highWatermark,
    taskCount: value.taskCount,
    canSplit: value.canSplit,
  };
}

export function parseCoordinatorServerMessage(value: unknown): CoordinatorServerMessageParseResult {
  if (!isRecord(value)) return { ok: false, code: "INVALID_MESSAGE" };
  if (value.protocolVersion !== PUBLIC_JOB_PROTOCOL_VERSION) return { ok: false, code: "UPGRADE_REQUIRED" };
  if (!hasBase(value) || typeof value.type !== "string" ||
    !isBoundedInteger(value.serverTime, 0, Number.MAX_SAFE_INTEGER)
  ) return { ok: false, code: "INVALID_MESSAGE" };
  const base = {
    protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
    messageId: value.messageId as string,
    jobId: value.jobId as string,
    serverTime: value.serverTime,
  };
  if (value.type === "WELCOME") {
    if (!isBoundedInteger(value.heartbeatIntervalMs, 1_000, 3_600_000) ||
      !isBoundedInteger(value.leaseDurationMs, 1_000, 24 * 60 * 60_000) ||
      !Array.isArray(value.activeLeases) || value.activeLeases.length > 32
    ) return { ok: false, code: "INVALID_MESSAGE" };
    const activeLeases: WelcomeMessage["activeLeases"] = [];
    for (const item of value.activeLeases) {
      if (!isRecord(item)) return { ok: false, code: "INVALID_MESSAGE" };
      const task = parseCubeTask(item.task);
      const lease = parseLease(item.lease);
      if (!task || !lease || task.taskId !== lease.taskId) return { ok: false, code: "INVALID_MESSAGE" };
      activeLeases.push({ task, lease });
    }
    return { ok: true, message: { ...base, type: "WELCOME", heartbeatIntervalMs: value.heartbeatIntervalMs, leaseDurationMs: value.leaseDurationMs, activeLeases } };
  }
  if (value.type === "WORK") {
    const task = parseCubeTask(value.task);
    const lease = parseLease(value.lease);
    const queue = parseQueueSnapshot(value.queue);
    if (!isId(value.requestMessageId) || !task || !lease || !queue || task.taskId !== lease.taskId) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    return { ok: true, message: { ...base, type: "WORK", requestMessageId: value.requestMessageId, task, lease, queue } };
  }
  if (value.type === "NO_WORK") {
    if (!isId(value.requestMessageId) || !isBoundedInteger(value.retryAfterMs, 0, 3_600_000)) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    return { ok: true, message: { ...base, type: "NO_WORK", requestMessageId: value.requestMessageId, retryAfterMs: value.retryAfterMs } };
  }
  if (value.type === "ACK") {
    if (!isId(value.requestMessageId) ||
      !(["HEARTBEAT", "SPLIT", "YIELD", "RESULT"] as const).includes(value.action as AckMessage["action"]) ||
      (value.leaseExpiresAt !== undefined && !isBoundedInteger(value.leaseExpiresAt, 0, Number.MAX_SAFE_INTEGER)) ||
      (value.staleLease !== undefined && typeof value.staleLease !== "boolean")
    ) return { ok: false, code: "INVALID_MESSAGE" };
    return {
      ok: true,
      message: {
        ...base,
        type: "ACK",
        requestMessageId: value.requestMessageId,
        action: value.action as AckMessage["action"],
        ...(typeof value.leaseExpiresAt === "number" ? { leaseExpiresAt: value.leaseExpiresAt } : {}),
        ...(typeof value.staleLease === "boolean" ? { staleLease: value.staleLease } : {}),
      },
    };
  }
  if (value.type === "ERROR") {
    const codes: CoordinatorErrorMessage["code"][] = [
      "INVALID_MESSAGE", "UPGRADE_REQUIRED", "JOB_MISMATCH", "HELLO_REQUIRED",
      "INVALID_STATE", "STALE_LEASE", "ATTEMPTS_EXHAUSTED", "TASK_LIMIT",
      "SESSION_QUARANTINED",
    ];
    if (!codes.includes(value.code as CoordinatorErrorMessage["code"]) ||
      typeof value.retryable !== "boolean" ||
      (value.requestMessageId !== undefined && !isId(value.requestMessageId))
    ) return { ok: false, code: "INVALID_MESSAGE" };
    return {
      ok: true,
      message: {
        ...base,
        type: "ERROR",
        code: value.code as CoordinatorErrorMessage["code"],
        retryable: value.retryable,
        ...(typeof value.requestMessageId === "string" ? { requestMessageId: value.requestMessageId } : {}),
      },
    };
  }
  if (value.type === "JOB_CANCELLED" && (value.reason === "OWNER_CANCELLED" || value.reason === "EXPIRED")) {
    return { ok: true, message: { ...base, type: "JOB_CANCELLED", reason: value.reason } };
  }
  if (value.type === "JOB_RESULT" &&
    (["SAT_VERIFIED", "UNSAT_CERTIFIED", "UNSAT_OWNER_VERIFIED"] as const).includes(value.result as JobResultMessage["result"]) &&
    isId(value.taskId)) {
    return {
      ok: true,
      message: {
        ...base,
        type: "JOB_RESULT",
        result: value.result as JobResultMessage["result"],
        taskId: value.taskId,
      },
    };
  }
  return { ok: false, code: "INVALID_MESSAGE" };
}
