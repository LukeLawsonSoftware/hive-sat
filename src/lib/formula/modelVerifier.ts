import type { HiveCnfV1 } from "./hiveCnf";
import {
  MAX_CLAUSES,
  MAX_LITERAL_OCCURRENCES,
  MAX_VARIABLES,
} from "./limits";

export type ModelVerification =
  | { valid: true; assignment: boolean[] }
  | { valid: false; reason: string; clauseIndex?: number };

export function verifySatModel(
  formula: Pick<HiveCnfV1, "variableCount" | "clauses">,
  model: readonly number[],
): ModelVerification {
  if (
    !Number.isSafeInteger(formula.variableCount) ||
    formula.variableCount < 0 ||
    formula.variableCount > MAX_VARIABLES
  ) {
    return {
      valid: false,
      reason: `Formula variable count exceeds the supported ${MAX_VARIABLES.toLocaleString("en-US")} variable limit.`,
    };
  }
  if (formula.clauses.length > MAX_CLAUSES) {
    return {
      valid: false,
      reason: `Formula clause count exceeds the supported ${MAX_CLAUSES.toLocaleString("en-US")} clause limit.`,
    };
  }
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

  let literalCount = 0;
  for (let clauseIndex = 0; clauseIndex < formula.clauses.length; clauseIndex += 1) {
    let satisfied = false;
    for (const literal of formula.clauses[clauseIndex]) {
      literalCount += 1;
      if (literalCount > MAX_LITERAL_OCCURRENCES) {
        return {
          valid: false,
          reason: `Formula exceeds the supported ${MAX_LITERAL_OCCURRENCES.toLocaleString("en-US")} literal-occurrence limit.`,
        };
      }
      if (!Number.isInteger(literal) || literal === 0 || Math.abs(literal) > formula.variableCount) {
        return { valid: false, reason: `Formula contains invalid literal ${literal}.` };
      }
      if (assignments[Math.abs(literal)] === (literal > 0 ? 1 : -1)) satisfied = true;
    }
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
