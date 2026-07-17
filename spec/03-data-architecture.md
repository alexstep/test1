# 03 - Data Architecture

## PostgreSQL Schema

All tables use UUID primary keys and timestamp columns. Managed via TypeORM migrations (no raw SQL, no `synchronize: true` in production).

### Table: `users`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK, default `uuidv7()` |
| `email` | VARCHAR(255) | UNIQUE, NOT NULL |
| `password_hash` | VARCHAR(255) | NOT NULL |
| `created_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() |
| `updated_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() |

Index: unique on `email`.

### Table: `refresh_tokens`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK, default `uuidv7()` |
| `user_id` | UUID | FK → `users.id`, NOT NULL |
| `token_hash` | VARCHAR(255) | NOT NULL |
| `expires_at` | TIMESTAMP WITH TIME ZONE | NOT NULL |
| `revoked` | BOOLEAN | DEFAULT FALSE |
| `created_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() |

Index: on `user_id`; on `token_hash`.

### Table: `games`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK, default `uuidv7()` |
| `name` | VARCHAR(100) | UNIQUE, NOT NULL |
| `description` | VARCHAR(500) | NULLABLE |
| `created_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() |

Index: unique on `name`.

### Table: `matches`

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PK, default `uuidv7()` |
| `player_id` | UUID | FK → `users.id`, NOT NULL |
| `game_id` | UUID | FK → `games.id`, NOT NULL |
| `score` | INTEGER | NOT NULL, CHECK > 0 |
| `idempotency_key` | VARCHAR(255) | NULL - client `Idempotency-Key` header |
| `created_at` | TIMESTAMP WITH TIME ZONE | DEFAULT NOW() |

Indexes: on `(game_id, player_id)`; on `(game_id, created_at)`; unique partial `(player_id, idempotency_key) WHERE idempotency_key IS NOT NULL`.

### Entity Relationships

```
users 1──N matches
games 1──N matches
users 1──N refresh_tokens
```

### Migrations

- TypeORM CLI generates migration files in `src/migrations/`.
- Migrations run automatically on app startup (`migrationsRun: true` in TypeORM config) OR via `npm run migration:run` (document both options).
- Never use `synchronize: true` outside local development.
- Each migration is idempotent and includes both `up` and `down`.

---

## Redis Data Structures

### Sorted Sets - Leaderboard Rankings

**Key pattern:** `leaderboard:{gameId}`

- Member: `player_id` (string UUID)
- Score: cumulative score (float64 in Redis)

**Operations:**
| Action | Redis Command |
|--------|--------------|
| Add/update score on match submit | `ZINCRBY leaderboard:{gameId} {score} {playerId}` |
| Get top-N | `ZREVRANGE leaderboard:{gameId} {offset} {offset+limit-1} WITHSCORES` |
| Get total players | `ZCARD leaderboard:{gameId}` |
| Get player rank (0-based, highest first) | `ZREVRANK leaderboard:{gameId} {playerId}` |
| Get player score | `ZSCORE leaderboard:{gameId} {playerId}` |

Ranks returned to clients are 1-based (add 1 to Redis 0-based result).

### Pub/Sub - Cross-Instance Fan-Out

**Channel pattern:** `leaderboard-updates:{gameId}`

**Published message (JSON string):**
```json
{
  "type": "leaderboard-update",
  "game_id": "uuid",
  "player_id": "uuid",
  "email": "player@example.com",
  "new_score": 6500,
  "new_rank": 5,
  "previous_rank": 8,
  "delta_score": 1500,
  "event_id": "1697000000000-0",
  "idempotency_key": "optional-uuid",
  "timestamp": "2026-07-15T10:05:00Z"
}
```

Every API instance subscribes to channels for games that have active WS connections. On receiving a pub/sub message, the instance broadcasts to its local WS clients on that game channel.

### Streams - Event Replay Buffer

**Key pattern:** `leaderboard-events:{gameId}`

- Entry ID: Redis auto-generated (`ms-seq`)
- Field `payload`: JSON of the leaderboard-update (without `event_id`; ID comes from the stream entry)
- Bounded with `XADD … MAXLEN ~ 500` and `EXPIRE` 900s
- Resume: `XRANGE key (last_event_id +`

### Redis Client Separation

Use **two separate Redis connections**:
1. **Data client** - for Sorted Set commands (`ZINCRBY`, `ZREVRANGE`, etc.), Streams (`XADD`/`XRANGE` via `send()`), and general key-value operations.
2. **Subscriber client** - dedicated to `SUBSCRIBE`/`PSUBSCRIBE`. A subscribed Redis connection cannot issue other commands.

Optionally a third connection for publishing if the data client is under heavy load.

---

## Sync Model: Postgres ↔ Redis

### Write Path (match submission)

```
1. Validate input (controller layer)
2. BEGIN transaction
3. INSERT match INTO postgres (ON CONFLICT DO NOTHING if Idempotency-Key)
4. COMMIT transaction
5. If new insert (not replay):
   a. ZINCRBY leaderboard:{gameId} score playerId  (Redis)
   b. Read new rank: ZREVRANK + ZSCORE
   c. XADD leaderboard-events:{gameId} … → event_id
   d. PUBLISH leaderboard-updates:{gameId} {update payload}
```

If Redis steps fail after Postgres commit: log error; Redis will be rebuilt on next cache warm. Postgres is source of truth. Idempotent retries do not re-apply Redis side effects.

If step 3 (Postgres) fails: abort - do not update Redis.

### Read Path (leaderboard query)

```
1. ZREVRANGE leaderboard:{gameId} offset (offset+limit-1) WITHSCORES
2. If Redis returns empty and game exists: trigger cache rebuild from Postgres
3. Hydrate player emails from a lightweight cache or DB lookup
```

### Cache Rebuild (Redis warm-up)

On application startup or on-demand:

```sql
-- Per game, compute cumulative scores
SELECT player_id, SUM(score) as total_score
FROM matches
WHERE game_id = :gameId
GROUP BY player_id
```

For each row: `ZADD leaderboard:{gameId} {total_score} {playerId}`

This runs:
- On app startup for all games (or lazily on first request per game)
- When Redis is detected as empty for a game that has Postgres data
- Manually via an admin/internal endpoint if needed

### Consistency Guarantees

- **Eventual consistency**: Redis may briefly lag behind Postgres during failures.
- **No data loss**: Postgres is always written first. Redis can be fully rebuilt.
- **Redis failure is non-fatal**: App logs the error, continues serving from Postgres (degraded mode with higher latency).
