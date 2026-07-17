# 05 - Infrastructure & DevOps

## Docker Compose Topology

```
┌─────────────────────────────────────────────────┐
│                 docker-compose.yml              │
│                                                 │
│  ┌──────────┐                                   │
│  │  nginx   │ :80 ──► api-1:3000 (round-robin)  │
│  │  (proxy) │ ──────► api-2:3000                │
│  └──────────┘                                   │
│                                                 │
│  ┌──────────┐  ┌──────────┐                     │
│  │  api-1   │  │  api-2   │  NestJS replicas    │
│  │  :3000   │  │  :3000   │                     │
│  └────┬─────┘  └────┬─────┘                     │
│       │              │                           │
│  ┌────┴──────────────┴────┐                     │
│  │       postgres         │ :5432               │
│  └────────────────────────┘                     │
│  ┌────────────────────────┐                     │
│  │        redis           │ :6379               │
│  └────────────────────────┘                     │
└─────────────────────────────────────────────────┘
```

## Services

### `api` (2 replicas via `deploy.replicas: 2` or two explicit services)

- **Image**: Built from `Dockerfile` in repo root (multi-stage: build → runtime).
- **Runtime**: Node.js 20 LTS (Alpine).
- **Port**: 3000 (internal).
- **Depends on**: `postgres`, `redis` (with `condition: service_healthy`).
- **Environment** (from `.env` or inline):
  - `DATABASE_URL=postgres://user:pass@postgres:5432/leaderboard`
  - `REDIS_URL=redis://redis:6379`
  - `JWT_SECRET=<generated>`
  - `JWT_ACCESS_TTL=900`
  - `JWT_REFRESH_TTL=604800`
  - `NODE_ENV=production`
  - `PORT=3000`
- **Health check**: `GET /health` every 10s, 3 retries, 30s start period.
- **Implementation note**: If using `deploy.replicas`, use `docker compose up --scale api=2`. If using explicit `api-1` and `api-2` services, each gets a unique `hostname` for `/health` identification.

**Recommended approach**: Two explicit services (`api-1`, `api-2`) sharing the same build context. This is simpler for Nginx upstream config and avoids Compose Swarm-mode requirements for `deploy.replicas`.

### `postgres`

- **Image**: `postgres:18-alpine`
- **Port**: 5432 (internal only; optionally expose for local development).
- **Volume**: `postgres_data:/var/lib/postgresql` (persistent; PG 18 image layout).
- **Environment**: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` from `.env`.
- **Health check**: `pg_isready -U $POSTGRES_USER` every 5s.

### `redis`

- **Image**: `redis:7-alpine`
- **Port**: 6379 (internal only).
- **Health check**: `redis-cli ping` every 5s.
- **No persistence required** (Redis is cache/pub-sub; Postgres is source of truth). Optional: enable AOF for faster warm-up.

### `nginx`

- **Image**: `nginx:alpine`
- **Port**: 80 (exposed to host).
- **Config**: `nginx/nginx.conf` mounted via volume.
- **Depends on**: `api-1`, `api-2`.

## Nginx Configuration

```nginx
upstream api {
    server api-1:3000;
    server api-2:3000;
}

server {
    listen 80;

    location / {
        proxy_pass http://api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Request-ID $request_id;
    }

    location /ws/ {
        proxy_pass http://api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Key points:
- WebSocket upgrade headers for `/ws/` path.
- `proxy_read_timeout` set high enough for long-lived WS connections.
- `X-Request-ID` forwarded for correlation.
- Do NOT log full query strings on the reverse proxy (good practice; resume cursor may appear in `last_event_id`).

## Dockerfile (Multi-Stage)

```dockerfile
# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

## Environment Variables

Provide `.env.example` in repo root (committed). Actual `.env` is `.gitignore`d.

```env
# Postgres
POSTGRES_USER=leaderboard
POSTGRES_PASSWORD=changeme
POSTGRES_DB=leaderboard

# App
DATABASE_URL=postgres://leaderboard:changeme@postgres:5432/leaderboard
REDIS_URL=redis://redis:6379
JWT_SECRET=change-this-to-random-string
JWT_ACCESS_TTL=900
JWT_REFRESH_TTL=604800
NODE_ENV=production
PORT=3000
```

For clean-checkout experience: if `.env` doesn't exist, `docker-compose.yml` should define defaults inline or the app should use sensible defaults matching `.env.example`.

## CI Pipeline

File: `.github/workflows/ci.yml`

```yaml
name: CI
on: [push, pull_request]

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck    # tsc --noEmit
      - run: npm run test

  docker:
    runs-on: ubuntu-latest
    needs: quality
    steps:
      - uses: actions/checkout@v4
      - run: docker compose build
```

Stages:
1. **lint**: Biome zero errors (`bun run lint`).
2. **typecheck**: `tsc --noEmit --strict`.
3. **test**: Jest/Vitest unit + integration tests.
4. **docker**: Verify Docker image builds successfully.

## Health Endpoint

`GET /health` - no auth, served directly by each API instance.

```json
{
  "status": "ok",
  "uptime": 3600,
  "hostname": "api-1"
}
```

- `uptime`: seconds since process start (`process.uptime()`).
- `hostname`: `os.hostname()` - in Docker, this is the container hostname, identifying which replica responded.
- Used by: Docker health checks, Nginx upstream checks, monitoring.

## Startup Order

1. Postgres starts, health check passes (`pg_isready`).
2. Redis starts, health check passes (`redis-cli ping`).
3. API replicas start (depend on healthy Postgres + Redis).
4. API runs TypeORM migrations on startup.
5. API warms Redis leaderboard cache from Postgres data.
6. Nginx starts (depends on API replicas).
7. System is ready to serve traffic on port 80.
