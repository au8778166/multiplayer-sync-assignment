import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Socket } from "node:net";

import {
  isClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "./protocol.js";
import { Room, type ClientConnection, type ClientState } from "./room.js";

const PORT = Number(process.env.PORT ?? 8080);
const rooms = new Map<string, Room>();

// --- RAW WEBSOCKET IMPLEMENTATION ---

class RawWebSocket implements ClientConnection {
  public readonly clientId: string;
  private readonly socket: Socket;
  private open = true;
  private buffer = Buffer.alloc(0);
  private messageHandler?: (message: string) => void;
  private closeHandler?: () => void;
  private lastPong = Date.now();

  constructor(socket: Socket, clientId: string) {
    this.socket = socket;
    this.clientId = clientId;

    socket.on("data", (data: Buffer) => this.handleData(data));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.handleClose());
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  // Drain any leftover bytes read by Node during the HTTP upgrade handshake
  receiveData(data: Buffer): void {
    this.handleData(data);
  }

  send(message: ServerMessage): void {
    if (!this.isOpen()) return;

    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const frame = createFrame(payload, 0x1);
    this.socket.write(frame);
  }

  ping(): void {
    if (!this.isOpen()) return;

    // Standard unmasked 0-byte ping frame (0x89 0x00); client browsers will reply with pong
    this.socket.write(Buffer.from([0x89, 0x00]));
  }

  close(code = 1000, reason = ""): void {
    if (!this.open) return;
    this.open = false;

    // RFC 6455 caps control frame payloads at 125 bytes; 2 bytes are reserved for status code
    const reasonBuffer = Buffer.from(reason, "utf8").subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);

    const frame = createFrame(payload, 0x8);
    this.socket.write(frame, () => {
      this.socket.end();
    });

    this.closeHandler?.();
  }

  isOpen(): boolean {
    return this.open && !this.socket.destroyed;
  }

  getLastPong(): number {
    return this.lastPong;
  }

  handleData(data: Buffer): void {
    if (!this.open) return;

    this.buffer = Buffer.concat([this.buffer, data]);

    while (true) {
      let frame: ParsedFrame | null;

      try {
        frame = readFrame(this.buffer);
      } catch {
        this.close(1002, "Invalid WebSocket frame");
        return;
      }

      // Incomplete frame; wait for next TCP chunk
      if (!frame) return;

      this.buffer = this.buffer.subarray(frame.bytesConsumed);

      switch (frame.opcode) {
        case 0x1: // Text frame
          this.messageHandler?.(frame.payload.toString("utf8"));
          break;

        case 0x8: // Close frame
          this.open = false;
          if (!this.socket.destroyed) {
            const closeFrame = createFrame(frame.payload, 0x8);
            this.socket.write(closeFrame, () => {
              this.socket.end();
            });
          }
          this.closeHandler?.();
          return;

        case 0x9: // Ping frame -> mirror back as pong (0xA)
          this.socket.write(createFrame(frame.payload, 0xa));
          break;

        case 0xa: // Pong frame
          this.lastPong = Date.now();
          break;

        default:
          this.close(1003, "Unsupported frame");
          return;
      }
    }
  }

  private handleClose(): void {
    if (!this.open) return;
    this.open = false;
    this.closeHandler?.();
  }
}

// --- FRAME ENCODING & PARSING ---

function createFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode; // FIN bit set
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

interface ParsedFrame {
  opcode: number;
  payload: Buffer;
  bytesConsumed: number;
}

function readFrame(buffer: Buffer): ParsedFrame | null {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const fin = (firstByte & 0x80) !== 0;
  const opcode = firstByte & 0x0f;

  if (!fin) {
    throw new Error("Fragmented frames are not supported");
  }

  const masked = (secondByte & 0x80) !== 0;
  if (!masked) {
    throw new Error("Client frame is not masked");
  }

  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null;
    const length = buffer.readBigUInt64BE(offset);
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Frame too large");
    }
    payloadLength = Number(length);
    offset += 8;
  }

  // Need 4 bytes for the masking key
  if (buffer.length < offset + 4) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;

  // Wait until we have the full payload
  if (buffer.length < offset + payloadLength) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  for (let i = 0; i < payload.length; i++) {
    payload[i] ^= mask[i % 4];
  }

  // Control frames (close/ping/pong) can't have payloads > 125 bytes
  if (opcode >= 0x8 && payloadLength > 125) {
    throw new Error("Control frame too large");
  }

  return {
    opcode,
    payload,
    bytesConsumed: offset + payloadLength,
  };
}

