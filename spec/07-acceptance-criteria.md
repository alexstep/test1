# 07 - Acceptance Criteria

## Automatic Disqualifiers

Any of these present → immediate rejection. Non-negotiable.

| # | Disqualifier | How to verify |
|---|-------------|---------------|
| DQ-1 | In-process broadcast only (no Redis pub/sub) | Code review: `PUBLISH`/`SUBSCRIBE` must exist. Test: submit score on replica 1, verify WS client on replica 2 receives it |
| DQ-2 | Unauthenticated WebSocket | Connect without auth message → must be rejected with close code 4001 |
| DQ-3 | Plaintext passwords or secrets in repo | `grep -r` for passwords, JWT secrets in committed files. `.env` must be in `.gitignore` |
| DQ-4 | Server crashes on Redis/Postgres failure | Stop Redis container while app runs → WS connections must survive, app must not exit |
| DQ-5 | Leaderboard lost on restart | Stop Redis → restart Redis → leaderboard must rebuild from Postgres data |
| DQ-6 | `docker compose up` fails on clean checkout | Clone repo, `docker compose up` → all services healthy within 60s |
| DQ-7 | Missing CI configuration | No `.github/workflows/ci.yml` or equivalent pipeline (lint, typecheck, test, build) |
| DQ-8 | ~~Bun runtime instead of Node.js~~ **WAIVED** - intentional human decision to use Bun runtime (`oven/bun:1-alpine`). Documented in `README.md`. | N/A - not auto-disqualifying in this submission |

## Scoring Rubric

### Core: Auth, Match, Leaderboard, Broadcast (35%)

| Criterion | Pass | Fail |
|-----------|------|------|
| Sign-up creates user with hashed password | User in DB, password_hash present, cannot reverse | Plaintext or missing |
| Login returns valid JWT pair | Access token decodes with correct payload, refresh token stored | Missing or broken tokens |
| Token refresh rotates refresh token | Old token rejected, new pair works | No rotation or old token still valid |
| `POST /matches` stores match and updates Redis | Match in Postgres, ZSCORE updated in Redis | Missing either side |
| `POST /matches` triggers WS broadcast | Connected client receives `leaderboard-update` | No message or wrong format |
| `GET /leaderboard/:gameId` returns ranked data from Redis | Correct order, scores, ranks; Redis commands in logs | Reads from Postgres on every request |
| `GET /leaderboard/:gameId` cursor pagination works | First page returns `next_cursor`; passing it returns next page; last page has null cursor | Missing cursor support or broken cursor decode |
| `GET /leaderboard/:gameId/rank/:playerId` returns correct rank | Rank matches sorted set position | Off-by-one or wrong |

### Real-Time: WS Lifecycle, Cross-Instance (20%)

| Criterion | Pass | Fail |
|-----------|------|------|
| WS auth via first message | Token validated from `{ type: auth, token }` before room join | No validation or after receiving updates |
| Invalid/expired token rejected | Close code 4001/4003 | Connection allowed |
| Snapshot after auth | Client receives `leaderboard-snapshot` after successful auth | No initial data |
| Update on score change | Client receives `leaderboard-update` with rank diff | Missing or incomplete |
| Cross-instance fan-out | Submit on replica A → client on replica B notified | Only local broadcast |
| Heartbeat + cleanup | Dead connections cleaned up, no socket leaks | Connections accumulate |
| Reconnection works | Client reconnects, gets fresh snapshot | Error or stale data |

### Data Layer: Redis, Postgres, Migrations (15%)

| Criterion | Pass | Fail |
|-----------|------|------|
| TypeORM migrations | Migration files exist, `up`/`down` work | `synchronize: true` or raw SQL |
| Redis Sorted Sets for ranking | `ZREVRANGE`, `ZINCRBY`, `ZREVRANK` used | Hash or plain keys |
| Postgres source of truth | All matches in DB, can rebuild Redis | Redis-only storage |
| Cache rebuild works | After Redis flush, leaderboard returns correct data | Empty or stale |
| Player email hydration | Leaderboard entries include player email, not just ID | UUID-only entries |

### Code Quality (15%)

| Criterion | Pass | Fail |
|-----------|------|------|
| `tsc --strict` passes | Zero errors | Any type error |
| Linter passes (Biome) | Zero errors | Any lint error |
| Layered architecture | Controllers thin, services have logic | Business logic in controllers |
| Input validation | `class-validator` DTOs, `ValidationPipe` | No validation or manual |
| Structured JSON logging | JSON output with correlation IDs | `console.log` or unstructured |
| Graceful shutdown | SIGTERM drains connections cleanly | Abrupt termination |
| Error resilience | Redis failure → degraded mode, not crash | Process exits |

### DevOps (10%)

| Criterion | Pass | Fail |
|-----------|------|------|
| `docker compose up` works | All services start, healthy, traffic flows | Any service fails |
| 2 API replicas behind proxy | Nginx/Caddy balances between them | Single instance |
| Health endpoint identifies replica | Different hostname per replica | Same or missing |
| CI pipeline | lint + typecheck + test + docker build | Missing or broken |
| `.env.example` provided | All required vars documented | Secrets committed |

### Write-Up (5%)

| Criterion | Pass | Fail |
|-----------|------|------|
| README.md | Setup, run, test; WS auth + Redis strategy explained | Missing or broken / superficial |
| Self-critique | Honest gaps identified, next steps listed | "Everything is perfect" |
| Known issues documented | Broken features listed, not hidden | Surprises during review |

## Deliverables Checklist

- [ ] `docker compose up` → all services healthy
- [ ] `POST /api/v1/auth/signup` → user created
- [ ] `POST /api/v1/auth/login` → JWT pair returned
- [ ] `POST /api/v1/auth/refresh` → new JWT pair, old refresh invalidated
- [ ] `POST /api/v1/games` → game created
- [ ] `GET /api/v1/games` → games listed
- [ ] `POST /api/v1/matches` → match stored, Redis updated, WS broadcast sent
- [ ] `GET /api/v1/leaderboard/:gameId` → ranked list from Redis
- [ ] `GET /api/v1/leaderboard/:gameId/rank/:playerId` → player rank
- [ ] `WS /ws/leaderboard/:gameId` + auth message → snapshot after auth
- [ ] WS receives `leaderboard-update` on score change
- [ ] Cross-instance: submit on replica A → WS on replica B receives update
- [ ] `GET /health` → status + hostname (different per replica)
- [ ] Unauthenticated WS (no auth message) rejected with code 4001
- [ ] Redis down → app doesn't crash, WS stays alive
- [ ] Redis restart → leaderboard rebuilds from Postgres
- [ ] `.github/workflows/ci.yml` exists and runs lint/typecheck/test/docker
- [ ] `README.md` - setup, run, and architecture decisions documented
- [ ] Demo script or recording showing end-to-end flow
