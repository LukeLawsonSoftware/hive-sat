import { describe, expect, it } from "vitest";
import { cubeQueueWatermarks } from "../../../shared/coordinator-protocol";
import { conservativeWorkerCapacity, ownerFirstClaims } from "./workerCapacity";

describe("distributed worker capacity", () => {
  it("uses at most two desktop workers and one mobile worker", () => {
    expect(conservativeWorkerCapacity({ hardwareConcurrency: 16, mobile: false })).toBe(2);
    expect(conservativeWorkerCapacity({ hardwareConcurrency: 16, mobile: true })).toBe(1);
    expect(conservativeWorkerCapacity({ hardwareConcurrency: 1, mobile: false })).toBe(1);
    expect(conservativeWorkerCapacity({ hardwareConcurrency: 8, mobile: false, preference: 1 })).toBe(1);
    expect(conservativeWorkerCapacity({ hardwareConcurrency: 8, mobile: false, preference: 20 })).toBe(2);
  });

  it("gives an owner's ready tasks first claim on every worker", () => {
    expect(ownerFirstClaims(2, 2, true).map((claim) => claim.source)).toEqual(["OWNER", "OWNER"]);
    expect(ownerFirstClaims(2, 1, true).map((claim) => claim.source)).toEqual(["OWNER", "PUBLIC"]);
    expect(ownerFirstClaims(2, 0, false).map((claim) => claim.source)).toEqual(["IDLE", "IDLE"]);
  });

  it("derives 1x/3x/8x queue watermarks from active workers", () => {
    expect(cubeQueueWatermarks(4)).toEqual({
      lowWatermark: 4,
      targetWatermark: 12,
      highWatermark: 32,
    });
    expect(cubeQueueWatermarks(0)).toEqual({
      lowWatermark: 1,
      targetWatermark: 3,
      highWatermark: 8,
    });
  });
});
