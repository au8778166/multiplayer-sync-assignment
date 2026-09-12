export interface Participant {
  clientId: string;
  x: number;
  y: number;
}

// Inbound client events
export type ClientMessage =
  | {
      type: "join";
      roomId: string;
      clientId: string;
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
    };

// Outbound server events
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

// Type guard helpers to enforce sanitized inbound payloads

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Normalized coordinates are clamped between 0 and 1
function isValidCoordinate(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function isValidSequence(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Record<string, unknown>;
  if (typeof message.type !== "string") {
    return false;
  }

  switch (message.type) {
    case "join":
      return (
        typeof message.roomId === "string" &&
        message.roomId.length > 0 &&
        message.roomId.length <= 100 &&
        typeof message.clientId === "string" &&
        message.clientId.length > 0 &&
        message.clientId.length <= 100
      );

    case "cursor":
      return (
        typeof message.clientId === "string" &&
        message.clientId.length > 0 &&
        isValidSequence(message.seq) &&
        isValidCoordinate(message.x) &&
        isValidCoordinate(message.y) &&
        isFiniteNumber(message.timestamp)
      );

    case "reaction":
      return (
        typeof message.clientId === "string" &&
        message.clientId.length > 0 &&
        isValidSequence(message.seq) &&
        isValidCoordinate(message.x) &&
        isValidCoordinate(message.y) &&
        typeof message.emoji === "string" &&
        message.emoji.length > 0 &&
        message.emoji.length <= 10 && // Guard against bloated unicode or string injection
        isFiniteNumber(message.timestamp)
      );

    default:
      return false;
  }
}