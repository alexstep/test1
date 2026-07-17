/* eslint-disable no-restricted-globals */
/**
 * Leaderboard Client SDK - SharedWorker transport layer.
 *
 * Owns:
 * - REST calls (fetch with same-origin cookies for the HttpOnly refresh token).
 * - Access-token lifecycle: single-flight refresh 30s before expiry.
 * - WebSocket lifecycle: one socket per `(clientId, gameId)`, refcounted by subscribed ports,
 *   with automatic reconnect (exponential backoff + jitter) and stream resume via `last_event_id`.
 * - Port lifecycle: heartbeat + `detach` message; stale ports are reaped after 30s of silence.
 *
 * The refresh token itself never enters this scope: the browser attaches an HttpOnly
 * `refresh_token_<clientId>` cookie to `/api/v1/auth/refresh` automatically. The worker only
 * needs to send `X-Session-Id: <clientId>` and `credentials: 'include'`.
 */

/**
 * @typedef {Object} Session
 * @property {string|null} accessToken
 * @property {number} expiresAt Unix ms.
 * @property {string|null} email
 * @property {number} lastUsed Unix ms; touched on any access.
 */

/**
 * @typedef {Object} WsConn
 * @property {WebSocket|null} ws
 * @property {string} wsUrl
 * @property {string} gameId
 * @property {string} clientId
 * @property {Set<MessagePort>} ports
 * @property {{entries: unknown[], current_event_id: string}|null} lastSnapshot
 * @property {string|null} lastEventId
 * @property {boolean} authed
 * @property {boolean} closedByClient
 * @property {boolean} connecting Guard against overlapping `openSocket` calls for the same conn.
 * @property {number} reconnectAttempt
 * @property {ReturnType<typeof setTimeout>|null} reconnectTimer
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

/** @type {Map<MessagePort, { clientIds: Set<string>, lastSeen: number }>} */
const ports = new Map();

/** @type {Map<string, WsConn>} */
const wsConnections = new Map();

/** @type {Map<string, Promise<string>>} single-flight lock per clientId */
const refreshPromises = new Map();

/** @type {Map<string, Promise<unknown>>} in-flight submitMatch keyed by Idempotency-Key */
const pendingMatches = new Map();

const WS_CLOSE_REASONS = {
  4000: 'Invalid last_event_id',
  4001: 'Authentication required',
  4003: 'Token expired or invalid',
  4004: 'Game not found',
  1000: 'Normal closure',
  1001: 'Server shutting down',
};

/** Close codes that mean "do not reconnect" (auth/game errors). */
const AUTH_FAIL_CODES = new Set([4001, 4003, 4004]);
/** Port is considered dead if no heartbeat for this long. */
const HEARTBEAT_STALE_MS = 30_000;
/** Refresh the access token this many ms before JWT expiry. */
const REFRESH_LEAD_MS = 30_000;
/** Fallback access-token TTL (seconds) when the server omits `expires_in`. */
const DEFAULT_EXPIRES_IN_S = 900;
/** Exponential reconnect delays (ms); last value is the cap. */
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Idle timeout after which an unreferenced session is GC'd from memory. */
const SESSION_IDLE_MS = 30 * 60_000;
/** Abort a hung submitMatch fetch so `pendingMatches` cannot leak forever. */
const SUBMIT_MATCH_TIMEOUT_MS = 30_000;
/** Must stay in sync with `PROTOCOL_VERSION` in `client-sdk.js`. */
const PROTOCOL_VERSION = 1;

/**
 * Outbound event types posted to page ports.
 * Values must stay in sync with listeners in `client-sdk.js`.
 */
const BroadcastType = Object.freeze({
  AUTH_CHANGED: 'auth-changed',
  WS_STATUS: 'ws-status',
  LEADERBOARD_SNAPSHOT: 'leaderboard-snapshot',
  LEADERBOARD_UPDATE: 'leaderboard-update',
  SDK_LOG: 'sdk-log',
});

