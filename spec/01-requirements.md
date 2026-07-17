# 01 - Functional & Non-Functional Requirements

## FR-1: Authentication & Sessions

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1.1 | Email/password sign-up: validate email format, enforce min password length (8 chars) | MUST |
| FR-1.2 | Email/password login: return JWT access token + refresh token | MUST |
| FR-1.3 | Access tokens are short-lived (15 min default, configurable via env) | MUST |
| FR-1.4 | Refresh tokens are long-lived (7 days default), stored hashed in DB | MUST |
| FR-1.5 | Token refresh endpoint: accept refresh token, return new access + refresh pair, rotate old refresh token | MUST |
| FR-1.6 | Passwords hashed with argon2 (preferred) or bcrypt - never stored plaintext | MUST |
| FR-1.7 | WebSocket connections require authentication (see spec/04-realtime.md for mechanism) | MUST |
| FR-1.8 | Reject unauthenticated or expired-token WS connections with proper close code (4001/4003) | MUST |

## FR-2: Games

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-2.1 | `POST /games` - create a new game (name, optional description) | MUST |
| FR-2.2 | `GET /games` - list all games | MUST |
| FR-2.3 | Game has: `id` (UUID), `name` (unique), `description`, `created_at` | MUST |

## FR-3: Match Results & Leaderboard

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-3.1 | `POST /matches` - submit match result: `{ game_id, score }`. `player_id` derived from JWT | MUST |
| FR-3.2 | Match stores: `id`, `player_id`, `game_id`, `score`, `created_at` in PostgreSQL | MUST |
| FR-3.3 | On match submit: update player's cumulative score in Redis Sorted Set for that game | MUST |
| FR-3.4 | On match submit: broadcast leaderboard-update event to all WS clients on that game's channel | MUST |
| FR-3.5 | `GET /leaderboard/:gameId` - return top-N ranked players from Redis (default N=10, max 100) | MUST |
| FR-3.6 | `GET /leaderboard/:gameId` supports cursor-based pagination (primary) and offset+limit as fallback. `cursor` takes precedence when provided | MUST |
| FR-3.7 | `GET /leaderboard/:gameId/rank/:playerId` - return single player's rank, cumulative score, and player info | MUST |
| FR-3.8 | Leaderboard reads come from Redis Sorted Sets, NOT from Postgres on every request | MUST |
| FR-3.9 | PostgreSQL is source of truth; Redis is cache. On Redis flush/restart, leaderboard can be rebuilt from Postgres | MUST |

## FR-4: Real-Time Updates

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-4.1 | WebSocket endpoint per game: `WS /ws/leaderboard/:gameId` | MUST |
| FR-4.2 | On connect: send current top-N leaderboard snapshot to the connecting client | MUST |
| FR-4.3 | On score change: push ranked-diff event (who moved, new rank, delta score) to all connected clients on that game channel | MUST |
| FR-4.4 | Cross-instance fan-out via Redis pub/sub: instance A's REST submission reaches WS clients on instance B | MUST |
| FR-4.5 | One Redis pub/sub channel per `game_id` | MUST |
| FR-4.6 | JSON message protocol with `type` field, structured payloads, and error messages | MUST |
| FR-4.7 | Dead connection cleanup: heartbeat/ping-pong, timeout cleanup, no socket leaks | MUST |

## FR-5: Infrastructure

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-5.1 | `docker compose up` starts: 2 API replicas, reverse proxy (Nginx or Caddy), PostgreSQL, Redis | MUST |
| FR-5.2 | Clean checkout → `docker compose up` → working system (no manual steps beyond optional `.env` copy) | MUST |
| FR-5.3 | Database migrations run automatically on startup or via one documented command | MUST |
| FR-5.4 | Reverse proxy load-balances across 2 API replicas (round-robin or similar) | MUST |
| FR-5.5 | `GET /health` returns: `{ status, uptime, hostname }` to identify which replica responds | MUST |
| FR-5.6 | CI pipeline (`.github/workflows/ci.yml`): lint, typecheck, test, Docker build on every push | MUST |

## Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-1 | `tsc --strict` passes with zero errors | MUST |
| NFR-2 | Linter configured (Biome) and passes with zero errors | MUST |
| NFR-3 | Layered architecture: controller → service → repository. No business logic in controllers | MUST |
| NFR-4 | `class-validator` + `class-transformer` for REST input validation | MUST |
| NFR-5 | Redis or Postgres failure must NOT crash active WebSocket connections | MUST |
| NFR-6 | Graceful shutdown: drain WS connections, finish in-flight DB writes on SIGTERM/SIGINT | MUST |
| NFR-7 | Structured JSON logging with correlation IDs (request-scoped) | MUST |
| NFR-8 | No secrets committed to repo - use `.env.example` with placeholder values | MUST |
| NFR-9 | Leaderboard survives Redis restart (rebuilt from Postgres) | MUST |
| NFR-10 | At least one meaningful test: score submit + broadcast, or JWT validation, or cross-instance fan-out | MUST |
