import type { Participant } from "./connection.js";
import type { CursorInterpolator } from "./interpolation.js";

export interface Reaction {
  id: string;
  x: number;
  y: number;
  emoji: string;
  createdAt: number;
}

export interface RenderCursor {
  clientId: string;
  interpolator: CursorInterpolator;
}

const CURSOR_SIZE = 12;
const REACTION_DURATION = 1200;

export function renderCursors(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cursors: Map<string, RenderCursor>,
  currentClientId: string
): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  ctx.save();

  for (const [clientId, cursor] of cursors) {
    if (clientId === currentClientId) continue; // Skip local cursor

    const position = cursor.interpolator.getPosition();
    if (!position) continue;

    const x = position.x * width;
    const y = position.y * height;

    drawCursor(ctx, x, y, clientId);
  }

  ctx.restore();
}

function drawCursor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  clientId: string
): void {
  ctx.save();

  // Pointer silhouette
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + CURSOR_SIZE * 2);
  ctx.lineTo(x + CURSOR_SIZE * 0.75, y + CURSOR_SIZE * 1.45);
  ctx.lineTo(x + CURSOR_SIZE * 1.5, y + CURSOR_SIZE * 2.4);
  ctx.lineTo(x + CURSOR_SIZE * 1.9, y + CURSOR_SIZE * 1.95);
  ctx.lineTo(x + CURSOR_SIZE * 1.15, y + CURSOR_SIZE * 1.1);
  ctx.closePath();

  ctx.fillStyle = "#111827";
  ctx.fill();

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Floating user badge
  const shortId = clientId.slice(0, 6);
  ctx.font = "12px sans-serif";

  const textWidth = ctx.measureText(shortId).width;
  const labelX = x + 18;
  const labelY = y + 24;

  ctx.fillStyle = "#111827";
  roundRect(ctx, labelX - 5, labelY - 14, textWidth + 10, 20, 5);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.fillText(shortId, labelX, labelY);

  ctx.restore();
}

export function renderReactions(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  reactions: Reaction[],
  currentTime = performance.now()
): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  ctx.save();

  for (const reaction of reactions) {
    const age = currentTime - reaction.createdAt;
    if (age < 0 || age > REACTION_DURATION) continue;

    const progress = age / REACTION_DURATION;
    const x = reaction.x * width;
    const y = reaction.y * height;

    // Float up, expand slightly, and fade out
    const offsetY = progress * 60;
    const opacity = 1 - progress;
    const scale = 1 + progress * 0.25;

    ctx.globalAlpha = opacity;
    ctx.font = `${32 * scale}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.fillText(reaction.emoji, x, y - offsetY);
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

export function removeExpiredReactions(
  reactions: Reaction[],
  currentTime = performance.now()
): Reaction[] {
  return reactions.filter(
    (reaction) => currentTime - reaction.createdAt <= REACTION_DURATION
  );
}

// Prune inactive cursor tracking instances when membership drops
export function syncParticipants(
  participants: Participant[],
  cursors: Map<string, RenderCursor>,
  currentClientId: string
): void {
  const activeIds = new Set(
    participants.map((participant) => participant.clientId)
  );

  for (const clientId of cursors.keys()) {
    if (!activeIds.has(clientId)) {
      cursors.delete(clientId);
    }
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}