function wsKey(clientId, gameId) {
  return `${clientId}:${gameId}`;
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

function safePost(port, msg) {
  try {
    port.postMessage({ ...msg, protocolVersion: PROTOCOL_VERSION });
  } catch {
    /* dead port; reaped by heartbeat */
  }
}

/**
 * @param {unknown} data
 * @returns {boolean}
 */
function protocolOk(data) {
  return (
    data &&
    typeof data === 'object' &&
    /** @type {{ protocolVersion?: unknown }} */ (data).protocolVersion === PROTOCOL_VERSION
  );
}

/**
 * @param {unknown} got
 */
function protocolMismatchError(got) {
  return `SDK protocol mismatch: expected ${PROTOCOL_VERSION}, got ${got}`;
}

/** @returns {Session} */
function getSession(clientId) {
  let s = sessions.get(clientId);
  if (!s) {
    s = { accessToken: null, expiresAt: 0, email: null, lastUsed: Date.now() };
    sessions.set(clientId, s);
  } else {
    s.lastUsed = Date.now();
  }
  return s;
}

/** @returns {{ accessToken: string|null, expiresAt: number, email: string|null }|null} */
function sessionSnapshot(session) {
  if (!session?.accessToken) return null;
  return {
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
    email: session.email,
  };
}

function clearSession(clientId) {
  sessions.delete(clientId);
}

/**
 * Apply tokens from an auth/refresh response and notify ports.
 * @param {string} clientId
 * @param {{ access_token: string, expires_in?: number }} data
 * @param {string|null} [email]
 */
function applySession(clientId, data, email) {
  const session = getSession(clientId);
  session.accessToken = data.access_token;
  session.expiresAt = Date.now() + (data.expires_in || DEFAULT_EXPIRES_IN_S) * 1000;
  if (email !== undefined) session.email = email;
  broadcast(clientId, BroadcastType.AUTH_CHANGED, { session: sessionSnapshot(session) });
  return session;
}

function* connectionsFor(clientId) {
  for (const conn of wsConnections.values()) {
    if (conn.clientId === clientId) yield conn;
  }
}

function portsForClient(clientId) {
  const result = [];
  for (const [port, meta] of ports) {
    if (meta.clientIds.has(clientId)) result.push(port);
  }
  return result;
}

/**
 * Fan-out to all ports registered for `clientId` (auth / sdk-log).
 * @param {string} clientId
 * @param {string} type
 * @param {Record<string, unknown>} [payload]
 */
function broadcast(clientId, type, payload) {
  const msg = { type, clientId, ...payload };
  for (const port of portsForClient(clientId)) {
    safePost(port, msg);
  }
}

/**
 * Fan-out to ports subscribed to this connection (ws-status / leaderboard events).
 * @param {WsConn} conn
 * @param {string} type
 * @param {Record<string, unknown>} [payload]
 */
function broadcastToConn(conn, type, payload) {
  const msg = { type, clientId: conn.clientId, gameId: conn.gameId, ...payload };
  for (const port of conn.ports) {
    safePost(port, msg);
  }
}

function log(clientId, level, message, data) {
  broadcast(clientId, BroadcastType.SDK_LOG, { level, message, data });
}

function emitWsStatus(conn, status, extra) {
  broadcastToConn(conn, BroadcastType.WS_STATUS, {
    status,
    wsUrl: conn.wsUrl,
    ...extra,
  });
}

function markAuthed(conn) {
  conn.authed = true;
  conn.reconnectAttempt = 0;
  emitWsStatus(conn, 'authenticated', { readyState: conn.ws?.readyState ?? WebSocket.OPEN });
}

/**
 * Same-origin fetch with `credentials: 'include'` so the browser attaches the
 * HttpOnly `refresh_token_<clientId>` cookie to /auth/refresh automatically.
 * `X-Session-Id` scopes that cookie per logical client.
 * @param {AbortSignal} [signal] Optional abort signal (e.g. submitMatch timeout).
 */
async function api(method, path, body, clientId, extraHeaders, signal) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Session-Id': clientId,
    ...extraHeaders,
  };
  const session = getSession(clientId);
  if (session.accessToken) {
    headers.Authorization = `Bearer ${session.accessToken}`;
  }
  const opts = { method, headers, credentials: 'include' };
  if (signal) opts.signal = signal;
  if (body !== undefined && body !== null) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, ok: res.ok };
}

