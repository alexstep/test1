/** Markdown rendered by Scalar (/docs) via OpenAPI `info.description`. */
export const OPENAPI_CLIENT_SDK_DOCS = `
## Client SDK (browser)

A ready-to-use JavaScript SDK is served from the same origin as the API. It hides REST calls,
JWT lifecycle, and WebSocket transport behind a single class, and multiplexes traffic from all
browser tabs through one **SharedWorker** so there is exactly one WebSocket per \`(clientId, gameId)\`
even when the app is open in several tabs.

### Include

\`\`\`html
<script src="/client-sdk.js"></script>
\`\`\`

The script exposes \`window.LeaderboardClient\`. The SharedWorker (\`/client-sdk.worker.js\`) is
loaded lazily on the first RPC and terminates automatically when the last tab detaches.

Browsers without SharedWorker (older Safari) transparently fall back to a per-tab dedicated
Worker with the same API surface - only the cross-tab sharing is lost.

### Construct

\`\`\`javascript
const client = new LeaderboardClient({
  clientId: 'a',              // per-session label; scopes cookie + WS pool
  wsUrl: 'ws://localhost'     // WS origin (no path; SDK appends /ws/leaderboard/:gameId)
});
\`\`\`

Multiple \`LeaderboardClient\` instances with the same \`clientId\` share one session and one
WebSocket. Use different \`clientId\` values (e.g. \`a\`, \`b\`) for independent sessions in the
same browser.

### Auth model

- **Plaintext never leaves the page.** The SDK applies a domain-separated SHA-256 prehash
  (\`leaderboard-v1:email:password\`) in the tab before handing it to the worker. The digest is
  still password-equivalent for this API; TLS remains required (see *Password transmission*).
- **Access token lives in worker memory only** and is attached as \`Authorization: Bearer\` on
  every REST call.
- **Refresh token lives in an HttpOnly \`refresh_token_<clientId>\` cookie** scoped to
  \`/api/v1/auth\`. Neither the page nor the worker can read it; the browser sends it
  automatically on \`POST /api/v1/auth/refresh\`.
- The SDK refreshes access tokens 30 seconds before expiry with a **single-flight lock** per
  \`clientId\`, so concurrent RPCs never trigger duplicate refresh calls.

The worker sets \`X-Session-Id: <clientId>\` on every login/refresh so the server picks the
correct cookie.

### RPC methods

All methods return \`Promise<Result>\`. \`Result\` shape mirrors the underlying REST response
(\`{ ok, status, data, ... }\`). RPC calls time out after 15 seconds by default.

| Method | Description |
|--------|-------------|
| \`signup(email, password)\` | \`POST /auth/signup\` (SDK hashes password) |
| \`login(email, password)\` | \`POST /auth/login\`; server sets the refresh cookie |
| \`listGames()\` | \`GET /games\` |
| \`createGame(name)\` | \`POST /games\` (rejects empty name) |
| \`submitMatch(gameId, score)\` | \`POST /matches\` (page generates \`Idempotency-Key\`; \`score\` must be a non-negative integer) |
| \`joinLeaderboard(gameId, { signal? })\` | Open (or reuse) WS; \`AbortSignal\` cancels join and best-effort leaves |
| \`leaveLeaderboard(gameId, { signal? })\` | Unsubscribe this tab; closes WS when the last subscriber leaves |
| \`getState()\` | Snapshot of current session, WS statuses, and cached leaderboards - useful on tab load |

The page↔worker wire format includes \`protocolVersion: 1\` on every message. A mismatched
facade/worker pair fails RPCs with \`SDK protocol mismatch\` instead of failing silently.

### Events

\`LeaderboardClient\` extends \`EventTarget\`. Payloads arrive as \`CustomEvent.detail\`.

| Event | \`detail\` shape |
|-------|----------------|
| \`auth-changed\` | \`{ session: { accessToken, expiresAt, email } \\| null }\` |
| \`ws-status\` | \`{ gameId, status: 'connecting' \\| 'connected' \\| 'authenticated' \\| 'reconnecting' \\| 'disconnected' \\| 'auth-failed' \\| 'error', wsUrl, code?, reason?, attempt?, nextRetryMs? }\` |
| \`leaderboard-snapshot\` | \`{ gameId, entries, current_event_id }\` |
| \`leaderboard-update\` | \`{ gameId, player_id, email, new_score, new_rank, previous_rank, event_id, idempotency_key? }\` |
| \`sdk-log\` | Structured log entry mirrored to the tab for pretty console output |

\`\`\`javascript
client.addEventListener('leaderboard-update', (evt) => {
  const { player_id, new_rank, new_score, event_id } = evt.detail;
  // dedupe by event_id (at-least-once delivery)
});
\`\`\`

### Reconnect & resume

On unexpected socket close (network drop, laptop sleep, api replica restart) the worker
reconnects with exponential backoff \`1s → 2s → 5s → 10s → 30s\` (plus jitter) and sends
\`?last_event_id=<id>\` from the last observed \`event_id\` / \`current_event_id\`. The server
either replays missed updates from the Redis Stream or responds with a fresh snapshot.
\`ws-status\` events surface the retry attempt so the UI can indicate reconnection.

Auth failure close codes (\`4001\`, \`4003\`, \`4004\`) suppress reconnect; the SDK emits
\`ws-status: 'auth-failed'\` and refreshes the token before the next \`joinLeaderboard\` call.

### End of life

- \`beforeunload\` rejects in-flight page RPCs with \`transport closed\` so late worker replies
  cannot resolve after the tab is going away.
- \`pagehide\` with \`event.persisted === false\` (real navigation / close) sends \`detach\` to the
  worker and stops heartbeats. When \`persisted === true\` (bfcache) the SDK only pauses
  heartbeats and does **not** detach, so a restored tab can resume.
- \`pageshow\` with \`persisted\` restarts heartbeats and re-registers \`clientId\`s on the port.
- The worker also tracks per-port heartbeats (~10s ping / 30s stale) so a crashed tab does not
  keep the WS alive forever.
`.trim();
