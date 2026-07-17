/**
 * Leaderboard Client SDK - page facade over the SharedWorker transport.
 *
 * The refresh token lives in an HttpOnly `refresh_token_<clientId>` cookie set by the server on
 * login; it is never visible to this facade nor to the worker. The access token lives only in
 * worker memory and is refreshed automatically 30 seconds before expiry (single-flight per
 * clientId).
 *
 * Password plaintext is domain-separated SHA-256 hashed on the page before it reaches the worker
 * (log-safety / worker isolation). The resulting prehash is password-equivalent for this API -
 * TLS is still required. Server storage is argon2id(prehash), not the prehash itself.
 *
 * All multi-tab coordination happens in the worker; this file is a thin RPC + event-emitter layer.
 */

/**
 * @typedef {Object} SessionState
 * @property {string|null} accessToken JWT, memory only.
 * @property {number} expiresAt Unix ms.
 * @property {string|null} email
 */

/**
 * @typedef {'connecting'|'connected'|'authenticated'|'reconnecting'|'disconnected'|'auth-failed'|'error'} WsStatus
 */

/**
 * @typedef {Object} LeaderboardEntry
 * @property {number} rank
 * @property {string} player_id
 * @property {string} email
 * @property {number} score
 */

/** Must stay in sync with `PROTOCOL_VERSION` in `client-sdk.worker.js`. */
const PROTOCOL_VERSION = 1;
/** Bump when static SDK/worker assets change so browsers reload cached scripts. */
const SDK_ASSET_VERSION = 3;
const HEARTBEAT_MS = 10_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const MIN_PASSWORD_LEN = 8;

let rpcId = 0;
/** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>, onAbort?: () => void }>} */
const pendingRpc = new Map();

/** @type {MessagePort|null} */
let transportPort = null;
/** @type {Worker|null} */
let dedicatedWorker = null;
/** @type {Map<string, Set<LeaderboardClient>>} */
const clientsById = new Map();
/** @type {ReturnType<typeof setInterval>|null} */
let heartbeatTimer = null;
/** @type {Promise<MessagePort>|null} */
let transportInitPromise = null;

/** Coalesce burst `leaderboard-update` events: last wins per `(clientId, gameId, player_id)`. */
/** @type {Map<string, { clients: Set<LeaderboardClient>, detail: unknown }>} */
const pendingUpdateFlush = new Map();
let updateFlushScheduled = false;

/**
 * Domain-separated password prehash for this API.
 * SHA-256("leaderboard-v1:" + normalizeEmail(email) + ":" + password) → lowercase hex.
 * Runs on the page so plaintext never crosses to the worker; the digest is still a credential.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<string>}
 */
