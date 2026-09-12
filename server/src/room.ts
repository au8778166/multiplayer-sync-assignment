import type { Participant, ServerMessage } from "./protocol.js";

export interface ClientConnection {
  readonly clientId: string;
  send(message: ServerMessage): void;
  close(code?: number, reason?: string): void;
  isOpen(): boolean;
  ping(): void;
  getLastPong(): number;
}

export interface ClientState {
  clientId: string;
  connection: ClientConnection;
  x: number;
  y: number;
  // Monotonic sequence counter to discard stale or out-of-order UDP-like frames
  lastSeq: number;
}

export class Room {
  public readonly roomId: string;
  private clients = new Map<string, ClientState>();

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  addClient(client: ClientState): void {
    this.clients.set(client.clientId, client);
  }

  removeClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  getClient(clientId: string): ClientState | undefined {
    return this.clients.get(clientId);
  }

  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  get size(): number {
    return this.clients.size;
  }

  // Snapshot of active cursor positions sent to newly connected peers on join
  getParticipants(): Participant[] {
    return Array.from(this.clients.values()).map((client) => ({
      clientId: client.clientId,
      x: client.x,
      y: client.y,
    }));
  }

  // Used by the heartbeat interval to sweep dead sockets
  forEachClient(callback: (client: ClientState) => void): void {
    for (const client of this.clients.values()) {
      callback(client);
    }
  }

  // Fan out a payload to everyone in the room, skipping the sender if specified
  broadcast(message: ServerMessage, excludeClientId?: string): void {
    for (const client of this.clients.values()) {
      if (client.clientId === excludeClientId) continue;
      if (client.connection.isOpen()) {
        client.connection.send(message);
      }
    }
  }

  // Sync the latest participant list across all connected peers
  broadcastPresence(): void {
    this.broadcast({
      type: "presence",
      participants: this.getParticipants(),
    });
  }
}