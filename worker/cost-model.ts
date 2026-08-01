import {
  COORDINATOR_LEASE_DURATION_MS,
  COORDINATOR_LEASE_RENEW_THRESHOLD_MS,
} from "../shared/coordinator-protocol";

const SECONDS_PER_DAY = 86_400;
const MUTATED_ROWS_PER_TASK_TRANSITION = 10;
const MUTATED_ROWS_PER_SUBMITTED_JOB = 6;
const MUTATED_ROWS_PER_DECISIVE_RESULT = 8;

export interface SwarmLoadScenario {
  clients: number;
  activeFraction: number;
  slotsPerClient: number;
  heartbeatIntervalSeconds: number;
  taskTransitionsPerSlotHour: number;
  assignmentQuantumHours: number;
  formulaCacheHitRate: number;
  submittedJobsPerDay: number;
  decisiveResultsPerDay: number;
}

export interface SwarmLoadProjection {
  activeClients: number;
  activeSlots: number;
  websocketMessagesPerDay: number;
  persistedRowsPerDay: number;
  directoryRequestsPerDay: number;
  kvReadsPerDay: number;
  kvWritesPerDay: number;
}

function boundedRatio(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between zero and one.`);
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive.`);
  return value;
}

function nonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must not be negative.`);
  return value;
}

/** Conservative request/write projection used by launch gates and runbooks. */
export function projectSwarmLoad(scenario: SwarmLoadScenario): SwarmLoadProjection {
  const clients = Math.ceil(positive(scenario.clients, "clients"));
  const activeClients = Math.ceil(clients * boundedRatio(scenario.activeFraction, "activeFraction"));
  const slotsPerClient = Math.ceil(positive(scenario.slotsPerClient, "slotsPerClient"));
  const activeSlots = activeClients * slotsPerClient;
  const heartbeatInterval = positive(scenario.heartbeatIntervalSeconds, "heartbeatIntervalSeconds");
  const leaseDurationSeconds = COORDINATOR_LEASE_DURATION_MS / 1_000;
  if (heartbeatInterval >= leaseDurationSeconds) {
    throw new Error("heartbeatIntervalSeconds must be shorter than the coordinator lease duration.");
  }
  const taskTransitionRate = nonnegative(scenario.taskTransitionsPerSlotHour, "taskTransitionsPerSlotHour");
  const quantumHours = positive(scenario.assignmentQuantumHours, "assignmentQuantumHours");
  const cacheMissRate = 1 - boundedRatio(scenario.formulaCacheHitRate, "formulaCacheHitRate");
  // One session heartbeat and one ACK, regardless of the number of slots.
  const heartbeatMessages = activeClients * Math.ceil(SECONDS_PER_DAY / heartbeatInterval) * 2;
  const taskTransitions = Math.ceil(activeSlots * 24 * taskTransitionRate);
  // Conservative upper bound: permit/push, mutation, ACK, and up to two
  // replacement WORK frames after a split.
  const transitionMessages = taskTransitions * 5;
  const directoryRequests = activeClients * Math.ceil(24 / quantumHours);
  const results = Math.ceil(nonnegative(scenario.decisiveResultsPerDay, "decisiveResultsPerDay"));
  const submittedJobs = Math.ceil(nonnegative(scenario.submittedJobsPerDay, "submittedJobsPerDay"));
  const renewalEligibilitySeconds = (
    COORDINATOR_LEASE_DURATION_MS - COORDINATOR_LEASE_RENEW_THRESHOLD_MS
  ) / 1_000;
  const renewalIntervalSeconds = Math.ceil(renewalEligibilitySeconds / heartbeatInterval) * heartbeatInterval;
  // A session heartbeat itself is not persisted. Each occupied slot writes once
  // when it crosses the split seed, then at the first heartbeat in each renewal
  // window. Treating every slot as continuously occupied is intentionally
  // conservative; task transitions normally reset the renewal clock.
  const leaseProgressWrites = activeSlots * (
    1 + Math.ceil(SECONDS_PER_DAY / renewalIntervalSeconds)
  ) + taskTransitions;
  return {
    activeClients,
    activeSlots,
    websocketMessagesPerDay: heartbeatMessages + transitionMessages,
    persistedRowsPerDay:
      activeClients +
      activeSlots * 2 +
      leaseProgressWrites +
      taskTransitions * MUTATED_ROWS_PER_TASK_TRANSITION +
      submittedJobs * MUTATED_ROWS_PER_SUBMITTED_JOB +
      results * MUTATED_ROWS_PER_DECISIVE_RESULT,
    directoryRequestsPerDay: directoryRequests,
    kvReadsPerDay: Math.ceil(directoryRequests * cacheMissRate) + results * 2,
    // Every retained artifact is written once and deleted at job cleanup.
    kvWritesPerDay: (submittedJobs + results) * 2,
  };
}

export function projectionWithinMargins(
  projection: SwarmLoadProjection,
  ceilings: Omit<SwarmLoadProjection, "activeClients" | "activeSlots">,
  safetyMarginPercent: number,
): boolean {
  const margin = boundedRatio(safetyMarginPercent / 100, "safetyMarginPercent");
  return (Object.keys(ceilings) as Array<keyof typeof ceilings>).every(
    (key) => projection[key] <= ceilings[key] * margin,
  );
}
