import { describe, expect, it } from "vitest";
import { verifySatModel } from "./modelVerifier";

const formula = {
  variableCount: 3,
  clauses: [[1, -2], [2, 3], [-1, -3]],
};

describe("independent TypeScript model verification", () => {
  it("accepts a complete satisfying assignment", () => {
    expect(verifySatModel(formula, [1, 2, -3])).toMatchObject({ valid: true });
  });

  it("rejects missing, conflicting, invalid, and unsatisfying assignments", () => {
    expect(verifySatModel(formula, [1, 2])).toMatchObject({ valid: false, reason: expect.stringMatching(/variable 3/i) });
    expect(verifySatModel(formula, [1, -1, 2, -3])).toMatchObject({ valid: false, reason: expect.stringMatching(/both/i) });
    expect(verifySatModel(formula, [1, 2, 4])).toMatchObject({ valid: false, reason: expect.stringMatching(/invalid/i) });
    expect(verifySatModel(formula, [-1, -2, -3])).toMatchObject({ valid: false, clauseIndex: 1 });
  });
});

