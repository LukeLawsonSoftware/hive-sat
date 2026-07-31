export const JOB_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const CREATION_WINDOW_MS = JOB_LIFETIME_MS;
export const MAX_CREATIONS_PER_WINDOW = 3;
export const MAX_COMPRESSED_FORMULA_BYTES = 5 * 1024 * 1024;
export const MAX_ENCODED_FORMULA_BYTES = 32 * 1024 * 1024;

export type {
  CreateJobInput,
  CreateJobResult,
  FormulaDeclaration,
  PublicJobState,
  PublicJobStatus,
} from "../shared/public-jobs";
import type { FormulaDeclaration } from "../shared/public-jobs";
import type { CubeTask } from "../shared/coordinator-protocol";

export interface InitializeJobInput {
  jobId: string;
  ownerDigest: string;
  uploadDigest: string;
  formula: FormulaDeclaration;
  createdAt: number;
  expiresAt: number;
}

export interface AdmissionInput {
  jobId: string;
  deviceDigest: string;
  networkDigest: string;
  createdAt: number;
  expiresAt: number;
  globalCeiling: number;
  bypassCreationRateLimit?: boolean;
}

export type AdmissionResult =
  | { ok: true }
  | {
      ok: false;
      code: "ACTIVE_JOB_LIMIT" | "CREATION_RATE_LIMIT" | "GLOBAL_JOB_LIMIT";
      retryAt?: number;
    };

export type UploadAuthorization =
  | { ok: true; objectKey: string; formulaHash: string; compressedBytes: number }
  | { ok: false; code: "NOT_FOUND" | "INVALID_TOKEN" | "INVALID_STATE" };

export type OwnerActionResult =
  | { ok: true; changed: boolean }
  | { ok: false; code: "NOT_FOUND" | "INVALID_TOKEN" };

export type ModelUploadAuthorization =
  | {
      ok: true;
      objectKey: string;
      jobId: string;
      formulaHash: string;
      task: CubeTask;
      maximumBytes: number;
    }
  | { ok: false; code: "NOT_FOUND" | "INVALID_STATE" };

export type ProofUploadAuthorization =
  | {
      ok: true;
      objectKey: string;
      jobId: string;
      formulaHash: string;
      task: CubeTask;
      maximumCompressedBytes: number;
      maximumDecompressedBytes: number;
    }
  | { ok: false; code: "NOT_FOUND" | "INVALID_STATE" | "PROOF_BUDGET_EXHAUSTED" };

export function formulaObjectKey(jobId: string, uploadId = "canonical"): string {
  return `jobs/${jobId}/formula/${uploadId}.hivecnf.gz`;
}
