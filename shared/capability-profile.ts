import type { WorkerCapabilities } from "./coordinator-protocol";
import { COORDINATOR_LEASE_DURATION_MS } from "./coordinator-protocol";

export interface CalibratedTaskProfile {
  conflictBudget: number;
  leaseDurationMs: number;
}

export function calibratedTaskProfile(capabilities: WorkerCapabilities): CalibratedTaskProfile {
  const throughput = capabilities.calibratedConflictsPerSecond;
  if (capabilities.mobile || (throughput !== undefined && throughput < 10_000)) {
    return { conflictBudget: 50, leaseDurationMs: COORDINATOR_LEASE_DURATION_MS };
  }
  if (throughput !== undefined && throughput >= 200_000) {
    return { conflictBudget: 200, leaseDurationMs: COORDINATOR_LEASE_DURATION_MS };
  }
  return { conflictBudget: 100, leaseDurationMs: COORDINATOR_LEASE_DURATION_MS };
}
