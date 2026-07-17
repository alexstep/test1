/* ═══════════════════════════════════════════════════════════
   Leaderboard Win95 Demo - UI Layer (SDK-backed)
   ═══════════════════════════════════════════════════════════ */

const WS_URLS = {
  a: 'ws://localhost:3001',
  b: 'ws://localhost:3002',
  c: 'ws://localhost:3001',
};

const REPLICA_LABELS = {
  a: 'api-1 :3001',
  b: 'api-2 :3002',
  c: 'api-1 :3001',
};

/** @type {Record<string, { sdk: LeaderboardClient, gameId: string|null, leaderboard: Array<{ rank: number, player_id: string, email: string, score: number, _anim: string }> }>} */
const clients = {
  a: { sdk: new LeaderboardClient({ clientId: 'a', wsUrl: WS_URLS.a }), gameId: null, leaderboard: [] },
  b: { sdk: new LeaderboardClient({ clientId: 'b', wsUrl: WS_URLS.b }), gameId: null, leaderboard: [] },
  c: { sdk: new LeaderboardClient({ clientId: 'c', wsUrl: WS_URLS.c }), gameId: null, leaderboard: [] },
};

const GAMES_POLL_MS = 15_000;
const CLIENT_IDS = Object.keys(clients);

/** Server WS close codes (see spec/02-api.md). */
const WS_CLOSE_REASONS = {
  4000: 'Invalid last_event_id',
  4001: 'Authentication required',
  4003: 'Token expired or invalid',
  4004: 'Game not found',
  1000: 'Normal closure',
  1001: 'Server shutting down',
};

// ── Helpers ──────────────────────────────────────────────

function mask(s) {
  if (!s) return '(empty)';
  return s.slice(0, 3) + '••••••••';
}

function jwtPreview(token) {
  if (!token) return '(none)';
  return token.slice(0, 16) + '…' + token.slice(-8);
}

function el(id) { return document.getElementById(id); }

function setStatus(id, msg, isError) {
  const e = el(id);
  if (!e) return;
  e.textContent = msg;
  e.style.color = isError ? '#800' : '#000';
}

function setFieldsetDisabled(fieldsetId, disabled) {
  const fs = el(fieldsetId);
  if (!fs) return;
  fs.classList.toggle('ui-disabled', disabled);
  fs.querySelectorAll('input, select, button').forEach((ctrl) => {
    ctrl.disabled = disabled;
  });
}

function isLoggedIn(cid) {
  return !!clients[cid].sdk && clients[cid]._loggedIn;
}

function updateUIState(cid) {
  const loggedIn = isLoggedIn(cid);
  const hasGame = !!el(`game-select-${cid}`)?.value;
  setFieldsetDisabled(`games-fs-${cid}`, !loggedIn);
  setFieldsetDisabled(`match-fs-${cid}`, !loggedIn || !hasGame);
}

function updateAllUIState() {
  for (const cid of CLIENT_IDS) updateUIState(cid);
}

async function refreshGamesAllLoggedIn() {
  await Promise.all(
    CLIENT_IDS.filter((cid) => isLoggedIn(cid)).map((cid) => doRefreshGames(cid)),
  );
}

