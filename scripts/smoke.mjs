#!/usr/bin/env node

/**
 * Smoke test for the leaderboard service.
 * Run: bun scripts/smoke.mjs
 * Expects: docker compose stack running (api-1:3001, api-2:3002, angie:1111)
 */

import { createHash, randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://localhost:1111';
const API1 = process.env.API1_URL || 'http://localhost:3001';
const API2 = process.env.API2_URL || 'http://localhost:3002';
const WS2 = process.env.WS2_URL || 'ws://localhost:3002';
const METRICS_TOKEN =
  process.env.METRICS_TOKEN || 'change-this-metrics-token';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function hashPasswordPrehash(plaintext, email) {
  const material = `leaderboard-v1:${email.trim().toLowerCase()}:${plaintext}`;
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

async function http(method, url, body, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function wsConnect(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WS connect timeout'));
    }, 5000);
    ws.addEventListener('open', () => {
      if (token) {
        ws.send(JSON.stringify({ type: 'auth', token }));
      }
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.addEventListener('error', () => {
      // wait for close event
    });
    ws.addEventListener('close', (event) => {
      clearTimeout(timeout);
      reject(
        Object.assign(new Error(`WS closed during connect: ${event.code}`), {
          code: event.code,
        }),
      );
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('WS message timeout')),
      timeoutMs,
    );
    const handler = (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === 'string' ? event.data : event.data.toString(),
        );
        if (predicate(msg)) {
          clearTimeout(timeout);
          ws.removeEventListener('message', handler);
          resolve(msg);
        }
      } catch {
        // ignore parse errors
      }
    };
    ws.addEventListener('message', handler);
  });
}

/**
 * @param {string} url
 * @param {number} expectedCode
 * @param {{ authToken?: string | null, waitMs?: number }} [opts]
 *   - authToken undefined: do not send auth (expect timeout → 4001)
 *   - authToken string: send `{ type: "auth", token }` on open
 */
function expectWSClose(url, expectedCode, opts = {}) {
  const { authToken, waitMs = 6000 } = opts;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(`Timeout waiting for close code ${expectedCode}`),
      );
    }, waitMs);
    ws.addEventListener('open', () => {
      if (authToken !== undefined && authToken !== null) {
        ws.send(JSON.stringify({ type: 'auth', token: authToken }));
      }
    });
    ws.addEventListener('close', (event) => {
      clearTimeout(timeout);
      resolve(event.code);
    });
    ws.addEventListener('error', () => {
      // wait for close
    });
  });
}

async function main() {
  const email = `smoke-${Date.now()}@test.com`;
  const password = hashPasswordPrehash('smokeTest123', email);

  console.log('\n━━━ 1. Signup + Login (via Angie :1111) ━━━');
  const signup = await http('POST', `${BASE}/api/v1/auth/signup`, {
    email,
    password,
  });
  assert(signup.status === 201, `Signup: ${signup.status}`);

  const login = await http('POST', `${BASE}/api/v1/auth/login`, {
    email,
    password,
  });
  assert(login.status === 200, `Login: ${login.status}`);
  assert(!!login.data.access_token, 'Got access_token');
  const token = login.data.access_token;

  console.log('\n━━━ 2. Create game ━━━');
  const gameName = `SmokeGame-${Date.now()}`;
  const game = await http(
    'POST',
    `${BASE}/api/v1/games`,
    { name: gameName },
    { Authorization: `Bearer ${token}` },
  );
  assert(game.status === 201, `Create game: ${game.status}`);
  const gameId = game.data.id;
  assert(!!gameId, `Got game ID: ${gameId}`);

  console.log('\n━━━ 3. WebSocket cross-instance fan-out ━━━');
  const ws = await wsConnect(`${WS2}/ws/leaderboard/${gameId}`, token);
  const snapshot = await waitForMessage(
    ws,
    (m) => m.type === 'leaderboard-snapshot',
  );
  assert(
    snapshot.type === 'leaderboard-snapshot',
    'Got leaderboard-snapshot on connect',
  );

  const updatePromise = waitForMessage(
    ws,
    (m) => m.type === 'leaderboard-update',
    2000,
  );
  const matchRes = await http(
    'POST',
    `${API1}/api/v1/matches`,
    { game_id: gameId, score: 100 },
    {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': randomUUID(),
    },
  );
  assert(matchRes.status === 201, `POST /matches on api-1: ${matchRes.status}`);

  try {
    const update = await updatePromise;
    assert(
      update.type === 'leaderboard-update',
      'Got leaderboard-update via WS on api-2 within 2s',
    );
    assert(update.new_score === 100, `Score = ${update.new_score}`);
  } catch {
    assert(false, 'leaderboard-update NOT received within 2s');
  }
  ws.close();

  console.log('\n━━━ 4. Negative WS tests ━━━');
  const noTokenCode = await expectWSClose(
    `${WS2}/ws/leaderboard/${gameId}`,
    4001,
  );
  assert(
    noTokenCode === 4001,
    `No auth message → close code ${noTokenCode} (expected 4001)`,
  );

  const badTokenCode = await expectWSClose(
    `${WS2}/ws/leaderboard/${gameId}`,
    4003,
    { authToken: 'invalid-jwt' },
  );
  assert(
    badTokenCode === 4003,
    `Bad token → close code ${badTokenCode} (expected 4003)`,
  );

  console.log('\n━━━ 5. Metrics ━━━');
  const noAuth = await http('GET', `${API1}/metrics`);
  assert(noAuth.status === 401, `Metrics without token: ${noAuth.status}`);

  const withAuth = await http('GET', `${API1}/metrics`, null, {
    Authorization: `Bearer ${METRICS_TOKEN}`,
  });
  assert(withAuth.status === 200, `Metrics with token: ${withAuth.status}`);
  assert(
    typeof withAuth.data === 'string' &&
      withAuth.data.includes('matches_submitted_total'),
    'Metrics contain matches_submitted_total',
  );

  console.log(
    `\n━━━ Results: ${passed} passed, ${failed} failed ━━━`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
