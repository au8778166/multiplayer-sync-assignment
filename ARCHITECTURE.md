# Architecture

## High-level shape

```
┌─────────────────────────────┐        WebSocket (raw TCP,          ┌──────────────────────────────┐
│  Browser tab (client)        │        RFC 6455 frames, JSON text)  │  Node process (server)        │
│                               │◄────────────────────────────────────►│                               │
│  App.tsx (React UI/render     │                                      │  server.ts (transport +       │
│    loop, input capture)       │                                      │    handshake + dispatch)      │
│  connection.ts (transport +   │                                      │  room.ts (presence/broadcast) │
│    reconnect + validation)    │                                      │  protocol.ts (message types + │
│  interpolation.ts (per-peer   │                                      │    validation)                │
│    smoothing buffer)          │                                      │                               │
│  render.ts (canvas drawing)   │                                      │                               │
└─────────────────────────────┘                                      └──────────────────────────────┘
```

One Node process holds all rooms in memory. Clients are plain browser tabs with no server-side session beyond the in-memory `ClientState` held while their socket is open.

## Layering and why each piece exists

The assignment specifically asks whether a new action type could be added "without touching transport code." The project is split along exactly that seam on both sides:

**Transport (`server.ts`'s `RawWebSocket` class, `readFrame`/`createFrame`, `performHandshake`)**
Everything here operates on bytes and knows nothing about cursors, reactions, or rooms. It: performs the RFC 6455 upgrade handshake (SHA-1 + base64 of the `Sec-WebSocket-Key`); parses/masks/unmasks WebSocket frames off a growing `Buffer`, handling partial-frame reads across multiple TCP chunks; and exposes a small `ClientConnection` interface (`send`, `close`, `isOpen`, `ping`, `getLastPong`) upward. The rest of the server only ever talks to that interface — it never touches a raw `Buffer` or `Socket`. This is the piece that would be swapped out entirely if we later used the `ws` package or SSE; nothing above it would need to change.

**Protocol (`protocol.ts` on the server, the mirrored types + guards in `connection.ts` on the client)**
Defines the `ClientMessage`/`ServerMessage` discriminated unions and the runtime type guards that validate every inbound payload field-by-field before it's trusted. This is deliberately duplicated (not shared via a package) between client and server for this assignment's scope — see Limitations — but each side is self-contained and neither trusts the other's shape claims. Adding a new action type means adding one variant to these unions plus one guard branch; it doesn't touch `RawWebSocket`/frame parsing at all.

**Room / presence (`room.ts`)**
Holds the authoritative per-room membership (`Map<clientId, ClientState>`), position snapshot, and broadcast fan-out. `broadcast()` iterates the room's client map once per call (O(n) per message, not O(n²) — there is no re-broadcast-to-broadcast chain), and always accepts an `excludeClientId` so senders don't get their own cursor echoed back. This is the only place that knows "who is in a room" — `server.ts` asks it questions, it never reaches into socket internals.

**Dispatch (`server.ts`'s `handleMessage`/`handleJoin`/`handleCursor`/`handleReaction`/`handleDisconnect`)**
The glue: takes a validated `ClientMessage`, checks session invariants (must have joined; `clientId` on the message must match the session's `clientId`, preventing one socket from spoofing another client's identity), applies the sequence-number staleness check, mutates `ClientState`, and asks `Room` to broadcast. This is where per-message-type logic lives, and it's the layer you'd extend for a new action type (e.g. a `"typing"` indicator) — a new `handleTyping` alongside the existing handlers, no transport changes.

**Client-side mirror: `connection.ts` (transport+protocol), `interpolation.ts` (reconciliation), `render.ts` (drawing), `App.tsx` (composition root)**
`connection.ts` owns the `WebSocket` object, reconnect/backoff state, outbound `seq` counter, and inbound validation — comparable in role to `server.ts` + `protocol.ts` combined, since a browser client doesn't need a separate raw-frame layer (the browser's native `WebSocket` already handles framing). `interpolation.ts` is pure state (a sample buffer + a `getPosition(now)` query) with no DOM or transport dependency, so it's independently testable. `render.ts` is pure functions that take already-reconciled positions/state and draw to a `CanvasRenderingContext2D` — it never touches the socket. `App.tsx` is the only place that wires these together: it owns a `Map<clientId, RenderCursor>` and a `requestAnimationFrame` loop that reads interpolated positions and reaction state via refs (not React state), so 60fps rendering never triggers React re-renders — only discrete events (participant list changing, connection status changing, reaction *count* for the UI badge) go through `useState`.

## Data flow by scenario

**Join:** client opens `WebSocket` → server performs handshake → client sends `join` → server creates/looks up the `Room`, evicts any stale connection already registered under that `clientId` (covers reconnect races), adds the new `ClientState` at a default `(0.5, 0.5)`, replies `welcome` with a full participant snapshot to the joiner only, then broadcasts `presence` to everyone (including the joiner) so all clients converge on one roster.

**Cursor move:** client throttles `mousemove` to 25Hz → sends `cursor` with an incrementing `seq` → server validates shape, checks `clientId` matches the session, drops it if `seq` isn't newer than `lastSeq`, updates `ClientState.x/y`, and broadcasts to everyone *except* the sender → each receiving client's `App.tsx` pushes the sample into that peer's `CursorInterpolator` → the render loop reads an interpolated position every frame independent of message arrival.

**Reaction:** same path as cursor, but the payload also carries an `emoji`; receiving clients push a timed `Reaction` object that `render.ts` fades/floats out over 1.2s and `App.tsx` prunes once expired.

**Disconnect:** TCP close/error on the socket → `RawWebSocket.handleClose` fires → server's `handleDisconnect` verifies the closing connection is still the one registered for that `clientId` (so an old, already-replaced connection from a fast reconnect can't wrongly evict the new one) → removes the client, broadcasts `leave`, broadcasts fresh `presence`, and deletes the room if now empty. Independently, a 10s heartbeat sweep force-closes any socket that hasn't ponged in 30s, so a hard network drop (no clean TCP close) is still bounded.