function setupSdkListeners(cid) {
  const c = clients[cid];
  const sdk = c.sdk;
  const replica = REPLICA_LABELS[cid];

  sdk.addEventListener('auth-changed', (evt) => {
    const session = evt.detail;
    c._loggedIn = !!session?.accessToken;
    if (session?.email) {
      el(`email-${cid}`).value = session.email;
    }
    updateUIState(cid);
  });

  sdk.addEventListener('sdk-log', (evt) => {
    const { level, message, data } = evt.detail;
    const color = level === 'error' ? '#f44336' : '#607d8b';
    console.info(`%c SDK [${cid}]`, `color:${color}`, message, data || '');
  });

  sdk.addEventListener('ws-status', (evt) => {
    const d = evt.detail;
    if (d.gameId !== c.gameId) return;

    const wsStatus = el(`ws-status-${cid}`);
    const status = d.status;
    c._wsStatus = status;

    if (status === 'connecting') {
      wsStatus.textContent = `WS: connecting to ${replica}…`;
      wsStatus.classList.remove('connected');
      wsStatus.style.color = '';
    } else if (status === 'reconnecting') {
      const secs = d.nextRetryMs ? Math.round(d.nextRetryMs / 1000) : '?';
      wsStatus.textContent = `WS: reconnecting to ${replica} in ${secs}s (attempt ${d.attempt || 1})…`;
      wsStatus.classList.remove('connected');
      wsStatus.style.color = '#a60';
    } else if (status === 'connected') {
      wsStatus.textContent = `WS: connected to ${replica} - authenticating…`;
      wsStatus.classList.remove('connected');
      wsStatus.style.color = '';
    } else if (status === 'authenticated') {
      console.group('%c WS', 'color:#ff5722;font-weight:bold');
      console.info('%c Auth OK', 'color:#4caf50', `snapshot received (${replica})`);
      console.groupEnd();
      wsStatus.textContent = `WS: authenticated on ${replica}`;
      wsStatus.classList.add('connected');
      wsStatus.style.color = '';
    } else if (status === 'auth-failed') {
      const detail = d.reason || WS_CLOSE_REASONS[d.code] || '—';
      console.group('%c WS', 'color:#ff5722;font-weight:bold');
      console.info('%c Auth failed', 'color:#f44336', `code=${d.code} ${detail} (${replica})`);
      console.groupEnd();
      wsStatus.textContent = `WS: auth failed - ${detail} (code ${d.code})`;
      wsStatus.style.color = '#800';
      wsStatus.classList.remove('connected');
    } else if (status === 'disconnected') {
      const detail = d.reason || WS_CLOSE_REASONS[d.code] || '—';
      console.group('%c WS', 'color:#ff5722;font-weight:bold');
      console.info('%c Closed', 'color:#f44336', `code=${d.code} reason=${detail} (${replica})`);
      console.groupEnd();
      wsStatus.textContent = `WS: disconnected (code ${d.code || '—'})`;
      wsStatus.style.color = '';
      wsStatus.classList.remove('connected');
    } else if (status === 'error') {
      wsStatus.textContent = `WS: error (${replica})`;
      wsStatus.classList.remove('connected');
    }
  });

  sdk.addEventListener('leaderboard-snapshot', (evt) => {
    const d = evt.detail;
    if (d.gameId !== c.gameId) return;

    console.group('%c WS', 'color:#ff5722;font-weight:bold');
    console.info('%c leaderboard-snapshot', 'color:#2196f3',
      `${d.entries?.length || 0} entries, event_id=${d.current_event_id || '—'}`,
      `(${replica})`);
    console.groupEnd();

    c.leaderboard = (d.entries || []).map((e) => ({ ...e, _anim: '' }));
    const lbStatus = el(`lb-status-${cid}`);
    if (lbStatus) lbStatus.textContent = `Snapshot: ${c.leaderboard.length} entries`;
    renderLeaderboard(cid);
  });

  sdk.addEventListener('leaderboard-update', (evt) => {
    const d = evt.detail;
    if (d.gameId !== c.gameId) {
      console.warn(
        `[${cid}] leaderboard-update dropped: gameId mismatch`,
        `evt=${d.gameId}`,
        `current=${c.gameId}`,
      );
      return;
    }

    console.group('%c WS', 'color:#ff5722;font-weight:bold');
    console.info('%c leaderboard-update', 'color:#e91e63',
      `${d.email} score=${d.new_score} rank=${d.new_rank}`,
      d.previous_rank != null ? `(was #${d.previous_rank})` : '(new)',
      `event_id=${d.event_id || '—'}`,
      d.idempotency_key ? `idem=${d.idempotency_key}` : '',
      `(${replica})`);
    console.groupEnd();

    applyUpdate(cid, d);
  });
}

// ── Client Actions ──────────────────────────────────────

async function clientAction(cid, action) {
  try {
    switch (action) {
      case 'signup': return await doSignup(cid);
      case 'login': return await doLogin(cid);
      case 'refreshGames': return await doRefreshGames(cid);
      case 'createGame': return await doCreateGame(cid);
      case 'submitMatch': return await doSubmitMatch(cid);
    }
  } catch (err) {
    setStatus(`auth-status-${cid}`, err.message, true);
  }
}

