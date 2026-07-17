# Real-Time Gaming Leaderboard

DEMO: https://lb.tools64.net/

Leaderboard service: auth, scores, and real-time updates across multiple API instances.

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

Wait for the stack to come up, then open:

| What | URL |
|------|-----|
| Demo page | http://localhost:1111/ |
| API docs (Scalar) | http://localhost:1111/docs |

## Design notes

```text
                +----------------+
                |     Angie      |
                +----------------+
                  /            \
             +-------+      +-------+
             | api-1 |      | api-2 |
             +-------+      +-------+
                 |              |
                 +------+-------+
                        |
             +----------+----------+
             |                     |
        PostgreSQL              Redis
     (source of truth)   (leaderboard + pub/sub)
```

- **REST** - sign-up/login, games, `POST /matches`, leaderboard reads.
- **WebSocket** - push-only live updates (`/ws/leaderboard/:gameId`). Scores stay on REST so submit stays idempotent and easy to retry.
- **Postgres** owns durable data. **Redis** holds ranked scores (sorted sets), buffers recent events (streams, ~500/game), and fans out updates across replicas via pub/sub (lazy per-game subscribe).

### WebSocket auth

First message after open: `{ "type": "auth", "token": "<jwt>" }` (timeout closes unauthenticated sockets). Browsers cannot set custom WS headers; a `?token=` query string can leak into proxy logs. `Sec-WebSocket-Protocol` was rejected (subprotocols, not credentials).

### Delivery

Pub/sub is a live hint; the Redis Stream is the reconnect source of truth. Clients pass `?last_event_id=...` to replay; if the buffer expired (15 min inactivity) or the id is unknown, the server sends a snapshot. Match submit uses `Idempotency-Key`.

### Stack deviations from the brief

| Spec-ish default | This repo | Why |
|------------------|-----------|-----|
| Node.js | **Bun** | Faster install/start in Docker/CI (DQ-8 waived) |
| Nginx | **Angie** | Drop-in, actively maintained |
| Express | **Fastify** | Higher throughput; Nest controllers unchanged |
| Socket.IO | raw **`ws`** | Simple JSON protocol |
| ESLint | **Biome** | One fast lint tool; same zero-errors bar |

### Intentionally skipped / known limits

Skipped: roles/admin, OAuth, presence, Terraform/K8s, Locust/k6, TLS at the proxy (local Compose is HTTP-only).

Rate limits are multi-layer (Angie + Nest + WS) but counters are in-memory per replica — approximate cluster-wide. Startup Redis rebuild is sequential; Postgres→Redis is eventually consistent (retries + per-game rebuild on failure). Bun Redis pub/sub is still experimental.

### What I’d do next

1. Redis-backed rate counters across replicas.
2. Parallel / background Redis rebuild.
3. TLS at Angie in any shared environment.
4. Watch Bun’s Redis pub/sub (still experimental) — fall back to a Node Redis client if it bites.

## Production notes (future, out of scope here)

### Realtime: don’t let the API own WebSockets

In this repo every API replica terminates its own WebSocket connections, because demonstrating Redis pub/sub fan-out across replicas is part of the task. That’s fine for a demo, but not a shape you want in production:

- Every API deploy / rolling restart / autoscale event drops live sockets and forces mass reconnect storms.
- API replicas have to keep per-game subscribe/unsubscribe bookkeeping, heartbeat loops, stream replay, and backpressure — none of which is business logic.
- Scaling reads (leaderboard HTTP) and scaling connections (idle WS holders) are very different workloads that end up sharing one process.
- Cross-replica fan-out is coupled to the API’s pub/sub client; a slow subscriber can back-pressure the API.

A cleaner production shape is a dedicated realtime gateway (e.g. **Centrifugo**, or NATS/Kafka + a thin WS layer):

```
API  ──publish──▶  Redis Pub/Sub / Streams  ──▶  Centrifugo  ──WS──▶  Clients
```

The API only *publishes* events on score change. Centrifugo owns connections, reconnects, presence, history, JWT/subscription auth, and horizontal scale of the socket tier. API replicas can be restarted freely without touching client sockets. Internal services keep consuming Redis/NATS/Kafka directly, so the browser transport stays replaceable — Centrifugo is a client gateway, not a service bus.

### Auth: cookie sessions instead of JWT-for-browsers

The assignment explicitly requires JWT, so that’s what’s shipped. For a browser-based production system I’d prefer **Redis-backed server sessions behind a `Secure; HttpOnly; SameSite=Lax` cookie**:

- **Instant revocation** — logout / "sign out all devices" / permission change takes effect on the next request. JWT can’t do this without a blacklist that reintroduces the same round-trip.
- **XSS-safe by construction** — the session id lives in an HttpOnly cookie and never touches JavaScript, so an exfiltrated in-memory token can’t be replayed and there’s nothing to refresh-rotate.
- **Sliding expiration + device list** — trivial when the server owns the session record; awkward with stateless JWT.
- **WebSocket upgrade carries the cookie automatically** — no first-message auth dance, no `?token=` in the URL, no browser-header workaround. The upgrade request is authenticated by the same cookie the REST call uses.
- **Redis is already in the stack** — sessions are a `SET` + TTL; no new dependency.

JWT still makes sense for OAuth flows, mobile/public APIs, service-to-service auth, signed URLs, and email-verification-style stateless tokens. It’s the wrong default for a first-party browser client.

Even inside the current JWT setup the refresh token is dual-issued: response body (spec/curl compatibility) *and* an HttpOnly cookie scoped to `/api/v1/auth`, per logical browser session (`X-Session-Id`). The browser SDK relies on the cookie only, so a stolen access token expires in ~15 min and cannot be extended via XSS.
