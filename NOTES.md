# NOTES

How the service is put together, why a few choices differ from the brief, what was skipped, and what I'd do differently in production.

## Architecture

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

- REST - sign-up/login, create games, submit scores, read leaderboard.
- WebSocket - live updates only (`/ws/leaderboard/:gameId`).
- Two API replicas behind Angie so cross-instance fan-out is real, not theoretical.

Postgres owns durable data. Redis holds ranked scores for fast reads and publishes score changes so a match on `api-1` reaches a viewer on `api-2`.

## REST vs WebSocket

Score submission stays on REST (`POST /matches`); WebSocket is push-only. REST is easier to make idempotent, validate, and retry. Mixing submit into the socket would complicate auth, retries, and multi-instance behaviour for little gain.

## WebSocket auth

First message `{ "type": "auth", "token": "<jwt>" }` after the connection opens.

Browsers cannot set custom headers on `WebSocket`, and a `?token=` query string may leak into proxy access logs. First-message auth avoids both; unauthenticated connections are closed after a short timeout. `Sec-WebSocket-Protocol` was rejected - it negotiates subprotocols, not credentials. A nice property of this scheme is that refreshing the token over the live connection is possible in principle (just send another auth message) - I didn't implement that here, after auth the server only expects pong. When the token expires the client reconnects with a fresh one and catches up via `last_event_id`, so nothing is lost.

## Redis

Redis has three responsibilities:
- Sorted sets store leaderboard rankings for fast reads.
- Streams buffer the last ~500 events per game (`XADD ... MAXLEN ~ 500`) so a reconnecting WebSocket client can replay via `XRANGE (last_event_id +`.
- Pub/sub broadcasts score updates between API replicas (one channel per game).

Replicas subscribe only while they have local clients for a game. The subscriber uses a seperate connection because subscriber mode cannot execute regular commands; publishing happens inside the Lua script, i.e. on the data connection. There is also a third `REDIS_PUBLISHER` connection in `redis.module.ts` - I created it before the Lua script existed and planned to publish from it, then PUBLISH moved into Lua for atomicity and I forgot to remove the connection. Dead weight, should be deleted.

The full rebuild from Postgres runs on API startup (fire-and-forget in `onModuleInit`). If Redis restarts while the API stays up, that walker doesn't help - the leaderboard is rebuilt lazily by `ensureLeaderboardBuilt` on the next read instead. If Redis is down the process does not crash and existing WebSocket connections stay up, but leaderboard reads currently surface as plain 500s - mapping that to a proper 503 / degraded response never got written, see self-critique.

### Delivery contract

- **Pub/sub is a hint, Stream is the source of truth.** `PUBLISH` is fire-and-forget and may drop messages under load or during a restart. The event is always appended to the stream first (in the same Lua script), so replay on reconnect stays correct even when a live message is lost.
- Client responsibility. On reconnect, clients pass their last `event_id` as `?last_event_id=...`. Missing/older-than-buffer -> server sends snapshot with the current head event id; matching -> server replays the tail. There is no server-side per-client cursor.
- Offline window. The stream key expires after 15 minutes of inactivity (`EVENTS_TTL_SECONDS`). A client offline longer than that will always recieve a snapshot instead of a delta replay - this is by design.

### Rebuild guarantees

`rebuildGameLeaderboard` builds the ZSET in a temporary key and then `RENAME`s it over the live key, so readers never see an empty window and a concurrent `ZINCRBY` on the live key isn't wiped by a slow rebuild. A per-game `SET NX EX 60` lock prevents two replicas from rebuilding the same game at once, and `rebuildAllLeaderboards` skips games whose ZSET already exists so a rolling restart doesn't re-scan Postgres. One micro-race remains: a match committed to Postgres *between* the rebuild's `SUM(score)` query and the `RENAME` will be overwritten by the snapshot; it is picked up by the next `ZINCRBY` or by a subsequent rebuild.

## Rate limits

Applied at multiple layers: Angie filters floods before they reach Bun, NestJS throttles auth/writes/reads separately, and WebSocket upgrades and message rate are limited independently. Exact numbers live in `src/common/rate-limits.ts` and `angie/angie.conf`.

Limits are intentionally generous for the demo. The NestJS throttler and WS counters are in-memory per replica, so those quotas are approximate cluster-wide; the Angie `limit_req`/`limit_conn` zones sit on the proxy and do count across both replicas. In production I'd move the app-level counters to Redis.

## Stack choices (where we differ from the PDF)

- **Bun** instead of Node.js - faster install/start in Docker/CI; NestJS runs fine on it (intentional deviation from DQ-8).
- **Angie** instead of Nginx - drop-in replacement, actively maintained.
- **Fastify** instead of Express - higher throughput, Nest controllers unchanged.
- Raw `ws` instead of Socket.IO - the simple JSON protocol doesn't need it.
- Biome instead of ESLint - one fast tool, same "lint must pass" bar
- Bonus: Idempotency-Key on matches + Redis Streams replay on WS reconnect (message delivery guarantees).

