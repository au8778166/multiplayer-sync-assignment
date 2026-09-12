import { useCallback, useEffect, useRef, useState } from "react";
import {
  SyncConnection,
  type Participant,
  type ServerMessage,
} from "./connection";
import { CursorInterpolator } from "./interpolation";
import {
  renderCursors,
  renderReactions,
  removeExpiredReactions,
  type Reaction,
  type RenderCursor,
} from "./render";
import "./index.css";

const ROOM_ID = "demo-room";
// Cap cursor broadcasts to ~25 updates/sec to prevent saturating the socket
const CURSOR_SEND_INTERVAL = 40;
const REACTIONS = ["👍", "❤️", "😂", "🔥", "🎉"];

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const connectionRef = useRef<SyncConnection | null>(null);
  const cursorsRef = useRef<Map<string, RenderCursor>>(new Map());
  const reactionsRef = useRef<Reaction[]>([]);
  const currentClientIdRef = useRef("");
  const lastCursorSentRef = useRef(0);

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  const [reactionCount, setReactionCount] = useState(0);

  // Lazily instantiate an interpolator per remote peer to smooth out network jitter
  const updateRemoteCursor = useCallback(
    (clientId: string, x: number, y: number) => {
      if (clientId === currentClientIdRef.current) return;

      let cursor = cursorsRef.current.get(clientId);
      if (!cursor) {
        cursor = {
          clientId,
          interpolator: new CursorInterpolator(100),
        };
        cursorsRef.current.set(clientId, cursor);
      }

      cursor.interpolator.addSample(x, y, performance.now());
    },
    []
  );

  const handleServerMessage = useCallback(
    (message: ServerMessage) => {
      switch (message.type) {
        case "welcome": {
          currentClientIdRef.current = message.clientId;
          setParticipants(message.participants);

          for (const p of message.participants) {
            if (p.clientId !== message.clientId) {
              updateRemoteCursor(p.clientId, p.x, p.y);
            }
          }
          break;
        }

        case "presence": {
          setParticipants(message.participants);

          // Purge stale cursor entries for peers no longer reported in the room roster
          const activeIds = new Set(message.participants.map((p) => p.clientId));
          for (const clientId of cursorsRef.current.keys()) {
            if (!activeIds.has(clientId)) {
              cursorsRef.current.delete(clientId);
            }
          }

          for (const p of message.participants) {
            if (p.clientId !== currentClientIdRef.current) {
              updateRemoteCursor(p.clientId, p.x, p.y);
            }
          }
          break;
        }

        case "cursor": {
          updateRemoteCursor(message.clientId, message.x, message.y);
          break;
        }

        case "reaction": {
          reactionsRef.current.push({
            id: `${message.clientId}-${message.seq}-${message.timestamp}`,
            x: message.x,
            y: message.y,
            emoji: message.emoji,
            createdAt: performance.now(),
          });
          setReactionCount((count) => count + 1);
          break;
        }

        case "leave": {
          cursorsRef.current.delete(message.clientId);
          setParticipants((current) =>
            current.filter((p) => p.clientId !== message.clientId)
          );
          break;
        }
      }
    },
    [updateRemoteCursor]
  );

  // Set up the persistent connection on mount and tear it down on unmount
  useEffect(() => {
    if (connectionRef.current) return;

    const connection = new SyncConnection(ROOM_ID);
    connectionRef.current = connection;

    connection.onMessage(handleServerMessage);
    connection.onStatusChange(setConnectionStatus);
    connection.connect();

    return () => {
      connection.close();
      if (connectionRef.current === connection) {
        connectionRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const now = performance.now();
    if (now - lastCursorSentRef.current < CURSOR_SEND_INTERVAL) return;

    lastCursorSentRef.current = now;

    const canvas = canvasRef.current;
    const connection = connectionRef.current;
    if (!canvas || !connection) return;

    // Normalize coordinates to [0, 1] so clients can render across arbitrary aspect ratios
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    const normalizedX = Math.max(0, Math.min(1, x));
    const normalizedY = Math.max(0, Math.min(1, y));

    connection.sendCursor(normalizedX, normalizedY);
  };

  const handleReaction = (emoji: string) => {
    const connection = connectionRef.current;
    const canvas = canvasRef.current;
    if (!connection || !canvas) return;

    // Jitter coordinates near the center to avoid overlapping identical reactions
    const x = 0.5 + (Math.random() - 0.5) * 0.2;
    const y = 0.5 + (Math.random() - 0.5) * 0.2;

    connection.sendReaction(emoji, x, y);
  };

  // Keep internal canvas dimensions synced with DPI scaling
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    };

    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Decoupled 60fps render loop; consumed state updates via refs without re-triggering React renders
  useEffect(() => {
    let animationFrame = 0;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        animationFrame = requestAnimationFrame(render);
        return;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      if (width === 0 || height === 0) {
        animationFrame = requestAnimationFrame(render);
        return;
      }

      // Re-scale context matrix to match high-DPI backbuffer
      const scaleX = canvas.width / width;
      const scaleY = canvas.height / height;
      ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);

      ctx.clearRect(0, 0, width, height);

      const now = performance.now();
      reactionsRef.current = removeExpiredReactions(reactionsRef.current, now);

      renderReactions(ctx, canvas, reactionsRef.current, now);
      renderCursors(ctx, canvas, cursorsRef.current, currentClientIdRef.current);

      animationFrame = requestAnimationFrame(render);
    };

    animationFrame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrame);
  }, []);

  return (
    <main className="app">
      <header className="header">
        <div>
          <h1>Real-Time Multiplayer Board</h1>
          <p className="subtitle">
            Move your cursor and react. Everyone connected to the room sees the
            changes in real time.
          </p>
        </div>

        <div className="status">
          <span className={`status-dot ${connectionStatus}`} />
          <span>
            {connectionStatus === "connected"
              ? "Connected"
              : connectionStatus === "connecting"
              ? "Connecting..."
              : "Disconnected"}
          </span>
        </div>
      </header>

      <section className="info-bar">
        <div>
          <strong>Room:</strong> {ROOM_ID}
        </div>
        <div>
          <strong>Participants:</strong> {participants.length}
        </div>
        <div>
          <strong>Reactions:</strong> {reactionCount}
        </div>
      </section>

      <section className="board-wrapper">
        <canvas
          ref={canvasRef}
          className="board"
          onMouseMove={handleMouseMove}
        />
        <div className="board-hint">Move your cursor around the board</div>
      </section>

      <section className="reactions">
        <span className="reaction-label">React:</span>
        {REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="reaction-button"
            onClick={() => handleReaction(emoji)}
            disabled={connectionStatus !== "connected"}
          >
            {emoji}
          </button>
        ))}
      </section>

      <section className="participants">
        <h2>Connected users</h2>
        {participants.length === 0 ? (
          <p>Waiting for participants...</p>
        ) : (
          <ul>
            {participants.map((participant) => (
              <li key={participant.clientId}>
                <span className="user-dot" />
                {participant.clientId === currentClientIdRef.current
                  ? "You"
                  : participant.clientId.slice(0, 8)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

export default App;