async function doSignup(cid) {
  const emailVal = el(`email-${cid}`).value.trim();
  const passVal = el(`password-${cid}`).value;

  if (!emailVal) throw new Error('Email required');
  if (passVal.length < 8) throw new Error('Password must be ≥ 8 characters');

  const prehash = await LeaderboardClientPasswordPrehash(emailVal, passVal);

  console.group('%c SIGNUP', 'color:#00bcd4;font-weight:bold');
  console.info('%c Email', 'color:#2196f3', emailVal);
  console.info('%c Password', 'color:#ff9800',
    'domain-separated SHA-256 prehash; password-equivalent for this API',
    { masked: mask(passVal), digest: prehash });

  setStatus(`auth-status-${cid}`, 'Signing up…');
  const res = await clients[cid].sdk.signup(emailVal, passVal);

  if (res.ok) {
    console.info('%c Success', 'color:#4caf50', res.data);
    setStatus(`auth-status-${cid}`, 'Signup OK - now login');
  } else {
    console.info('%c Failed', 'color:#f44336', res.data);
    setStatus(`auth-status-${cid}`, `Signup failed: ${res.data.message || res.status}`, true);
  }
  console.groupEnd();
}

async function doLogin(cid) {
  const emailVal = el(`email-${cid}`).value.trim();
  const passVal = el(`password-${cid}`).value;

  if (!emailVal) throw new Error('Email required');
  if (passVal.length < 8) throw new Error('Password must be ≥ 8 characters');

  const prehash = await LeaderboardClientPasswordPrehash(emailVal, passVal);

  console.group('%c LOGIN', 'color:#00bcd4;font-weight:bold');
  console.info('%c Email', 'color:#2196f3', emailVal);
  console.info('%c Password', 'color:#ff9800',
    'domain-separated SHA-256 prehash; password-equivalent for this API',
    { masked: mask(passVal), digest: prehash });

  setStatus(`auth-status-${cid}`, 'Logging in…');
  const res = await clients[cid].sdk.login(emailVal, passVal);

  if (res.ok) {
    clients[cid]._loggedIn = true;
    console.info('%c access_token', 'color:#4caf50', jwtPreview(res.session?.accessToken));
    console.info(
      '%c refresh_token',
      'color:#4caf50',
      'HttpOnly cookie set by server (invisible to JS)',
    );
    console.info('%c expires_in', 'color:#607d8b', res.data.expires_in, 'seconds');
    setStatus(`auth-status-${cid}`, `Logged in as ${emailVal}`);
    updateUIState(cid);
    await doRefreshGames(cid);
  } else {
    console.info('%c Failed', 'color:#f44336', res.data);
    setStatus(`auth-status-${cid}`, `Login failed: ${res.data.message || res.status}`, true);
  }
  console.groupEnd();
}

async function doRefreshGames(cid) {
  console.group('%c REFRESH', 'color:#607d8b;font-weight:bold');
  console.info('%c Loading games list', 'color:#607d8b');

  const res = await clients[cid].sdk.listGames();
  if (!res.ok) {
    console.info('%c Failed', 'color:#f44336', res.data);
    console.groupEnd();
    return;
  }

  const c = clients[cid];
  const select = el(`game-select-${cid}`);
  const prevVal = select.value;
  select.innerHTML = '<option value="">— select game —</option>';
  const games = res.data;
  for (const g of games) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    select.appendChild(opt);
  }
  if (prevVal) select.value = prevVal;

  console.info('%c Games loaded', 'color:#4caf50', games.length);
  console.groupEnd();

  select.onchange = () => { void onGameSelected(cid); };
  // Only (re)join when the selected game actually changed — never tear down WS on poll.
  if (select.value !== (c.gameId || '')) {
    await onGameSelected(cid);
  } else {
    updateUIState(cid);
  }
}

async function doCreateGame(cid) {
  const name = el(`new-game-${cid}`).value.trim();
  if (!name) throw new Error('Game name required');

  const res = await clients[cid].sdk.createGame(name);
  if (res.ok) {
    el(`new-game-${cid}`).value = '';
    await refreshGamesAllLoggedIn();
    const select = el(`game-select-${cid}`);
    select.value = res.data.id;
    await onGameSelected(cid);
  } else {
    throw new Error(res.data.message || 'Create game failed');
  }
}

