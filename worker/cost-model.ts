export interface SwarmLoadScenario {
  clients: number;
  activeFraction: number;
  heartbeatIntervalSeconds: number;
  leaseMinutes: number;
  assignmentQuantumHours: number;
  formulaCacheHitRate: number;
  decisiveResultsPerDay: number;
}

export interface SwarmLoadProjection {
  activeClients: number;
  websocketMessagesPerDay: number;
  persistedRowsPerDay: number;
  directoryRequestsPerDay: number;
  r2ReadsPerDay: number;
  r2WritesPerDay: number;
}

function boundedRatio(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between zero and one.`);
  return value;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive.`);
  return value;
}

/** Conservative request/write projection used by launch gates and runbooks. */
export function projectSwarmLoad(scenario: SwarmLoadScenario): SwarmLoadProjection {
  const clients = Math.ceil(positive(scenario.clients, "clients"));
  const activeClients = Math.ceil(clients * boundedRatio(scenario.activeFraction, "activeFraction"));
  const heartbeatInterval = positive(scenario.heartbeatIntervalSeconds, "heartbeatIntervalSeconds");
  const leaseMinutes = positive(scenario.leaseMinutes, "leaseMinutes");
  const quantumHours = positive(scenario.assignmentQuantumHours, "assignmentQuantumHours");
  const cacheMissRate = 1 - boundedRatio(scenario.formulaCacheHitRate, "formulaCacheHitRate");
  const heartbeats = activeClients * Math.ceil(86_400 / heartbeatInterval);
  const leaseTransitions = activeClients * Math.ceil(1_440 / leaseMinutes) * 2;
  const directoryRequests = activeClients * Math.ceil(24 / quantumHours);
  const results = Math.max(0, Math.ceil(scenario.decisiveResultsPerDay));
  return {
    activeClients,
    websocketMessagesPerDay: heartbeats + leaseTransitions,
    // Ordinary 60-second heartbeats are intentionally not persisted.
    persistedRowsPerDay: leaseTransitions + results * 2,
    directoryRequestsPerDay: directoryRequests,
    r2ReadsPerDay: Math.ceil(directoryRequests * cacheMissRate),
    r2WritesPerDay: results,
  };
}

export function projectionWithinMargins(
  projection: SwarmLoadProjection,
  ceilings: Omit<SwarmLoadProjection, "activeClients">,
  safetyMarginPercent: number,
): boolean {
  const margin = boundedRatio(safetyMarginPercent / 100, "safetyMarginPercent");
  return (Object.keys(ceilings) as Array<keyof typeof ceilings>).every(
    (key) => projection[key] <= ceilings[key] * margin,
  );
}
