/** Markdown rendered by Scalar (/docs) via OpenAPI `info.description`. */
export const OPENAPI_WEBSOCKET_DOCS = `
## WebSocket

Real-time leaderboard updates over a raw JSON WebSocket (not Socket.IO).

### Connect

\`\`\`
WS /ws/leaderboard/{gameId}
WS /ws/leaderboard/{gameId}?last_event_id={streamId}
\`\`\`

| Param | Where | Required | Description |
|-------|--------|----------|-------------|
| \`gameId\` | path | yes | Game UUID |
| \`last_event_id\` | query | no | Redis Stream ID of the last processed \`leaderboard-update\` (e.g. \`1697000000000-0\`) for resume |

JWT is **not** accepted in the URL. Do not use \`?token=\`.

Local replicas (bypass Angie): \`ws://localhost:3001\` / \`ws://localhost:3002\`. Via proxy: \`ws://localhost\` (port 80).

### Authentication (first message)

Immediately after \`open\`, send (within **5 seconds**):

\`\`\`json
{ "type": "auth", "token": "<access_token jwt>" }
\`\`\`

Until auth succeeds the socket is not subscribed to the game room and receives no snapshot or updates.

### Browser example

\`\`\`javascript
const ws = new WebSocket(\`ws://localhost/ws/leaderboard/\${gameId}\`);

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'auth', token: accessToken }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
    return;
  }
  if (msg.type === 'leaderboard-snapshot') {
    // initial top-N + current_event_id
  }
  if (msg.type === 'leaderboard-update') {
    // live score change; dedupe by event_id
  }
};
\`\`\`

### Server → client messages

**Snapshot** - after successful auth (or when resume buffer has a gap):

\`\`\`json
{
  "type": "leaderboard-snapshot",
  "game_id": "uuid",
  "entries": [
    { "rank": 1, "player_id": "uuid", "email": "top@example.com", "score": 15000 }
  ],
  "current_event_id": "1697000000000-0",
  "timestamp": "2026-07-15T10:00:00Z"
}
\`\`\`

Store \`current_event_id\` (and later \`event_id\` values) for reconnect resume.

**Update** - on score change, and on resume replay:

\`\`\`json
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
\`\`\`

\`idempotency_key\` is present only when the match was submitted with an \`Idempotency-Key\` header.

**Heartbeat ping** (every 30s):

\`\`\`json
{ "type": "ping", "timestamp": "2026-07-15T10:06:00Z" }
\`\`\`

Reply with \`{ "type": "pong" }\` within **10 seconds**, or the server closes the connection.

### Client → server messages

| Message | When |
|---------|------|
| \`{ "type": "auth", "token": "<jwt>" }\` | First message after open (required) |
| \`{ "type": "pong" }\` | Reply to each server \`ping\` |

### Resume after reconnect

1. Keep the last seen \`event_id\` / \`current_event_id\`.
2. Reconnect: \`WS /ws/leaderboard/{gameId}?last_event_id={id}\`.
3. Send auth again.
4. If the server buffer still covers the gap → missed \`leaderboard-update\` messages are replayed. Otherwise → full \`leaderboard-snapshot\`.
5. Delivery is at-least-once; **dedupe by \`event_id\`**.

Invalid \`last_event_id\` format → close code \`4000\`.

### Close codes

| Code | Meaning |
|------|---------|
| \`4000\` | Invalid \`last_event_id\` |
| \`4001\` | Auth missing, timeout (5s), or first message is not valid auth |
| \`4003\` | JWT expired or invalid |
| \`4004\` | Game not found |
| \`1000\` | Normal closure / heartbeat timeout |
| \`1001\` | Server shutting down |
| \`1011\` | Internal server error |

### Notes

- Access token expiry mid-session does **not** force disconnect; reconnect with a refreshed token.
- Cross-instance fan-out uses Redis pub/sub - clients on any replica receive the same updates.
`.trim();
