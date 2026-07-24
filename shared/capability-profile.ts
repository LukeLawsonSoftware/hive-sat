import type { WorkerCapabilities } from "./coordinator-protocol";

export interface CalibratedTaskProfile {
  conflictBudget: number;
  leaseDurationMs: number;
}

export function calibratedTaskProfile(capabilities: WorkerCapabilities): CalibratedTaskProfile {
  const throughput = capabilities.calibratedConflictsPerSecond;
  if (capabilities.mobile || (throughput !== undefined && throughput < 10_000)) {
    return { conflictBudget: 50, leaseDurationMs: 10 * 60_000 };
  }
  if (throughput !== undefined && throughput >= 200_000) {
    return { conflictBudget: 200, leaseDurationMs: 20 * 60_000 };
  }
  return { conflictBudget: 100, leaseDurationMs: 15 * 60_000 };
}
