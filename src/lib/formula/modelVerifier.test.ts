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

  it("rejects unsupported formula metadata before allocating an assignment table", () => {
    expect(verifySatModel({ variableCount: 2_000_001, clauses: [] }, [])).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/variable limit/i),
    });
  });

  it("rejects invalid formula literals independently of the parser", () => {
    expect(verifySatModel({ variableCount: 3, clauses: [[4]] }, [1, 2, 3])).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/invalid literal/i),
    });
  });
});
