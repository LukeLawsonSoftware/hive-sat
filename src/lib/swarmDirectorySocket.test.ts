import { describe, expect, it } from "vitest";
import { SwarmDirectorySocket } from "./swarmDirectorySocket";

class FakeWebSocket extends EventTarget {
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING;
  readonly sent: string[] = [];

  send(data: Parameters<WebSocket["send"]>[0]): void {
    this.sent.push(String(data));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

function serverBase(type: string) {
  return {
    type,
    protocolVersion: 1,
    messageId: "server-one",
    requestMessageId: "request-one",
    serverTime: 1,
    snapshot: { activeJobs: 2, activeWorkers: 3 },
  };
}

describe("SwarmDirectorySocket", () => {
  it("reports prior actual time and waits for directory close before handoff", () => {
    const socket = new FakeWebSocket();
    const events: string[] = [];
    const client = new SwarmDirectorySocket({
      sessionId: "session-one",
      capabilities: {
        hardwareConcurrency: 8,
        maxWorkers: 2,
        mobile: false,
        solverVersion: "cadical-3.0.1",
      },
      previousAssignment: { assignmentId: "assignment-old", activeWorkerMs: 123_000 },
      webSocketFactory: () => socket,
      onAssignment: (message) => events.push(`assignment:${message.jobId}`),
      onNoWork: () => events.push("no-work"),
    });
    client.start();
    socket.open();
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: "SWARM_HELLO",
      sessionId: "session-one",
      previousAssignment: { assignmentId: "assignment-old", activeWorkerMs: 123_000 },
    });
    socket.receive({
      ...serverBase("SWARM_ASSIGNMENT"),
      assignmentId: "assignment-new",
      jobId: "job-one",
      workers: 2,
      quantumMs: 3_600_000,
      reservedWorkerMs: 7_200_000,
      conflictBudget: 100,
      leaseTargetMs: 900_000,
    });
    expect(events).toEqual([]);
    socket.close();
    expect(events).toEqual(["assignment:job-one"]);
  });

  it("fails closed on a malformed response", () => {
    const socket = new FakeWebSocket();
    const errors: string[] = [];
    const client = new SwarmDirectorySocket({
      sessionId: "session-one",
      capabilities: {
        hardwareConcurrency: 4,
        maxWorkers: 1,
        mobile: false,
        solverVersion: "cadical-3.0.1",
      },
      webSocketFactory: () => socket,
      onAssignment: () => undefined,
      onNoWork: () => undefined,
      onProtocolError: (code) => errors.push(code),
    });
    client.start();
    socket.open();
    socket.receive({ type: "SWARM_ASSIGNMENT" });
    expect(errors).toEqual(["UPGRADE_REQUIRED"]);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});
