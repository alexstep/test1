# 00 - Project Overview

## Project

**Real-Time Gaming Leaderboard Service** - Dizzaract backend & DevOps test assignment.

Authenticated users submit match scores via REST. Leaderboard rankings are stored in Redis Sorted Sets, backed by PostgreSQL as source of truth. Score changes broadcast in real time over WebSockets to all connected clients across multiple server replicas via Redis pub/sub.

## Goals

1. Demonstrate production-grade backend architecture (NestJS, layered, strict TypeScript).
2. Prove cross-instance real-time fan-out works (2 API replicas, Redis pub/sub, reverse proxy).
3. Show DevOps competence (Docker Compose one-command startup, CI pipeline).
4. Deliver clean, reviewable code with structured logging, graceful shutdown, and input validation.

## Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js 20 LTS | Per AGENTS.md - not Bun runtime |
| Framework | NestJS 10+ | TypeScript strict mode |
| Database | PostgreSQL 18 | Source of truth for users, games, matches (UUID v7 PKs) |
| Cache / Pub-Sub | Redis 7 | Sorted Sets for rankings, pub/sub for fan-out |
| Real-time | `@nestjs/websockets` + `socket.io` or `ws` adapter | Per-game channels |
| ORM | TypeORM | Migrations only - no raw SQL |
| Auth | JWT (access + refresh tokens) | Passwords hashed with argon2 or bcrypt |
| Containerisation | Docker Compose | 2 API replicas + Nginx/Caddy + Postgres + Redis |
| CI | GitHub Actions | Lint, typecheck, test, Docker build |

## Timeline

2–3 business days for full implementation including deliverables.

## Deliverables

| Artifact | Description |
|----------|-------------|
| Application | NestJS app per spec sections 01–06 |
| `docker-compose.yml` | `docker compose up` works on clean checkout |
| `.github/workflows/ci.yml` | Lint, typecheck, test, Docker build on every push |
| `README.md` | Setup, run, test instructions; architecture decisions, WS auth rationale, Redis strategy, self-critique, next steps |
| Demo | Screen recording or curl/websocat script: sign-up → submit → broadcast → replica fan-out |

## Scoring Weights

| Area | Weight |
|------|--------|
| Core (auth, match, leaderboard, broadcast) | 35% |
| Real-time (WS lifecycle, Redis pub/sub across 2 instances) | 20% |
| Data layer (Redis Sorted Sets, Postgres, migrations, consistency) | 15% |
| Code quality (layers, validation, logging, resilience) | 15% |
| DevOps (Compose 2 replicas + proxy, CI, health) | 10% |
| Write-up / self-critique | 5% |
