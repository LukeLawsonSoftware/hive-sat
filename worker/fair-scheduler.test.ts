import { describe, expect, it } from "vitest";
import {
  newJobVirtualRuntime,
  reconciledVirtualRuntime,
  selectFairJob,
  type FairJob,
} from "./fair-scheduler";
import { calibratedTaskProfile } from "../shared/capability-profile";

function simulate(
  jobs: FairJob[],
  durations: Record<string, number[]>,
  assignments: number,
): Record<string, number> {
  const received = Object.fromEntries(jobs.map((job) => [job.jobId, 0]));
  for (let index = 0; index < assignments; index += 1) {
    const now = index * 60_000;
    const selected = selectFairJob(jobs, index % 3 === 0 ? 2 : 1, now);
    if (!selected) throw new Error("Expected an eligible fair-scheduler job.");
    const job = selected.job;
    const durationList = durations[job.jobId];
    const activeMs = (durationList[index % durationList.length] ?? 0) * selected.workers;
    const reservedMs = 3_600_000 * selected.workers;
    job.virtualWorkerMs += reservedMs;
    job.assignedWorkers += selected.workers;
    job.lastServiceAt = now;
    job.virtualWorkerMs = reconciledVirtualRuntime(job.virtualWorkerMs, reservedMs, activeMs);
    job.assignedWorkers -= selected.workers;
    received[job.jobId] += activeMs;
  }
  return received;
}

describe("equal-service virtual worker-time scheduler", () => {
  it("keeps received worker time bounded under unequal tasks and heterogeneous devices", () => {
    const jobs: FairJob[] = ["a", "b", "c"].map((jobId) => ({
      jobId,
      virtualWorkerMs: 0,
      assignedWorkers: 0,
      lastServiceAt: 0,
    }));
    const received = simulate(jobs, {
      a: [90_000, 700_000, 10_000],
      b: [400_000, 30_000],
      c: [250_000, 250_000, 0],
    }, 120);
    const values = Object.values(received);
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1_400_000);
  });

  it("rotates after zero-work churn and gives a new job the current minimum", () => {
    const jobs: FairJob[] = [
      { jobId: "old-a", virtualWorkerMs: 9_000, assignedWorkers: 0, lastServiceAt: 0 },
      { jobId: "old-b", virtualWorkerMs: 12_000, assignedWorkers: 0, lastServiceAt: 0 },
    ];
    expect(newJobVirtualRuntime(jobs)).toBe(9_000);
    jobs.push({ jobId: "new", virtualWorkerMs: 9_000, assignedWorkers: 0, lastServiceAt: 10 });

    const first = selectFairJob(jobs, 1, 100);
    expect(first?.job.jobId).toBe("old-a");
    if (!first) return;
    first.job.lastServiceAt = 100;
    first.job.virtualWorkerMs = reconciledVirtualRuntime(
      first.job.virtualWorkerMs + 3_600_000,
      3_600_000,
      0,
    );
    expect(selectFairJob(jobs, 1, 101)?.job.jobId).toBe("new");
  });

  it("enforces the per-job worker ceiling without changing priority by capability", () => {
    const jobs: FairJob[] = [
      { jobId: "lowest", virtualWorkerMs: 0, assignedWorkers: 7, lastServiceAt: 0 },
      { jobId: "next", virtualWorkerMs: 1, assignedWorkers: 0, lastServiceAt: 0 },
    ];
    expect(selectFairJob(jobs, 32, 0)).toMatchObject({
      job: { jobId: "lowest" },
      workers: 1,
    });
    jobs[0].assignedWorkers = 8;
    expect(selectFairJob(jobs, 32, 0)).toMatchObject({
      job: { jobId: "next" },
      workers: 8,
    });
  });

  it("uses calibration only to size slices and leases", () => {
    const base = {
      hardwareConcurrency: 8,
      maxWorkers: 2,
      solverVersion: "cadical-3.0.1",
    };
    expect(calibratedTaskProfile({
      ...base,
      mobile: true,
      calibratedConflictsPerSecond: 5_000,
    })).toEqual({ conflictBudget: 50, leaseDurationMs: 600_000 });
    expect(calibratedTaskProfile({
      ...base,
      mobile: false,
      calibratedConflictsPerSecond: 300_000,
    })).toEqual({ conflictBudget: 200, leaseDurationMs: 1_200_000 });
  });
});
