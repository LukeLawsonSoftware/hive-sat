import type { HiveCnfV1 } from "./hiveCnf";

export type ModelVerification =
  | { valid: true; assignment: boolean[] }
  | { valid: false; reason: string; clauseIndex?: number };

export function verifySatModel(
  formula: Pick<HiveCnfV1, "variableCount" | "clauses">,
  model: readonly number[],
): ModelVerification {
  const assignments = new Int8Array(formula.variableCount + 1);

  for (const literal of model) {
    if (!Number.isInteger(literal) || literal === 0 || Math.abs(literal) > formula.variableCount) {
      return { valid: false, reason: `Model contains invalid literal ${literal}.` };
    }
    const variable = Math.abs(literal);
    const value = literal > 0 ? 1 : -1;
    if (assignments[variable] !== 0 && assignments[variable] !== value) {
      return { valid: false, reason: `Model assigns variable ${variable} both true and false.` };
    }
    assignments[variable] = value;
  }

  for (let variable = 1; variable <= formula.variableCount; variable += 1) {
    if (assignments[variable] === 0) {
      return { valid: false, reason: `Model does not assign variable ${variable}.` };
    }
  }

  for (let clauseIndex = 0; clauseIndex < formula.clauses.length; clauseIndex += 1) {
    const satisfied = formula.clauses[clauseIndex].some((literal) =>
      assignments[Math.abs(literal)] === (literal > 0 ? 1 : -1),
    );
    if (!satisfied) {
      return {
        valid: false,
        reason: `Model does not satisfy clause ${clauseIndex + 1}.`,
        clauseIndex,
      };
    }
  }

  return {
    valid: true,
    assignment: Array.from(assignments.subarray(1), (value) => value === 1),
  };
}

