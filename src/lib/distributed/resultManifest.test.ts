import { describe, expect, it } from "vitest";
import {
  bitsetValue,
  decodeSatModelArtifact,
  encodeSatModelArtifact,
  parseResultManifest,
  resultPathHash,
} from "../../../shared/result-manifest";

describe("SAT model artifact", () => {
  it("round-trips ordered literals into a compact bitset bound to the cube path", async () => {
    const cube = [2, -4];
    const metadata = {
      version: 1 as const,
      formulaHash: "ab".repeat(32),
      taskId: "task-one",
      cube,
      pathHash: await resultPathHash(cube),
      solverVersion: "cadical-3.0.1",
      variableCount: 5,
    };
    const bytes = encodeSatModelArtifact(metadata, [1, 2, -3, -4, 5]);
    expect(bytes.byteLength).toBeLessThan(512);
    const decoded = decodeSatModelArtifact(bytes);
    expect(decoded.metadata).toEqual(metadata);
    expect([1, 2, 3, 4, 5].map((variable) => bitsetValue(decoded.assignment, variable)))
      .toEqual([true, true, false, false, true]);
  });

  it("rejects unordered models and manifests with duplicate cube variables", async () => {
    const cube = [2];
    const metadata = {
      version: 1 as const,
      formulaHash: "ab".repeat(32),
      taskId: "task-one",
      cube,
      pathHash: await resultPathHash(cube),
      solverVersion: "cadical-3.0.1",
      variableCount: 2,
    };
    expect(() => encodeSatModelArtifact(metadata, [2, 1])).toThrow(/ordered literal/i);
    expect(parseResultManifest({
      kind: "UNSAT_CANDIDATE_V1",
      formulaHash: "ab".repeat(32),
      taskId: "task-one",
      cube: [1, -1],
      pathHash: "cd".repeat(32),
      solverVersion: "cadical-3.0.1",
    })).toBeNull();
  });

  it("binds LRAT proof manifests to exact formula and cube clause IDs", async () => {
    const cube = [2, -4];
    const manifest = parseResultManifest({
      kind: "UNSAT_PROOF_V1",
      version: 1,
      formulaHash: "ab".repeat(32),
      taskId: "leaf-proof",
      cube,
      pathHash: await resultPathHash(cube),
      solverVersion: "cadical-3.0.1",
      artifactId: "proof-lease",
      artifactSha256: "cd".repeat(32),
      compressedBytes: 120,
      decompressedBytes: 500,
      originalClauseCount: 10,
      cubeClauseIds: [11, 12],
      checker: "drat-trim-lrat-check",
    });
    expect(manifest).toMatchObject({ kind: "UNSAT_PROOF_V1", cubeClauseIds: [11, 12] });
    expect(parseResultManifest({ ...manifest, cubeClauseIds: [11, 13] })).toBeNull();
  });
});
