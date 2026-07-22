export type LratCheckResult = {
  valid: boolean;
  reason?: string;
  derivedClauses: number;
};

type Assignment = Map<number, boolean>;

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

function checkRupChain(
  clause: number[],
  hints: number[],
  clauses: Map<number, number[]>,
) {
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
    if (antecedent.some((literal) => literalValue(literal, assignment))) {
      return false;
    }
    if (unassigned.length === 0) return true;
    if (unassigned.length !== 1 || !assignLiteral(unassigned[0], assignment)) {
      return false;
    }
  }
  return false;
}

/** A deliberately independent, text-LRAT RUP checker used by the gate tests. */
export function verifyTextLrat(
  originalClauses: readonly (readonly number[])[],
  proof: string,
): LratCheckResult {
  const clauses = new Map<number, number[]>();
  originalClauses.forEach((clause, index) => clauses.set(index + 1, [...clause]));
  let derivedClauses = 0;
  let reachedEmptyClause = false;

  for (const [lineIndex, sourceLine] of proof.split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line) continue;
    const tokens = line.split(/\s+/);
    const id = Number(tokens.shift());
    if (!Number.isSafeInteger(id) || id <= 0) {
      return { valid: false, reason: `invalid id on line ${lineIndex + 1}`, derivedClauses };
    }
    if (tokens[0] === "d") {
      for (const token of tokens.slice(1)) {
        const deletedId = Number(token);
        if (deletedId === 0) break;
        clauses.delete(deletedId);
      }
      continue;
    }

    const firstZero = tokens.indexOf("0");
    const lastZero = tokens.lastIndexOf("0");
    if (firstZero < 0 || lastZero <= firstZero) {
      return { valid: false, reason: `malformed addition on line ${lineIndex + 1}`, derivedClauses };
    }
    const clause = tokens.slice(0, firstZero).map(Number);
    const hints = tokens.slice(firstZero + 1, lastZero).map(Number);
    if (!checkRupChain(clause, hints, clauses)) {
      return { valid: false, reason: `invalid RUP chain on line ${lineIndex + 1}`, derivedClauses };
    }
    clauses.set(id, clause);
    derivedClauses += 1;
    if (!clause.length) reachedEmptyClause = true;
  }

  return reachedEmptyClause
    ? { valid: true, derivedClauses }
    : { valid: false, reason: "proof did not derive the empty clause", derivedClauses };
}
