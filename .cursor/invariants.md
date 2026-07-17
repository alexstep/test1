# Invariants - Leaderboard Assignment

Hard requirements derived from the assignment spec and disqualifiers. Violations block merge and may disqualify the submission.

## Architecture

| ID | Invariant |
|----|-----------|
| A1 | **Redis pub/sub** must broadcast leaderboard updates across all app instances. In-process-only WebSocket fan-out is **not** sufficient. |
| A2 | **PostgreSQL** is the source of truth for users, scores, and leaderboard data. |
| A3 | Redis is used for caching and/or pub/sub - not as the primary persistent store for scores. |
| A4 | Multiple app replicas must show consistent leaderboard state after writes (eventual consistency via pub/sub is acceptable per spec). |

## Authentication & security

| ID | Invariant |
|----|-----------|
| S1 | **WebSocket connections must be authenticated** before subscribing to leaderboard events. |
| S2 | REST endpoints that mutate or read private data require auth per spec. |
| S3 | Passwords stored with **argon2 or bcrypt** - never plaintext, never reversible encoding. |
| S4 | **No secrets, tokens, or credentials** committed to the repository. Use `.env.example` with placeholder values. |
| S5 | JWT secrets and DB passwords come from environment variables only. |

## Data integrity

| ID | Invariant |
|----|-----------|
| D1 | Score submissions are validated (type, range, user ownership) before persistence. |
| D2 | Leaderboard queries reflect Postgres data; cache invalidation or pub/sub refresh on writes. |
| D3 | Database schema changes go through **TypeORM migrations** - no manual-only schema drift. |

## DevOps & deliverables

| ID | Invariant |
|----|-----------|
| O1 | `docker compose up` (or documented equivalent) works on a **clean checkout** with no manual steps beyond copying `.env.example`. |
| O2 | **CI pipeline** runs lint, typecheck, test, and build. |
| O3 | `README.md` documents setup, env vars, and how to run tests. |
| O4 | `NOTES.md` documents non-obvious design decisions and known limitations. |
| O5 | Spec requirements in `spec/` are met or deviations are documented in `NOTES.md`. |

## Code quality

| ID | Invariant |
|----|-----------|
| C1 | TypeScript **strict** mode enabled. |
| C2 | Input validation on all external inputs (`class-validator` + DTOs). |
| C3 | Structured logging - no secrets or PII in log output. |
| C4 | NestJS layered architecture: controllers → services → repositories - no business logic in controllers. |

## Disqualifiers (assignment)

These will fail review:

- WebSocket updates work only within a single process (no Redis pub/sub).
- Unauthenticated WebSocket access to live leaderboard stream.
- Plaintext password storage.
- Hardcoded secrets in source or docker-compose.
- `docker compose up` fails on clean machine.
- Missing CI configuration.
- Runtime is Bun instead of Node.js for the NestJS application.
