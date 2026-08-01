import { describe, expect, it } from "vitest";
import { parseDimacsText } from "./dimacs";
import { createClauseBatches, decodeHiveCnfV1, encodeHiveCnfV1, sha256Hex } from "./hiveCnf";

describe("HiveCnfV1", () => {
  it("uses a deterministic little-endian encoding and round-trips clause order", async () => {
    const parsed = await parseDimacsText("p cnf 2 2\n1 -2 0\n2 0\n");
    const encoded = encodeHiveCnfV1(parsed);

    expect(Array.from(encoded.subarray(0, 20))).toEqual([
      72, 73, 86, 69, 67, 78, 70, 49,
      2, 0, 0, 0,
      2, 0, 0, 0,
      3, 0, 0, 0,
    ]);
    expect(decodeHiveCnfV1(encoded)).toEqual({
      format: "HiveCnfV1",
      variableCount: 2,
      clauseCount: 2,
      literalCount: 3,
      clauses: [[1, -2], [2]],
    });
    expect(await sha256Hex(encoded)).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex(encodeHiveCnfV1(parsed))).toBe(await sha256Hex(encoded));
  });

  it("creates transferable batches only at clause boundaries", () => {
    const batches = createClauseBatches([[1, 2], [-1], [3, 4, 5], []], 4);
    expect(batches.map((batch) => Array.from(batch))).toEqual([
      [1, 2, 0],
      [-1, 0],
      [3, 4, 5, 0],
      [0],
    ]);
    expect(batches.every((batch) => batch.at(-1) === 0)).toBe(true);
  });

  it("fails closed on corrupt headers and payloads", async () => {
    const parsed = await parseDimacsText("p cnf 1 1\n1 0\n");
    const badMagic = encodeHiveCnfV1(parsed);
    badMagic[0] = 0;
    expect(() => decodeHiveCnfV1(badMagic)).toThrow(/magic/i);

    const badLiteral = encodeHiveCnfV1(parsed);
    new DataView(badLiteral.buffer).setInt32(20, 2, true);
    expect(() => decodeHiveCnfV1(badLiteral)).toThrow(/out-of-range/i);

    const excessiveVariables = encodeHiveCnfV1(parsed);
    new DataView(excessiveVariables.buffer).setUint32(8, 2_000_001, true);
    expect(() => decodeHiveCnfV1(excessiveVariables)).toThrow(/variable limit/i);
  });

  it("rejects an unsupported variable count before encoding", () => {
    expect(() => encodeHiveCnfV1({
      variableCount: 2_000_001,
      clauseCount: 0,
      literalCount: 0,
      clauses: [],
    })).toThrow(/variable count/i);
  });
});
