import { describe, expect, it, vi } from "vitest";
import {
  MockSolverClient,
  resultForFilename,
  validateCnfFile,
} from "./solver";

const selectedFile = {
  name: "benchmark.cnf",
  size: 1024,
  lastModified: 0,
};

describe("DIMACS file validation", () => {
  it("accepts a non-empty .cnf file", () => {
    expect(validateCnfFile(new File(["p cnf 1 1"], "tiny.cnf"))).toBeNull();
  });

  it("rejects empty and incorrectly named files", () => {
    expect(validateCnfFile(new File([], "empty.cnf"))).toMatch(/empty/i);
    expect(validateCnfFile(new File(["x"], "notes.txt"))).toMatch(/\.cnf/i);
  });
});

describe("MockSolverClient", () => {
  it("moves through the complete simulated lifecycle", () => {
    vi.useFakeTimers();
    const client = new MockSolverClient();
    const phases: string[] = [];
    client.subscribe((snapshot) => phases.push(snapshot.phase));

    client.select(selectedFile);
    client.start();
    vi.runAllTimers();

    expect(phases).toEqual(["ready", "queued", "distributing", "solving", "result"]);
    expect(client.getSnapshot().result?.verdict).toBe(resultForFilename(selectedFile.name));
    vi.useRealTimers();
  });

  it("cancels to a ready state and clears pending work", () => {
    vi.useFakeTimers();
    const client = new MockSolverClient();
    client.select(selectedFile);
    client.start();
    client.cancel();
    vi.runAllTimers();

    expect(client.getSnapshot().phase).toBe("ready");
    expect(client.getSnapshot().message).toMatch(/cancelled/i);
    vi.useRealTimers();
  });

  it("exposes a deterministic demo error path", () => {
    vi.useFakeTimers();
    const client = new MockSolverClient();
    client.select({ ...selectedFile, name: "network-error.cnf" });
    client.start();
    vi.runAllTimers();

    expect(client.getSnapshot().phase).toBe("error");
    vi.useRealTimers();
  });
});
