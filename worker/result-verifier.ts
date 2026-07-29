import { DurableObject } from "cloudflare:workers";
import {
  bitsetValue,
  decodeSatModelArtifact,
  MAX_SAT_MODEL_ARTIFACT_BYTES,
  type SatResultManifest,
  MAX_SERVER_PROOF_COMPRESSED_BYTES,
  MAX_SERVER_PROOF_DECOMPRESSED_BYTES,
  type UnsatProofManifest,
} from "../shared/result-manifest";
import { verifyTextLrat } from "../shared/lrat-check";

const MAX_ENCODED_FORMULA_BYTES = 32 * 1024 * 1024;
const MAX_LITERAL_CHECKS = 2_000_064;
const HIVECNF_MAGIC = Uint8Array.from([0x48, 0x49, 0x56, 0x45, 0x43, 0x4e, 0x46, 0x31]);

export interface VerifySatInput {
  formulaStream: ReadableStream;
  modelStream: ReadableStream;
  manifest: SatResultManifest;
  expectedCube: number[];
  expectedVariableCount: number;
  maxLiteralChecks?: number;
}

export type VerifySatResult =
  | { status: "VALID_SAT"; checkedClauses: number; checkedLiterals: number }
  | {
      status: "INVALID_FORMULA" | "INVALID_MODEL" | "VERIFICATION_TIMEOUT";
      reason: string;
    };

export interface VerifyUnsatInput {
  formulaStream: ReadableStream;
  proofStream: ReadableStream;
  manifest: UnsatProofManifest;
  expectedCube: number[];
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  maxDerivedClauses?: number;
  maxHints?: number;
}

export type VerifyUnsatResult =
  | { status: "VALID_UNSAT"; derivedClauses: number; checkedHints: number }
  | { status: "OWNER_CHECK_REQUIRED"; reason: string }
  | { status: "INVALID_FORMULA" | "INVALID_PROOF" | "VERIFICATION_TIMEOUT"; reason: string };