Smaller hardening extras (encrypted email at rest, secrets kept out of `process.env`) are in the code and README.

## What we skipped

Cut on purpose so the core stays solid: roles/admin reset, OAuth, presence events, Terraform/Kubernetes, Locust/k6 load test (demo script covers fan-out instead), TLS at the proxy (fine for local Compose, required in real prod).

## Scope decisions

One thing worth explaining about `spec/`: those files were written as working instructions for the AI agents I used during development, not as a plan for myself. The non-goals list is there mostly so agents would not build extras on their own without my explicit go-ahead. When I did step outside that scope (minimally - rate limiting and metrics) it was my own deliberate call, and I kept the agent instructions as they were - which is why spec/08 still lists these items as non-goals.

The working principle was: all MUST requirements first, extras only after they passed. So a few items from `spec/08-non-goals.md` were built anyway - I considered them worthwhile because they materially improve the public demo without complicating the core architecture:

- **Rate limiting.** The service runs as a public demo (https://lb.tools64.net/), and unthrottled signup/login/submit on a public endpoint invites abuse (credential stuffing, score-spam filling Postgres and Redis). Shipped: Angie request limits + NestJS throttler + WS message caps. The Redis token bucket spec/08 deferred stays deferred - app-level counters are in-memory per replica and approximate, as documented under "Rate limits" above.
- **Prometheus `/metrics`.** spec/08 itself ranks it as bonus #1 "if time permits". Core acceptance criteria were done, and the endpoint is useful for watching the live deployment. It is guarded by a Bearer token, and Angie returns 404 for `/metrics` on the public side - the endpoint is only reachable on the direct replica ports (:3001/:3002).
- **Idempotency-Key + Streams resume.** The demo page reconnects aggresively, and silent gap-loss would make the live demo look broken; spec/08 was updated at the time to mark this implemented.

Everything else from the non-goals list (RBAC, OAuth, presence, Terraform/K8s, per-player history) stayed cut.

## Self-critique

- Startup Redis rebuild is fire-and-forget and walks games sequentially - fine for a demo, still slow at scale (lazy `ensureLeaderboardBuilt` + per-game Redis lock covers the gap).
- Score update + stream append + pub/sub run in one Redis Lua script so rank deltas and events stay atomic. Postgres->Redis is eventually consistent: after commit, `MatchesService` retries `updateScoreAndPublish` up to three times, and if all attempts fail it fires a per-game `rebuildGameLeaderboard` (Postgres `SUM(score)` -> temp ZSET -> atomic RENAME) so a Redis blip converges instead of leaving the ZSET permanently stale. An Outbox worker would be the next step but is out of scope for this assignment.
- Redis-down reads return a plain 500 instead of a deliberate 503/degraded response - the exception mapping was never written.
- The unused `REDIS_PUBLISHER` connection is an idle client per replica, leftover from before PUBLISH moved into the Lua script.
- Raw `ws` + custom HTTP upgrade means more code than a Nest gateway, but was needed for path params + auth-before-join.
- Full WS flow is covered by smoke/demo against Compose more than by unit tests.
- In-memory rate counters are per-replica, not exact cluster-wide quotas.

## Remaining risks

Things that are fine for a test assignment but would be the first conversations in production:

- Redis is a single point of failure. One instance, no Sentinel/Cluster/replica. If it dies there are no live updates and no leaderboard reads until it comes back (data survives in Postgres, ZSETs get rebuilt). Postgres is a single instance too - in production both would be managed/HA setups.
- No distributed tracing. Logs are structured and carry a correlation id within one request, but the interesting path - submit on replica A -> Lua -> pub/sub -> replica B -> WS push - is not stitched into one trace. OpenTelemetry would be the first thing to add.
- Observability is really just /metrics. No dashboards, no alerting, no log aggregation. An endpoint with numbers is not an observability stack.
- Single region. Both replicas, Redis and Postgres live in one Compose file on one host. A geo-distributed leaderboard (regional shards, cross-region fan-out) is a different project and was never claimed here.

## What I'd do next

1. Move rate counters to Redis for accurate cross-replica limits.
2. Parallelize the Redis rebuild (or move it to a background worker).
3. Terminate TLS at Angie in any shared environment.
4. Watch Bun's Redis pub/sub (still experimental) - fall back to a Node Redis client if it bites.
5. Redis HA (Sentinel or a managed instance) before anything else production-shaped.
6. Wire in OpenTelemetry tracing across the submit -> broadcast path.

## Production realtime (future)

For this assignment every API replica owns its WebSocket connections, because demonstrating Redis pub/sub fan-out is part of the task.

In production I'd move realtime delivery into a dedicated service such as Centrifugo:

```
API -> Redis Pub/Sub / Streams -> Centrifugo -> Clients
```

API would only publish events, while Centrifugo handles connections, reconnects, presence, history, and scale. Internal services keep consuming Redis/NATS/Kafka directly, so the browser transport stays replaceable - Centrifugo is a client gateway, not a service bus.

## Refresh token cookie

The refresh token is dual-issued: the response body still contains `refresh_token` (spec compatibility, curl, non-browser API clients) *and* the server sets an HttpOnly cookie `refresh_token_<X-Session-Id>` scoped to `Path=/api/v1/auth`. The browser SDK relies on the cookie only, so the refresh token never touches JavaScript or SharedWorker memory - a stolen access token is short-lived and cannot be extended via XSS.

- Per-session scoping. The demo runs two independent logical clients (A/B) in one browser. The client sends `X-Session-Id: a|b` on login/refresh; the cookie name is `refresh_token_a` / `refresh_token_b`. `X-Session-Id` defaults to `default` when absent.
- CSRF surface. `SameSite=Lax` + `Path=/api/v1/auth` limits cross-site POSTs; login/refresh are already rate-limited. `Secure` is tied to `NODE_ENV=production`, and the Docker image always sets that - so the cookie is Secure in local Compose too. It still works over http://localhost because browsers treat localhost as a secure context.
- `POST /auth/refresh` body is now optional: cookie wins when both are present, so browser SDK calls `refresh` with an empty body while curl / tests pass `refresh_token` in JSON as before.

### Threat model: same-origin XSS

The SharedWorker is a transport, not a security boundary. Same-origin script can send any RPC the legitimate SDK can send, and can also skip the worker entirely - `fetch('/api/v1/auth/refresh', { credentials: 'include', headers: { 'X-Session-Id': 'a' } })` will still get the HttpOnly cookie attached by the browser. A server-issued `clientId` or worker nonce would not change that: whatever secret the page can obtain, XSS in that page can too.

Real boundaries against XSS-in-my-origin are:
- Refresh token in HttpOnly cookie - never readable from JS, so an exfiltrated access token expires in 15 min and cannot be extended.
- Short access-token TTL + rotation on refresh - narrows the window an attacker gets from a stolen token.
- CSP + input escaping upstream - the actual XSS prevention layer; out of scope for the SDK.

The `clientIds.has(clientId)` check inside the worker is not a security control - it just prevents one tab's port from accidentally receiving events for another logical client that happens to share this worker.

Would a `workerSecret` / `clientId` binding help? Not against XSS on the same origin. A scheme where login returns `{ client_id, worker_binding_secret }` and `register` requires a proof still leaves the secret in JavaScript-readable memory (page or worker), so the same XSS that can call the SDK can also read and replay the proof. The only binding that would actually raise the bar is a per-session secret in an HttpOnly cookie that the browser attaches automatically and JS never sees - that is bank-app territory and out of scope for this demo. Worth mentioning in an interview; not worth shipping here.

### Client-side rate limiting

The SDK deliberately does not gate outbound RPCs. Rate limits live server-side (Angie + NestJS throttling + WS message rate, see "Rate limits" above), which is the only place they can be enforced anyway - a compromised page ignores whatever the SDK does. The one exception is `submitMatch`, where the SDK coalesces concurrent calls sharing the same `Idempotency-Key` into a single fetch so a UI retry after an RPC timeout does not double the load.

### SharedWorker lifecycle & protocol

- bfcache-safe detach. `pagehide` only sends `{ type: 'detach' }` when `event.persisted` is false. Entering the back-forward cache only pauses heartbeats; `pageshow` with `persisted` resumes them and re-registers. Detaching on every `pagehide` would drop the tab's WS subscription when the user hit Back and the page was still alive in bfcache.
- Pending RPC cleanup. `beforeunload` / hard detach reject all in-flight page RPCs with `transport closed` so a response arriving after unload cannot settle a dead Promise.
- Game-scoped fan-out. `ws-status` / `leaderboard-*` go only to ports that called `joinLeaderboard` for that game, not every port sharing the `clientId`. The page additionally coalesces burst `leaderboard-update` dispatches (last update per player per game per microtask).
- `protocolVersion: 1`. Page and worker messages carry an explicit version so a stale CDN facade against a newer worker (or the reverse) fails with a clear mismatch error instead of undefined behaviour.

## Client password prehash

Signup/login accept a domain-separated SHA-256 prehash
(`leaderboard-v1:` + normalized email + `:` + password), not bare `sha256(password)`.
This avoids rainbow tables for common passwords and binds the credential to this service.
The prehash is still password-equivalent for this API; storage at rest is `argon2id(prehash)`.
Accounts created with the old bare-SHA-256 scheme are incompatible - re-signup or wipe the
local DB (`docker compose down -v`).

## Production auth (future)

The assignment explicitly requires JWT, so that's what I implemented.

For a browser-based production system I'd prefer Redis-backed server sessions with Secure HttpOnly cookies: instant logout, device management, immediate permission updates, sliding expiration - and Redis is already in the stack. The WebSocket upgrade would carry the cookie automatically, removing the first-message auth step.

JWT still makes sense for OAuth, mobile/public APIs, service-to-service auth, signed URLs, email verification, and similar stateless use cases.