async function doSubmitMatch(cid) {
  const gameId = el(`game-select-${cid}`).value;
  if (!gameId) throw new Error('Select a game first');

  const scoreInput = el(`score-${cid}`).value;
  const score = scoreInput ? parseInt(scoreInput, 10) : Math.floor(Math.random() * 500) + 1;

  console.group('%c MATCH', 'color:#e91e63;font-weight:bold');
  console.info('%c game_id', 'color:#2196f3', gameId);
  console.info('%c score', 'color:#ff9800', score);

  setStatus(`match-status-${cid}`, `Submitting score ${score}…`);
  const res = await clients[cid].sdk.submitMatch(gameId, score);

  if (res.ok) {
    console.info('%c Match submitted', 'color:#4caf50', {
      ...res.data,
      'Idempotency-Key': res.idempotencyKey,
    });
    console.info(
      '%c Idempotency-Key (header sent → safe to retry same key)',
      'color:#9c27b0;font-weight:bold',
      res.idempotencyKey,
    );
    setStatus(
      `match-status-${cid}`,
      `Score ${score} ✓ · Idempotency-Key: ${res.idempotencyKey}`,
    );
  } else {
    console.info('%c Failed', 'color:#f44336', res.data, {
      'Idempotency-Key': res.idempotencyKey,
    });
    setStatus(
      `match-status-${cid}`,
      `Failed: ${res.data.message || res.status} · key ${res.idempotencyKey}`,
      true,
    );
  }
  console.groupEnd();
}

// ── Game Selection → WS ─────────────────────────────────

async function onGameSelected(cid) {
  const c = clients[cid];
  const prev = c._joinChain || Promise.resolve();
  let release;
  c._joinChain = new Promise((resolve) => { release = resolve; });
  await prev.catch(() => {});

  try {
    const gameId = el(`game-select-${cid}`).value;

    // Same game already joined — keep WS room and existing table rows.
    if (gameId && gameId === c.gameId) {
      updateUIState(cid);
      return;
    }

    if (c.gameId) {
      await c.sdk.leaveLeaderboard(c.gameId);
      c._wsStatus = 'disconnected';
    }

    c.gameId = gameId || null;
    c.leaderboard = [];
    renderLeaderboard(cid);
    updateUIState(cid);

    if (!gameId || !isLoggedIn(cid)) return;

    const replica = REPLICA_LABELS[cid];
    const url = `${WS_URLS[cid]}/ws/leaderboard/${gameId}`;

    console.group('%c WS', 'color:#ff5722;font-weight:bold');
    console.info('%c Connecting to', 'color:#ff5722', replica);
    console.info('%c URL', 'color:#607d8b', url);
    console.info(
      '%c Auth mode',
      'color:#607d8b',
      'first message `{ type: "auth", token }` - query ?token= not used',
    );
    console.groupEnd();

    try {
      await c.sdk.joinLeaderboard(gameId);
    } catch (err) {
      setStatus(`ws-status-${cid}`, `WS: ${err.message}`, true);
    }
  } finally {
    release();
  }
}

/** Resolve when this client's WS for the current game reaches `authenticated`. */
function waitForWsAuth(cid, signal, timeoutMs = 15_000) {
  const c = clients[cid];
  if (c.gameId && c._wsStatus === 'authenticated') return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WS auth timeout (${cid})`));
    }, timeoutMs);

    const onStatus = (evt) => {
      const d = evt.detail;
      if (d.gameId !== c.gameId) return;
      if (d.status === 'authenticated') {
        cleanup();
        resolve();
      } else if (d.status === 'auth-failed') {
        cleanup();
        reject(new Error(`WS auth failed (${cid}): ${d.reason || d.code || '—'}`));
      }
    };

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      c.sdk.removeEventListener('ws-status', onStatus);
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    c.sdk.addEventListener('ws-status', onStatus);

    if (c.gameId && c._wsStatus === 'authenticated') {
      cleanup();
      resolve();
    }
  });
}

// ── Leaderboard State ───────────────────────────────────

function applyUpdate(cid, msg) {
  const c = clients[cid];
  const lb = c.leaderboard;
  const idx = lb.findIndex((e) => e.player_id === msg.player_id);

  let anim = '';
  if (idx === -1) {
    anim = 'rank-new';
  } else if (msg.previous_rank !== null && msg.new_rank < msg.previous_rank) {
    anim = 'rank-up';
  } else if (msg.previous_rank !== null && msg.new_rank > msg.previous_rank) {
    anim = 'rank-down';
  } else {
    anim = 'rank-new';
  }

  if (idx !== -1) lb.splice(idx, 1);
  lb.push({
    rank: msg.new_rank,
    player_id: msg.player_id,
    email: msg.email,
    score: msg.new_score,
    _anim: anim,
  });

  lb.sort((a, b) => a.rank - b.rank);
  const lbStatusEl = el(`lb-status-${cid}`);
  if (lbStatusEl) lbStatusEl.textContent = `Updated: ${msg.email} → #${msg.new_rank}`;
  renderLeaderboard(cid);

  setTimeout(() => {
    for (const e of c.leaderboard) e._anim = '';
    renderLeaderboard(cid);
  }, 1200);
}

