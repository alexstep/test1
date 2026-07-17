# 06 - Code Quality & Architecture

## Project Structure

```
src/
├── main.ts                          # NestJS bootstrap, graceful shutdown
├── app.module.ts                    # Root module
├── config/
│   ├── database.config.ts           # TypeORM config from env
│   ├── redis.config.ts              # Redis connection config
│   └── jwt.config.ts                # JWT options from env
├── auth/
│   ├── auth.module.ts
│   ├── auth.controller.ts           # POST signup, login, refresh
│   ├── auth.service.ts              # Hash, verify, issue tokens
│   ├── jwt.strategy.ts              # Passport JWT strategy
│   ├── ws-auth.guard.ts             # WebSocket authentication guard
│   ├── dto/
│   │   ├── signup.dto.ts
│   │   ├── login.dto.ts
│   │   └── refresh.dto.ts
│   └── entities/
│       ├── user.entity.ts
│       └── refresh-token.entity.ts
├── games/
│   ├── games.module.ts
│   ├── games.controller.ts          # POST /games, GET /games
│   ├── games.service.ts
│   ├── dto/
│   │   └── create-game.dto.ts
│   └── entities/
│       └── game.entity.ts
├── matches/
│   ├── matches.module.ts
│   ├── matches.controller.ts        # POST /matches
│   ├── matches.service.ts           # Insert match, update Redis, publish
│   ├── dto/
│   │   └── create-match.dto.ts
│   └── entities/
│       └── match.entity.ts
├── leaderboard/
│   ├── leaderboard.module.ts
│   ├── leaderboard.controller.ts    # GET /leaderboard/:gameId, GET rank
│   ├── leaderboard.service.ts       # Redis Sorted Set reads, cache rebuild
│   └── leaderboard.gateway.ts       # WebSocket gateway, pub/sub listener
├── redis/
│   ├── redis.module.ts
│   ├── redis.service.ts             # Data client (Sorted Sets, general ops)
│   └── redis-pubsub.service.ts      # Subscriber + publisher clients
├── health/
│   ├── health.module.ts
│   └── health.controller.ts         # GET /health
├── common/
│   ├── filters/
│   │   └── http-exception.filter.ts # Consistent error responses
│   ├── interceptors/
│   │   └── logging.interceptor.ts   # Correlation ID, request logging
│   ├── middleware/
│   │   └── correlation-id.middleware.ts
│   └── logger/
│       └── logger.service.ts        # Structured JSON logger wrapper
├── migrations/
│   └── *.ts                         # TypeORM auto-generated migrations
└── test/
    ├── auth.e2e-spec.ts
    ├── matches.e2e-spec.ts
    └── leaderboard.e2e-spec.ts
```

## Layered Architecture

Strict separation - no exceptions:

| Layer | Responsibility | May call |
|-------|---------------|----------|
| **Controller** | HTTP/WS request handling, input validation (DTOs), response shaping | Service |
| **Service** | Business logic, orchestration, transactions | Repository, Redis service, Pub/sub service |
| **Repository** | Data access (TypeORM repositories) | Database |
| **Gateway** | WebSocket lifecycle, room management, message relay | Service, Redis pub/sub service |

**Rules:**
- Controllers contain NO business logic. They validate input, call service, format output.
- Services never access `Request`/`Response` objects directly.
- Repositories are TypeORM's built-in `Repository<Entity>` - no custom repository classes unless needed for complex queries.
- Gateways handle WS connection events and delegate to services for data operations.

## TypeScript Strict Mode

`tsconfig.json` must include:
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

## Input Validation

Use `class-validator` + `class-transformer` on all REST DTOs with NestJS `ValidationPipe` globally.

```typescript
// Example DTO
class CreateMatchDto {
  @IsUUID()
  game_id: string;

  @IsInt()
  @Min(1)
  score: number;
}
```

Global pipe in `main.ts`:
```typescript
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
}));
```

## Linter (Biome)

Configure [Biome](https://biomejs.dev/) with recommended rules. Zero errors on `bun run lint`.

This project uses **Biome instead of ESLint** - an intentional deviation documented in `README.md`. Acceptance intent unchanged: lint must pass with zero errors.

Minimum config:
- Biome recommended rules
- `noFloatingPromises` (error)
- `noUnusedVariables` / `noUnusedFunctionParameters` (error; `_`-prefixed names ignored)
- `noExplicitAny` (warn)

## Structured Logging

Use NestJS built-in `Logger` or `nestjs-pino` for structured JSON output.

Every log entry must include:
- `timestamp` (ISO 8601)
- `level` (info, warn, error, debug)
- `message`
- `correlationId` (from request middleware, propagated through async context)
- `context` (module/class name)

Correlation ID flow:
1. `CorrelationIdMiddleware` reads `X-Request-ID` header or generates a UUID.
2. Stored in `AsyncLocalStorage` (or NestJS `ClsModule`).
3. All downstream logs and external calls include it.
4. WS connections get a correlation ID on connect, used for all messages on that socket.

## Error Handling

### REST
- Global `HttpExceptionFilter` catches all exceptions.
- Returns consistent JSON shape (see spec/02-api.md error format).
- Unhandled exceptions return 500 with generic message (no stack traces in production).

### WebSocket
- Gateway wraps all handlers in try-catch.
- Sends `{ "type": "error", "code": "...", "message": "..." }` to the client.
- Never closes the connection on a recoverable error.

### Infrastructure Failures
- Redis unavailable → log error, serve from Postgres (degraded), do not crash.
- Postgres unavailable → return 503 for write operations, WS connections stay alive.
- Catch all async errors in services - never let an unhandled rejection crash the process.

## Graceful Shutdown

In `main.ts`:

```typescript
app.enableShutdownHooks();
```

On `SIGTERM` / `SIGINT`:
1. Stop accepting new HTTP/WS connections.
2. Send WS close frames (code 1001) to all connected clients.
3. Wait for in-flight HTTP requests to complete (up to 10s timeout).
4. Close database connections (TypeORM `DataSource.destroy()`).
5. Close Redis connections.
6. Exit process.

## Testing Strategy

### Required (minimum for submission)

At least ONE of these:
1. **Score submit + broadcast**: Submit match via REST, verify WS client receives `leaderboard-update`.
2. **JWT validation**: Test token issuance, verification, expiry, refresh rotation.

### Strong Signal (demonstrates competence)

3. **Cross-instance fan-out**: Start two NestJS instances, submit on instance A, verify WS client on instance B receives the update. Uses Docker Compose test setup.

### Test Setup

- Use Jest with NestJS testing utilities (`@nestjs/testing`).
- Integration tests use testcontainers or Docker Compose test profile for Postgres + Redis.
- E2E tests hit actual HTTP/WS endpoints.