/**
 * Returns a valid access token, refreshing via cookie when close to expiry.
 * Concurrent callers share one refresh request (single-flight lock).
 */
async function ensureToken(clientId) {
  const session = getSession(clientId);
  if (session.accessToken && Date.now() < session.expiresAt - REFRESH_LEAD_MS) {
    return session.accessToken;
  }

  const inflight = refreshPromises.get(clientId);
  if (inflight) return inflight;

  const promise = (async () => {
    if (!session.accessToken && session.expiresAt === 0) {
      log(clientId, 'info', 'Attempting refresh via cookie (no in-memory access token)');
    } else {
      log(clientId, 'info', 'Refreshing access token');
    }

    const res = await api('POST', '/api/v1/auth/refresh', {}, clientId);
    if (!res.ok) {
      clearSession(clientId);
      broadcast(clientId, BroadcastType.AUTH_CHANGED, { session: null });
      log(clientId, 'error', 'Token refresh failed', res.data);
      throw new Error(
        res.data && typeof res.data === 'object' && 'message' in res.data
          ? String(res.data.message)
          : 'Token refresh failed',
      );
    }
    applySession(clientId, res.data);
    return getSession(clientId).accessToken;
  })().finally(() => {
    refreshPromises.delete(clientId);
  });

  refreshPromises.set(clientId, promise);
  return promise;
}

function getWsStatus(clientId) {
  const statuses = [];
  for (const conn of connectionsFor(clientId)) {
    statuses.push({
      gameId: conn.gameId,
      wsUrl: conn.wsUrl,
      authed: conn.authed,
      readyState: conn.ws?.readyState ?? WebSocket.CLOSED,
      reconnectAttempt: conn.reconnectAttempt,
    });
  }
  return statuses;
}

function cleanupStale() {
  const now = Date.now();
  for (const [port, meta] of ports) {
    if (now - meta.lastSeen > HEARTBEAT_STALE_MS) {
      detachPort(port);
    }
  }
  // Drop sessions that no port references and that haven't been touched for SESSION_IDLE_MS.
  // Prevents unbounded `sessions` growth for tabs that were closed without a clean detach.
  // Skip clients with an in-flight refresh so `applySession` cannot resurrect a just-deleted entry.
  for (const [clientId, session] of sessions) {
    if (now - session.lastUsed <= SESSION_IDLE_MS) continue;
    if (portsForClient(clientId).length > 0) continue;
    if (refreshPromises.has(clientId)) continue;
    sessions.delete(clientId);
  }
}

function dropConnection(conn) {
  destroyConnection(conn);
  wsConnections.delete(wsKey(conn.clientId, conn.gameId));
}

function detachPort(port) {
  const meta = ports.get(port);
  if (!meta) return;
  ports.delete(port);

  for (const conn of [...wsConnections.values()]) {
    if (!conn.ports.has(port)) continue;
    conn.ports.delete(port);
    if (conn.ports.size === 0) {
      dropConnection(conn);
    }
  }

  try {
    port.close();
  } catch {
    /* ignore */
  }
}

function attachPort(port) {
  port.onmessage = (evt) => {
    void handlePortMessage(port, evt.data);
  };
  port.onmessageerror = () => {
    detachPort(port);
  };
  port.start?.();
}

