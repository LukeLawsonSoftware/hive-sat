import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  encodeSatModelArtifact,
  MAX_UNSAT_PROOF_COMPRESSED_BYTES,
  parseResultManifest,
  resultPathHash,
  type SatResultManifest,
  type UnsatProofManifest,
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

function stream(bytes: Uint8Array | ArrayBuffer): ReadableStream {
  const body = bytes instanceof Uint8Array ? bytes.slice().buffer as ArrayBuffer : bytes;
  return new Response(body).body!;
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
  const compressedFormula = await gzip(encoded);
  return { jobId, compressedFormula, artifact, manifest, cube };
}

describe("ResultVerifierDO", () => {
  it("caps compressed proof manifests at the Workers KV value limit", async () => {
    const base = {
      kind: "UNSAT_PROOF_V1",
      version: 1,
      formulaHash: "ab".repeat(32),
      taskId: "root",
      cube: [],
      pathHash: await resultPathHash([]),
      solverVersion: "cadical-3.0.1",
      artifactId: "proof",
      artifactSha256: "cd".repeat(32),
      decompressedBytes: 1,
      originalClauseCount: 0,
      cubeClauseIds: [],
      checker: "drat-trim-lrat-check",
    };
    expect(parseResultManifest({
      ...base,
      compressedBytes: MAX_UNSAT_PROOF_COMPRESSED_BYTES,
    })).not.toBeNull();
    expect(parseResultManifest({
      ...base,
      compressedBytes: MAX_UNSAT_PROOF_COMPRESSED_BYTES + 1,
    })).toBeNull();
  });

  it("independently verifies the formula hash, cube, and every SAT clause", async () => {
    const item = await fixture([1, 2]);
    const verifier = env.RESULT_VERIFIERS.getByName(`valid-${item.jobId}`);
    await expect(verifier.verifySat({
      formulaStream: stream(item.compressedFormula),
      modelStream: stream(item.artifact),
      manifest: item.manifest,
      expectedCube: item.cube,
      expectedVariableCount: 2,
    })).resolves.toEqual({
      status: "VALID_SAT",
      checkedClauses: 2,
      checkedLiterals: 5,
    });
  });

  it("certifies a bounded LRAT proof and fails closed on corruption or limits", async () => {
    const jobId = crypto.randomUUID();
    const encoded = encodeFormula(1, [[1], [-1]]);
    const formulaHash = await sha256Hex(encoded);
    const proofText = "3 0 1 2 0\n";
    const proofBytes = new TextEncoder().encode(proofText);
    const compressed = new Uint8Array(await gzip(proofBytes));
    const artifactSha256 = await sha256Hex(compressed);
    const artifactId = "proof-lease";
    const compressedFormula = await gzip(encoded);
    const manifest: UnsatProofManifest = {
      kind: "UNSAT_PROOF_V1",
      version: 1,
      formulaHash,
      taskId: "root",
      cube: [],
      pathHash: await resultPathHash([]),
      solverVersion: "cadical-3.0.1",
      artifactId,
      artifactSha256,
      compressedBytes: compressed.byteLength,
      decompressedBytes: proofBytes.byteLength,
      originalClauseCount: 2,
      cubeClauseIds: [],
      checker: "drat-trim-lrat-check",
    };
    const verifier = env.RESULT_VERIFIERS.getByName(`proof-${jobId}`);
    await expect(verifier.verifyUnsat({
      formulaStream: stream(compressedFormula),
      proofStream: stream(compressed),
      manifest,
      expectedCube: [],
    })).resolves.toMatchObject({ status: "VALID_UNSAT", derivedClauses: 1 });
    await expect(verifier.verifyUnsat({
      formulaStream: stream(compressedFormula),
      proofStream: stream(compressed),
      manifest: { ...manifest, artifactSha256: "00".repeat(32) },
      expectedCube: [],
    })).resolves.toMatchObject({ status: "INVALID_PROOF" });
    await expect(verifier.verifyUnsat({
      formulaStream: stream(compressedFormula),
      proofStream: stream(compressed),
      manifest,
      expectedCube: [],
      maxCompressedBytes: compressed.byteLength - 1,
    })).resolves.toMatchObject({ status: "OWNER_CHECK_REQUIRED" });
  });

  it("fails closed for an invalid model and an exhausted verifier budget", async () => {
    const invalid = await fixture([1, -2]);
    const verifier = env.RESULT_VERIFIERS.getByName(`invalid-${invalid.jobId}`);
    await expect(verifier.verifySat({
      formulaStream: stream(invalid.compressedFormula),
      modelStream: stream(invalid.artifact),
      manifest: invalid.manifest,
      expectedCube: invalid.cube,
      expectedVariableCount: 2,
    })).resolves.toMatchObject({ status: "INVALID_MODEL" });

    const valid = await fixture([1, 2]);
    await expect(verifier.verifySat({
      formulaStream: stream(valid.compressedFormula),
      modelStream: stream(valid.artifact),
      manifest: valid.manifest,
      expectedCube: valid.cube,
      expectedVariableCount: 2,
      maxLiteralChecks: 1,
    })).resolves.toMatchObject({ status: "VERIFICATION_TIMEOUT" });
  });
});
