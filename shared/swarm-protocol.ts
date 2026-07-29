import {
  parseWorkerCapabilities,
  type WorkerCapabilities,
} from "./coordinator-protocol";
import { PUBLIC_JOB_PROTOCOL_VERSION } from "./public-jobs";

export const SWARM_ASSIGNMENT_QUANTUM_MS = 60 * 60_000;
export const SWARM_MAX_JOB_WORKERS = 8;
export const SWARM_NO_WORK_RETRY_MS = 30_000;
export const SWARM_MAX_MESSAGE_BYTES = 8 * 1024;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export interface PreviousSwarmAssignment {
  assignmentId: string;
  activeWorkerMs: number;
}

export interface SwarmHelloMessage {
  type: "SWARM_HELLO";
  protocolVersion: typeof PUBLIC_JOB_PROTOCOL_VERSION;
  messageId: string;
  sessionId: string;
  capabilities: WorkerCapabilities;
  previousAssignment?: PreviousSwarmAssignment;
}

export type SwarmClientMessage = SwarmHelloMessage;

export interface SwarmSnapshot {
  activeJobs: number;
  activeWorkers: number;
}

interface SwarmServerBase {
  protocolVersion: typeof PUBLIC_JOB_PROTOCOL_VERSION;
  messageId: string;
  requestMessageId: string;
  serverTime: number;
  snapshot: SwarmSnapshot;
}

export interface SwarmAssignmentMessage extends SwarmServerBase {
  type: "SWARM_ASSIGNMENT";
  assignmentId: string;
  jobId: string;
  workers: number;
  quantumMs: number;
  reservedWorkerMs: number;
  conflictBudget: number;
  leaseTargetMs: number;
}

export interface SwarmNoWorkMessage extends SwarmServerBase {
  type: "SWARM_NO_WORK";
  retryAfterMs: number;
}

export interface SwarmErrorMessage extends SwarmServerBase {
  type: "SWARM_ERROR";
  code: "INVALID_MESSAGE" | "UPGRADE_REQUIRED" | "INVALID_ASSIGNMENT";
  retryable: boolean;
}

export type SwarmServerMessage =
  | SwarmAssignmentMessage
  | SwarmNoWorkMessage
  | SwarmErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function parseSnapshot(value: unknown): SwarmSnapshot | null {
  if (
    !isRecord(value) ||
    !boundedInteger(value.activeJobs, 0, 100_000) ||
    !boundedInteger(value.activeWorkers, 0, 1_000_000)
  ) return null;
  return { activeJobs: value.activeJobs, activeWorkers: value.activeWorkers };
}

export function parseSwarmClientMessage(value: unknown):
  | { ok: true; message: SwarmClientMessage }
  | { ok: false; code: "INVALID_MESSAGE" | "UPGRADE_REQUIRED" } {
  if (!isRecord(value)) return { ok: false, code: "INVALID_MESSAGE" };
  if (value.protocolVersion !== PUBLIC_JOB_PROTOCOL_VERSION) {
    return { ok: false, code: "UPGRADE_REQUIRED" };
  }
  if (
    value.type !== "SWARM_HELLO" ||
    !isId(value.messageId) ||
    !isId(value.sessionId)
  ) return { ok: false, code: "INVALID_MESSAGE" };
  const capabilities = parseWorkerCapabilities(value.capabilities);
  if (!capabilities) return { ok: false, code: "INVALID_MESSAGE" };
  let previousAssignment: PreviousSwarmAssignment | undefined;
  if (value.previousAssignment !== undefined) {
    if (
      !isRecord(value.previousAssignment) ||
      !isId(value.previousAssignment.assignmentId) ||
      !boundedInteger(value.previousAssignment.activeWorkerMs, 0, SWARM_ASSIGNMENT_QUANTUM_MS * 32)
    ) return { ok: false, code: "INVALID_MESSAGE" };
    previousAssignment = {
      assignmentId: value.previousAssignment.assignmentId,
      activeWorkerMs: value.previousAssignment.activeWorkerMs,
    };
  }
  return {
    ok: true,
    message: {
      type: "SWARM_HELLO",
      protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
      messageId: value.messageId,
      sessionId: value.sessionId,
      capabilities,
      ...(previousAssignment ? { previousAssignment } : {}),
    },
  };
}

export function parseSwarmServerMessage(value: unknown):
  | { ok: true; message: SwarmServerMessage }
  | { ok: false; code: "INVALID_MESSAGE" | "UPGRADE_REQUIRED" } {
  if (!isRecord(value)) return { ok: false, code: "INVALID_MESSAGE" };
  if (value.protocolVersion !== PUBLIC_JOB_PROTOCOL_VERSION) {
    return { ok: false, code: "UPGRADE_REQUIRED" };
  }
  const snapshot = parseSnapshot(value.snapshot);
  if (
    !snapshot ||
    !isId(value.messageId) ||
    !isId(value.requestMessageId) ||
    !boundedInteger(value.serverTime, 0, Number.MAX_SAFE_INTEGER)
  ) return { ok: false, code: "INVALID_MESSAGE" };
  const base = {
    protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
    messageId: value.messageId,
    requestMessageId: value.requestMessageId,
    serverTime: value.serverTime,
    snapshot,
  } as const;
  if (
    value.type === "SWARM_ASSIGNMENT" &&
    isId(value.assignmentId) &&
    isId(value.jobId) &&
    boundedInteger(value.workers, 1, 32) &&
    boundedInteger(value.quantumMs, 60_000, 24 * 60 * 60_000) &&
    boundedInteger(value.reservedWorkerMs, 60_000, 32 * 24 * 60 * 60_000) &&
    boundedInteger(value.conflictBudget, 1, 10_000) &&
    boundedInteger(value.leaseTargetMs, 60_000, 24 * 60 * 60_000)
  ) {
    return {
      ok: true,
      message: {
        ...base,
        type: "SWARM_ASSIGNMENT",
        assignmentId: value.assignmentId,
        jobId: value.jobId,
        workers: value.workers,
        quantumMs: value.quantumMs,
        reservedWorkerMs: value.reservedWorkerMs,
        conflictBudget: value.conflictBudget,
        leaseTargetMs: value.leaseTargetMs,
      },
    };
  }
  if (
    value.type === "SWARM_NO_WORK" &&
    boundedInteger(value.retryAfterMs, 1_000, 60 * 60_000)
  ) {
    return { ok: true, message: { ...base, type: "SWARM_NO_WORK", retryAfterMs: value.retryAfterMs } };
  }
  if (
    value.type === "SWARM_ERROR" &&
    ["INVALID_MESSAGE", "UPGRADE_REQUIRED", "INVALID_ASSIGNMENT"].includes(String(value.code)) &&
    typeof value.retryable === "boolean"
  ) {
    return {
      ok: true,
      message: {
        ...base,
        type: "SWARM_ERROR",
        code: value.code as SwarmErrorMessage["code"],
        retryable: value.retryable,
      },
    };
  }
  return { ok: false, code: "INVALID_MESSAGE" };
}
