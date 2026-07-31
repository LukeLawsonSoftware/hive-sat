import { describe, expect, it } from "vitest";
import { PublicSwarmRuntime } from "./publicSwarmRuntime";

class FakeWebSocket extends EventTarget {
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("Invalid browser WebSocket close code", "InvalidAccessError");
    }
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

describe("PublicSwarmRuntime", () => {
  it("reconfigures an active assignment with the same session and reconciles it", () => {
    const sockets: FakeWebSocket[] = [];
    const runtime = new PublicSwarmRuntime({
      sessionId: "stable-session",
      workerPreference: 2,
      hardwareConcurrency: 8,
      mobile: false,
      directoryWebSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      fetcher: () => new Promise<Response>(() => undefined),
    });

    runtime.start();
    sockets[0].open();
    sockets[0].receive({
      type: "SWARM_ASSIGNMENT",
      protocolVersion: 3,
      messageId: "server-one",
      requestMessageId: "request-one",
      serverTime: 1,
      snapshot: { activeJobs: 1, activeWorkers: 2 },
      assignmentId: "assignment-one",
      jobId: "job-one",
      workers: 2,
      quantumMs: 3_600_000,
      reservedWorkerMs: 7_200_000,
      conflictBudget: 100,
      leaseTargetMs: 900_000,
    });
    sockets[0].close();

    runtime.reconfigureWorkers(1);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(JSON.parse(sockets[1].sent[0])).toMatchObject({
      sessionId: "stable-session",
      capabilities: { maxWorkers: 1 },
      previousAssignment: { assignmentId: "assignment-one" },
    });
    runtime.stop();
  });
});