async function passwordPrehash(email, password) {
  const material = `leaderboard-v1:${email.trim().toLowerCase()}:${password}`;
  const data = new TextEncoder().encode(material);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * @param {string} name
 * @param {unknown} value
 */
function requireNonEmptyString(name, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

/**
 * @param {string} email
 * @param {string} password
 */
function requireCredentials(email, password) {
  requireNonEmptyString('email', email);
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    throw new TypeError(`password must be a string of at least ${MIN_PASSWORD_LEN} characters`);
  }
}

/** @param {unknown} signal */
function assertAbortSignal(signal) {
  if (signal != null && typeof signal !== 'object') {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (signal != null && typeof /** @type {{ aborted?: unknown }} */ (signal).aborted !== 'boolean') {
    throw new TypeError('signal must be an AbortSignal');
  }
}

function abortError() {
  try {
    return new DOMException('The operation was aborted.', 'AbortError');
  } catch {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
  }
}

/**
 * @param {string} reason
 */
function rejectAllPending(reason) {
  const err = new Error(reason);
  for (const [, pending] of pendingRpc) {
    clearTimeout(pending.timer);
    if (pending.onAbort) {
      try {
        pending.onAbort();
      } catch {
        /* ignore */
      }
    }
    pending.reject(err);
  }
  pendingRpc.clear();
}

function postToTransport(msg) {
  if (!transportPort) return;
  try {
    transportPort.postMessage({ ...msg, protocolVersion: PROTOCOL_VERSION });
  } catch {
    /* transport already gone */
  }
}

function hardDetachTransport() {
  rejectAllPending('transport closed');
  if (transportPort) {
    postToTransport({ type: 'detach' });
  }
  stopHeartbeat();
}

function reRegisterAllClients() {
  for (const clientId of clientsById.keys()) {
    postToTransport({ type: 'register', clientId });
  }
}

/**
 * @param {Set<LeaderboardClient>} clients
 * @param {string} eventType
 * @param {unknown} detail
 */
function dispatchToClients(clients, eventType, detail) {
  for (const client of clients) {
    client.dispatchEvent(new CustomEvent(eventType, { detail }));
  }
}

function flushPendingUpdates() {
  updateFlushScheduled = false;
  for (const [, entry] of pendingUpdateFlush) {
    dispatchToClients(entry.clients, 'leaderboard-update', entry.detail);
  }
  pendingUpdateFlush.clear();
}

/**
 * @param {string} clientId
 * @param {Set<LeaderboardClient>} clients
 * @param {unknown} detail
 */
function enqueueLeaderboardUpdate(clientId, clients, detail) {
  const gameId =
    detail && typeof detail === 'object' && 'gameId' in detail
      ? String(/** @type {{ gameId: unknown }} */ (detail).gameId)
      : '';
  const playerId =
    detail && typeof detail === 'object' && 'player_id' in detail
      ? String(/** @type {{ player_id: unknown }} */ (detail).player_id)
      : '';
  const key = `${clientId}:${gameId}:${playerId}`;
  pendingUpdateFlush.set(key, { clients, detail });
  if (!updateFlushScheduled) {
    updateFlushScheduled = true;
    queueMicrotask(flushPendingUpdates);
  }
}

/** @param {MessageEvent} evt */
function handleTransportMessage(evt) {
  const data = evt.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'rpc-response') {
    const pending = pendingRpc.get(data.id);
    if (!pending) return;
    pendingRpc.delete(data.id);
    clearTimeout(pending.timer);
    if (pending.onAbort) {
      try {
        pending.onAbort();
      } catch {
        /* ignore */
      }
    }
    if (data.ok) pending.resolve(data.result);
    else pending.reject(new Error(data.error || 'RPC failed'));
    return;
  }

  if (data.type === 'pong') return;

  const clientId = data.clientId;
  if (!clientId) return;

  const clients = clientsById.get(clientId);
  if (!clients) return;

  const eventType = data.type;
  if (
    eventType !== 'auth-changed' &&
    eventType !== 'ws-status' &&
    eventType !== 'leaderboard-snapshot' &&
    eventType !== 'leaderboard-update' &&
    eventType !== 'sdk-log'
  ) {
    return;
  }

  const detail = eventType === 'auth-changed' ? data.session : data;

  if (eventType === 'leaderboard-update') {
    enqueueLeaderboardUpdate(clientId, clients, detail);
    return;
  }

  dispatchToClients(clients, eventType, detail);
}

/**
 * Lazily create the shared transport. Prefers SharedWorker (one connection across all tabs of
 * this origin); falls back to a dedicated Worker on browsers where SharedWorker is unavailable
 * (e.g. Safari) - single-tab only, but same API.
 * @returns {Promise<MessagePort>}
 */
function ensureTransport() {
  if (transportPort) return Promise.resolve(transportPort);
  if (transportInitPromise) return transportInitPromise;

  transportInitPromise = new Promise((resolve, reject) => {
    try {
      if (typeof SharedWorker !== 'undefined') {
        const shared = new SharedWorker(`/client-sdk.worker.js?v=${SDK_ASSET_VERSION}`, {
          name: 'leaderboard-sdk',
        });
        transportPort = shared.port;
        transportPort.onmessage = handleTransportMessage;
        transportPort.start();
      } else {
        dedicatedWorker = new Worker(`/client-sdk.worker.js?v=${SDK_ASSET_VERSION}`);
        transportPort = /** @type {MessagePort} */ ({
          postMessage: (msg) => dedicatedWorker.postMessage(msg),
          start: () => {},
          close: () => dedicatedWorker.terminate(),
        });
        dedicatedWorker.onmessage = handleTransportMessage;
      }

      startHeartbeat();
      resolve(transportPort);
    } catch (err) {
      transportInitPromise = null;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  return transportInitPromise;
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (transportPort) {
      try {
        postToTransport({ type: 'ping' });
      } catch {
        /* transport gone; heartbeat will be cleaned up on page unload */
      }
    }
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Send an RPC request to the worker.
 * @param {string} clientId
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<unknown>}
 */
async function rpc(clientId, method, params, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const signal = options.signal;

  if (signal) {
    assertAbortSignal(signal);
    if (signal.aborted) return Promise.reject(abortError());
  }

  const port = await ensureTransport();
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const pending = pendingRpc.get(id);
      pendingRpc.delete(id);
      if (pending?.onAbort) {
        try {
          pending.onAbort();
        } catch {
          /* ignore */
        }
      }
      reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
    }, timeoutMs);

    /** @type {{ resolve: (v: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout>, onAbort?: () => void }} */
    const entry = { resolve, reject, timer };

    if (signal) {
      const onAbort = () => {
        if (!pendingRpc.has(id)) return;
        pendingRpc.delete(id);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      entry.onAbort = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
    }

    pendingRpc.set(id, entry);
    try {
      port.postMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'rpc',
        id,
        clientId,
        method,
        params: params || {},
      });
    } catch (err) {
      pendingRpc.delete(id);
      clearTimeout(timer);
      if (entry.onAbort) entry.onAbort();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Browser SDK for the Leaderboard service. Multiplexes REST + WebSocket through a SharedWorker
 * so multiple tabs of the same origin share one session and one WebSocket per `(clientId, gameId)`.
 *
 * Extends `EventTarget` - subscribe with `client.addEventListener(name, handler)`.
 *
 * @fires LeaderboardClient#auth-changed        `CustomEvent<SessionState|null>`
 * @fires LeaderboardClient#ws-status           `CustomEvent<{ gameId, status: WsStatus, ... }>`
 * @fires LeaderboardClient#leaderboard-snapshot `CustomEvent<{ gameId, entries: LeaderboardEntry[], current_event_id: string }>`
 * @fires LeaderboardClient#leaderboard-update  `CustomEvent<{ gameId, player_id, email, new_score, new_rank, previous_rank, event_id, idempotency_key? }>`
 * @fires LeaderboardClient#sdk-log             `CustomEvent<{ level, message, data }>` - structured worker log mirrored to the page
 */
class LeaderboardClient extends EventTarget {
  /**
   * @param {{ clientId: string, wsUrl: string }} options
   *   `clientId` is a short label (`a`, `b`, ...) that scopes the HttpOnly refresh cookie and the
   *   WebSocket pool. Two `LeaderboardClient` instances with the same `clientId` share one
   *   session; different values give independent sessions in the same browser.
   *   `wsUrl` is the WebSocket origin (e.g. `ws://localhost:3001`) - the SDK appends
   *   `/ws/leaderboard/:gameId`.
   */
  constructor({ clientId, wsUrl }) {
    super();
    requireNonEmptyString('clientId', clientId);
    requireNonEmptyString('wsUrl', wsUrl);
    this.clientId = clientId.trim();
    this.wsUrl = wsUrl.trim();

    if (!clientsById.has(this.clientId)) clientsById.set(this.clientId, new Set());
    clientsById.get(this.clientId).add(this);

    void this._register();
  }

  async _register() {
    const port = await ensureTransport();
    port.postMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'register',
      clientId: this.clientId,
    });
  }

  /**
   * Create a new player account. Domain-separated password prehash is computed on the page
   * before it reaches the worker.
   * @param {string} email
   * @param {string} password Plaintext, min 8 chars.
   */
  async signup(email, password) {
    requireCredentials(email, password);
    const emailTrimmed = email.trim();
    const prehash = await passwordPrehash(emailTrimmed, password);
    return rpc(this.clientId, 'signup', { email: emailTrimmed, passwordPrehash: prehash });
  }

  /**
   * Log in and receive an access token. Server also sets the HttpOnly refresh cookie for this
   * `clientId`; the token itself never enters JavaScript.
   * @param {string} email
   * @param {string} password Plaintext, min 8 chars.
   */
  async login(email, password) {
    requireCredentials(email, password);
    const emailTrimmed = email.trim();
    const prehash = await passwordPrehash(emailTrimmed, password);
    return rpc(this.clientId, 'login', { email: emailTrimmed, passwordPrehash: prehash });
  }

  /** Clear the in-memory access token and close any WebSockets for this `clientId`. */
  async logout() {
    return rpc(this.clientId, 'logout');
  }

  /** `GET /api/v1/games`. Emits `auth-changed` if the access token was refreshed. */
  async listGames() {
    return rpc(this.clientId, 'listGames');
  }

  /**
   * `POST /api/v1/games`.
   * @param {string} name
   */
  async createGame(name) {
    requireNonEmptyString('name', name);
    return rpc(this.clientId, 'createGame', { name: name.trim() });
  }

  /**
   * `POST /api/v1/matches`. The idempotency key is generated **on the page** so that a UI
   * retry (e.g. after an RPC timeout) reuses the same key and the server dedupes the second
   * submission. The worker also dedupes in-flight requests by this key. The value is
   * returned in `result.idempotencyKey` so the UI can show it.
   * @param {string} gameId
   * @param {number} score
   * @param {string} [idempotencyKey] Optional override; caller may reuse a key to retry safely.
   */
  async submitMatch(gameId, score, idempotencyKey = crypto.randomUUID()) {
    requireNonEmptyString('gameId', gameId);
    if (!Number.isInteger(score) || score < 0) {
      throw new TypeError('score must be a non-negative integer');
    }
    requireNonEmptyString('idempotencyKey', idempotencyKey);
    return rpc(this.clientId, 'submitMatch', {
      gameId: gameId.trim(),
      score,
      idempotencyKey,
    });
  }

  /**
   * Subscribe to real-time leaderboard updates for `gameId`. Opens the shared WebSocket if this
   * is the first subscriber; otherwise attaches to the existing one and immediately receives the
   * cached snapshot.
   * @param {string} gameId
   * @param {{ signal?: AbortSignal }} [options] Abort cancels the join RPC and best-effort leaves.
   */
  async joinLeaderboard(gameId, { signal } = {}) {
    requireNonEmptyString('gameId', gameId);
    assertAbortSignal(signal);
    const id = gameId.trim();
    const leave = () => {
      void rpc(this.clientId, 'leaveLeaderboard', { gameId: id }).catch(() => {});
    };
    try {
      const result = await rpc(
        this.clientId,
        'joinLeaderboard',
        { gameId: id, wsUrl: this.wsUrl },
        { signal },
      );
      // After a successful join, abort still unsubscribes (React unmount / navigation).
      if (signal) {
        if (signal.aborted) {
          leave();
          throw abortError();
        }
        signal.addEventListener('abort', leave, { once: true });
      }
      return result;
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        leave();
      }
      throw err;
    }
  }

  /**
   * Unsubscribe from `gameId`. The underlying WebSocket is closed when the last subscriber
   * leaves.
   * @param {string} gameId
   * @param {{ signal?: AbortSignal }} [options]
   */
  async leaveLeaderboard(gameId, { signal } = {}) {
    requireNonEmptyString('gameId', gameId);
    assertAbortSignal(signal);
    return rpc(this.clientId, 'leaveLeaderboard', { gameId: gameId.trim() }, { signal });
  }

  /**
   * Snapshot of current session + WebSocket statuses + cached leaderboards. Useful on tab load
   * when another tab already established the session.
   */
  async getState() {
    return rpc(this.clientId, 'getState');
  }

  /** Stop dispatching worker events to this instance. Does not affect other tabs. */
  detach() {
    const set = clientsById.get(this.clientId);
    if (!set) return;
    set.delete(this);
    if (set.size === 0) clientsById.delete(this.clientId);
  }
}

// Real unload / freeze: reject in-flight RPCs early. Detach happens on pagehide when not bfcache.
window.addEventListener('beforeunload', () => {
  rejectAllPending('transport closed');
});

window.addEventListener('pagehide', (event) => {
  if (event.persisted) {
    // Entering bfcache - keep the SharedWorker port; only pause heartbeats.
    stopHeartbeat();
    return;
  }
  hardDetachTransport();
});

window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  // Restored from bfcache - resume heartbeat and re-assert clientIds on the port.
  if (transportPort) {
    startHeartbeat();
    reRegisterAllClients();
  }
});

window.LeaderboardClient = LeaderboardClient;
window.LeaderboardClientPasswordPrehash = passwordPrehash;
window.LeaderboardClientProtocolVersion = PROTOCOL_VERSION;
window.LeaderboardClientAssetVersion = SDK_ASSET_VERSION;
