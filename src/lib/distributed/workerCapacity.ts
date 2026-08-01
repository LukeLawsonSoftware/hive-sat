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
