# 02 - API Contracts

## Base URL

All REST endpoints served behind reverse proxy. Base path: `/api/v1`.

---

## Authentication

### POST /api/v1/auth/signup

Create a new player account.

**Request:**
```json
{
  "email": "player@example.com",
  "password": "securePass123"
}
```

**Validation:**
- `email`: valid email format, unique in DB
- `password`: min 8 characters

**Response 201:**
```json
{
  "id": "uuid",
  "email": "player@example.com",
  "created_at": "2026-07-15T10:00:00Z"
}
```

**Errors:**
- `400` - validation failure (invalid email, short password)
- `409` - email already registered

### POST /api/v1/auth/login

**Request:**
```json
{
  "email": "player@example.com",
  "password": "securePass123"
}
```

**Response 200:**
```json
{
  "access_token": "jwt...",
  "refresh_token": "opaque-token",
  "expires_in": 900
}
```

**Errors:**
- `401` - invalid credentials

### POST /api/v1/auth/refresh

**Request:**
```json
{
  "refresh_token": "opaque-token"
}
```

**Response 200:**
```json
{
  "access_token": "jwt...",
  "refresh_token": "new-opaque-token",
  "expires_in": 900
}
```

Old refresh token is invalidated (rotation).

**Errors:**
- `401` - invalid or expired refresh token

---

## Games

All game endpoints require valid JWT in `Authorization: Bearer <token>`.

### POST /api/v1/games

**Request:**
```json
{
  "name": "Space Invaders",
  "description": "Classic arcade shooter"
}
```

**Validation:**
- `name`: required, 1–100 chars, unique
- `description`: optional, max 500 chars

**Response 201:**
```json
{
  "id": "uuid",
  "name": "Space Invaders",
  "description": "Classic arcade shooter",
  "created_at": "2026-07-15T10:00:00Z"
}
```

### GET /api/v1/games

**Response 200:**
```json
[
  {
    "id": "uuid",
    "name": "Space Invaders",
    "description": "Classic arcade shooter",
    "created_at": "2026-07-15T10:00:00Z"
  }
]
```

---

## Matches

All match endpoints require valid JWT.

### POST /api/v1/matches

Submit a match result. `player_id` is extracted from the JWT - players cannot submit scores for others.

**Headers (optional):**
- `Idempotency-Key: <uuid>` - client-generated UUID identifying this submission intent (Stripe / IETF `Idempotency-Key` draft). Retries with the same key for the same player return the original match without re-applying score side effects. Scoped per `player_id`.

**Request:**
```json
{
  "game_id": "uuid",
  "score": 1500
}
```

**Validation:**
- `game_id`: must exist
- `score`: positive integer
- `Idempotency-Key` (when present): UUID, max 255 characters

**Response 201** (first successful submit):
```json
{
  "id": "uuid",
  "player_id": "uuid",
  "game_id": "uuid",
  "score": 1500,
  "created_at": "2026-07-15T10:05:00Z"
}
```

**Response 200** (idempotent replay - same `Idempotency-Key` for this player):
- Same body shape as 201 (reconstructed from the existing match row)
- Response header: `Idempotent-Replayed: true`
- No Redis `ZINCRBY`, no stream append, no pub/sub publish

**Side effects (within same request, first submit only):**
1. Insert match record into PostgreSQL (with optional `idempotency_key`)
2. `ZINCRBY` player's cumulative score in Redis Sorted Set `leaderboard:{gameId}`
3. `XADD` to Redis Stream `leaderboard-events:{gameId}` (bounded replay buffer) → `event_id`
4. Publish leaderboard-update (with `event_id`) to Redis pub/sub channel `leaderboard-updates:{gameId}`
5. All WS clients subscribed to that game receive the update

**Errors:**
- `400` - validation failure (including invalid `Idempotency-Key`)
- `404` - game not found
- `409` - concurrent request with the same key still in progress; client should retry shortly

---

## Leaderboard

### GET /api/v1/leaderboard/:gameId

Top-N leaderboard for a game. Reads from Redis. Supports cursor-based pagination (primary) and offset pagination (fallback).

**Query params:**
- `cursor` (optional, opaque string) - pagination cursor for next page; omit for first page. When provided, takes precedence over `offset`.
- `offset` (default: 0, min: 0) - fallback offset-based pagination; ignored when `cursor` is provided.
- `limit` (default: 10, min: 1, max: 100)

**Pagination behavior:**
- **First page**: omit `cursor` (optionally provide `offset=0`). Response may include `next_cursor` when more entries exist - this bootstraps cursor pagination without requiring clients to start with a `cursor` param.
- **Next page (cursor)**: pass `next_cursor` from previous response as `cursor`.
- **Next page (offset fallback)**: increment `offset` by `limit` (e.g. `offset=10` after first page with `limit=10`).
- When `cursor` is provided, `offset` is ignored.
- `next_cursor` is an opaque base64url-encoded string. Clients must not parse or construct it.

