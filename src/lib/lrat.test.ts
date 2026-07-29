import { describe, expect, it } from "vitest";
import { verifyTextLrat } from "./lrat";

describe("independent text LRAT checker", () => {
  it("accepts a valid unit contradiction proof", () => {
    expect(verifyTextLrat([[1], [-1]], "3 0 1 2 0\n")).toMatchObject({
      valid: true,
      derivedClauses: 1,
    });
  });

  it("rejects a proof whose chain does not imply its clause", () => {
    expect(verifyTextLrat([[1], [2]], "3 0 1 2 0\n")).toMatchObject({
      valid: false,
      reason: "invalid RUP chain on line 1",
    });
  });
});
