import { describe, expect, it } from "vitest";
import { formatDimacsSatModel, modelDownloadFilename } from "./modelOutput";

describe("DIMACS-style SAT model output", () => {
  it("writes a status line, formula binding, signed literals, and final terminator", () => {
    expect(formatDimacsSatModel([1, -2, 3], "abc123")).toBe(
      "c HiveSAT independently verified SAT model\n" +
      "c formula-sha256 abc123\n" +
      "s SATISFIABLE\n" +
      "v 1 -2 3 0\n",
    );
  });

  it("wraps large models and terminates only the final value line", () => {
    const model = Array.from({ length: 21 }, (_, index) => index + 1);
    const output = formatDimacsSatModel(model, "hash");
    const valueLines = output.split("\n").filter((line) => line.startsWith("v "));

    expect(valueLines).toHaveLength(2);
    expect(valueLines[0]).not.toMatch(/ 0$/);
    expect(valueLines[1]).toBe("v 21 0");
  });

  it("rejects invalid literals and derives stable download names", () => {
    expect(() => formatDimacsSatModel([1, 0], "hash")).toThrow(/invalid model literal/i);
    expect(modelDownloadFilename("benchmark.cnf")).toBe("benchmark.model.txt");
    expect(modelDownloadFilename("benchmark.CNF.GZ")).toBe("benchmark.model.txt");
  });
});

