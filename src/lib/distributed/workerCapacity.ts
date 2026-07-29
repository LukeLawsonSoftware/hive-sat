export interface WorkerCapacityInput {
  hardwareConcurrency?: number;
  mobile: boolean;
  preference?: number;
}

export function conservativeWorkerCapacity(input: WorkerCapacityInput): number {
  const detected = Number.isFinite(input.hardwareConcurrency)
    ? Math.max(1, Math.floor(input.hardwareConcurrency ?? 1))
    : 1;
  const platformDefault = input.mobile ? 1 : 2;
  const preference = input.preference === undefined
    ? platformDefault
    : Math.max(1, Math.floor(input.preference));
  return Math.max(1, Math.min(detected, platformDefault, preference));
}

export function isLikelyMobile(userAgent = navigator.userAgent): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/u.test(userAgent);
}

export interface WorkerClaim {
  workerIndex: number;
  source: "OWNER" | "PUBLIC" | "IDLE";
}

/**
 * Assigns every available worker to the owner's active job before any worker
 * is allowed to ask the public swarm for work.
 */
export function ownerFirstClaims(
  availableWorkers: number,
  ownerReadyTasks: number,
  publicWorkEnabled: boolean,
): WorkerClaim[] {
  const claims: WorkerClaim[] = [];
  let ownerRemaining = Math.max(0, Math.floor(ownerReadyTasks));
  for (let workerIndex = 0; workerIndex < Math.max(0, Math.floor(availableWorkers)); workerIndex += 1) {
    if (ownerRemaining > 0) {
      claims.push({ workerIndex, source: "OWNER" });
      ownerRemaining -= 1;
    } else {
      claims.push({ workerIndex, source: publicWorkEnabled ? "PUBLIC" : "IDLE" });
    }
  }
  return claims;
}
