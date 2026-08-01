import { PUBLIC_JOB_PROTOCOL_VERSION } from "./public-jobs";
import { parseResultManifest, type ResultManifest } from "./result-manifest";

export const COORDINATOR_HEARTBEAT_INTERVAL_MS = 60_000;
export const COORDINATOR_LEASE_DURATION_MS = 5 * 60_000;
export const COORDINATOR_LEASE_RENEW_THRESHOLD_MS = 3 * 60_000;
export const COORDINATOR_MAX_LEASE_TENURE_MS = 60 * 60_000;
export const COORDINATOR_MAX_MESSAGE_BYTES = 16 * 1024;
export const COORDINATOR_ALARM_BATCH_SIZE = 64;
export const COORDINATOR_MAX_CUBE_DEPTH = 64;
export const COORDINATOR_MAX_TASKS = 10_000;
export const COORDINATOR_MAX_SLOTS = 32;
export const COORDINATOR_MAX_FRONTIER = 16;
export const COORDINATOR_SPLIT_SEED_MS = 1_000;
export const COORDINATOR_SPLIT_PERMIT_MS = 2 * 60_000;

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
  proofGeneration?: boolean;
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
  slotId: string;
  leaseCount: number;
  issuedAt: number;
  expiresAt: number;
  maximumExpiresAt: number;
}

interface MessageBase {
  protocolVersion: typeof PUBLIC_JOB_PROTOCOL_VERSION;
  messageId: string;
  jobId: string;
}

export interface HelloMessage extends MessageBase {
  type: "HELLO";
  sessionId: string;
  assignmentId?: string;
  slotIds: string[];
  capabilities: WorkerCapabilities;
}

export interface SessionHeartbeatSlot {
  slotId: string;
  leaseId: string | null;
  activeMs: number;
  conflicts: number;
  decisions: number;
  propagations: number;
}

export interface SessionHeartbeatMessage extends MessageBase {
  type: "SESSION_HEARTBEAT";
  slots: SessionHeartbeatSlot[];
}

export interface SplitMessage extends MessageBase {
  type: "SPLIT";
  slotId: string;
  taskId: string;
  leaseId: string;
  permitId: string;
  splitLiteral: number;
}

export interface YieldMessage extends MessageBase {
  type: "YIELD";
  slotId: string;
  taskId: string;
  leaseId: string;
  reason: "PAUSED" | "SHUTDOWN" | "UNSUPPORTED" | "WORKER_ERROR";
}

export interface ResultMessage extends MessageBase {
  type: "RESULT";
  slotId: string;
  taskId: string;
  leaseId: string;
  result: "SAT" | "UNSAT";
  evidenceSha256: string;
  manifest: ResultManifest;
}

export type CoordinatorClientMessage =
  | HelloMessage
  | SessionHeartbeatMessage
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
  activeLeases: Array<{ slotId: string; task: CubeTask; lease: Lease }>;
}

export interface WorkMessage extends ServerMessageBase {
  type: "WORK";
  slotId: string;
  requestMessageId?: string;
  task: CubeTask;
  lease: Lease;
}

export interface SplitPermitMessage extends ServerMessageBase {
  type: "SPLIT_PERMIT";
  permitId: string;
  slotId: string;
  taskId: string;
  leaseId: string;
  expiresAt: number;
}

