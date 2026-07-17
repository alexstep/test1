# AGENTS.md - Leaderboard Backend & DevOps

## Project

**Real-Time Gaming Leaderboard Service** - Dizzaract test assignment.

Backend service: authenticated users, score submission, real-time leaderboard updates across multiple app instances.

## Stack

| Layer | Technology |
|-------|------------|
| Runtime | **Bun** (`oven/bun:1-alpine`) - intentional deviation from spec DQ-8, documented in NOTES.md |
| Framework | NestJS 10, TypeScript strict |
| Database | PostgreSQL 18 (source of truth, UUID v7 PKs) |
| Cache / pub-sub | Redis 7 + Bun native `RedisClient` (cross-instance WebSocket fan-out) |
| Real-time | raw `ws` (custom upgrade) + Redis pub/sub |
| Reverse proxy | **Angie** (`docker.angie.software/angie:latest`) - NOT nginx |
| Local dev | Docker Compose (2 explicit replicas + Angie) |
| CI | GitHub Actions |

## Spec source of truth

All requirements, disqualifiers, and acceptance criteria live in **`spec/`**. When spec and code disagree, spec wins until human documents a deviation in `NOTES.md`.

## Deliverables

- `README.md` - setup, run, test, architecture overview
- `NOTES.md` - design decisions, trade-offs, known gaps
- `docker-compose.yml` - `docker compose up` on clean checkout
- CI pipeline - lint, typecheck, test, build
- NestJS application per spec

## Agent hierarchy

```
Human (owns git commits)
  └── CTO (.cursor/commands/cto.md)
        └── teamlead (.cursor/agents/teamlead.md)
              ├── explore (research)
              ├── developer / senior / junior (implement)
              ├── build-fixer (verify failures)
              ├── reviewer (multi-pass review)
              └── tester (integration / smoke)
```

Workers report to **teamlead**, not CTO. CTO receives **compressed handoff only** (see below).

## Compressed handoff (teamlead → CTO)

```
Status: DONE | BLOCKED
Flow: quick|standard|frontend|parallel
Plan: [3-5 bullets max]
Outcome: [what shipped]
Verify: PASS|FAIL
Review: ACCEPT|REJECT
Test: PASS|FAIL|SKIPPED
needs_human_review: true|false
Risks: [bullets]
```

## Key invariants

See `.cursor/invariants.md` for full list. Non-negotiable:

1. **Redis pub/sub** for cross-instance WebSocket broadcast - not in-process-only fan-out.
2. **PostgreSQL** is source of truth for scores and users; Redis is cache/pub-sub, not primary store.
3. **WebSocket connections must be authenticated** (JWT or equivalent per spec).
4. **Passwords hashed** (argon2 or bcrypt) - never plaintext.
5. **No secrets in repo** - env vars / `.env.example` only.
6. **`docker compose up`** works on clean checkout.
7. **Human owns git commits** - agents do not commit or push unless explicitly instructed.

## Rules & docs

| File | Purpose |
|------|---------|
| `.cursor/invariants.md` | Assignment disqualifiers & hard requirements |
| `.cursor/rules/nestjs-node-stack.mdc` | Node/NestJS stack conventions |
| `.cursor/rules/zone-backend.mdc` | Backend architecture zone rules |
| `.cursor/commands/verify.md` | Verify gate commands |
| `.cursor/docs/human-approval-checklist.md` | Pre-commit human checklist |

## Risky domains

Set `needs_human_review: true` when touching:

- Auth / JWT issuance & validation
- WebSocket auth handshake
- Redis pub/sub channel design
- Database migrations (TypeORM)
- Docker / CI configuration
- Secrets / env handling
