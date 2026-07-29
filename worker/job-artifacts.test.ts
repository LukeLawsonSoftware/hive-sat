import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_UNSAT_PROOF_COMPRESSED_BYTES } from "../shared/result-manifest";
import {
  ARTIFACT_DELETE_BATCH_SIZE,
  deleteJobArtifacts,
  putJobArtifact,
  type JobArtifactMetadata,
} from "./job-artifacts";

const metadata: JobArtifactMetadata = {
  kind: "formula",
  jobId: "artifact-helper-job",
  formulaHash: "ab".repeat(32),
  contentType: "application/vnd.hivesat.cnf+gzip",
  bytes: 4,
};

function streamChunks(chunk: Uint8Array, count: number): ReadableStream<Uint8Array> {
  let emitted = 0;
  return new ReadableStream({
    pull(controller) {
      if (emitted >= count) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(chunk);
    },
  });
}

describe("KV job artifacts", () => {
  it("streams exact-length values with metadata and absolute expiration", async () => {
    const key = "test-artifacts/exact";
    const expiresAt = Date.now() + 24 * 60 * 60_000;
    await putJobArtifact(
      env.JOB_ARTIFACTS,
      key,
      new Response(new Uint8Array([1, 2, 3, 4])).body!,
      metadata,
      expiresAt,
    );

    const stored = await env.JOB_ARTIFACTS.getWithMetadata<JobArtifactMetadata>(key, "arrayBuffer");
    expect(new Uint8Array(stored.value!)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(stored.metadata).toEqual(metadata);
    const listed = await env.JOB_ARTIFACTS.list({ prefix: key });
    expect(listed.keys[0]?.expiration).toBe(Math.ceil(expiresAt / 1_000));
  });

  it.each([
    ["undersized", new Uint8Array([1, 2, 3])],
    ["oversized", new Uint8Array([1, 2, 3, 4, 5])],
  ])("deletes %s bodies that do not match the declared length", async (suffix, body) => {
    const key = `test-artifacts/${suffix}`;
    await expect(putJobArtifact(
      env.JOB_ARTIFACTS,
      key,
      new Response(body).body!,
      metadata,
      Date.now() + 24 * 60 * 60_000,
    )).rejects.toThrow("declared byte length");
    expect(await env.JOB_ARTIFACTS.get(key)).toBeNull();
  });

  it("accepts a streamed proof at KV's exact 25 MiB value boundary", async () => {
    const key = "test-artifacts/proof-limit";
    const chunk = new Uint8Array(1024 * 1024);
    await putJobArtifact(
      env.JOB_ARTIFACTS,
      key,
      streamChunks(chunk, 25),
      {
        ...metadata,
        kind: "unsat-proof",
        artifactSha256: "cd".repeat(32),
        contentType: "application/vnd.hivesat.lrat+gzip",
        bytes: MAX_UNSAT_PROOF_COMPRESSED_BYTES,
      },
      Date.now() + 24 * 60 * 60_000,
    );
    const stored = await env.JOB_ARTIFACTS.getWithMetadata<JobArtifactMetadata>(key, "arrayBuffer");
    expect(stored.value?.byteLength).toBe(MAX_UNSAT_PROOF_COMPRESSED_BYTES);
    expect(stored.metadata).toMatchObject({
      kind: "unsat-proof",
      artifactSha256: "cd".repeat(32),
      bytes: MAX_UNSAT_PROOF_COMPRESSED_BYTES,
    });
  });

  it("deletes only one bounded batch per cleanup call", async () => {
    const keys = Array.from(
      { length: ARTIFACT_DELETE_BATCH_SIZE + 1 },
      (_, index) => `test-artifacts/delete-${index}`,
    );
    await Promise.all(keys.map((key) => env.JOB_ARTIFACTS.put(key, "x")));
    expect(await deleteJobArtifacts(env.JOB_ARTIFACTS, keys)).toHaveLength(ARTIFACT_DELETE_BATCH_SIZE);
    expect((await env.JOB_ARTIFACTS.list({ prefix: "test-artifacts/delete-" })).keys).toHaveLength(1);
  });
});