function renderLeaderboard(cid) {
  const c = clients[cid];
  const table = el(`lb-table-${cid}`);
  if (!table) return;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';
  for (const e of c.leaderboard) {
    const tr = document.createElement('tr');
    if (e._anim) tr.className = e._anim;
    tr.innerHTML = `<td>${e.rank}</td><td title="${e.player_id}">${e.email}</td><td>${e.score}</td>`;
    tbody.appendChild(tr);
  }
}

// ── Restore state on load ───────────────────────────────

async function restoreState(cid) {
  const c = clients[cid];
  try {
    const state = await c.sdk.getState();
    c._loggedIn = !!state.session?.accessToken;
    if (state.session?.email) {
      el(`email-${cid}`).value = state.session.email;
    }
    if (c._loggedIn) {
      setStatus(`auth-status-${cid}`, `Logged in as ${state.session.email || '(unknown)'}`);
      await doRefreshGames(cid);
    }

    if (state.ws?.length) {
      const active = state.ws[0];
      if (active.gameId) {
        c.gameId = active.gameId;
        const select = el(`game-select-${cid}`);
        if (select.querySelector(`option[value="${active.gameId}"]`)) {
          select.value = active.gameId;
        }
        if (state.snapshots?.[active.gameId]) {
          const snap = state.snapshots[active.gameId];
          c.leaderboard = (snap.entries || []).map((e) => ({ ...e, _anim: '' }));
          const lbStatus = el(`lb-status-${cid}`);
          if (lbStatus) lbStatus.textContent = `Snapshot: ${c.leaderboard.length} entries`;
          renderLeaderboard(cid);
        }
        const replica = REPLICA_LABELS[cid];
        const wsStatus = el(`ws-status-${cid}`);
        if (active.authed) {
          c._wsStatus = 'authenticated';
          wsStatus.textContent = `WS: authenticated on ${replica}`;
          wsStatus.classList.add('connected');
        }
      }
    }
    updateUIState(cid);
  } catch {
    /* worker may not have state yet */
  }
}

// ── Draggable Windows ───────────────────────────────────

(function initDrag() {
  let dragging = null;
  let offsetX = 0, offsetY = 0;

  document.addEventListener('mousedown', (e) => {
    const bar = e.target.closest('[data-drag]');
    if (!bar) return;
    const winId = bar.dataset.drag;
    const win = el(winId);
    if (!win) return;

    dragging = win;
    const rect = win.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;

    bringToFront(winId);
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    dragging.style.left = (e.clientX - offsetX) + 'px';
    dragging.style.top = (e.clientY - offsetY) + 'px';
  });

  document.addEventListener('mouseup', () => { dragging = null; });
})();

function bringToFront(winId) {
  document.querySelectorAll('.win95-window').forEach((w) => w.classList.remove('active'));
  el(winId).classList.add('active');
  refreshTaskbar();
}

document.addEventListener('mousedown', (e) => {
  const win = e.target.closest('.win95-window');
  if (win) bringToFront(win.id);
});

// ── Minimize ────────────────────────────────────────────

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-minimize]');
  if (!btn) return;
  const winId = btn.dataset.minimize;
  el(winId).classList.toggle('minimized');
  refreshTaskbar();
});

// ── Taskbar ─────────────────────────────────────────────

function refreshTaskbar() {
  const container = el('taskbar-items');
  container.innerHTML = '';
  document.querySelectorAll('.win95-window').forEach((win) => {
    const title = win.querySelector('.win95-titlebar-text')?.textContent || win.id;
    const btn = document.createElement('button');
    btn.className = 'taskbar-item' + (win.classList.contains('active') ? ' active' : '');
    btn.textContent = title;
    btn.onclick = () => {
      win.classList.remove('minimized');
      bringToFront(win.id);
    };
    container.appendChild(btn);
  });
}

// ── Clock ───────────────────────────────────────────────

