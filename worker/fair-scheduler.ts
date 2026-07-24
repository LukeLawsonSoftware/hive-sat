import {
  SWARM_ASSIGNMENT_QUANTUM_MS,
  SWARM_MAX_JOB_WORKERS,
} from "../shared/swarm-protocol";

export interface FairJob {
  jobId: string;
  virtualWorkerMs: number;
  assignedWorkers: number;
  lastServiceAt: number;
}

export function agingCreditMs(job: FairJob, now: number): number {
  const waitedMs = Math.max(0, now - job.lastServiceAt);
  return Math.min(SWARM_ASSIGNMENT_QUANTUM_MS, waitedMs * 0.05);
}

export function fairServiceScore(job: FairJob, now: number): number {
  return job.virtualWorkerMs - agingCreditMs(job, now);
}

export function selectFairJob(
  jobs: readonly FairJob[],
  requestedWorkers: number,
  now: number,
): { job: FairJob; workers: number } | null {
  const available = jobs
    .filter((job) => job.assignedWorkers < SWARM_MAX_JOB_WORKERS)
    .sort((left, right) =>
      fairServiceScore(left, now) - fairServiceScore(right, now) ||
      left.lastServiceAt - right.lastServiceAt ||
      left.jobId.localeCompare(right.jobId));
  const job = available[0];
  if (!job) return null;
  return {
    job,
    workers: Math.max(
      1,
      Math.min(
        Math.floor(requestedWorkers),
        SWARM_MAX_JOB_WORKERS - job.assignedWorkers,
      ),
    ),
  };
}

export function newJobVirtualRuntime(existing: readonly FairJob[]): number {
  if (existing.length === 0) return 0;
  return Math.min(...existing.map((job) => job.virtualWorkerMs));
}

export function reconciledVirtualRuntime(
  virtualWorkerMs: number,
  reservedWorkerMs: number,
  actualWorkerMs: number,
): number {
  const boundedActual = Math.max(0, Math.min(reservedWorkerMs, actualWorkerMs));
  return Math.max(0, virtualWorkerMs - reservedWorkerMs + boundedActual);
}
