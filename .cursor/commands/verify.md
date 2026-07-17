# Verify

Run verification steps at the **project root** (NestJS Leaderboard service). Uses `--if-present` to skip missing scripts safely during scaffold phase.

## Modes

- **quick**: lint, test, build (fast feedback after implementation)
- **full**: typecheck, lint, test, build, docker compose config (before review hand-off)

## Commands

### quick
```bash
npm run --if-present lint || bun run --if-present lint
npm run --if-present test || bun run --if-present test
npm run --if-present build || bun run --if-present build
```

### full
```bash
npm run --if-present typecheck || bun run --if-present typecheck
npm run --if-present lint || bun run --if-present lint
npm run --if-present test || bun run --if-present test
npm run --if-present build || bun run --if-present build
docker compose config 2>/dev/null || docker-compose config 2>/dev/null || true
```

The `docker compose config` step validates the compose file when present; exits gracefully if no compose file exists yet.

## Output Format

```
PASS | FAIL
Failed steps: [list of step names that failed]
```

Example:
```
FAIL
Failed steps: lint, build
```