async function handlePortMessage(port, data) {
  if (!data || typeof data !== 'object') return;

  if (!protocolOk(data)) {
    const got = /** @type {{ protocolVersion?: unknown, type?: unknown, id?: unknown }} */ (data)
      .protocolVersion;
    const err = protocolMismatchError(got);
    if (data.type === 'rpc' && data.id != null) {
      safePost(port, { type: 'rpc-response', id: data.id, ok: false, error: err });
    } else if (data.clientId) {
      safePost(port, {
        type: BroadcastType.SDK_LOG,
        clientId: data.clientId,
        level: 'warn',
        message: err,
        data: { type: data.type, protocolVersion: got },
      });
    }
    return;
  }

  if (data.type === 'ping') {
    const meta = ports.get(port);
    if (meta) meta.lastSeen = Date.now();
    safePost(port, { type: 'pong' });
    return;
  }

  if (data.type === 'detach') {
    detachPort(port);
    return;
  }

  if (data.type === 'register') {
    let meta = ports.get(port);
    if (!meta) {
      meta = { clientIds: new Set(), lastSeen: Date.now() };
      ports.set(port, meta);
    }
    meta.clientIds.add(data.clientId);
    meta.lastSeen = Date.now();
    return;
  }

  if (data.type === 'rpc') {
    const { id, clientId, method, params } = data;
    const meta = ports.get(port);
    // A port may only speak for clientIds it explicitly registered - stops one tab from
    // impersonating another logical client that happens to share this worker.
    if (!meta || !meta.clientIds.has(clientId)) {
      safePost(port, {
        type: 'rpc-response',
        id,
        ok: false,
        error: `Port not registered for clientId "${clientId}"`,
      });
      return;
    }
    meta.lastSeen = Date.now();

    try {
      const result = await handleRpc(clientId, method, params || {}, port);
      safePost(port, { type: 'rpc-response', id, ok: true, result });
    } catch (err) {
      safePost(port, {
        type: 'rpc-response',
        id,
        ok: false,
        error: errMsg(err),
      });
    }
  }
}

const rpcHandlers = {
  signup: rpcSignup,
  login: rpcLogin,
  logout: rpcLogout,
  listGames: rpcListGames,
  createGame: rpcCreateGame,
  submitMatch: rpcSubmitMatch,
  joinLeaderboard: rpcJoinLeaderboard,
  leaveLeaderboard: rpcLeaveLeaderboard,
  getState: rpcGetState,
};

async function handleRpc(clientId, method, params, port) {
  const handler = rpcHandlers[method];
  if (!handler) throw new Error(`Unknown method: ${method}`);
  return handler(clientId, params, port);
}

async function rpcSignup(clientId, { email, passwordPrehash }) {
  return api('POST', '/api/v1/auth/signup', { email, password: passwordPrehash }, clientId);
}

async function rpcLogin(clientId, { email, passwordPrehash }) {
  const res = await api('POST', '/api/v1/auth/login', { email, password: passwordPrehash }, clientId);
  if (res.ok) {
    // Server also sets HttpOnly refresh_token_<clientId> cookie; refresh_token in body is ignored.
    applySession(clientId, res.data, email);
  }
  return {
    status: res.status,
    data: res.data && typeof res.data === 'object' ? { ...res.data, refresh_token: undefined } : res.data,
    ok: res.ok,
    session: sessionSnapshot(getSession(clientId)),
  };
}

function rpcLogout(clientId) {
  // Drops in-memory access token; the HttpOnly refresh cookie stays until the browser evicts it
  // or the next successful refresh rotates it. (No /logout endpoint on the server for the demo.)
  clearSession(clientId);
  for (const conn of [...connectionsFor(clientId)]) {
    dropConnection(conn);
  }
  broadcast(clientId, BroadcastType.AUTH_CHANGED, { session: null });
  return { ok: true };
}

async function rpcListGames(clientId) {
  await ensureToken(clientId);
  const res = await api('GET', '/api/v1/games', null, clientId);
  if (!res.ok) return { status: res.status, data: res.data, ok: false };
  const games = Array.isArray(res.data) ? res.data : (res.data.data || []);
  return { status: res.status, data: games, ok: true };
}

async function rpcCreateGame(clientId, { name }) {
  await ensureToken(clientId);
  return api('POST', '/api/v1/games', { name }, clientId);
}

async function rpcSubmitMatch(clientId, { gameId, score, idempotencyKey }) {
  // Fallback if a caller (e.g. an older facade) omits the key. Preferred path is
  // caller-supplied so a UI-level retry after RPC timeout reuses the same key.
  const key = idempotencyKey || crypto.randomUUID();

  // Coalesce concurrent submissions with the same key into a single fetch. Without this,
  // an RPC timeout on the page (default 15s) can trigger a retry while the original request
  // is still in-flight, doubling the load even though the server would dedupe eventually.
  const inflight = pendingMatches.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SUBMIT_MATCH_TIMEOUT_MS);
    try {
      await ensureToken(clientId);
      const res = await api(
        'POST',
        '/api/v1/matches',
        { game_id: gameId, score },
        clientId,
        { 'Idempotency-Key': key },
        ctrl.signal,
      );
      return { ...res, idempotencyKey: key };
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => {
    pendingMatches.delete(key);
  });

  pendingMatches.set(key, promise);
  return promise;
}

