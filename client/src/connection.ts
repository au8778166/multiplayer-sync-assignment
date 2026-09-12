export type Participant = {
  clientId: string;
  x: number;
  y: number;
};

export type ServerMessage =
  | {
      type: "welcome";
      clientId: string;
      participants: Participant[];
    }
  | {
      type: "cursor";
      clientId: string;
      seq: number;
      x: number;
      y: number;
      timestamp: number;
    }
  | {
      type: "reaction";
      clientId: string;
      seq: number;
      x: number;
      y: number;
      emoji: string;
      timestamp: number;
    }
  | {
      type: "presence";
      participants: Participant[];
    }
  | {
      type: "leave";
      clientId: string;
    };

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

type MessageHandler = (message: ServerMessage) => void;
type StatusHandler = (status: ConnectionStatus) => void;

// sessionStorage keeps tabs distinct; localStorage would share the same identity across tabs
const CLIENT_ID_KEY = "multiplayer-sync-client-id";

function getClientId(): string {
  const existing = sessionStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;

  const id = crypto.randomUUID();
  sessionStorage.setItem(CLIENT_ID_KEY, id);
  return id;
}

// Inbound payload validators

function isValidParticipant(value: unknown): value is Participant {
  if (!value || typeof value !== "object") return false;

  const participant = value as Record<string, unknown>;
  return (
    typeof participant.clientId === "string" &&
    typeof participant.x === "number" &&
    Number.isFinite(participant.x) &&
    typeof participant.y === "number" &&
    Number.isFinite(participant.y)
  );
}

function isValidServerMessage(value: unknown): value is ServerMessage {
  if (!value || typeof value !== "object") return false;

  const message = value as Record<string, unknown>;

  switch (message.type) {
    case "welcome":
      return (
        typeof message.clientId === "string" &&
        Array.isArray(message.participants) &&
        message.participants.every(isValidParticipant)
      );

    case "presence":
      return (
        Array.isArray(message.participants) &&
        message.participants.every(isValidParticipant)
      );

    case "leave":
      return typeof message.clientId === "string";

    case "cursor":
      return (
        typeof message.clientId === "string" &&
        typeof message.seq === "number" &&
        Number.isFinite(message.seq) &&
        typeof message.x === "number" &&
        Number.isFinite(message.x) &&
        typeof message.y === "number" &&
        Number.isFinite(message.y) &&
        typeof message.timestamp === "number" &&
        Number.isFinite(message.timestamp)
      );

    case "reaction":
      return (
        typeof message.clientId === "string" &&
        typeof message.seq === "number" &&
        Number.isFinite(message.seq) &&
        typeof message.x === "number" &&
        Number.isFinite(message.x) &&
        typeof message.y === "number" &&
        Number.isFinite(message.y) &&
        typeof message.emoji === "string" &&
        typeof message.timestamp === "number" &&
        Number.isFinite(message.timestamp)
      );

    default:
      return false;
  }
}

// Client-side WebSocket wrapper with auto-reconnect and backoff

export class SyncConnection {
  private socket: WebSocket | null = null;
  private readonly clientId: string;
  private readonly roomId: string;
  private seq = 0;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private connecting = false;
  private messageHandler: MessageHandler | null = null;
  private statusHandler: StatusHandler | null = null;

  constructor(roomId: string) {
    this.roomId = roomId;
    this.clientId = getClientId();
  }

  connect(): void {
    const isSocketBusy =
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING);

    if (isSocketBusy || this.connecting) return;

    this.manuallyClosed = false;
    this.createConnection();
  }

  close(): void {
    this.manuallyClosed = true;
    this.connecting = false;

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const socket = this.socket;
    this.socket = null;

    if (socket) {
      socket.close(1000, "Client closed");
    }

    this.statusHandler?.("disconnected");
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onStatusChange(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  sendCursor(x: number, y: number): void {
    this.send({
      type: "cursor",
      clientId: this.clientId,
      seq: this.seq++,
      x,
      y,
      timestamp: Date.now(),
    });
  }

  sendReaction(emoji: string, x: number, y: number): void {
    this.send({
      type: "reaction",
      clientId: this.clientId,
      seq: this.seq++,
      x,
      y,
      emoji,
      timestamp: Date.now(),
    });
  }

  getClientId(): string {
    return this.clientId;
  }

  private createConnection(): void {
    if (this.manuallyClosed || this.connecting) return;

    const isSocketBusy =
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING);

    if (isSocketBusy) return;

    this.connecting = true;
    this.statusHandler?.("connecting");

    const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:8080";
    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.connecting = false;

      // Handle edge case where socket opens right after client called close()
      if (this.manuallyClosed) {
        socket.close(1000, "Client closed");
        return;
      }

      this.reconnectAttempt = 0;
      this.statusHandler?.("connected");

      this.send({
        type: "join",
        roomId: this.roomId,
        clientId: this.clientId,
      });
    });

    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = null;
      }

      this.connecting = false;
      this.statusHandler?.("disconnected");

      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      }
    });

    // Let the close event drive reconnection rather than duplicating in error
    socket.addEventListener("error", () => {});
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;

    try {
      const parsed: unknown = JSON.parse(data);
      if (!isValidServerMessage(parsed)) {
        console.warn("Invalid server message:", parsed);
        return;
      }

      this.messageHandler?.(parsed);
    } catch {
      console.warn("Received invalid JSON from server.");
    }
  }

  private send(message: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  // Exponential backoff up to a 10s ceiling
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.manuallyClosed) return;

    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 10000);
    this.reconnectAttempt++;

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manuallyClosed) return;

      const isSocketBusy =
        this.socket &&
        (this.socket.readyState === WebSocket.OPEN ||
          this.socket.readyState === WebSocket.CONNECTING);

      if (isSocketBusy) return;

      this.createConnection();
    }, delay);
  }
}