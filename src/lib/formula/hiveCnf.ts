import type { ParsedDimacs } from "./dimacs";
import {
  MAX_ENCODED_FORMULA_BYTES,
  MAX_LITERAL_OCCURRENCES,
  SOLVER_CLAUSE_BATCH_INTS,
} from "./limits";

const MAGIC = Uint8Array.from([0x48, 0x49, 0x56, 0x45, 0x43, 0x4e, 0x46, 0x31]); // HIVECNF1
const HEADER_BYTES = 20;

export interface HiveCnfV1 {
  format: "HiveCnfV1";
  variableCount: number;
  clauseCount: number;
  literalCount: number;
  clauses: number[][];
}

function encodedByteLength(formula: Pick<ParsedDimacs, "literalCount" | "clauseCount">): number {
  return HEADER_BYTES +
    (formula.literalCount + formula.clauseCount) * Int32Array.BYTES_PER_ELEMENT;
}

export function encodeHiveCnfV1(formula: ParsedDimacs): Uint8Array {
  const actualClauseCount = formula.clauses.length;
  const actualLiteralCount = formula.clauses.reduce((total, clause) => total + clause.length, 0);
  if (actualClauseCount !== formula.clauseCount || actualLiteralCount !== formula.literalCount) {
    throw new Error("Cannot encode HiveCnfV1 with mismatched clause metadata.");
  }
  if (actualLiteralCount > MAX_LITERAL_OCCURRENCES) {
    throw new Error(`HiveCnfV1 exceeds ${MAX_LITERAL_OCCURRENCES} literal occurrences.`);
  }
  for (const clause of formula.clauses) {
    for (const literal of clause) {
      if (!Number.isInteger(literal) || literal === 0 || Math.abs(literal) > formula.variableCount) {
        throw new Error(`Cannot encode invalid literal ${literal} in HiveCnfV1.`);
      }
    }
  }
  const byteLength = encodedByteLength(formula);
  if (byteLength > MAX_ENCODED_FORMULA_BYTES) {
    throw new Error(`HiveCnfV1 encoding exceeds ${MAX_ENCODED_FORMULA_BYTES} bytes.`);
  }

  const output = new Uint8Array(byteLength);
  output.set(MAGIC);
  const view = new DataView(output.buffer);
  view.setUint32(8, formula.variableCount, true);
  view.setUint32(12, formula.clauseCount, true);
  view.setUint32(16, formula.literalCount, true);

  let offset = HEADER_BYTES;
  for (const clause of formula.clauses) {
    for (const literal of clause) {
      view.setInt32(offset, literal, true);
      offset += Int32Array.BYTES_PER_ELEMENT;
    }
    view.setInt32(offset, 0, true);
    offset += Int32Array.BYTES_PER_ELEMENT;
  }
  return output;
}

export function decodeHiveCnfV1(bytes: Uint8Array): HiveCnfV1 {
  if (bytes.byteLength < HEADER_BYTES || bytes.byteLength > MAX_ENCODED_FORMULA_BYTES) {
    throw new Error("Invalid HiveCnfV1 byte length.");
  }
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) throw new Error("Invalid HiveCnfV1 magic/version.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const variableCount = view.getUint32(8, true);
  const clauseCount = view.getUint32(12, true);
  const literalCount = view.getUint32(16, true);
  if (literalCount > MAX_LITERAL_OCCURRENCES) {
    throw new Error("HiveCnfV1 exceeds the literal-occurrence limit.");
  }
  const expectedBytes = HEADER_BYTES + (literalCount + clauseCount) * 4;
  if (expectedBytes !== bytes.byteLength) throw new Error("HiveCnfV1 length metadata does not match its payload.");

  const clauses: number[][] = [];
  let currentClause: number[] = [];
  let observedLiterals = 0;
  for (let offset = HEADER_BYTES; offset < bytes.byteLength; offset += 4) {
    const literal = view.getInt32(offset, true);
    if (literal === 0) {
      clauses.push(currentClause);
      currentClause = [];
      continue;
    }
    if (literal === -0x8000_0000 || Math.abs(literal) > variableCount) {
      throw new Error(`HiveCnfV1 contains an out-of-range literal at byte ${offset}.`);
    }
    observedLiterals += 1;
    currentClause.push(literal);
  }

  if (currentClause.length > 0 || clauses.length !== clauseCount || observedLiterals !== literalCount) {
    throw new Error("HiveCnfV1 clause metadata does not match its payload.");
  }

  return {
    format: "HiveCnfV1",
    variableCount,
    clauseCount,
    literalCount,
    clauses,
  };
}

export function createClauseBatches(
  clauses: readonly (readonly number[])[],
  targetInts = SOLVER_CLAUSE_BATCH_INTS,
): Int32Array[] {
  if (!Number.isInteger(targetInts) || targetInts < 1) throw new Error("Batch size must be a positive integer.");
  const batches: Int32Array[] = [];
  let pending: number[] = [];

  for (const clause of clauses) {
    const required = clause.length + 1;
    if (pending.length > 0 && pending.length + required > targetInts) {
      batches.push(Int32Array.from(pending));
      pending = [];
    }
    for (const literal of clause) pending.push(literal);
    pending.push(0);
    if (pending.length >= targetInts) {
      batches.push(Int32Array.from(pending));
      pending = [];
    }
  }
  if (pending.length > 0) batches.push(Int32Array.from(pending));
  return batches;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = bytes.slice().buffer as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
