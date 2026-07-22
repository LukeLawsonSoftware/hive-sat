import {
  MAX_COMPRESSED_FORMULA_BYTES,
  MAX_DECOMPRESSED_DIMACS_BYTES,
} from "./limits";

function requireCompressionStream(): typeof CompressionStream {
  if (typeof CompressionStream === "undefined") {
    throw new Error("This browser does not support gzip compression streams.");
  }
  return CompressionStream;
}

function requireDecompressionStream(): typeof DecompressionStream {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser does not support gzip decompression streams.");
  }
  return DecompressionStream;
}

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  label: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException(`${label} was cancelled.`, "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > limit) throw new Error(`${label} exceeds the ${limit}-byte limit.`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function gzipHiveCnf(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  const Stream = requireCompressionStream();
  const compressed = new Blob([bytes.slice().buffer])
    .stream()
    .pipeThrough(new Stream("gzip"));
  return collectBounded(
    compressed,
    MAX_COMPRESSED_FORMULA_BYTES,
    "Compressed HiveCnfV1 formula",
    signal,
  );
}

export interface DimacsFileStream {
  chunks: AsyncGenerator<Uint8Array>;
  compressed: boolean;
  totalBytes?: number;
}

export async function streamDimacsFile(
  file: File,
  signal: AbortSignal,
  onInputProgress?: (bytesRead: number, totalBytes: number) => void,
): Promise<DimacsFileStream> {
  const prefix = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const compressed = prefix[0] === 0x1f && prefix[1] === 0x8b;
  const namedAsGzip = file.name.toLowerCase().endsWith(".gz");

  if (namedAsGzip && !compressed) throw new Error("The .gz file does not contain a gzip stream.");
  if (compressed && file.size > MAX_COMPRESSED_FORMULA_BYTES) {
    throw new Error(`Compressed formula exceeds the ${MAX_COMPRESSED_FORMULA_BYTES}-byte limit.`);
  }
  if (!compressed && file.size > MAX_DECOMPRESSED_DIMACS_BYTES) {
    throw new Error(`DIMACS input exceeds the ${MAX_DECOMPRESSED_DIMACS_BYTES}-byte limit.`);
  }

  let inputBytes = 0;
  const countedInput = file.stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (signal.aborted) {
          controller.error(new DOMException("Formula parsing was cancelled.", "AbortError"));
          return;
        }
        inputBytes += chunk.byteLength;
        onInputProgress?.(inputBytes, file.size);
        controller.enqueue(chunk);
      },
    }),
  );

  const output: ReadableStream<Uint8Array> = compressed
    ? countedInput.pipeThrough(
        new (requireDecompressionStream())("gzip") as unknown as ReadableWritablePair<
          Uint8Array,
          Uint8Array
        >,
      )
    : countedInput;

  async function* read(): AsyncGenerator<Uint8Array> {
    const reader = output.getReader();
    let decompressedBytes = 0;
    try {
      while (true) {
        if (signal.aborted) throw new DOMException("Formula parsing was cancelled.", "AbortError");
        const { done, value } = await reader.read();
        if (done) break;
        decompressedBytes += value.byteLength;
        if (decompressedBytes > MAX_DECOMPRESSED_DIMACS_BYTES) {
          throw new Error(
            `Decompressed DIMACS exceeds the ${MAX_DECOMPRESSED_DIMACS_BYTES}-byte limit.`,
          );
        }
        yield value;
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  return {
    chunks: read(),
    compressed,
    totalBytes: compressed ? undefined : file.size,
  };
}
