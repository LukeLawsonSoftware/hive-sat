import { VerifiedFormulaCache } from "../lib/formula/cache";
import { gzipHiveCnf, streamDimacsFile } from "../lib/formula/compression";
import { DimacsParseError, parseDimacs } from "../lib/formula/dimacs";
import { decodeHiveCnfV1, encodeHiveCnfV1, sha256Hex } from "../lib/formula/hiveCnf";
import type { FormulaWorkerRequest, FormulaWorkerResponse } from "../lib/formula/workerProtocol";

const controllers = new Map<string, AbortController>();
const cache = new VerifiedFormulaCache();

function send(message: FormulaWorkerResponse, transfer: Transferable[] = []): void {
  globalThis.postMessage(message, { transfer });
}

async function parseFormula(requestId: string, file: File): Promise<void> {
  const controller = new AbortController();
  controllers.set(requestId, controller);
  try {
    const stream = await streamDimacsFile(file, controller.signal, (bytesRead, totalBytes) => {
      send({ type: "progress", requestId, stage: "reading", bytesRead, totalBytes });
    });
    const parsed = await parseDimacs(stream.chunks, {
      signal: controller.signal,
      totalBytes: stream.totalBytes,
      onProgress: ({ bytesRead, totalBytes, line }) => {
        send({ type: "progress", requestId, stage: "reading", bytesRead, totalBytes, line });
      },
    });

    send({ type: "progress", requestId, stage: "encoding" });
    let encoded = encodeHiveCnfV1(parsed);
    const hash = await sha256Hex(encoded);

    send({ type: "progress", requestId, stage: "caching" });
    const cached = await cache.get(hash).catch(() => null);
    let gzip: Uint8Array;
    let cacheHit = false;
    if (cached) {
      encoded = new Uint8Array(cached.encoded);
      gzip = new Uint8Array(cached.gzip);
      cacheHit = true;
    } else {
      send({ type: "progress", requestId, stage: "compressing" });
      gzip = await gzipHiveCnf(encoded, controller.signal);
      await cache.put({
        hash,
        encoded: encoded.slice().buffer,
        gzip: gzip.slice().buffer,
        variableCount: parsed.variableCount,
        clauseCount: parsed.clauseCount,
        literalCount: parsed.literalCount,
        verifiedAt: Date.now(),
      }).catch(() => undefined);
    }

    const verified = decodeHiveCnfV1(encoded);
    const encodedBuffer = encoded.slice().buffer;
    send(
      {
        type: "completed",
        requestId,
        metadata: {
          hash,
          variableCount: verified.variableCount,
          clauseCount: verified.clauseCount,
          literalCount: verified.literalCount,
          encodedBytes: encoded.byteLength,
          compressedBytes: gzip.byteLength,
          cacheHit,
        },
        encoded: encodedBuffer,
      },
      [encodedBuffer],
    );
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      send({ type: "cancelled", requestId });
    } else if (error instanceof DimacsParseError) {
      send({
        type: "error",
        requestId,
        message: error.message,
        line: error.line,
        column: error.column,
        byteOffset: error.byteOffset,
      });
    } else {
      send({
        type: "error",
        requestId,
        message: error instanceof Error ? error.message : "Formula processing failed.",
      });
    }
  } finally {
    controllers.delete(requestId);
  }
}

globalThis.addEventListener("message", (event: MessageEvent<FormulaWorkerRequest>) => {
  if (event.data.type === "cancel") {
    controllers.get(event.data.requestId)?.abort();
    return;
  }
  void parseFormula(event.data.requestId, event.data.file);
});
