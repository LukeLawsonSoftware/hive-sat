import type { TaskState } from "./coordinator-protocol";

export const PUBLIC_JOB_PROTOCOL_VERSION = 4 as const;
export const MAX_PUBLIC_JOB_COMPRESSED_FORMULA_BYTES = 5 * 1024 * 1024;
export const MAX_PUBLIC_JOB_ENCODED_FORMULA_BYTES = 32 * 1024 * 1024;
export const MAX_PUBLIC_JOB_VARIABLES = 2_000_000;
export const MAX_PUBLIC_JOB_CLAUSES = 1_000_000;
export const MAX_PUBLIC_JOB_LITERAL_OCCURRENCES = 2_000_000;

export type PublicJobState =
  | "UPLOADING"
  | "QUEUED"
  | "RUNNING"
  | "SAT_VERIFIED"
  | "UNSAT_CERTIFIED"
  | "UNSAT_OWNER_VERIFIED"
  | "INVALID"
  | "UNKNOWN"
  | "CANCELLED";

export interface FormulaDeclaration {
  hash: string;
  variableCount: number;
  clauseCount: number;
  literalCount: number;
  encodedBytes: number;
  compressedBytes: number;
}

export interface CreateJobInput {
  protocolVersion: typeof PUBLIC_JOB_PROTOCOL_VERSION;
  deviceId: string;
  turnstileToken: string;
  publicConsent: true;
  formula: FormulaDeclaration;
}

export interface CreateJobResult {
  protocolVersion: typeof PUBLIC_JOB_PROTOCOL_VERSION;
  jobId: string;
  uploadToken: string;
  ownerToken: string;
  expiresAt: number;
  uploadUrl: string;
  publicUrl: string;
  ownerUrl: string;
}

export interface PublicJobStatus {
  protocolVersion: typeof PUBLIC_JOB_PROTOCOL_VERSION;
  jobId: string;
  state: PublicJobState;
  formula: FormulaDeclaration;
  createdAt: number;
  expiresAt: number;
  uploadedBytes: number | null;
  rootTaskState: TaskState;
  certificate: null | {
    artifactId: string;
    artifactSha256: string;
    compressedBytes: number;
    decompressedBytes: number;
    cube: number[];
    verification: "SERVER_CERTIFIED" | "OWNER_CHECK_REQUIRED" | "OWNER_VERIFIED";
    downloadUrl: string;
  };
}
