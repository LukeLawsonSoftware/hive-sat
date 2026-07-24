import {
  type CoordinatorClientMessage,
  type CoordinatorServerMessage,
  type HelloMessage,
  type WorkerCapabilities,
  parseCoordinatorServerMessage,
} from "../../shared/coordinator-protocol";
import { PUBLIC_JOB_PROTOCOL_VERSION } from "../../shared/public-jobs";

export type CoordinatorSocketState = "idle" | "connecting" | "connected" | "reconnecting" | "stopped";
export type CoordinatorWebSocket = Pick<WebSocket, "readyState" | "send" | "close" | "addEventListener">;

export interface CoordinatorSocketOptions {
  jobId: string;
  sessionId: string;
  capabilities: WorkerCapabilities;
  url?: string;
  webSocketFactory?: (url: string) => CoordinatorWebSocket;
  random?: () => number;
  onMessage: (message: CoordinatorServerMessage) => void;
  onStateChange?: (state: CoordinatorSocketState) => void;
  onProtocolError?: (code: "INVALID_MESSAGE" | "UPGRADE_REQUIRED" | "JOB_MISMATCH") => void;
}

const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export function coordinatorReconnectDelayMs(attempt: number, random = Math.random): number {
  const exponent = Math.min(Math.max(0, attempt), 10);
  const base = Math.min(MAX_RECONNECT_DELAY_MS, MIN_RECONNECT_DELAY_MS * 2 ** exponent);
  const jitter = 0.75 + Math.min(1, Math.max(0, random())) * 0.5;
  return Math.min(MAX_RECONNECT_DELAY_MS, Math.round(base * jitter));
}

function defaultSocketUrl(jobId: string): string {
  const url = new URL(`/api/v1/jobs/${encodeURIComponent(jobId)}/socket`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class JobCoordinatorSocket {
  private socket: CoordinatorWebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = true;
  private state: CoordinatorSocketState = "idle";

  constructor(private readonly options: CoordinatorSocketOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.open(false);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Client stopped");
    this.setState("stopped");
  }

  send(message: Exclude<CoordinatorClientMessage, HelloMessage>): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  getState(): CoordinatorSocketState {
    return this.state;
  }

  private open(reconnecting: boolean): void {
    if (this.stopped) return;
    this.setState(reconnecting ? "reconnecting" : "connecting");
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    const socket = factory(this.options.url ?? defaultSocketUrl(this.options.jobId));
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket || this.stopped) return;
      const hello: HelloMessage = {
        type: "HELLO",
        protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
        messageId: crypto.randomUUID(),
        jobId: this.options.jobId,
        sessionId: this.options.sessionId,
        capabilities: this.options.capabilities,
      };
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || this.stopped) return;
      if (typeof event.data !== "string") {
        this.protocolError(socket, "INVALID_MESSAGE");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(event.data) as unknown;
      } catch {
        this.protocolError(socket, "INVALID_MESSAGE");
        return;
      }
      const parsed = parseCoordinatorServerMessage(value);
      if (!parsed.ok) {
        this.protocolError(socket, parsed.code);
        return;
      }
      if (parsed.message.jobId !== this.options.jobId) {
        this.protocolError(socket, "JOB_MISMATCH");
        return;
      }
      if (parsed.message.type === "WELCOME") {
        this.reconnectAttempt = 0;
        this.setState("connected");
      }
      this.options.onMessage(parsed.message);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1011, "Connection error");
      }
    });
  }

  private protocolError(socket: CoordinatorWebSocket, code: "INVALID_MESSAGE" | "UPGRADE_REQUIRED" | "JOB_MISMATCH"): void {
    this.options.onProtocolError?.(code);
    if (code === "UPGRADE_REQUIRED") this.stopped = true;
    if (socket.readyState < WebSocket.CLOSING) socket.close(1008, code);
  }

  private scheduleReconnect(): void {
    const delay = coordinatorReconnectDelayMs(this.reconnectAttempt, this.options.random);
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open(true);
    }, delay);
  }

  private setState(state: CoordinatorSocketState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
