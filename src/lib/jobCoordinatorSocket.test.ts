import { afterEach, describe, expect, it, vi } from "vitest";
import { JobCoordinatorSocket, coordinatorReconnectDelayMs } from "./jobCoordinatorSocket";

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

function welcome(jobId: string) {
  return {
    type: "WELCOME",
    protocolVersion: 2,
    messageId: "welcome-one",
    jobId,
    serverTime: 1,
    heartbeatIntervalMs: 60_000,
    leaseDurationMs: 900_000,
    activeLeases: [],
  };
}

describe("JobCoordinatorSocket", () => {
  afterEach(() => vi.useRealTimers());

  it("uses capped exponential backoff with bounded jitter", () => {
    expect(coordinatorReconnectDelayMs(0, () => 0.5)).toBe(1_000);
    expect(coordinatorReconnectDelayMs(3, () => 0.5)).toBe(8_000);
    expect(coordinatorReconnectDelayMs(20, () => 0)).toBe(22_500);
    expect(coordinatorReconnectDelayMs(20, () => 1)).toBe(30_000);
  });

  it("sends HELLO, validates WELCOME, and reconnects with the same session", async () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const states: string[] = [];
    const messages: string[] = [];
    const client = new JobCoordinatorSocket({
      jobId: "job-one",
      sessionId: "session-one",
      capabilities: { hardwareConcurrency: 8, maxWorkers: 2, mobile: false, solverVersion: "cadical-3.0.1" },
      url: "wss://hive.test/socket",
      random: () => 0.5,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      onMessage: (message) => messages.push(message.type),
      onStateChange: (state) => states.push(state),
    });

    client.start();
    sockets[0].open();
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({
      type: "HELLO",
      jobId: "job-one",
      sessionId: "session-one",
    });
    sockets[0].receive(welcome("job-one"));
    expect(client.getState()).toBe("connected");
    expect(messages).toEqual(["WELCOME"]);

    sockets[0].close();
    expect(client.getState()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(JSON.parse(sockets[1].sent[0])).toMatchObject({ sessionId: "session-one" });
    client.stop();
    expect(states).toContain("stopped");
  });

  it("fails closed on malformed or cross-job server messages", () => {
    const sockets: FakeWebSocket[] = [];
    const errors: string[] = [];
    const client = new JobCoordinatorSocket({
      jobId: "job-one",
      sessionId: "session-one",
      capabilities: { hardwareConcurrency: 4, maxWorkers: 1, mobile: false, solverVersion: "cadical-3.0.1" },
      url: "wss://hive.test/socket",
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      onMessage: () => undefined,
      onProtocolError: (code) => errors.push(code),
    });
    client.start();
    sockets[0].open();
    sockets[0].receive(welcome("another-job"));
    expect(errors).toEqual(["JOB_MISMATCH"]);
    expect(sockets[0].readyState).toBe(WebSocket.CLOSED);
    client.stop();
  });
});