// RFC 6455 opening handshake response
function performHandshake(socket: Socket, websocketKey: string): void {
  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const acceptKey = createHash("sha1")
    .update(websocketKey + GUID)
    .digest("base64");

  const response = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey}`,
    "",
    "",
  ].join("\r\n");

  socket.write(response);
}

// --- ROOM MANAGEMENT ---

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Room(roomId);
    rooms.set(roomId, room);
  }
  return room;
}

function cleanupRoom(room: Room): void {
  if (room.size === 0) {
    rooms.delete(room.roomId);
  }
}

// --- MESSAGE DISPATCH ---

interface ConnectionSessionState {
  room?: Room;
  clientId?: string;
}

function handleMessage(
  connection: RawWebSocket,
  rawMessage: string,
  state: ConnectionSessionState,
): void {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawMessage);
  } catch {
    connection.close(1007, "Invalid JSON");
    return;
  }

  if (!isClientMessage(parsed)) {
    connection.close(1003, "Invalid message");
    return;
  }

  if (parsed.type === "join") {
    handleJoin(connection, parsed, state);
    return;
  }

  const { room, clientId } = state;
  if (!room || !clientId) {
    connection.close(1008, "Join required");
    return;
  }

  // Spoofing check
  if (parsed.clientId !== clientId) {
    connection.close(1008, "Client ID mismatch");
    return;
  }

  if (parsed.type === "cursor") {
    handleCursor(parsed, room, clientId);
  } else if (parsed.type === "reaction") {
    handleReaction(parsed, room, clientId);
  }
}

function handleJoin(
  connection: RawWebSocket,
  message: Extract<ClientMessage, { type: "join" }>,
  state: ConnectionSessionState,
): void {
  // Ignore repeated join packets on an active socket
  if (state.room && state.clientId) return;

  const room = getOrCreateRoom(message.roomId);

  // If this ID is already active, boot the older connection before replacing it
  const previous = room.getClient(message.clientId);
  if (previous) {
    previous.connection.close(1000, "Reconnected");
    room.removeClient(message.clientId);
  }

  const client: ClientState = {
    clientId: message.clientId,
    connection,
    x: 0.5,
    y: 0.5,
    lastSeq: -1,
  };

  room.addClient(client);
  state.room = room;
  state.clientId = message.clientId;

  connection.send({
    type: "welcome",
    clientId: message.clientId,
    participants: room.getParticipants(),
  });

  room.broadcastPresence();
  console.log(
    `[JOIN] ${message.clientId} -> ${message.roomId} | participants=${room.size}`,
  );
}

function handleCursor(
  message: Extract<ClientMessage, { type: "cursor" }>,
  room: Room,
  clientId: string,
): void {
  const client = room.getClient(clientId);
  if (!client || message.seq <= client.lastSeq) return; // Drop out-of-order packets

  client.lastSeq = message.seq;
  client.x = message.x;
  client.y = message.y;

  room.broadcast(
    {
      type: "cursor",
      clientId,
      seq: message.seq,
      x: message.x,
      y: message.y,
      timestamp: message.timestamp,
    },
    clientId,
  );
}

function handleReaction(
  message: Extract<ClientMessage, { type: "reaction" }>,
  room: Room,
  clientId: string,
): void {
  const client = room.getClient(clientId);
  if (!client || message.seq <= client.lastSeq) return;

  client.lastSeq = message.seq;
  client.x = message.x;
  client.y = message.y;

  room.broadcast(
    {
      type: "reaction",
      clientId,
      seq: message.seq,
      x: message.x,
      y: message.y,
      emoji: message.emoji,
      timestamp: message.timestamp,
    },
    clientId,
  );
}

function handleClient(
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
): void {
  const upgrade = request.headers.upgrade;
  if (typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const websocketKey = request.headers["sec-websocket-key"];
  if (typeof websocketKey !== "string") {
    socket.destroy();
    return;
  }

  performHandshake(socket, websocketKey);

  const connection = new RawWebSocket(socket, "pending");
  const state: ConnectionSessionState = {};

  connection.onMessage((rawMessage) => {
    handleMessage(connection, rawMessage, state);
  });

  connection.onClose(() => {
    handleDisconnect(connection, state);
  });

  // If the client pushed data alongside the HTTP upgrade request, parse it immediately
  if (head.length > 0) {
    connection.receiveData(head);
  }
}

function handleDisconnect(
  connection: RawWebSocket,
  state: ConnectionSessionState,
): void {
  const { room, clientId } = state;
  if (!room || !clientId) return;

  // Race check: don't let an old connection cleanup a reconnected instance of the same client
  const registeredClient = room.getClient(clientId);
  if (!registeredClient || registeredClient.connection !== connection) {
    return;
  }

  room.removeClient(clientId);
  room.broadcast({ type: "leave", clientId });
  room.broadcastPresence();

  console.log(
    `[LEAVE] ${clientId} <- ${room.roomId} | participants=${room.size}`,
  );

  cleanupRoom(room);
  state.room = undefined;
  state.clientId = undefined;
}

// --- HEARTBEAT MONITOR ---

const HEARTBEAT_INTERVAL = 10_000;
const HEARTBEAT_TIMEOUT = 30_000;

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    room.forEachClient((client) => {
      if (!client.connection.isOpen()) return;

      if (now - client.connection.getLastPong() > HEARTBEAT_TIMEOUT) {
        console.log(`[TIMEOUT] ${client.clientId}`);
        client.connection.close(1001, "Heartbeat timeout");
        return;
      }

      client.connection.ping();
    });
  }
}, HEARTBEAT_INTERVAL);

// --- SERVER INITIALIZATION ---

const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("WebSocket server");
});

server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
  handleClient(request, socket, head);
});

server.on("error", (error: Error) => {
  console.error("Server error:", error);
});

server.listen(PORT, () => {
  console.log(`Multiplayer sync server running on ws://localhost:${PORT}`);
});