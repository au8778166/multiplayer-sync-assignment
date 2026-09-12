# Real-Time Multiplayer Cursor/State Sync

A raw-WebSocket, framework-free real-time sync engine: multiple browser tabs join a shared room and see each other's cursors and emoji reactions live, with client-side interpolation for smooth motion and honest handling of disconnects, reconnects, and out-of-order delivery.

No Socket.IO, Yjs, PartyKit, Liveblocks, or any sync/transport library. The server implements the WebSocket protocol (RFC 6455 handshake + frame parsing) directly on top of Node's `http`/`net` modules.

---

## Setup

**Requirements:** Node 18+.

### 1. Start the server

```bash
cd server
npm install
npm run dev
```

Runs on `ws://localhost:8080` (override with `PORT=xxxx npm run dev`).

### 2. Start the client

```bash
cd client
npm install
npm run dev
```

Vite will print a local URL (default `http://localhost:5173`). By default the client connects to `ws://localhost:8080`; override with a `.env` file in `client/` setting `VITE_WS_URL=ws://your-host:port`.

### 3. Try it with multiple clients

Open the client URL in 3–5 browser tabs (or devices on the same network, pointing `VITE_WS_URL` at your machine's LAN IP). Every tab auto-joins the same room (`demo-room`). Move your mouse over the board in one tab and it appears in the others; click a reaction emoji to burst it at a random point near the center.

To simulate a bad network: open Chrome DevTools → Network tab → set throttling (e.g. "Slow 3G") on one tab, and watch that its remote cursors elsewhere still move smoothly rather than snapping — see [Interpolation strategy](#interpolation-strategy).

---

## Protocol design

Every message is a single JSON object over one WebSocket text frame. The server (`server/src/protocol.ts`) and client (`client/src/connection.ts`) each define and structurally validate the same shapes independently — any message that doesn't match one of these shapes exactly is rejected (server closes the socket with code `1003`; client logs a warning and drops it) rather than being passed through.

### Client → Server

| Type | Shape | Notes |
|---|---|---|
| `join` | `{ type: "join", roomId: string, clientId: string }` | First message on every new connection. Server ignores repeat joins on an already-joined socket. |
| `cursor` | `{ type: "cursor", clientId, seq: number, x: number, y: number, timestamp: number }` | `x`/`y` are normalized `0–1` (fraction of board width/height), so any client's aspect ratio can render them. |
| `reaction` | `{ type: "reaction", clientId, seq, x, y, emoji: string (≤10 chars), timestamp }` | Discrete, one-shot event. |

`clientId` is re-sent on every message and cross-checked server-side against the ID the socket joined with (`server.ts: handleMessage`) — a client can't spoof another client's `clientId` mid-session.

### Server → Client

| Type | Shape | Notes |
|---|---|---|
| `welcome` | `{ type: "welcome", clientId, participants: Participant[] }` | Sent once, only to the joining client, right after `join`. Full-snapshot approach to late-join state (see below). |
| `presence` | `{ type: "presence", participants: Participant[] }` | Broadcast to the whole room whenever membership changes (join/leave). |
| `cursor` / `reaction` | Same shape as inbound, relayed with the server-observed `seq`/`timestamp`. | Sender is excluded from the fan-out (no self-echo). |
| `leave` | `{ type: "leave", clientId }` | Broadcast when a client disconnects, so peers can drop that cursor immediately instead of waiting for a stale timeout. |

**Late-join strategy:** full-state snapshot. On `join`, the server replies with a `welcome` containing every current participant's last-known `{clientId, x, y}`. This is simplest to reason about and correct at room sizes of 3–10 (the assignment's stated bar); it does not scale to very large rooms, since the snapshot payload grows linearly with participants. A `presence` broadcast follows on every membership change so everyone converges to the same roster without needing a replay log.

### Throttling / bandwidth

Raw `mousemove` fires at 60–120Hz; sending every event would flood the socket and mostly transmit redundant intent. The client throttles outbound cursor sends to one every **40ms (~25 updates/sec)** — `client/src/App.tsx: CURSOR_SEND_INTERVAL` — using a simple "drop if too soon since last send" gate rather than a timer/debounce, so the *first* movement in a gesture is never delayed. 25Hz was chosen as a middle ground: fast enough that interpolation between samples looks continuous, slow enough to keep per-client bandwidth trivial (a `cursor` message is well under 150 bytes, so ~25 msgs/sec is ~3–4 KB/s per client). Reactions are not throttled — they're discrete, user-initiated, and already rate-limited by human click speed.

---

## Interpolation strategy

Implemented in `client/src/interpolation.ts` (`CursorInterpolator`), one instance per remote peer.

**Approach: buffered linear interpolation (render-delay lerp).** Each incoming `cursor` sample is timestamped with `performance.now()` on arrival and pushed into a small ring buffer (capped at 10 samples — old ones are shifted out, so memory is bounded regardless of session length). Instead of drawing the *latest* sample immediately, the renderer asks for the position at `now - 100ms` and linearly interpolates between the two buffered samples that straddle that render time. If the render time has caught up past the newest sample (e.g. a burst of loss), it holds at the last known point rather than freezing mid-lerp or extrapolating past unknown data.

**Why:** at a 40ms send interval, network jitter means samples don't arrive every 40ms on the wire — some gaps are 20ms, some are 150ms. Interpolating between the two most recent *received* samples using their actual receipt-time gap (not an assumed fixed interval) means motion stays smooth even when the send cadence is irregular, without needing to trust each sample's own client-supplied `timestamp` for playback timing.

**Tradeoff:** this deliberately adds a fixed ~100ms of visual lag to remote cursors in exchange for eliminating teleport/snap artifacts. 100ms is small enough to still feel "live" for a cursor/reaction use case (not a competitive game) while comfortably covering typical jitter between 25Hz updates. Under DevTools throttling (added latency, not jitter) the whole buffer simply shifts later in wall-clock time — motion stays smooth, it just lags proportionally more; under packet loss, the "hold at latest" fallback prevents both under- and over-shooting.

---

## Failure handling

**Disconnect (server-detected):** the server pings every connected socket every 10s and tracks the last pong per client (`server.ts`: `HEARTBEAT_INTERVAL` / `HEARTBEAT_TIMEOUT`). A client that hasn't ponged in 30s is force-closed. On any socket close (deliberate, timeout, or TCP-level error), the server removes the client from its room, broadcasts `leave` (so peers drop the cursor immediately rather than waiting for the next stale `presence`), and broadcasts an updated `presence`. If a room reaches zero members it's deleted, so idle rooms don't leak.

**Disconnect (client-detected):** loss of `close`/`error` on the browser `WebSocket` sets status to `disconnected` and schedules a reconnect with exponential backoff (1s, 2s, 4s… capped at 10s — `connection.ts: scheduleReconnect`).

**Reconnect (no duplicate cursor):** the browser client persists its `clientId` in `sessionStorage` (stable across reconnects within the same tab, distinct across tabs — `localStorage` would collide across tabs). On reconnect it re-sends `join` with the same `clientId`. If the server still has a stale entry under that ID (e.g. the old TCP connection hadn't fully torn down yet), it force-closes the old connection and replaces it, rather than ending up with two entries for one participant.

**Out-of-order delivery:** every `cursor`/`reaction` carries a client-incrementing `seq`. The server tracks `lastSeq` per client and silently drops any inbound message whose `seq` isn't strictly greater than the last accepted one (`room.ts` / `server.ts: handleCursor`). This is a monotonic-counter approach rather than timestamp-based, so it's immune to client clock skew.

**Malformed / unknown messages:** both sides run a full structural type guard (`isClientMessage` / `isValidServerMessage`) before touching a parsed payload. Invalid JSON or a message that doesn't match a known shape/type is rejected outright — the server closes the offending socket (codes `1007` invalid JSON, `1003` invalid message, `1008` protocol violation e.g. missing join or `clientId` spoofing), the client just logs and ignores it. Nothing is ever passed downstream unchecked.

---

## Known limitations

- No persistence — server restart drops all rooms and presence; clients simply reconnect and re-join as if new.
- No horizontal scaling — a single Node process holds all room state in memory (see `ARCHITECTURE.md` for a discussion of how this would change).
- No authentication/access control — any client can join `roomId` `"demo-room"` (or any room ID they construct); this was explicitly out of scope per the assignment FAQ.
- Only one room is used by the demo UI (`ROOM_ID` is hardcoded in `App.tsx`), though the protocol and server are already multi-room.
- WebSocket frame parsing supports single, unfragmented text frames plus ping/pong/close control frames — it does not handle fragmented (multi-frame) messages, since browsers don't produce them for JSON-sized payloads in practice.
- No adaptive/per-client latency-based throttling (fixed 40ms for everyone) and no client-side extrapolation past the latest sample — both are listed as bonus items in the assignment and were left for a follow-up.

## Time spent

~32 hours.

## AI Usage Disclosure

AI tools were used as a development assistant during this project.

AI assistance was primarily used for:
- Understanding and reviewing the WebSocket protocol and synchronization approach
- Debugging TypeScript and connection lifecycle issues
- Reviewing cursor throttling and interpolation logic
- Reasoning about sequence numbers, stale-message rejection, and reconnection handling
- Reviewing the implementation against the assignment requirements
- Improving documentation and explaining technical concepts

The architecture, implementation, integration, and testing were reviewed and validated manually. The application was tested locally using multiple browser tabs to verify real-time cursor synchronization, reactions, presence, joining, disconnection, and reconnection behavior.

AI was used as a supporting tool rather than as a replacement for understanding, testing, or validating the implementation.
