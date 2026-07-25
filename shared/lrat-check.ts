export interface LratCheckLimits {
  maxProofBytes: number;
  maxDerivedClauses: number;
  maxHints: number;
}

export type LratCheckResult = {
  valid: boolean;
  reason?: string;
  derivedClauses: number;
  checkedHints: number;
  limitExceeded: boolean;
  requiresFullChecker?: true;
};

type Assignment = Map<number, boolean>;

const DEFAULT_LIMITS: LratCheckLimits = {
  maxProofBytes: 128 * 1024 * 1024,
  maxDerivedClauses: 2_000_000,
  maxHints: 16_000_000,
};

function literalValue(literal: number, assignment: Assignment) {
  const value = assignment.get(Math.abs(literal));
  return value === undefined ? undefined : literal > 0 === value;
}

function assignLiteral(literal: number, assignment: Assignment) {
  const variable = Math.abs(literal);
  const value = literal > 0;
  const previous = assignment.get(variable);
  if (previous !== undefined && previous !== value) return false;
  assignment.set(variable, value);
  return true;
}

function checkRupChain(clause: number[], hints: number[], clauses: Map<number, number[]>) {
  const assignment: Assignment = new Map();
  for (const literal of clause) {
    if (!assignLiteral(-literal, assignment)) return true;
  }
  for (const hint of hints) {
    if (hint <= 0) return false;
    const antecedent = clauses.get(hint);
    if (!antecedent) return false;
    const unassigned = antecedent.filter(
      (literal) => literalValue(literal, assignment) === undefined,
    );
    if (antecedent.some((literal) => literalValue(literal, assignment))) return false;
    if (unassigned.length === 0) return true;
    if (unassigned.length !== 1 || !assignLiteral(unassigned[0], assignment)) return false;
  }
  return false;
}

/**
 * Bounded text-LRAT checking shared by the browser owner flow and verifier DO.
 * Production builds also compile the pinned upstream lrat-check.c; this small
 * implementation keeps the Workers path deterministic and explicitly metered.
 */
export function verifyTextLrat(
  originalClauses: readonly (readonly number[])[],
  proof: string,
  limits: Partial<LratCheckLimits> = {},
): LratCheckResult {
  const bounded = { ...DEFAULT_LIMITS, ...limits };
  if (new TextEncoder().encode(proof).byteLength > bounded.maxProofBytes) {
    return { valid: false, reason: "proof byte limit exceeded", derivedClauses: 0, checkedHints: 0, limitExceeded: true };
  }
  const clauses = new Map<number, number[]>();
  originalClauses.forEach((clause, index) => clauses.set(index + 1, [...clause]));
  let derivedClauses = 0;
  let checkedHints = 0;
  let reachedEmptyClause = false;

  for (const [lineIndex, sourceLine] of proof.split(/\r?\n/u).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("c ")) continue;
    const tokens = line.split(/\s+/u);
    const id = Number(tokens.shift());
    if (!Number.isSafeInteger(id) || id <= 0) {
      return { valid: false, reason: `invalid id on line ${lineIndex + 1}`, derivedClauses, checkedHints, limitExceeded: false };
    }
    if (tokens[0] === "d") {
      for (const token of tokens.slice(1)) {
        const deletedId = Number(token);
        if (deletedId === 0) break;
        if (!Number.isSafeInteger(deletedId) || deletedId < 1) {
          return { valid: false, reason: `invalid deletion on line ${lineIndex + 1}`, derivedClauses, checkedHints, limitExceeded: false };
        }
        clauses.delete(deletedId);
      }
      continue;
    }
    const firstZero = tokens.indexOf("0");
    const lastZero = tokens.lastIndexOf("0");
    if (firstZero < 0 || lastZero <= firstZero) {
      return { valid: false, reason: `malformed addition on line ${lineIndex + 1}`, derivedClauses, checkedHints, limitExceeded: false };
    }
    const clause = tokens.slice(0, firstZero).map(Number);
    const hints = tokens.slice(firstZero + 1, lastZero).map(Number);
    if (!clause.every((literal) => Number.isSafeInteger(literal) && literal !== 0) ||
      !hints.every((hint) => Number.isSafeInteger(hint))) {
      return { valid: false, reason: `invalid integer on line ${lineIndex + 1}`, derivedClauses, checkedHints, limitExceeded: false };
    }
    if (hints.some((hint) => hint < 0)) {
      return {
        valid: false,
        reason: "proof contains RAT hints that require the pinned full LRAT checker",
        derivedClauses,
        checkedHints,
        limitExceeded: false,
        requiresFullChecker: true,
      };
    }
    checkedHints += hints.length;
    derivedClauses += 1;
    if (derivedClauses > bounded.maxDerivedClauses || checkedHints > bounded.maxHints) {
      return { valid: false, reason: "proof operation limit exceeded", derivedClauses, checkedHints, limitExceeded: true };
    }
    if (!checkRupChain(clause, hints, clauses)) {
      return { valid: false, reason: `invalid RUP chain on line ${lineIndex + 1}`, derivedClauses, checkedHints, limitExceeded: false };
    }
    clauses.set(id, clause);
    if (clause.length === 0) reachedEmptyClause = true;
  }
  return reachedEmptyClause
    ? { valid: true, derivedClauses, checkedHints, limitExceeded: false }
    : { valid: false, reason: "proof did not derive the empty clause", derivedClauses, checkedHints, limitExceeded: false };
}
