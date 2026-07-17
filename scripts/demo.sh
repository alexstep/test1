#!/usr/bin/env bash
set -euo pipefail

echo "=== Leaderboard Smoke Test ==="
echo ""

echo "Building and starting services..."
docker compose up -d --build

echo "Waiting for services to be healthy..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:1111/health > /dev/null 2>&1; then
    echo "Services healthy after ~$((i * 2))s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "FAIL: Services did not become healthy within 60s"
    docker compose logs --tail=50
    docker compose down
    exit 1
  fi
  sleep 2
done

echo ""
echo "Running smoke tests..."
bun scripts/smoke.mjs
RESULT=$?

if [ $RESULT -eq 0 ]; then
  echo ""
  echo "=== PASS ==="
else
  echo ""
  echo "=== FAIL ==="
fi

exit $RESULT