function updateClock() {
  const now = new Date();
  el('taskbar-clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(updateClock, 15000);
updateClock();

// ── Auto Demo ───────────────────────────────────────────

let demoRunning = false;
/** @type {AbortController|null} */
let demoAbort = null;

function setDemoRunning(running) {
  demoRunning = running;
  const btn = el('start-btn');
  btn.textContent = running ? '■ Stop' : '▣ Start';
  btn.classList.toggle('demo-running', running);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

async function delay(minMs, maxMs, signal) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  await sleep(ms, signal);
}

async function typeInto(inputId, text, signal) {
  const input = el(inputId);
  input.value = '';
  input.focus();
  for (const ch of text) {
    await sleep(30 + Math.random() * 40, signal);
    input.value += ch;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function stopDemo() {
  demoAbort?.abort();
  demoAbort = null;
  setDemoRunning(false);
}

async function demoAuthClient(cid, email, password, signal) {
  await typeInto(`email-${cid}`, email, signal);
  await delay(400, 800, signal);
  await typeInto(`password-${cid}`, password, signal);
  await delay(400, 800, signal);

  el(`email-${cid}`).value = email;
  el(`password-${cid}`).value = password;

  setStatus(`auth-status-${cid}`, 'Signing up…');
  const signupRes = await clients[cid].sdk.signup(email, password);

  if (signupRes.ok) {
    setStatus(`auth-status-${cid}`, 'Signup OK - now login');
    await delay(400, 800, signal);
  }

  setStatus(`auth-status-${cid}`, 'Logging in…');
  const loginRes = await clients[cid].sdk.login(email, password);

  if (!loginRes.ok) {
    const msg = signupRes.ok
      ? `Login failed: ${loginRes.data?.message || loginRes.status}`
      : `Demo auth failed: ${loginRes.data?.message || loginRes.status}`;
    setStatus(`auth-status-${cid}`, msg, true);
    return false;
  }

  clients[cid]._loggedIn = true;
  setStatus(`auth-status-${cid}`, `Logged in as ${email}`);
  updateUIState(cid);
  await doRefreshGames(cid);
  await delay(400, 800, signal);
  return true;
}

async function runDemo() {
  if (demoRunning) return;

  demoAbort = new AbortController();
  const signal = demoAbort.signal;
  setDemoRunning(true);

  try {
    const ts = Date.now();
    const password = 'demopass1';

    for (const cid of CLIENT_IDS) {
      const email = `demo-${cid}-${ts}@test.com`;
      const ok = await demoAuthClient(cid, email, password, signal);
      if (!ok) {
        stopDemo();
        return;
      }
    }

    const gameName = `Demo Arena ${ts}`;
    await typeInto('new-game-a', gameName, signal);
    await delay(400, 800, signal);
    el('new-game-a').value = gameName;
    await doCreateGame('a');
    const gameId = el('game-select-a').value;
    if (!gameId) throw new Error('Failed to create demo game');

    for (const cid of ['b', 'c']) {
      await doRefreshGames(cid);
      el(`game-select-${cid}`).value = gameId;
      await onGameSelected(cid);
    }

    // Wait until every replica has an authenticated WS + snapshot before scoring.
    await Promise.all(CLIENT_IDS.map((cid) => waitForWsAuth(cid, signal)));
    await delay(400, 800, signal);

    const rounds = 12;
    for (let i = 0; i < rounds; i++) {
      const cid = CLIENT_IDS[Math.floor(Math.random() * CLIENT_IDS.length)];
      const score = Math.floor(Math.random() * 500) + 1;
      el(`score-${cid}`).value = String(score);
      await doSubmitMatch(cid);
      await delay(1000, 1500, signal);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Demo error:', err);
      setStatus('auth-status-a', `Demo error: ${err.message}`, true);
    }
  } finally {
    if (demoRunning) {
      setDemoRunning(false);
      demoAbort = null;
    }
  }
}

// ── Init ────────────────────────────────────────────────

for (const cid of CLIENT_IDS) {
  clients[cid]._loggedIn = false;
  clients[cid]._wsStatus = 'disconnected';
  setupSdkListeners(cid);
}

updateAllUIState();
refreshTaskbar();

void Promise.all(CLIENT_IDS.map((cid) => restoreState(cid)));

window.addEventListener('focus', () => {
  if (demoRunning) return;
  refreshGamesAllLoggedIn().catch(() => {});
});

setInterval(() => {
  if (demoRunning) return;
  refreshGamesAllLoggedIn().catch(() => {});
}, GAMES_POLL_MS);

el('start-btn').addEventListener('click', () => {
  if (demoRunning) stopDemo();
  else void runDemo();
});

window.clientAction = clientAction;
