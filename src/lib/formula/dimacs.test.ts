import { describe, expect, it } from "vitest";
import { chunksFromBytes, DimacsParseError, parseDimacs, parseDimacsText } from "./dimacs";

describe("strict DIMACS parsing", () => {
  it("preserves clause and literal order across arbitrary chunks", async () => {
    const text = "c example\np cnf 3 3\n1 -2\n3 0\n0\n-1 2 0\n";
    const parsed = await parseDimacs(chunksFromBytes(new TextEncoder().encode(text), 3));

    expect(parsed).toEqual({
      variableCount: 3,
      clauseCount: 3,
      literalCount: 5,
      clauses: [[1, -2, 3], [], [-1, 2]],
    });
  });

  it.each([
    ["missing header", "1 0\n", /problem header/i],
    ["duplicate header", "p cnf 1 0\np cnf 1 0\n", /more than one/i],
    ["bad header", "p sat 1 1\n1 0\n", /form: p cnf/i],
    ["out-of-range literal", "p cnf 2 1\n3 0\n", /exceeds the declared/i],
    ["unterminated clause", "p cnf 1 1\n1\n", /terminating 0/i],
    ["clause mismatch", "p cnf 1 2\n1 0\n", /2 clauses.*1 were parsed/i],
    ["too many clauses", "p cnf 1 0\n0\n", /more than the declared/i],
    ["leading zero", "p cnf 1 1\n01 0\n", /invalid dimacs literal/i],
    ["negative zero", "p cnf 1 1\n-0\n", /invalid dimacs literal/i],
  ])("rejects %s", async (_name, input, expected) => {
    await expect(parseDimacsText(input)).rejects.toThrow(expected);
  });

  it("reports an exact line, column, and byte offset", async () => {
    const error = await parseDimacsText("c x\np cnf 2 1\n1 nope 0\n").catch((reason) => reason);
    expect(error).toBeInstanceOf(DimacsParseError);
    expect(error).toMatchObject({ line: 3, column: 3, byteOffset: 16 });
    expect(error.message).toMatch(/line 3, column 3, byte offset 16/);
  });

  it("reports progress and honors cancellation between chunks", async () => {
    const controller = new AbortController();
    const updates: number[] = [];
    async function* input() {
      yield new TextEncoder().encode("p cnf 1 1\n");
      controller.abort();
      yield new TextEncoder().encode("1 0\n");
    }

    await expect(parseDimacs(input(), {
      signal: controller.signal,
      onProgress: ({ bytesRead }) => updates.push(bytesRead),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(updates).toEqual([10]);
  });

  it("rejects declarations above the public clause ceiling", async () => {
    await expect(parseDimacsText("p cnf 0 1000001\n")).rejects.toThrow(/1,000,000 clause limit/i);
  });

  it("rejects a variable declaration before it can drive oversized allocations", async () => {
    await expect(parseDimacsText("p cnf 2000001 0\n")).rejects.toThrow(/2,000,000 variable limit/i);
  });
});
