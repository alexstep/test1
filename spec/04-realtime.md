# 04 - Real-Time Updates

## WebSocket Lifecycle

### Connection Flow

```
Client                          Server (any replica)
  │                                │
  ├─ WS UPGRADE ──────────────────►│
  │  /ws/leaderboard/:gameId       │
  │  (?last_event_id=… optional)   │
  │                                │
  │── { type: auth, token } ──────►│ 1. Validate JWT from first message
  │                        ┌───────┤ 2. Verify game exists
  │                        │       │ 3. Add client to game room
  │                        │       │ 4. Subscribe to Redis channel
  │                        └───────┤    (if first client for this game on this instance)
  │                                │
  │◄── leaderboard-snapshot ───────┤ 5. Send current top-N
  │    (+ current_event_id)        │    OR replay missed updates
  │                                │    if ?last_event_id=… resumes
  │◄── leaderboard-update ────────┤ 6. Push updates as scores change
  │    (+ event_id)                │
  │◄── ping ──────────────────────┤ 7. Server-initiated heartbeat (every 30s)
  │── pong ───────────────────────►│
  │                                │
  │── close ──────────────────────►│ 8. Client disconnects
  │                                │
  │                        ┌───────┤ 9. Remove from game room
  │                        │       │ 10. If last client for game on this
  │                        │       │     instance: unsubscribe Redis channel
  │                        └───────┤
```

### Authentication

**Mechanism:** JWT in the first WebSocket message after upgrade:

```json
{ "type": "auth", "token": "<jwt>" }
```

Must arrive within **5 seconds**; otherwise the server closes with `4001`. Until auth succeeds the socket is not joined to a room and receives no leaderboard traffic.

**Rationale (documented in README.md):**
- Browser `WebSocket` API does not support custom headers.
- Query-param JWT risks access logs, Referer leakage, and URL length limits.
- First-message auth keeps credentials out of the request URL while staying browser-compatible.
- Alternative considered: query param - rejected for logging/URL exposure.
- Alternative considered: subprotocol - limited library support, awkward API.

### Rejection Handling

| Condition | Action |
|-----------|--------|
| No auth message / timeout / non-auth first message | Close with code `4001` |
| Invalid or expired JWT | Close with code `4003` |
| Game ID not found | Close with code `4004` and error message |
| Token expires mid-session | Server does NOT proactively disconnect (access tokens are short-lived; reconnection handles refresh). Alternative: implement token refresh over WS - out of scope for MVP |

---

## Cross-Instance Fan-Out

### Architecture (2 replicas)

```
┌─────────────┐      ┌─────────────┐
│  API-1      │      │  API-2      │
│  (NestJS)   │      │  (NestJS)   │
│             │      │             │
│  WS clients:│      │  WS clients:│
│  Alice, Bob │      │  Carol      │
└──────┬──────┘      └──────┬──────┘
       │                     │
       │   ┌─────────────┐   │
       └───┤   Redis      ├───┘
           │  Pub/Sub     │
           │  Sorted Sets │
           └─────────────┘
```

### Flow: Match Submit on API-1, Carol on API-2

1. Player submits `POST /matches` to API-1 (via load balancer), optionally with `Idempotency-Key`.
2. API-1 writes to Postgres, updates Redis Sorted Set.
3. API-1 `XADD`s the update to Redis Stream `leaderboard-events:{gameId}` (gets `event_id`).
4. API-1 computes rank diff (new rank, previous rank, delta score).
5. API-1 publishes update (with `event_id`) to Redis channel `leaderboard-updates:{gameId}`.
6. API-1 receives its own pub/sub message → broadcasts to Alice and Bob.
7. API-2 receives the same pub/sub message → broadcasts to Carol.

All three clients receive the update regardless of which replica handled the REST request.

### Resume Protocol (at-least-once / effectively-once)

On reconnect the client may pass `?last_event_id=<id>` (last processed stream ID):

1. Server subscribes to live pub/sub for the game (if first local client).
2. If `last_event_id` is set:
   - If the stream buffer still covers the cursor (`XRANGE` oldest ≤ last_event_id): replay missed `leaderboard-update` messages via `XRANGE (last_event_id +`.
   - Otherwise (buffer trimmed / TTL expired): fall back to `leaderboard-snapshot` with `current_event_id`.
3. If no `last_event_id`: send snapshot with `current_event_id`.
4. Live updates continue via pub/sub. Duplicates between replay and live are possible - clients dedupe by `event_id` (**effectively-once**).

Stream buffer: `MAXLEN ~ 500`, TTL 15 minutes per game key.

### Redis Channel Management

Each NestJS instance maintains a map of `gameId → Set<WebSocket>`.

- **On first client connecting to a game**: `SUBSCRIBE leaderboard-updates:{gameId}`
- **On last client disconnecting from a game**: `UNSUBSCRIBE leaderboard-updates:{gameId}`
- Use the dedicated subscriber Redis connection (see spec/03-data-architecture.md).

### Pub/Sub Message Format

Same JSON structure as the WS `leaderboard-update` message (see spec/02-api.md). The instance receiving from pub/sub relays it directly to local WS clients without transformation.

---

## Connection Management

### Heartbeat

- Server sends `{ "type": "ping" }` every **30 seconds**.
- Client must respond with `{ "type": "pong" }` within **10 seconds**.
- If no pong received: close connection with code `1000` and clean up.
- Also rely on native WebSocket ping/pong frames if using `ws` adapter.

### Room/Channel Management

NestJS Gateway maintains per-game rooms:

```typescript
// Conceptual structure
Map<gameId, Set<WebSocket>>
```

- `handleConnection`: validate JWT → add to room → send snapshot
- `handleDisconnect`: remove from room → unsubscribe Redis channel if room empty
- Guard against race conditions: use synchronous room operations or mutex

### Resource Cleanup

On disconnect (clean or dirty):
1. Remove socket from game room.
2. If room is now empty: unsubscribe from Redis pub/sub channel for that game.
3. Clear any heartbeat timers for that socket.
4. Log disconnection with correlation ID.

On server shutdown (SIGTERM):
1. Stop accepting new WS connections.
2. Send close frame (code 1001 "going away") to all connected clients.
3. Wait up to 5 seconds for clients to acknowledge close.
4. Force-close remaining connections.

### Error Resilience

- **Redis pub/sub connection drops**: reconnect with exponential backoff. Buffer is lost (acceptable - clients will get next update). Log reconnection events.
- **Redis data connection drops**: leaderboard reads fall back to Postgres (slower). Log degradation. Auto-reconnect.
- **Postgres connection drops**: match submissions fail with 503. WS connections remain open (they don't need Postgres). Log and retry.
- **No cascading crashes**: wrap all Redis/Postgres calls in try-catch at the service layer. Never let an infrastructure error propagate to crash the process.