export interface AckMessage extends ServerMessageBase {
  type: "ACK";
  requestMessageId: string;
  action: "SESSION_HEARTBEAT" | "SPLIT" | "YIELD" | "RESULT";
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
    | "SPLIT_NOT_NEEDED"
    | "SESSION_QUARANTINED"
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

export interface JobSuspendedMessage extends ServerMessageBase {
  type: "JOB_SUSPENDED";
  reason: "OWNER_ACTION_REQUIRED";
}

export type CoordinatorServerMessage =
  | WelcomeMessage
  | WorkMessage
  | SplitPermitMessage
  | AckMessage
  | CoordinatorErrorMessage
  | JobCancelledMessage
  | JobSuspendedMessage
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
    (value.proofGeneration !== undefined && typeof value.proofGeneration !== "boolean") ||
    (value.calibratedConflictsPerSecond !== undefined &&
      !isBoundedInteger(value.calibratedConflictsPerSecond, 1, 10_000_000))
  ) return null;
  return {
    hardwareConcurrency: value.hardwareConcurrency,
    maxWorkers: value.maxWorkers,
    mobile: value.mobile,
    solverVersion: value.solverVersion,
    ...(typeof value.proofGeneration === "boolean"
      ? { proofGeneration: value.proofGeneration }
      : {}),
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
    if (!isId(value.sessionId) || !capabilities ||
      !Array.isArray(value.slotIds) || value.slotIds.length < 1 ||
      value.slotIds.length > COORDINATOR_MAX_SLOTS ||
      value.slotIds.length !== capabilities.maxWorkers ||
      !value.slotIds.every(isId) || new Set(value.slotIds).size !== value.slotIds.length ||
      (value.assignmentId !== undefined && !isId(value.assignmentId))) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    return {
      ok: true,
      message: {
        ...base,
        type: "HELLO",
        sessionId: value.sessionId,
        slotIds: [...value.slotIds] as string[],
        ...(typeof value.assignmentId === "string" ? { assignmentId: value.assignmentId } : {}),
        capabilities,
      },
    };
  }
  if (value.type === "SESSION_HEARTBEAT") {
    if (!Array.isArray(value.slots) || value.slots.length > COORDINATOR_MAX_SLOTS) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    const slots: SessionHeartbeatSlot[] = [];
    for (const slot of value.slots) {
      if (!isRecord(slot) || !isId(slot.slotId) ||
        (slot.leaseId !== null && !isId(slot.leaseId)) ||
        !isBoundedInteger(slot.activeMs, 0, COORDINATOR_MAX_LEASE_TENURE_MS) ||
        !isBoundedInteger(slot.conflicts, 0, Number.MAX_SAFE_INTEGER) ||
        !isBoundedInteger(slot.decisions, 0, Number.MAX_SAFE_INTEGER) ||
        !isBoundedInteger(slot.propagations, 0, Number.MAX_SAFE_INTEGER)) {
        return { ok: false, code: "INVALID_MESSAGE" };
      }
      slots.push({
        slotId: slot.slotId,
        leaseId: slot.leaseId,
        activeMs: slot.activeMs,
        conflicts: slot.conflicts,
        decisions: slot.decisions,
        propagations: slot.propagations,
      });
    }
    if (new Set(slots.map((slot) => slot.slotId)).size !== slots.length) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    return { ok: true, message: { ...base, type: "SESSION_HEARTBEAT", slots } };
  }
  if (!isId(value.taskId) || !isId(value.leaseId)) return { ok: false, code: "INVALID_MESSAGE" };
  if (value.type === "SPLIT") {
    if (!isId(value.slotId) || !isId(value.permitId) ||
      !isBoundedInteger(value.splitLiteral, -0x7fff_ffff, 0x7fff_ffff) || value.splitLiteral === 0) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    return { ok: true, message: { ...base, type: "SPLIT", slotId: value.slotId, taskId: value.taskId, leaseId: value.leaseId, permitId: value.permitId, splitLiteral: value.splitLiteral } };
  }
  if (value.type === "YIELD") {
    if (!isId(value.slotId) || !(["PAUSED", "SHUTDOWN", "UNSUPPORTED", "WORKER_ERROR"] as const).includes(value.reason as YieldMessage["reason"])) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    return { ok: true, message: { ...base, type: "YIELD", slotId: value.slotId, taskId: value.taskId, leaseId: value.leaseId, reason: value.reason as YieldMessage["reason"] } };
  }
  if (value.type === "RESULT") {
    const manifest = parseResultManifest(value.manifest);
    if (!isId(value.slotId) || (value.result !== "SAT" && value.result !== "UNSAT") ||
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
        slotId: value.slotId,
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
    !isId(value.slotId) ||
    !isBoundedInteger(value.leaseCount, 1, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.issuedAt, 0, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.expiresAt, 0, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(value.maximumExpiresAt, 0, Number.MAX_SAFE_INTEGER) ||
    value.expiresAt < value.issuedAt || value.maximumExpiresAt < value.expiresAt
  ) return null;
  return {
    leaseId: value.leaseId,
    taskId: value.taskId,
    slotId: value.slotId,
    leaseCount: value.leaseCount,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    maximumExpiresAt: value.maximumExpiresAt,
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
      if (!isRecord(item) || !isId(item.slotId)) return { ok: false, code: "INVALID_MESSAGE" };
      const task = parseCubeTask(item.task);
      const lease = parseLease(item.lease);
      if (!task || !lease || task.taskId !== lease.taskId || item.slotId !== lease.slotId) {
        return { ok: false, code: "INVALID_MESSAGE" };
      }
      activeLeases.push({ slotId: item.slotId, task, lease });
    }
    return { ok: true, message: { ...base, type: "WELCOME", heartbeatIntervalMs: value.heartbeatIntervalMs, leaseDurationMs: value.leaseDurationMs, activeLeases } };
  }
  if (value.type === "WORK") {
    const task = parseCubeTask(value.task);
    const lease = parseLease(value.lease);
    if (!isId(value.slotId) ||
      (value.requestMessageId !== undefined && !isId(value.requestMessageId)) ||
      !task || !lease || task.taskId !== lease.taskId || value.slotId !== lease.slotId) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    return {
      ok: true,
      message: {
        ...base,
        type: "WORK",
        slotId: value.slotId,
        ...(typeof value.requestMessageId === "string" ? { requestMessageId: value.requestMessageId } : {}),
        task,
        lease,
      },
    };
  }
  if (value.type === "SPLIT_PERMIT") {
    if (!isId(value.permitId) || !isId(value.slotId) || !isId(value.taskId) ||
      !isId(value.leaseId) || !isBoundedInteger(value.expiresAt, 0, Number.MAX_SAFE_INTEGER)) {
      return { ok: false, code: "INVALID_MESSAGE" };
    }
    return {
      ok: true,
      message: {
        ...base,
        type: "SPLIT_PERMIT",
        permitId: value.permitId,
        slotId: value.slotId,
        taskId: value.taskId,
        leaseId: value.leaseId,
        expiresAt: value.expiresAt,
      },
    };
  }
  if (value.type === "ACK") {
    if (!isId(value.requestMessageId) ||
      !(["SESSION_HEARTBEAT", "SPLIT", "YIELD", "RESULT"] as const).includes(value.action as AckMessage["action"]) ||
      (value.staleLease !== undefined && typeof value.staleLease !== "boolean")
    ) return { ok: false, code: "INVALID_MESSAGE" };
    return {
      ok: true,
      message: {
        ...base,
        type: "ACK",
        requestMessageId: value.requestMessageId,
        action: value.action as AckMessage["action"],
        ...(typeof value.staleLease === "boolean" ? { staleLease: value.staleLease } : {}),
      },
    };
  }
  if (value.type === "ERROR") {
    const codes: CoordinatorErrorMessage["code"][] = [
      "INVALID_MESSAGE", "UPGRADE_REQUIRED", "JOB_MISMATCH", "HELLO_REQUIRED",
      "INVALID_STATE", "STALE_LEASE", "SPLIT_NOT_NEEDED", "TASK_LIMIT",
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
  if (value.type === "JOB_SUSPENDED" && value.reason === "OWNER_ACTION_REQUIRED") {
    return { ok: true, message: { ...base, type: "JOB_SUSPENDED", reason: value.reason } };
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
