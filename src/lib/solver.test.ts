import { describe, expect, it, vi } from "vitest";
import { encodeHiveCnfV1, sha256Hex } from "./formula/hiveCnf";
import type { FormulaWorkerResponse, SolverWorkerResponse } from "./formula/workerProtocol";
import { BrowserSolverClient, validateCnfFile } from "./solver";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Array<{ message: Record<string, unknown>; transfer: Transferable[] }> = [];
  terminated = false;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted.push({ message: message as Record<string, unknown>, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: FormulaWorkerResponse | SolverWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

async function fixture() {
  const encoded = encodeHiveCnfV1({
    variableCount: 1,
    clauseCount: 1,
    literalCount: 1,
    clauses: [[1]],
  });
  return { encoded, hash: await sha256Hex(encoded) };
}

describe("DIMACS file validation", () => {
  it("accepts plain and gzip DIMACS extensions", () => {
    expect(validateCnfFile(new File(["p cnf 1 1"], "tiny.cnf"))).toBeNull();
    expect(validateCnfFile(new File(["gzip"], "tiny.cnf.gz"))).toBeNull();
  });

  it("rejects empty, incorrectly named, and oversized files", () => {
    expect(validateCnfFile(new File([], "empty.cnf"))).toMatch(/empty/i);
    expect(validateCnfFile(new File(["x"], "notes.txt"))).toMatch(/\.cnf/i);
    const large = { name: "large.cnf.gz", size: 5 * 1024 * 1024 + 1 } as File;
    expect(validateCnfFile(large)).toMatch(/5\.0 MB/i);
  });
});

describe("BrowserSolverClient", () => {
  it("verifies formula bytes, transfers clause batches, and checks a SAT model", async () => {
    const formulaWorker = new FakeWorker();
    const solverWorker = new FakeWorker();
    const workers = [formulaWorker, solverWorker];
    const client = new BrowserSolverClient(() => workers.shift()!);
    client.select(new File(["p cnf 1 1\n1 0\n"], "sat.cnf"));
    client.prepare();
    const requestId = formulaWorker.posted[0].message.requestId as string;
    const { encoded, hash } = await fixture();
    const batch = Int32Array.from([1, 0]);

    formulaWorker.emit({
      type: "completed",
      requestId,
      metadata: {
        hash,
        variableCount: 1,
        clauseCount: 1,
        literalCount: 1,
        encodedBytes: encoded.byteLength,
        compressedBytes: 30,
        cacheHit: false,
      },
      encoded: encoded.slice().buffer as ArrayBuffer,
      batches: [batch],
    });

    await vi.waitFor(() => expect(client.getSnapshot().phase).toBe("prepared"));
    expect(solverWorker.posted).toHaveLength(0);
    client.solveLocally();
    await vi.waitFor(() => expect(solverWorker.posted).toHaveLength(2));
    expect(solverWorker.posted.map(({ message }) => message.type)).toEqual(["initialize", "clause-batch"]);
    expect(solverWorker.posted[1].transfer).toHaveLength(1);
    solverWorker.emit({ type: "ready", requestId });
    expect(client.getSnapshot().phase).toBe("solving");
    expect(solverWorker.posted.at(-1)?.message.type).toBe("solve");

    solverWorker.emit({
      type: "result",
      requestId,
      verdict: "SAT",
      model: [1],
      metrics: { conflicts: 0, decisions: 0, propagations: 1 },
      slices: 1,
    });
    expect(client.getSnapshot().result).toMatchObject({
      verdict: "SAT",
      modelVerified: true,
      model: [1],
      formulaHash: hash,
    });
  });

  it("pauses and resumes the same bounded solver worker", async () => {
    const formulaWorker = new FakeWorker();
    const solverWorker = new FakeWorker();
    const workers = [formulaWorker, solverWorker];
    const client = new BrowserSolverClient(() => workers.shift()!);
    client.select(new File(["p cnf 1 1\n1 0\n"], "resume.cnf"));
    client.prepare();
    const requestId = formulaWorker.posted[0].message.requestId as string;
    const { encoded, hash } = await fixture();
    const batch = Int32Array.from([1, 0]);
    formulaWorker.emit({
      type: "completed",
      requestId,
      metadata: { hash, variableCount: 1, clauseCount: 1, literalCount: 1, encodedBytes: encoded.byteLength, compressedBytes: 30, cacheHit: false },
      encoded: encoded.slice().buffer as ArrayBuffer,
      batches: [batch],
    });
    await vi.waitFor(() => expect(client.getSnapshot().phase).toBe("prepared"));
    client.solveLocally();
    await vi.waitFor(() => expect(solverWorker.posted).toHaveLength(2));
    solverWorker.emit({ type: "ready", requestId });
    client.cancel();
    expect(client.getSnapshot()).toMatchObject({ phase: "prepared", message: expect.stringMatching(/resume continues/i) });
    expect(solverWorker.posted.at(-1)?.message.type).toBe("pause");

    client.solveLocally();
    expect(client.getSnapshot().phase).toBe("solving");
    expect(solverWorker.posted.at(-1)?.message.type).toBe("solve");
    expect(workers).toHaveLength(0);
  });

  it("fails closed when the independent verifier rejects a model", async () => {
    const formulaWorker = new FakeWorker();
    const solverWorker = new FakeWorker();
    const workers = [formulaWorker, solverWorker];
    const client = new BrowserSolverClient(() => workers.shift()!);
    client.select(new File(["p cnf 1 1\n1 0\n"], "bad-model.cnf"));
    client.prepare();
    const requestId = formulaWorker.posted[0].message.requestId as string;
    const { encoded, hash } = await fixture();
    const batch = Int32Array.from([1, 0]);
    formulaWorker.emit({
      type: "completed",
      requestId,
      metadata: { hash, variableCount: 1, clauseCount: 1, literalCount: 1, encodedBytes: encoded.byteLength, compressedBytes: 30, cacheHit: false },
      encoded: encoded.slice().buffer as ArrayBuffer,
      batches: [batch],
    });
    await vi.waitFor(() => expect(client.getSnapshot().phase).toBe("prepared"));
    client.solveLocally();
    await vi.waitFor(() => expect(solverWorker.posted).toHaveLength(2));
    solverWorker.emit({ type: "ready", requestId });
    solverWorker.emit({
      type: "result",
      requestId,
      verdict: "SAT",
      model: [-1],
      metrics: { conflicts: 0, decisions: 0, propagations: 1 },
      slices: 1,
    });
    expect(client.getSnapshot()).toMatchObject({ phase: "error", message: expect.stringMatching(/model verification failed/i) });
  });
});
