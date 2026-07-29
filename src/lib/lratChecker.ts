export interface PinnedLratCheckRequest {
  encodedFormula: Uint8Array;
  cube: number[];
  proof: Uint8Array;
}

interface CheckerWorkerResponse {
  valid: boolean;
  reason?: string;
}

export function verifyWithPinnedLratChecker(request: PinnedLratCheckRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/lrat-check.worker.ts", import.meta.url), {
      type: "module",
      name: "hivesat-lrat-check",
    });
    worker.onmessage = (event: MessageEvent<CheckerWorkerResponse>) => {
      worker.terminate();
      if (event.data.valid) resolve();
      else reject(new Error(event.data.reason ?? "The pinned LRAT checker rejected the proof."));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "The pinned LRAT checker failed."));
    };
    const encoded = request.encodedFormula.slice();
    const proof = request.proof.slice();
    worker.postMessage(
      { encodedFormula: encoded, cube: request.cube, proof },
      [encoded.buffer, proof.buffer],
    );
  });
}