// ── WebSocket manager ───────────────────────────────────

function buildWsUrl(conn) {
  const base = `${conn.wsUrl}/ws/leaderboard/${conn.gameId}`;
  if (conn.lastEventId) {
    return `${base}?last_event_id=${encodeURIComponent(conn.lastEventId)}`;
  }
  return base;
}

function scheduleReconnect(conn) {
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  const idx = Math.min(conn.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1);
  const base = RECONNECT_BACKOFF_MS[idx];
  const jitter = Math.floor(base * (Math.random() * 0.5 - 0.25));
  const delay = Math.max(500, base + jitter);
  conn.reconnectAttempt += 1;

  emitWsStatus(conn, 'reconnecting', {
    attempt: conn.reconnectAttempt,
    nextRetryMs: delay,
  });

  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = null;
    if (conn.closedByClient || conn.ports.size === 0) return;
    void openSocket(conn);
  }, delay);
}

/**
 * Terminal transition: after this call the conn will not reconnect.
 * If a future public `reconnect()` API appears, split into `closeSocketOnly()`.
 * Leaves `conn.ws` set so the matching `onclose` passes the `conn.ws !== ws` guard
 * and can emit the final status; the handler clears the reference.
 */
function destroyConnection(conn) {
  conn.closedByClient = true;
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
  }
  try {
    conn.ws?.close();
  } catch {
    /* ignore */
  }
}

async function openSocket(conn) {
  // Belt-and-suspenders: `openSocket` is only reached from a fresh join or a reconnect timer,
  // but this guard makes overlapping calls a no-op if future refactors change entry points.
  if (conn.connecting) return;
  conn.connecting = true;

  let token;
  try {
    token = await ensureToken(conn.clientId);
  } catch (err) {
    conn.connecting = false;
    emitWsStatus(conn, 'auth-failed', { reason: errMsg(err) });
    // Refresh failed → nothing to reconnect to. UI needs to trigger login again.
    wsConnections.delete(wsKey(conn.clientId, conn.gameId));
    return;
  }

  if (conn.closedByClient || conn.ports.size === 0) {
    conn.connecting = false;
    return;
  }

  const url = buildWsUrl(conn);
  const ws = new WebSocket(url);
  conn.ws = ws;
  conn.authed = false;

  emitWsStatus(conn, 'connecting', {
    readyState: ws.CONNECTING,
    attempt: conn.reconnectAttempt,
  });

  ws.onopen = () => {
    if (conn.ws !== ws) return;
    conn.connecting = false;
    try {
      ws.send(JSON.stringify({ type: 'auth', token }));
    } catch {
      /* onclose will fire */
    }
    emitWsStatus(conn, 'connected', { readyState: ws.OPEN });
  };

  ws.onmessage = (evt) => {
    // Ignore events from a superseded socket after reconnect/recreate.
    if (conn.ws !== ws) return;
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }

    if (msg.type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* ignore */
      }
      return;
    }

    if (msg.type === BroadcastType.LEADERBOARD_SNAPSHOT) {
      markAuthed(conn);
      conn.lastSnapshot = {
        entries: msg.entries,
        current_event_id: msg.current_event_id,
      };
      if (msg.current_event_id) conn.lastEventId = msg.current_event_id;
      broadcastToConn(conn, BroadcastType.LEADERBOARD_SNAPSHOT, {
        entries: msg.entries,
        current_event_id: msg.current_event_id,
      });
      return;
    }

    if (msg.type === BroadcastType.LEADERBOARD_UPDATE) {
      if (!conn.authed) markAuthed(conn);
      if (msg.event_id) conn.lastEventId = msg.event_id;
      broadcastToConn(conn, BroadcastType.LEADERBOARD_UPDATE, {
        player_id: msg.player_id,
        email: msg.email,
        new_score: msg.new_score,
        new_rank: msg.new_rank,
        previous_rank: msg.previous_rank,
        event_id: msg.event_id,
        idempotency_key: msg.idempotency_key,
      });
    }
  };

  ws.onclose = (evt) => {
    if (conn.ws !== ws) return;
    conn.ws = null;
    conn.connecting = false;
    const known = WS_CLOSE_REASONS[evt.code];
    const detail = evt.reason || known || '—';
    const authFailed = !conn.authed && AUTH_FAIL_CODES.has(evt.code);
    const key = wsKey(conn.clientId, conn.gameId);

    if (wsConnections.get(key) !== conn) {
      // Superseded (e.g. connection recreated); ignore.
      return;
    }

    if (conn.closedByClient || authFailed) {
      emitWsStatus(conn, authFailed ? 'auth-failed' : 'disconnected', {
        code: evt.code,
        reason: detail,
        readyState: WebSocket.CLOSED,
      });
      wsConnections.delete(key);
      return;
    }

    if (evt.code === 4000) {
      // Server rejected our last_event_id (buffer expired). Drop it and reconnect for a fresh snapshot.
      conn.lastEventId = null;
    }

    if (conn.ports.size === 0) {
      wsConnections.delete(key);
      return;
    }

    scheduleReconnect(conn);
  };

  ws.onerror = () => {
    if (conn.ws !== ws) return;
    emitWsStatus(conn, 'error', { readyState: ws.readyState });
  };
}

