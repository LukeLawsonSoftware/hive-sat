import { describe, expect, it } from "vitest";
import { projectSwarmLoad, projectionWithinMargins } from "./cost-model";

describe("launch load and quota projection", () => {
  it("models several hundred intermittent clients without heartbeat row writes", () => {
    const projection = projectSwarmLoad({
      clients: 600,
      activeFraction: 0.04,
      heartbeatIntervalSeconds: 60,
      leaseMinutes: 15,
      assignmentQuantumHours: 1,
      formulaCacheHitRate: 0.8,
      decisiveResultsPerDay: 20,
    });
    expect(projection.activeClients).toBe(24);
    expect(projection.websocketMessagesPerDay).toBe(39_168);
    expect(projection.persistedRowsPerDay).toBe(4_648);
    expect(projection.directoryRequestsPerDay).toBe(576);
    expect(projection.r2ReadsPerDay).toBe(116);
    expect(projectionWithinMargins(projection, {
      websocketMessagesPerDay: 60_000,
      persistedRowsPerDay: 10_000,
      directoryRequestsPerDay: 1_000,
      r2ReadsPerDay: 1_000,
      r2WritesPerDay: 100,
    }, 80)).toBe(true);
  });

  it("fails the launch margin when reconnect or participation assumptions are unsafe", () => {
    const projection = projectSwarmLoad({
      clients: 600,
      activeFraction: 0.5,
      heartbeatIntervalSeconds: 60,
      leaseMinutes: 10,
      assignmentQuantumHours: 1,
      formulaCacheHitRate: 0,
      decisiveResultsPerDay: 200,
    });
    expect(projectionWithinMargins(projection, {
      websocketMessagesPerDay: 100_000,
      persistedRowsPerDay: 20_000,
      directoryRequestsPerDay: 10_000,
      r2ReadsPerDay: 10_000,
      r2WritesPerDay: 500,
    }, 80)).toBe(false);
  });
});
