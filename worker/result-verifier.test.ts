import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  encodeSatModelArtifact,
  resultPathHash,
  satModelObjectKey,
  type SatResultManifest,
} from "../shared/result-manifest";

function encodeFormula(variableCount: number, clauses: number[][]): Uint8Array {
  const literalCount = clauses.reduce((total, clause) => total + clause.length, 0);
  const output = new Uint8Array(20 + (literalCount + clauses.length) * 4);
  output.set([0x48, 0x49, 0x56, 0x45, 0x43, 0x4e, 0x46, 0x31]);
  const view = new DataView(output.buffer);
  view.setUint32(8, variableCount, true);
  view.setUint32(12, clauses.length, true);
  view.setUint32(16, literalCount, true);
  let offset = 20;
  for (const clause of clauses) {
    for (const literal of clause) {
      view.setInt32(offset, literal, true);
      offset += 4;
    }
    view.setInt32(offset, 0, true);
    offset += 4;
  }
  return output;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function gzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Blob([bytes.slice().buffer as ArrayBuffer]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function fixture(model: number[]) {
  const jobId = crypto.randomUUID();
  const taskId = "leaf";
  const leaseId = crypto.randomUUID();
  const cube = [1];
  const encoded = encodeFormula(2, [[1, 2], [-1, 2]]);
  const formulaHash = await sha256Hex(encoded);
  const pathHash = await resultPathHash(cube);
  const artifact = encodeSatModelArtifact({
    version: 1,
    formulaHash,
    taskId,
    cube,
    pathHash,
    solverVersion: "cadical-3.0.1",
    variableCount: 2,
  }, model);
  const artifactSha256 = await sha256Hex(artifact);
  const manifest: SatResultManifest = {
    kind: "SAT_MODEL_V1",
    version: 1,
    formulaHash,
    taskId,
    cube,
    pathHash,
    solverVersion: "cadical-3.0.1",
    variableCount: 2,
    artifactId: leaseId,
    artifactSha256,
    artifactBytes: artifact.byteLength,
  };
  const formulaObjectKey = `jobs/${jobId}/formula.hivecnf.gz`;
  const modelObjectKey = satModelObjectKey(jobId, leaseId);
  await env.FORMULAS.put(formulaObjectKey, await gzip(encoded));
  await env.FORMULAS.put(modelObjectKey, artifact);
  return { jobId, formulaObjectKey, modelObjectKey, manifest, cube };
}

describe("ResultVerifierDO", () => {
  it("independently verifies the formula hash, cube, and every SAT clause", async () => {
    const item = await fixture([1, 2]);
    const verifier = env.RESULT_VERIFIERS.getByName(`valid-${item.jobId}`);
    await expect(verifier.verifySat({
      formulaObjectKey: item.formulaObjectKey,
      modelObjectKey: item.modelObjectKey,
      manifest: item.manifest,
      expectedCube: item.cube,
      expectedVariableCount: 2,
    })).resolves.toEqual({
      status: "VALID_SAT",
      checkedClauses: 2,
      checkedLiterals: 5,
    });
  });

  it("fails closed for an invalid model and an exhausted verifier budget", async () => {
    const invalid = await fixture([1, -2]);
    const verifier = env.RESULT_VERIFIERS.getByName(`invalid-${invalid.jobId}`);
    await expect(verifier.verifySat({
      formulaObjectKey: invalid.formulaObjectKey,
      modelObjectKey: invalid.modelObjectKey,
      manifest: invalid.manifest,
      expectedCube: invalid.cube,
      expectedVariableCount: 2,
    })).resolves.toMatchObject({ status: "INVALID_MODEL" });

    const valid = await fixture([1, 2]);
    await expect(verifier.verifySat({
      formulaObjectKey: valid.formulaObjectKey,
      modelObjectKey: valid.modelObjectKey,
      manifest: valid.manifest,
      expectedCube: valid.cube,
      expectedVariableCount: 2,
      maxLiteralChecks: 1,
    })).resolves.toMatchObject({ status: "VERIFICATION_TIMEOUT" });
  });
});
