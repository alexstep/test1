# 08 - Non-Goals (Out of Scope for MVP)

These are nice-to-haves from the assignment. Explicitly deferred to avoid scope creep. Implement only after all MUST requirements pass.

## Authentication

| Feature | Why deferred |
|---------|-------------|
| RBAC (player/admin roles) | No assignment feature requires admin-only endpoints. Can be added later by extending JWT payload and adding a `RolesGuard` |
| OAuth2 (Google/Discord) | Significant additional complexity (OAuth flow, provider config, account linking). Core auth with email/password demonstrates the same competence |

## Leaderboard

| Feature | Why deferred |
|---------|-------------|
| Per-player score history | Requires additional endpoint and potentially a dedicated query. Match history exists in Postgres already - the endpoint is trivial to add but not scored |

## Real-Time

| Feature | Why deferred |
|---------|-------------|
| Presence events (player online/offline) | Requires additional Redis tracking (SET of online users per game) and WS messages. Not part of core scoring |
| Rate limiting via Redis token bucket | Good production practice but not in scoring criteria. Can be added as middleware with Redis MULTI/EXEC |

## Infrastructure

| Feature | Why deferred |
|---------|-------------|
| Terraform snippet | No cloud deployment in scope. Would be a static example with no way to verify |
| Kubernetes manifests | Same as Terraform - useful for production but unverifiable in this context |
| Prometheus `/metrics` endpoint | Requires `prom-client` integration. Low scoring weight. If time permits, this is the easiest bonus to add |

## Bonus (Pick at Most One if Time Permits)

Priority order if time allows:

1. **Prometheus `/metrics`** - lowest effort, integrates with NestJS easily via `@willsoto/nestjs-prometheus` or manual `prom-client`.
2. **Load test (k6)** - demonstrates the system works under load across 2 replicas. Good demo value.
3. **Terraform snippet** - static config, least demonstrable value.

~~Message delivery guarantees (dedupe / resume)~~ - **implemented**: HTTP `Idempotency-Key` + Redis Streams resume (`last_event_id`). See README.md and spec/02-api.md / spec/04-realtime.md.

## Explicitly NOT Doing

- No frontend / UI - this is backend-only.
- No email verification or password reset flow.
- No file uploads or media handling.
- No API versioning beyond `/api/v1` prefix.
- No database seeding beyond what tests require.
- No horizontal auto-scaling - fixed 2 replicas.
- No HTTPS termination - Nginx serves HTTP only (production would add TLS).
- No WebSocket binary protocol - JSON only.
- No message queue (RabbitMQ, Kafka) - Redis pub/sub is sufficient for this scale.
