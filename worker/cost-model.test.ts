import { describe, expect, it } from "vitest";
import { projectSwarmLoad, projectionWithinMargins } from "./cost-model";

describe("launch load and quota projection", () => {
  it("models several hundred intermittent clients with bounded session heartbeats", () => {
    const projection = projectSwarmLoad({
      clients: 600,
      activeFraction: 0.04,
      slotsPerClient: 2,
      heartbeatIntervalSeconds: 60,
      taskTransitionsPerSlotHour: 0.25,
      assignmentQuantumHours: 1,
      formulaCacheHitRate: 0.8,
      submittedJobsPerDay: 10,
      decisiveResultsPerDay: 20,
    });
    expect(projection.activeClients).toBe(24);
    expect(projection.activeSlots).toBe(48);
    expect(projection.websocketMessagesPerDay).toBe(70_560);
    expect(projection.persistedRowsPerDay).toBe(38_116);
    expect(projection.directoryRequestsPerDay).toBe(576);
    expect(projection.kvReadsPerDay).toBe(156);
    expect(projection.kvWritesPerDay).toBe(60);
    expect(projectionWithinMargins(projection, {
      websocketMessagesPerDay: 100_000,
      persistedRowsPerDay: 50_000,
      directoryRequestsPerDay: 1_000,
      kvReadsPerDay: 1_000,
      kvWritesPerDay: 100,
    }, 80)).toBe(true);
  });

  it("rejects heartbeat assumptions that cannot renew a five-minute lease", () => {
    expect(() => projectSwarmLoad({
      clients: 1,
      activeFraction: 1,
      slotsPerClient: 1,
      heartbeatIntervalSeconds: 300,
      taskTransitionsPerSlotHour: 0,
      assignmentQuantumHours: 1,
      formulaCacheHitRate: 1,
      submittedJobsPerDay: 0,
      decisiveResultsPerDay: 0,
    })).toThrow(/shorter than the coordinator lease duration/i);
  });

  it("fails the launch margin when reconnect or participation assumptions are unsafe", () => {
    const projection = projectSwarmLoad({
      clients: 600,
      activeFraction: 0.5,
      slotsPerClient: 2,
      heartbeatIntervalSeconds: 60,
      taskTransitionsPerSlotHour: 2,
      assignmentQuantumHours: 1,
      formulaCacheHitRate: 0,
      submittedJobsPerDay: 100,
      decisiveResultsPerDay: 200,
    });
    expect(projectionWithinMargins(projection, {
      websocketMessagesPerDay: 100_000,
      persistedRowsPerDay: 20_000,
      directoryRequestsPerDay: 10_000,
      kvReadsPerDay: 10_000,
      kvWritesPerDay: 500,
    }, 80)).toBe(false);
  });
});
