import { describe, expect, it } from "vitest";
import { conservativeWorkerCapacity } from "./workerCapacity";

describe("distributed worker capacity", () => {
  it("uses at most two desktop workers and one mobile worker", () => {
    expect(conservativeWorkerCapacity({ hardwareConcurrency: 16, mobile: false })).toBe(2);
    expect(conservativeWorkerCapacity({ hardwareConcurrency: 16, mobile: true })).toBe(1);
    expect(conservativeWorkerCapacity({ hardwareConcurrency: 1, mobile: false })).toBe(1);
    expect(conservativeWorkerCapacity({ hardwareConcurrency: 8, mobile: false, preference: 1 })).toBe(1);
    expect(conservativeWorkerCapacity({ hardwareConcurrency: 8, mobile: false, preference: 20 })).toBe(2);
  });
});
