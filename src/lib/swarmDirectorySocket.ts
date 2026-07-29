import { PUBLIC_JOB_PROTOCOL_VERSION } from "../../shared/public-jobs";
import {
  parseSwarmServerMessage,
  type PreviousSwarmAssignment,
  type SwarmAssignmentMessage,
  type SwarmNoWorkMessage,
} from "../../shared/swarm-protocol";
import type { WorkerCapabilities } from "../../shared/coordinator-protocol";
import type { CoordinatorWebSocket } from "./jobCoordinatorSocket";

export type SwarmDirectorySocketState = "idle" | "connecting" | "waiting" | "handoff" | "stopped";

export interface SwarmDirectorySocketOptions {
  sessionId: string;
  capabilities: WorkerCapabilities;
  previousAssignment?: PreviousSwarmAssignment;
  url?: string;
  webSocketFactory?: (url: string) => CoordinatorWebSocket;
  onAssignment: (message: SwarmAssignmentMessage) => void;
  onNoWork: (message: SwarmNoWorkMessage) => void;
  onStateChange?: (state: SwarmDirectorySocketState) => void;
  onProtocolError?: (code: "INVALID_MESSAGE" | "UPGRADE_REQUIRED" | "INVALID_ASSIGNMENT") => void;
}

function defaultSocketUrl(): string {
  const url = new URL("/api/v1/swarm/socket", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export class SwarmDirectorySocket {
  private socket: CoordinatorWebSocket | null = null;
  private stopped = true;
  private pending: SwarmAssignmentMessage | SwarmNoWorkMessage | null = null;
  private state: SwarmDirectorySocketState = "idle";

  constructor(private readonly options: SwarmDirectorySocketOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.pending = null;
    this.setState("connecting");
    const factory = this.options.webSocketFactory ?? ((url: string) => new WebSocket(url));
    const socket = factory(this.options.url ?? defaultSocketUrl());
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.stopped || this.socket !== socket) return;
      this.setState("waiting");
      socket.send(JSON.stringify({
        type: "SWARM_HELLO",
        protocolVersion: PUBLIC_JOB_PROTOCOL_VERSION,
        messageId: crypto.randomUUID(),
        sessionId: this.options.sessionId,
        capabilities: this.options.capabilities,
        ...(this.options.previousAssignment
          ? { previousAssignment: this.options.previousAssignment }
          : {}),
      }));
    });
    socket.addEventListener("message", (event) => {
      if (this.stopped || this.socket !== socket || typeof event.data !== "string") {
        if (!this.stopped) this.fail(socket, "INVALID_MESSAGE");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(event.data) as unknown;
      } catch {
        this.fail(socket, "INVALID_MESSAGE");
        return;
      }
      const parsed = parseSwarmServerMessage(value);
      if (!parsed.ok) {
        this.fail(socket, parsed.code);
        return;
      }
      if (parsed.message.type === "SWARM_ERROR") {
        this.fail(socket, parsed.message.code);
        return;
      }
      this.pending = parsed.message;
      this.setState("handoff");
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      const pending = this.pending;
      this.pending = null;
      if (this.stopped) return;
      this.stopped = true;
      this.setState("stopped");
      if (pending?.type === "SWARM_ASSIGNMENT") this.options.onAssignment(pending);
      else if (pending?.type === "SWARM_NO_WORK") this.options.onNoWork(pending);
      else this.options.onProtocolError?.("INVALID_MESSAGE");
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket && socket.readyState < WebSocket.CLOSING) {
        socket.close(1011, "Directory connection failed");
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.pending = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "Client stopped");
    this.setState("stopped");
  }

  private fail(
    socket: CoordinatorWebSocket,
    code: "INVALID_MESSAGE" | "UPGRADE_REQUIRED" | "INVALID_ASSIGNMENT",
  ): void {
    this.options.onProtocolError?.(code);
    this.pending = null;
    this.stopped = true;
    if (socket.readyState < WebSocket.CLOSING) socket.close(1008, code);
    this.setState("stopped");
  }

  private setState(state: SwarmDirectorySocketState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