interface DecodedFormula {
  variableCount: number;
  clauses: number[][];
}

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  label: string,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) throw new Error(`${label} exceeds its byte limit.`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalCube(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((literal, index) => literal === right[index]);
}

function decodeHiveCnfV1(bytes: Uint8Array): DecodedFormula {
  if (bytes.byteLength < 20 || bytes.byteLength > MAX_ENCODED_FORMULA_BYTES) {
    throw new Error("HiveCnfV1 byte length is invalid.");
  }
  for (let index = 0; index < HIVECNF_MAGIC.length; index += 1) {
    if (bytes[index] !== HIVECNF_MAGIC[index]) throw new Error("HiveCnfV1 magic/version is invalid.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const variableCount = view.getUint32(8, true);
  const clauseCount = view.getUint32(12, true);
  const literalCount = view.getUint32(16, true);
  if (literalCount > 2_000_000 || bytes.byteLength !== 20 + (literalCount + clauseCount) * 4) {
    throw new Error("HiveCnfV1 length metadata is invalid.");
  }
  const clauses: number[][] = [];
  let clause: number[] = [];
  let observedLiterals = 0;
  for (let offset = 20; offset < bytes.byteLength; offset += 4) {
    const literal = view.getInt32(offset, true);
    if (literal === 0) {
      clauses.push(clause);
      clause = [];
    } else {
      if (literal === -0x8000_0000 || Math.abs(literal) > variableCount) {
        throw new Error("HiveCnfV1 contains an out-of-range literal.");
      }
      clause.push(literal);
      observedLiterals += 1;
    }
  }
  if (clause.length !== 0 || clauses.length !== clauseCount || observedLiterals !== literalCount) {
    throw new Error("HiveCnfV1 clause metadata is invalid.");
  }
  return { variableCount, clauses };
}

export class ResultVerifierDO extends DurableObject<Env> {
  async verifySat(input: VerifySatInput): Promise<VerifySatResult> {
    let artifact: Uint8Array;
    try {
      artifact = await collectBounded(input.modelStream, MAX_SAT_MODEL_ARTIFACT_BYTES, "SAT model");
    } catch (error) {
      return { status: "INVALID_MODEL", reason: String(error) };
    }
    if (
      artifact.byteLength !== input.manifest.artifactBytes ||
      await sha256Hex(artifact) !== input.manifest.artifactSha256
    ) {
      return { status: "INVALID_MODEL", reason: "The model artifact does not match its manifest." };
    }

    let decodedModel: ReturnType<typeof decodeSatModelArtifact>;
    try {
      decodedModel = decodeSatModelArtifact(artifact);
    } catch (error) {
      return { status: "INVALID_MODEL", reason: String(error) };
    }
    const metadata = decodedModel.metadata;
    if (
      metadata.formulaHash !== input.manifest.formulaHash ||
      metadata.taskId !== input.manifest.taskId ||
      metadata.pathHash !== input.manifest.pathHash ||
      metadata.solverVersion !== input.manifest.solverVersion ||
      metadata.variableCount !== input.manifest.variableCount ||
      !equalCube(metadata.cube, input.manifest.cube) ||
      !equalCube(metadata.cube, input.expectedCube) ||
      metadata.variableCount !== input.expectedVariableCount
    ) {
      return { status: "INVALID_MODEL", reason: "The model metadata is not bound to the leased cube." };
    }

    let encoded: Uint8Array;
    try {
      encoded = await collectBounded(
        input.formulaStream.pipeThrough(new DecompressionStream("gzip")),
        MAX_ENCODED_FORMULA_BYTES,
        "HiveCnfV1 formula",
      );
      if (await sha256Hex(encoded) !== input.manifest.formulaHash) {
        throw new Error("The formula hash does not match its declaration.");
      }
    } catch (error) {
      return { status: "INVALID_FORMULA", reason: String(error) };
    }

    let formula: DecodedFormula;
    try {
      formula = decodeHiveCnfV1(encoded);
    } catch (error) {
      return { status: "INVALID_FORMULA", reason: String(error) };
    }
    if (formula.variableCount !== metadata.variableCount) {
      return { status: "INVALID_FORMULA", reason: "Formula variable metadata is inconsistent." };
    }

    const maximumChecks = input.maxLiteralChecks ?? MAX_LITERAL_CHECKS;
    let checkedLiterals = 0;
    const truth = (literal: number) =>
      bitsetValue(decodedModel.assignment, Math.abs(literal)) === (literal > 0);
    for (const literal of input.expectedCube) {
      checkedLiterals += 1;
      if (checkedLiterals > maximumChecks) {
        return { status: "VERIFICATION_TIMEOUT", reason: "The bounded verification budget was exhausted." };
      }
      if (!truth(literal)) return { status: "INVALID_MODEL", reason: "The model violates its cube assumptions." };
    }
    for (let index = 0; index < formula.clauses.length; index += 1) {
      let satisfied = false;
      for (const literal of formula.clauses[index]) {
        checkedLiterals += 1;
        if (checkedLiterals > maximumChecks) {
          return { status: "VERIFICATION_TIMEOUT", reason: "The bounded verification budget was exhausted." };
        }
        if (truth(literal)) satisfied = true;
      }
      if (!satisfied) {
        return { status: "INVALID_MODEL", reason: `The model does not satisfy clause ${index + 1}.` };
      }
    }
    return { status: "VALID_SAT", checkedClauses: formula.clauses.length, checkedLiterals };
  }

  async verifyUnsat(input: VerifyUnsatInput): Promise<VerifyUnsatResult> {
    if (!equalCube(input.manifest.cube, input.expectedCube)) {
      return { status: "INVALID_PROOF", reason: "The proof is not bound to the expected cube." };
    }
    if (input.manifest.compressedBytes > (input.maxCompressedBytes ?? MAX_SERVER_PROOF_COMPRESSED_BYTES) ||
      input.manifest.decompressedBytes > (input.maxDecompressedBytes ?? MAX_SERVER_PROOF_DECOMPRESSED_BYTES)) {
      return { status: "OWNER_CHECK_REQUIRED", reason: "The proof exceeds conservative server verification limits." };
    }

    let compressed: Uint8Array;
    try {
      compressed = await collectBounded(
        input.proofStream,
        input.maxCompressedBytes ?? MAX_SERVER_PROOF_COMPRESSED_BYTES,
        "LRAT proof",
      );
    } catch (error) {
      return { status: "VERIFICATION_TIMEOUT", reason: String(error) };
    }
    if (compressed.byteLength !== input.manifest.compressedBytes ||
      await sha256Hex(compressed) !== input.manifest.artifactSha256) {
      return { status: "INVALID_PROOF", reason: "The proof artifact does not match its manifest." };
    }
    let proofBytes: Uint8Array;
    try {
      proofBytes = await collectBounded(
        new Response(compressed.slice().buffer as ArrayBuffer).body!
          .pipeThrough(new DecompressionStream("gzip")),
        input.maxDecompressedBytes ?? MAX_SERVER_PROOF_DECOMPRESSED_BYTES,
        "decompressed LRAT proof",
      );
    } catch (error) {
      return { status: "INVALID_PROOF", reason: String(error) };
    }
    if (proofBytes.byteLength !== input.manifest.decompressedBytes) {
      return { status: "INVALID_PROOF", reason: "The decompressed proof length does not match its manifest." };
    }

    let formula: DecodedFormula;
    try {
      const encoded = await collectBounded(
        input.formulaStream.pipeThrough(new DecompressionStream("gzip")),
        MAX_ENCODED_FORMULA_BYTES,
        "HiveCnfV1 formula",
      );
      if (await sha256Hex(encoded) !== input.manifest.formulaHash) {
        throw new Error("The formula hash does not match its declaration.");
      }
      formula = decodeHiveCnfV1(encoded);
    } catch (error) {
      return { status: "INVALID_FORMULA", reason: String(error) };
    }
    if (input.manifest.originalClauseCount !== formula.clauses.length ||
      input.manifest.cubeClauseIds.some((id, index) => id !== formula.clauses.length + index + 1)) {
      return { status: "INVALID_PROOF", reason: "The proof clause IDs are not bound to the formula and cube." };
    }
    const proofFormula = [...formula.clauses, ...input.expectedCube.map((literal) => [literal])];
    const checked = verifyTextLrat(proofFormula, new TextDecoder().decode(proofBytes), {
      maxProofBytes: input.maxDecompressedBytes ?? MAX_SERVER_PROOF_DECOMPRESSED_BYTES,
      maxDerivedClauses: input.maxDerivedClauses ?? 100_000,
      maxHints: input.maxHints ?? 1_000_000,
    });
    if (checked.limitExceeded) {
      return { status: "VERIFICATION_TIMEOUT", reason: checked.reason ?? "The verifier budget was exhausted." };
    }
    if (checked.requiresFullChecker) {
      return { status: "OWNER_CHECK_REQUIRED", reason: checked.reason ?? "The full checker is required." };
    }
    if (!checked.valid) return { status: "INVALID_PROOF", reason: checked.reason ?? "The LRAT proof is invalid." };
    return { status: "VALID_UNSAT", derivedClauses: checked.derivedClauses, checkedHints: checked.checkedHints };
  }
}