**Response 200:**
```json
{
  "game_id": "uuid",
  "entries": [
    {
      "rank": 1,
      "player_id": "uuid",
      "email": "top@example.com",
      "score": 15000
    },
    {
      "rank": 2,
      "player_id": "uuid",
      "email": "second@example.com",
      "score": 12000
    }
  ],
  "total": 150,
  "limit": 10,
  "offset": 0,
  "next_cursor": "ZXlKelkyOXlaU0k2TVRVD..."
}
```

**Notes:**
- `next_cursor` is `null` (or omitted) on the last page.
- When offset fallback is used (no `cursor`), response includes `offset` reflecting the current page start. `next_cursor` is also included when more entries exist - including on the default first page (`offset=0`) - so clients can switch to cursor pagination for subsequent pages.
- When `cursor` is provided, response omits `offset` and uses cursor-based paging only.
- Invalid cursor format returns `400 Bad Request`.

**Errors:**
- `400` - invalid cursor format
- `404` - game not found

### GET /api/v1/leaderboard/:gameId/rank/:playerId

Single player's rank and score for a game.

**Response 200:**
```json
{
  "game_id": "uuid",
  "player_id": "uuid",
  "email": "player@example.com",
  "rank": 42,
  "score": 5000
}
```

**Errors:**
- `404` - game or player not found, or player has no score in this game

---

## Health

### GET /health

No auth required. Used by reverse proxy and monitoring.

**Response 200:**
```json
{
  "status": "ok",
  "uptime": 3600,
  "hostname": "api-1"
}
```

---

## WebSocket Protocol

### Connection

```
WS /ws/leaderboard/:gameId?last_event_id=<stream-id>
```

Authentication via first message after upgrade (not query string). Documented in README.md.

```json
{ "type": "auth", "token": "<jwt>" }
```

Must be sent within 5 seconds of open. Until auth succeeds the client is not subscribed to leaderboard updates.

**Optional resume:** `last_event_id` - Redis Stream ID of the last `leaderboard-update` the client processed (e.g. `1697000000000-0`). When present and the server buffer still covers the gap, the server replays missed updates instead of (or before needing) a full snapshot. Invalid format → close code `4000`.

### Server → Client Messages

**Leaderboard snapshot** (sent after successful auth when no resume, or when resume buffer has a gap):
```json
{
  "type": "leaderboard-snapshot",
  "game_id": "uuid",
  "entries": [
    { "rank": 1, "player_id": "uuid", "email": "top@example.com", "score": 15000 },
    { "rank": 2, "player_id": "uuid", "email": "second@example.com", "score": 12000 }
  ],
  "current_event_id": "1697000000000-0",
  "timestamp": "2026-07-15T10:00:00Z"
}
```

`current_event_id` is the latest stream entry ID (`"0-0"` if the buffer is empty). Clients should store it (and subsequent update `event_id`s) for reconnect resume.

**Leaderboard update** (pushed on score change, and on resume replay):
```json
{
  "type": "leaderboard-update",
  "game_id": "uuid",
  "player_id": "uuid",
  "email": "player@example.com",
  "new_score": 6500,
  "new_rank": 5,
  "previous_rank": 8,
  "delta_score": 1500,
  "event_id": "1697000000000-0",
  "idempotency_key": "8f14e45f-ceea-467a-a3b6-8f8cabc8f2f5",
  "timestamp": "2026-07-15T10:05:00Z"
}
```

`idempotency_key` is present only when the match was submitted with an `Idempotency-Key` header.

**Delivery contract (effectively-once):** server delivers at-least-once (replay may overlap with live pub/sub). Clients must dedupe by `event_id` (and optionally `idempotency_key`).
**Error message:**
```json
{
  "type": "error",
  "code": "INVALID_GAME",
  "message": "Game not found"
}
```

**Heartbeat ping** (server-initiated):
```json
{
  "type": "ping",
  "timestamp": "2026-07-15T10:06:00Z"
}
```

### Client → Server Messages

**Auth (required, first message):**
```json
{
  "type": "auth",
  "token": "<jwt>"
}
```

**Heartbeat pong:**
```json
{
  "type": "pong"
}
```

No other client-to-server messages required for MVP.

### Close Codes

| Code | Meaning |
|------|---------|
| 4001 | Authentication required (no/timeout/invalid auth message) |
| 4003 | Token expired or invalid |
| 4004 | Game not found |
| 1000 | Normal closure |
| 1011 | Internal server error |

### Error Response Format (REST)

All REST errors follow a consistent shape:

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "errors": [
    { "field": "email", "message": "must be a valid email address" }
  ]
}
```
