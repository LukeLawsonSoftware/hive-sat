const MIN_KV_EXPIRATION_SECONDS = 60;
export const ARTIFACT_DELETE_BATCH_SIZE = 128;

export type JobArtifactKind = "formula" | "sat-model" | "unsat-proof";

export interface JobArtifactMetadata {
  kind: JobArtifactKind;
  jobId: string;
  taskId?: string;
  formulaHash: string;
  artifactSha256?: string;
  contentType: string;
  bytes: number;
}

function exactLengthStream(
  body: ReadableStream<Uint8Array>,
): { stream: ReadableStream<Uint8Array>; observedBytes: () => number } {
  let observedBytes = 0;
  const stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      observedBytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }));
  return { stream, observedBytes: () => observedBytes };
}

export async function putJobArtifact(
  namespace: KVNamespace,
  key: string,
  body: ReadableStream<Uint8Array>,
  metadata: JobArtifactMetadata,
  expiresAt: number,
): Promise<void> {
  const expiration = Math.ceil(expiresAt / 1_000);
  if (expiration - Math.floor(Date.now() / 1_000) < MIN_KV_EXPIRATION_SECONDS) {
    throw new Error("The job expires too soon to store another artifact.");
  }
  const counted = exactLengthStream(body);
  await namespace.put(key, counted.stream, {
    expiration,
    metadata,
  });
  if (counted.observedBytes() !== metadata.bytes) {
    await namespace.delete(key);
    throw new Error("Artifact body does not match its declared byte length.");
  }
}

export function getJobArtifact(
  namespace: KVNamespace,
  key: string,
): Promise<ReadableStream | null> {
  return namespace.get(key, "stream");
}

export async function deleteJobArtifacts(
  namespace: KVNamespace,
  keys: readonly string[],
): Promise<string[]> {
  const batch = keys.slice(0, ARTIFACT_DELETE_BATCH_SIZE);
  await Promise.all(batch.map((key) => namespace.delete(key)));
  return batch;
}