## Design decisions worth calling out

- **Raw sockets over `ws`:** the server hand-rolls the WebSocket handshake and frame (de)serialization on `node:net`/`node:http` rather than using the `ws` npm package, per the assignment's "no socket libraries" constraint. It supports single unfragmented frames and the three control opcodes it needs (`close`/`ping`/`pong`) — enough for JSON payloads this size, not a general-purpose WebSocket implementation.
- **Full-snapshot late join over replay:** simpler and sufficient at the assignment's stated scale (3–10 clients); a replay log would add complexity without a clear benefit until room sizes get much larger.
- **Sequence numbers over timestamps for ordering:** client clocks can't be trusted to agree, but a per-client monotonic counter can't go backwards except via a full reconnect (which resets `seq` to 0 — harmless, since the server's own `lastSeq` for that `clientId` is also reset when the entry is replaced on rejoin).
- **Refs + rAF over React state for the render loop:** keeps 60fps drawing off the React reconciler entirely; `useState` is reserved for the handful of values the DOM chrome (participant list, status pill, reaction counter) actually needs to re-render on.

## Scaling beyond one process (discussion only, not implemented)

The current design keeps all room state (`Map<roomId, Room>`) in a single process's memory, so it can't run as multiple instances behind a load balancer today — two clients in the same room could land on different processes and never see each other. To scale horizontally:

1. **Sticky sessions aren't enough by themselves** — they'd keep a given client's *reconnects* on the same node, but two different clients in the same room can still land on different nodes on first connect.
2. **Externalize room membership and fan-out through a pub/sub layer** (Redis Pub/Sub, NATS, or similar): each server instance keeps its own locally-connected sockets, but instead of `Room.broadcast()` iterating an in-memory `Map`, a `cursor`/`reaction` message gets published to a `room:{roomId}` channel; every instance subscribed to that channel (i.e. hosting at least one member of that room) relays it to its own local sockets. Presence would need a shared store (e.g. Redis hash of `roomId → {clientId → lastSeen}`, with the heartbeat sweep updating it) rather than each instance's local `Map`, so `welcome`/`presence` snapshots are globally accurate regardless of which instance a joining client hits.
3. **Sequence numbers would need to be scoped per-client, not renumbered globally** — this already holds today since ordering is enforced per `clientId`, not per room, so it survives the multi-instance case unchanged.
4. **Heartbeat/timeout logic moves from "the process this socket happens to live on" to "whichever instance owns that socket," with cleanup still publishing `leave`/`presence` to the shared channel** so other instances' local clients find out promptly.

This is a meaningful rewrite of the room/broadcast layer, not a config change — which is why it's called out as a discussion item rather than attempted here, consistent with the assignment's scope (correctness at 3–10 clients on one process).