async function rpcJoinLeaderboard(clientId, { gameId, wsUrl }, port) {
  if (!gameId) throw new Error('gameId required');
  if (!wsUrl) throw new Error('wsUrl required');

  const key = wsKey(clientId, gameId);
  let conn = wsConnections.get(key);

  if (conn) {
    conn.ports.add(port);
    if (conn.lastSnapshot) {
      safePost(port, {
        type: BroadcastType.LEADERBOARD_SNAPSHOT,
        clientId,
        gameId: conn.gameId,
        ...conn.lastSnapshot,
      });
    }
    const status = conn.authed
      ? 'authenticated'
      : conn.reconnectTimer
        ? 'reconnecting'
        : 'connecting';
    emitWsStatus(conn, status, {
      readyState: conn.ws?.readyState ?? WebSocket.CONNECTING,
    });
    return { joined: true, existing: true };
  }

  conn = {
    ws: null,
    wsUrl,
    gameId,
    clientId,
    ports: new Set([port]),
    lastSnapshot: null,
    lastEventId: null,
    authed: false,
    closedByClient: false,
    connecting: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
  };
  wsConnections.set(key, conn);

  await openSocket(conn);
  return { joined: true, existing: false };
}

function rpcLeaveLeaderboard(clientId, { gameId }, port) {
  const key = wsKey(clientId, gameId);
  const conn = wsConnections.get(key);
  if (!conn) return { left: false };

  conn.ports.delete(port);

  if (conn.ports.size === 0) {
    dropConnection(conn);
    // Port already removed from conn.ports; notify it explicitly before the page moves on.
    safePost(port, {
      type: BroadcastType.WS_STATUS,
      clientId,
      gameId: conn.gameId,
      status: 'disconnected',
      wsUrl: conn.wsUrl,
      readyState: WebSocket.CLOSED,
    });
  }

  return { left: true };
}

function rpcGetState(clientId) {
  const session = getSession(clientId);
  const snapshots = {};
  for (const conn of connectionsFor(clientId)) {
    if (conn.lastSnapshot) snapshots[conn.gameId] = conn.lastSnapshot;
  }
  return {
    session: sessionSnapshot(session),
    ws: getWsStatus(clientId),
    snapshots,
  };
}

setInterval(cleanupStale, 10_000);

// SharedWorker (multi-tab) vs dedicated Worker (Safari fallback) share one attach path.
if (typeof self.onconnect !== 'undefined') {
  self.onconnect = (evt) => {
    const port = evt.ports[0];
    attachPort(port);
  };
} else {
  // Dedicated worker has no MessagePort - wrap `self` in a stable endpoint so `detachPort`
  // never calls `self.close()` (which would terminate the worker itself and hang the page).
  const endpoint = {
    postMessage: (msg) => self.postMessage(msg),
    start: () => {},
    close: () => {
      /* dedicated worker dies with its page; never self-terminate */
    },
  };
  self.onmessage = (evt) => {
    void handlePortMessage(endpoint, evt.data);
  };
}
