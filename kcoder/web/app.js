/* kcoder web app - a client of kcoderd. No build step; vanilla JS. */
'use strict';

const BANNER = [
  '██╗  ██╗ ██████╗ ██████╗ ██████╗ ███████╗██████╗ ',
  '██║ ██╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗',
  '█████╔╝ ██║     ██║   ██║██║  ██║█████╗  ██████╔╝',
  '██╔═██╗ ██║     ██║   ██║██║  ██║██╔══╝  ██╔══██╗',
  '██║  ██╗╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║',
  '╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝',
].join('\n');

const SLASH = [
  ['/help', 'show commands'], ['/clear', 'reset conversation history'], ['/cd', 'change working directory'],
  ['/model', 'switch model or provider (all providers)'], ['/provider', 'same picker as /model'], ['/trust', 'auto | write | read | none | dry'], ['/auto', 'toggle auto-approve'],
  ['/title', 'set the chat title'], ['/name', 'rename the session'], ['/queue', 'add a follow-up task'],
  ['/fork', 'fork this chat'], ['/compact', 'summarise history to free context'], ['/export', 'download as markdown'], ['/recap', 'where we left off (/recap new rewrites it)'],
  ['/archive', 'archive this chat'], ['/shell', 'toggle the shell pane'], ['/grid', 'sessions: the grid'],
  ['/panes', 'sessions: 1 to 3 panes (/panes 2)'], ['/terminal', 'toggle this pane between chat and terminal view'],
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => (n || 0).toLocaleString();
const fmtUsd = (n) => (n >= 100 ? '$' + Math.round(n).toLocaleString() : n >= 10 ? '$' + n.toFixed(1) : '$' + (n || 0).toFixed(2));
const fmtTokens = (n) => (n >= 1e12 ? (n / 1e12).toFixed(n >= 1e13 ? 1 : 2) + 'T' : n >= 1e9 ? (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n || 0));
const age = (ts) => { const d = Math.max(0, Date.now() / 1000 - (ts || 0)); return d < 60 ? Math.floor(d) + 's' : d < 3600 ? Math.floor(d / 60) + 'm' : d < 86400 ? Math.floor(d / 3600) + 'h' : Math.floor(d / 86400) + 'd'; };
const shortHome = (p) => (p || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

// ----------------------------------------------------------------------
// state
// ----------------------------------------------------------------------
const state = {
  token: null, ws: null, connected: false, reqId: 1, pending: new Map(),
  sessions: new Map(),     // sid -> snapshot (active)
  chats: [], projects: [], stats: {}, providers: null,
  events: new Map(),       // sid -> { list: [], live: '' , loaded: bool }
  view: (localStorage.getItem('kcoder.view') || 'wall').replace('terminal', 'chat'),
  cpaneView: new Map(),    // sid -> 'chat' | 'term' (split panes; wall panes use paneView)
  verbs: new Map(),        // sid -> { verb, at, recent } for the working status line
  jobTails: new Map(),     // 'sid:jobid' -> last output of a background job
  jobOpen: null,
  statsSorts: JSON.parse(localStorage.getItem('kcoder.statsSorts') || '{}'),   // stats tables: id -> { key, dir }
  statsCal: localStorage.getItem('kcoder.statsCal') || 'tokens',
  sid: localStorage.getItem('kcoder.sid') || null,     // current chat (chat/terminal views)
  focus: null,             // focused pane sid (wall)
  paneView: new Map(),     // sid -> 'chat' | 'term' | 'shell'
  order: JSON.parse(localStorage.getItem('kcoder.order') || '[]'),  // wall pane order (drag to reorder)
  dragSid: null,           // pane being dragged
  sound: localStorage.getItem('kcoder.sound') !== 'off',
  winName: sessionStorage.getItem('kcoder.win') || null,
  pins: [],
  shells: new Map(),       // sid -> { term, fit }
  histories: new Map(),    // sid -> prompt history
  dialog: null,
  prevStatus: new Map(),
  renderQueued: new Set(),
  searchResults: null,
  gitInfo: new Map(),
  fileCache: new Map(),
  layout: JSON.parse(localStorage.getItem('kcoder.layout') || 'null') || { panes: [localStorage.getItem('kcoder.sid') || null], focus: 0, zoom: null },
  broadcast: localStorage.getItem('kcoder.broadcast') === 'on',
  dragChat: null,          // chat being dragged from the sidebar onto a pane
  statsDays: Number(localStorage.getItem('kcoder.statsDays') || 30),   // 1 = today, 0 = all time
  statsDate: null,            // a single day picked in the stats view (YYYY-MM-DD)
  statsMetric: null,
  statsSort: { key: 'date', dir: -1 },
  recapShown: new Map(),   // sid -> when the "where we left off" card was last shown in this app run
  recaps: new Map(),       // sid -> the recap on screen
};

if (!state.winName) { state.winName = 'w' + Math.random().toString(36).slice(2, 7); sessionStorage.setItem('kcoder.win', state.winName); }
state.pins = JSON.parse(localStorage.getItem('kcoder.pins.' + state.winName) || '[]');
function savePins() { localStorage.setItem('kcoder.pins.' + state.winName, JSON.stringify(state.pins)); }

// ---- theme: dark (default), light, or follow the system ----
function themeChoice() { return localStorage.getItem('kcoder.theme') || 'dark'; }
function effectiveTheme() { const c = themeChoice(); return c === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : c; }
function applyTheme() {
  const c = themeChoice(), eff = effectiveTheme();
  if (c === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = c;
  $('#hljs-dark').disabled = eff === 'light'; $('#hljs-light').disabled = eff !== 'light';
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = eff === 'light' ? '#FFFFFF' : '#0C0E12';
  for (const sh of state.shells.values()) { try { sh.term.options.theme = xtermTheme(); } catch {} }
  renderConditions();
}
function setTheme(c) { localStorage.setItem('kcoder.theme', c); applyTheme(); }
// ---- density: comfortable (default) or compact ----
function densityChoice() { return localStorage.getItem('kcoder.density') || 'comfortable'; }
function applyDensity() { const c = densityChoice(); if (c === 'compact') document.documentElement.dataset.density = 'compact'; else delete document.documentElement.dataset.density; for (const sh of state.shells.values()) { try { sh.fit.fit(); } catch {} } }
function setDensity(c) { localStorage.setItem('kcoder.density', c); applyDensity(); }
// ---- text font: any installed family (falls back to the system monospace) and a size ----
const FONT_PRESETS = [['', 'system monospace (default)'], ['JetBrains Mono', 'JetBrains Mono'], ['Fira Code', 'Fira Code'], ['Cascadia Code', 'Cascadia Code'], ['SF Mono', 'SF Mono'], ['Menlo', 'Menlo'], ['Consolas', 'Consolas'], ['IBM Plex Mono', 'IBM Plex Mono'], ['Source Code Pro', 'Source Code Pro'], ['Monaco', 'Monaco'], ['Courier New', 'Courier New'], ['system-ui', 'system sans (not monospace)']];
const FONT_SIZES = [11, 12, 12.5, 13, 14, 15, 16, 18];
function fontChoice() { return { family: localStorage.getItem('kcoder.font') || '', size: Number(localStorage.getItem('kcoder.fontSize')) || 12.5 }; }
function fontStack(family) { return family ? `"${family.replace(/"/g, '')}", ${cssVar('--mono') || 'monospace'}` : ''; }
function applyFont() {
  const f = fontChoice();
  const root = document.documentElement.style;
  if (f.family) root.setProperty('--font', fontStack(f.family)); else root.removeProperty('--font');
  root.setProperty('--font-size', f.size + 'px');
  for (const sh of state.shells.values()) { try { sh.term.options.fontFamily = f.family ? fontStack(f.family) : 'ui-monospace, Menlo, monospace'; sh.term.options.fontSize = Math.round(f.size); sh.fit.fit(); } catch {} }
}
function setFont(family, size) {
  if (family != null) { if (family) localStorage.setItem('kcoder.font', family); else localStorage.removeItem('kcoder.font'); }
  if (size != null) localStorage.setItem('kcoder.fontSize', String(size));
  applyFont();
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function xtermTheme() { return { background: cssVar('--code-bg'), foreground: cssVar('--fg'), cursor: cssVar('--accent'), selectionBackground: cssVar('--accent-soft') }; }
applyTheme();
applyFont();
applyDensity();
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (themeChoice() === 'system') applyTheme(); });

// ----------------------------------------------------------------------
// connection
// ----------------------------------------------------------------------
function readToken() {
  const m = location.hash.match(/token=([^&]+)/);
  if (m) { localStorage.setItem('kcoder.token', decodeURIComponent(m[1])); history.replaceState(null, '', location.pathname + location.search); }
  return localStorage.getItem('kcoder.token');
}

function connect() {
  state.token = readToken();
  if (!state.token) { tokenGate(); return; }
  setConn('wait');
  const ws = new WebSocket(`ws://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token: state.token, id: 0 }));
  };
  ws.onmessage = (e) => onFrame(JSON.parse(e.data));
  ws.onclose = (e) => {
    state.connected = false; if (!state.downSince) state.downSince = Date.now(); setConn('off'); renderClaudeButton();
    for (const [, p] of state.pending) p.reject(new Error('disconnected'));
    state.pending.clear();
    if (e.code === 4401) { localStorage.removeItem('kcoder.token'); tokenGate('That token was rejected.'); return; }
    maybeStartDaemon();
    setTimeout(connect, 1500);
  };
  ws.onerror = () => {};
}

function setConn(s) {
  const el = $('#conn'); el.className = 'conn ' + (s === 'on' ? 'on' : s === 'wait' ? 'wait' : '');
  const native = !!(window.pywebview && window.pywebview.api);
  const downFor = state.downSince ? Date.now() - state.downSince : 0;
  el.title = s === 'on' ? 'connected to kcoderd' : s === 'wait' && downFor < 4000 ? 'connecting to kcoderd…' : native ? 'kcoderd is not running - starting it…' : 'kcoderd is not running - run `kcoder app` (or `kcoder`) in a terminal';
  const note = $('#status-down'); if (note) { note.hidden = s === 'on' || downFor < 4000; note.textContent = native ? 'kcoderd not running · starting it…' : 'kcoderd not running · run `kcoder app` in a terminal'; }
  if (s === 'on') state.downSince = 0;
}
// The native window can start kcoderd itself (a browser tab cannot): after
// a few seconds down, ask it to, at most every 15 seconds.
function maybeStartDaemon() {
  const api = window.pywebview && window.pywebview.api; if (!api || !api.start_daemon) return;
  const downFor = Date.now() - (state.downSince || Date.now());
  if (downFor < 4000 || Date.now() - (state._daemonStartAt || 0) < 15000) return;
  state._daemonStartAt = Date.now();
  Promise.resolve(api.start_daemon()).then((r) => { if (r === 'started') toast('kcoderd was not running: started it', 'warn'); else if (String(r).startsWith('failed')) toast('could not start kcoderd: ' + r, 'err'); }).catch(() => {});
}

function request(type, fields = {}) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== 1) return reject(new Error('kcoderd is not running (the app reconnects as soon as it starts)'));
    const id = state.reqId++;
    state.pending.set(id, { resolve, reject: (e) => { if (/unknown request type/.test(e.message)) restartForMismatch('the running kcoderd does not know ' + type); reject(e); } });
    state.ws.send(JSON.stringify({ type, id, ...fields }));
  });
}
// app and daemon exchange versions on connect; when they differ (a new
// version was installed under a running daemon) the app restarts the daemon
// itself instead of surfacing protocol errors
function handleVersion(msg) {
  state.version = { running: msg.version, installed: msg.installed, dev: !!msg.dev };
  if (msg.installed && msg.version && msg.installed !== msg.version) restartForMismatch(`kcoder ${msg.installed} is installed but kcoderd ${msg.version} is running`);
}
function restartForMismatch(why) {
  if (state._mismatchAt && Date.now() - state._mismatchAt < 60000) return;
  state._mismatchAt = Date.now();
  toast(why + ' - restarting kcoderd', 'warn');
  request('restart').then(() => toast('kcoderd is restarting…', 'warn')).catch((e) => toast('restart later: ' + e.message, 'warn'));
}
let uiSyncTimer = null;
function syncUiState() {
  clearTimeout(uiSyncTimer);
  uiSyncTimer = setTimeout(() => { if (state.connected) request('ui_state', { state: uiStateOut() }).catch(() => {}); }, 800);
}
function send(type, fields = {}) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type, ...fields })); }

async function onFrame(msg) {
  if (msg.type === 'reply') {
    if (msg.id === 0) {
      if (!msg.ok) { localStorage.removeItem('kcoder.token'); tokenGate('Unauthorized.'); return; }
      state.connected = true; setConn('on');
      handleVersion(msg);
      await onConnected();
      return;
    }
    const p = state.pending.get(msg.id);
    if (p) { state.pending.delete(msg.id); msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error || 'request failed')); }
    return;
  }
  if (msg.type === 'sessions') { onSessions(msg.sessions, msg.stats); return; }
  if (msg.type === 'chats') { state.chats = msg.chats; state.projects = msg.projects; renderSidebar(); return; }
  if (msg.type === 'event') { onEvent(msg.sid, msg.ev); return; }
  if (msg.type === 'shell') { onShellData(msg.sid, msg.data, msg.exit); return; }
  if (msg.type === 'conditions') { onConditions(msg); return; }
  if (msg.type === 'plan_usage') { state.claude = { ...(state.claude || {}), usage: msg.usage }; renderClaudeButton(); if (state.dialog === 'claude' && state._renderClaude) state._renderClaude(state.claude); return; }
  if (msg.type === 'notice') { toast(`${msg.title}: ${msg.body}`, 'warn'); notify(msg.title, msg.body, msg.sid, 'wait'); return; }
}

async function onConnected() {
  await request('attach', { sid: '*' });
  await refreshProviders();
  try { state.config = (await request('config')).config; } catch {}
  if (!state._updOffered) { state._updOffered = true; request('update', { action: 'check' }).then((r) => { if (r.update && r.update.available && !r.update.failed) updateNow(); }).catch(() => {}); }
  {
    const fresh = !localStorage.getItem('kcoder.layout') && !localStorage.getItem('kcoder.order');
    // a fresh browser profile picks up the layout the daemon kept for us; the token mine is adopted whenever the daemon's copy is further along
    try { const r = await request('ui_state'); if (r.state) { if (fresh && r.state.layout) { state.layout = r.state.layout; localStorage.setItem('kcoder.layout', JSON.stringify(state.layout)); } if (fresh && Array.isArray(r.state.order)) { state.order = r.state.order; localStorage.setItem('kcoder.order', JSON.stringify(state.order)); } if (r.state.mine) mineAdopt(r.state.mine); } } catch {}
  }
  applyUrlParams();
  setTimeout(maybeMorningBrief, 1500);
  setTimeout(maybeWrapped, 4000);
  for (const sid of state.sessions.keys()) loadEvents(sid, 80);
  for (const sid of state.layout.panes) if (sid) loadEvents(sid, -1);
  if (state.sid && !state.events.has(state.sid)) await loadEvents(state.sid, -1);
  syncSid();
  renderAll();
  if (!state._setupShown && (((state.providers || []).length && !state.providers.some((p) => p.configured)) || (state.github && !state.github.connected))) { state._setupShown = true; setupDialog(); }
  const open = new URLSearchParams(location.search).get('open');
  if (open && !state._openedOnce) { state._openedOnce = true; ({ new: openNewSession, inbox: openInbox, palette: openPalette, help: helpDialog, changes: () => state.sid && changesDialog(state.sid) }[open] || (() => {}))(); }
}

function applyUrlParams() {
  // ?view=wall|chat|terminal  ?sid=<id or name>  ?focus=1  ?pin=<id,id>  ?open=new|inbox|palette|help|changes (of ?sid)
  const q = new URLSearchParams(location.search);
  if (state._urlApplied) return; state._urlApplied = true;
  if (q.get('view')) { state.view = q.get('view').replace('terminal', 'chat'); localStorage.setItem('kcoder.view', state.view); }
  const ref = q.get('sid');
  if (ref) { const s = Array.from(state.sessions.values()).find((x) => x.id === ref || x.name === ref) || state.chats.find((x) => x.id === ref || x.name === ref); if (s) { state.sid = s.id; localStorage.setItem('kcoder.sid', s.id); } }
  if (q.get('focus') && state.sid) state.focus = state.sid;
  if (q.get('panes')) { const find = (r) => { const s = Array.from(state.sessions.values()).find((x) => x.id === r || x.name === r) || state.chats.find((x) => x.id === r || x.name === r); return s ? s.id : null; }; state.layout.panes = q.get('panes').split(',').slice(0, 3).map(find); state.layout.focus = 0; state.layout.zoom = null; saveLayout(); }
  if (q.get('pin')) { state.pins = q.get('pin').split(',').map((r) => { const s = Array.from(state.sessions.values()).find((x) => x.id === r || x.name === r); return s ? s.id : r; }); savePins(); }
  renderViews();
}

async function loadEvents(sid, replay) {
  let store = state.events.get(sid);
  if (store && (store.loaded || (store.partial && replay > 0))) return store;
  try {
    const r = await request('attach', { sid, replay });
    store = state.events.get(sid);
    if (!store || !store.loaded) {
      store = { list: r.events, live: '', streaming: false, loaded: replay < 0, partial: replay > 0 };
      state.events.set(sid, store);
    }
    if (r.session) upsertSession(r.session);
    queueRender(sid);
  } catch (e) {
    if (/no session/.test(e.message)) { if (state.sid === sid) { state.sid = null; localStorage.removeItem('kcoder.sid'); } return null; }
    toast(e.message, 'err');
  }
  return store;
}

// ----------------------------------------------------------------------
// sessions & events
// ----------------------------------------------------------------------
function upsertSession(s) {
  state.sessions.set(s.id, s);
  if (!state.order.includes(s.id)) state.order.push(s.id);
}

function onSessions(list, stats) {
  const seen = new Set();
  for (const s of list) {
    seen.add(s.id);
    const prev = state.prevStatus.get(s.id);
    upsertSession(s);
    if (prev && prev !== s.status) statusChanged(s, prev);
    state.prevStatus.set(s.id, s.status);
  }
  for (const sid of Array.from(state.sessions.keys())) if (!seen.has(sid)) { state.sessions.delete(sid); state.order = state.order.filter((x) => x !== sid); if (state.focus === sid) state.focus = null; }
  state.stats = stats || state.stats;
  for (const s of list) if (!state.events.has(s.id)) loadEvents(s.id, 80);
  renderHeader(); renderWall(); renderTitlebars(); renderSplitBars(); renderSidebar();
  if (state.view === 'tasks') renderTasksView(false);
}

function statusChanged(s, prev) {
  if (s.status === 'waiting') notify(`${s.name} is waiting on you`, s.pending_approval ? 'tool approval needed' : 'needs input', s.id, 'wait');
  else if (s.status === 'idle' && prev === 'working') notify(`${s.name} finished`, s.title || '', s.id, 'done');
  else if (s.status === 'error' && prev !== 'error') notify(`${s.name} hit an error`, '', s.id, 'err');
}

function onEvent(sid, ev) {
  if (ev.t === 'error' && ev.fix) { refreshClaude().then(() => { if (ev.fix === 'claude-login' && !state.dialog) claudeDialog(); }); }
  let store = state.events.get(sid);
  if (!store) { store = { list: [], live: '', streaming: false, loaded: false, partial: true }; state.events.set(sid, store); }
  if (ev.t === 'text') { store.live += ev.delta; store.streaming = true; queueRender(sid); return; }
  if (ev.t === 'progress') { store.turn = { input: ev.input, output: ev.output }; return; }
  if (ev.t === 'job_output') { state.jobTails.set(sid + ':' + ev.id, ((state.jobTails.get(sid + ':' + ev.id) || '') + ev.delta).slice(-60000)); if (state.dialog === 'job' && state.jobOpen === sid + ':' + ev.id) renderJobDialogTail(); return; }
  if (ev.t === 'job') { if (state.dialog === 'job' && state.jobOpen === sid + ':' + ev.id) setTimeout(() => jobDialog(sid, ev.id), 200); }
  if (ev.t === 'handoff' && ev.to) {      // follow the work: every pane showing the old session shows the new one
    setTimeout(() => { state.layout.panes.forEach((p, i) => { if (p === sid) assignPane(i, ev.to); }); if (state.sid === sid) { state.sid = ev.to; localStorage.setItem('kcoder.sid', ev.to); } toast(`${ev.name}: fresh session with a handoff summary`, 'ok'); }, 300);
  }
  if (ev.t === 'turn_start') store.turn = { input: 0, output: 0 };
  if (ev.t === 'user') hideRecap(sid);
  if (ev.t === 'tool_output') { store.toolLive = store.toolLive || {}; store.toolLive[ev.id] = ((store.toolLive[ev.id] || '') + ev.delta).slice(-12000); queueRender(sid); return; }
  if (ev.t === 'tool_result' && store.toolLive) delete store.toolLive[ev.id];
  if (ev.t === 'assistant_start') { store.live = ''; store.streaming = true; }
  if (ev.t === 'assistant_end') { store.live = ''; store.streaming = false; }
  if (ev.t === 'history_reset') { loadEventsFresh(sid); return; }
  if (ev.t === 'git') { state.gitInfo.set(sid, ev); }
  if (ev.t === 'turn_end') { const s = state.sessions.get(sid); if (s && s.project && s.project.git) gitStatus(sid, false).catch(() => {}); }
  if (ev.t === 'usage' || (ev.t === 'git' && ev.commit)) mineOnEvent(sid, ev);
  store.list.push(ev);
  if (store.list.length > 3000) store.list.splice(0, store.list.length - 3000);
  if (ev.t === 'approval_request' && state.dialog === 'inbox') renderInbox();
  queueRender(sid);
}

async function loadEventsFresh(sid) {
  state.events.delete(sid);
  await loadEvents(sid, -1);
}

function queueRender(sid) {
  state.renderQueued.add(sid);
  if (state._raf) return;
  state._raf = requestAnimationFrame(() => {
    state._raf = null;
    const sids = Array.from(state.renderQueued); state.renderQueued.clear();
    for (const s of sids) renderSession(s);
    tickStatusLines();
  });
}

function renderSession(sid) {
  const pane = $(`.pane[data-sid="${sid}"]`);
  if (pane) renderPaneBody(pane, sid);
  if (state.view === 'chat') for (const cp of $$(`.cpane[data-sid="${sid}"]`)) renderCpaneLog(cp);
  if (state.sid === sid && state.view === 'terminal') renderTermLog();
}

function renderAll() { renderHeader(); renderViews(); renderWall(); renderSidebar(); renderTitlebars(); renderSplit(); renderTermLog(); if (state.view === 'stats') renderStatsView(); if (state.view === 'fun') renderFunView(); tickStatusLines(); }

// ----------------------------------------------------------------------
// markdown, diffs, sanitising
// ----------------------------------------------------------------------
marked.setOptions({ gfm: true, breaks: false });
function renderMarkdown(text) {
  let html;
  try { html = marked.parse(text || ''); } catch { html = '<pre>' + esc(text) + '</pre>'; }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('script,iframe,object,embed,style,link,meta')) el.remove();
  for (const el of doc.querySelectorAll('*')) {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener'); }
  }
  for (const pre of doc.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (code) {
      const lang = (code.className.match(/language-(\S+)/) || [])[1];
      try {
        if (lang && hljs.getLanguage(lang)) code.innerHTML = hljs.highlight(code.textContent, { language: lang }).value;
        else if (code.textContent.length < 20000) code.innerHTML = hljs.highlightAuto(code.textContent).value;
      } catch {}
      code.classList.add('hljs');
    }
    const btn = doc.createElement('button'); btn.className = 'copy'; btn.textContent = 'copy'; btn.dataset.copy = '1';
    pre.appendChild(btn);
  }
  return doc.body.innerHTML;
}

function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  if (n * m > 250000) return A.map((l) => ['del', l]).concat(B.map((l) => ['add', l]));
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push(['ctx', A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['del', A[i++]]);
    else out.push(['add', B[j++]]);
  }
  while (i < n) out.push(['del', A[i++]]);
  while (j < m) out.push(['add', B[j++]]);
  return out;
}
function renderDiff(oldS, newS) {
  return '<div class="diff">' + lineDiff(oldS, newS).map(([k, l]) => `<div class="${k}">${k === 'add' ? '+' : k === 'del' ? '-' : ' '} ${esc(l)}</div>`).join('') + '</div>';
}

// ----------------------------------------------------------------------
// event stream -> chat DOM
// ----------------------------------------------------------------------
function toolBodyHtml(call, result) {
  const inp = call.input || {};
  let h = '';
  if (call.name === 'edit_file' || call.name === 'Edit') {
    h += `<div class="label">${esc(inp.path || inp.file_path || '')}</div>` + renderDiff(inp.old_str || inp.old_string || '', inp.new_str || inp.new_string || '');
  } else if (call.name === 'MultiEdit') {
    for (const ed of inp.edits || []) h += `<div class="label">${esc(inp.file_path || '')}</div>` + renderDiff(ed.old_string || '', ed.new_string || '');
  } else if (call.name === 'write_file' || call.name === 'Write') {
    h += `<div class="label">${esc(inp.path || inp.file_path || '')} · ${(inp.content || '').length} bytes</div><pre>${esc((inp.content || '').slice(0, 6000))}${(inp.content || '').length > 6000 ? '\n…' : ''}</pre>`;
  } else if (call.name === 'run_bash' || call.name === 'Bash') {
    h += `<div class="label">command${inp.description ? ' · ' + esc(inp.description) : ''}</div><pre>${esc(inp.command || '')}</pre>`;
  } else if (Object.keys(inp).length) {
    h += `<div class="label">input</div><pre>${esc(JSON.stringify(inp, null, 2))}</pre>`;
  }
  if (result) {
    h += `<div class="label">${result.is_error ? 'error' : 'result'}${result.elapsed != null ? ' · ' + result.elapsed + 's' : ''}${result.truncated ? ' · truncated' : ''}</div><pre>${esc(stripAnsi(result.content || '(empty)'))}</pre>`;
  }
  return h;
}

function buildChatHtml(store, sid, opts = {}) {
  const list = opts.tail ? store.list.slice(-opts.tail) : (opts.from != null ? store.list.slice(opts.from, opts.to == null ? undefined : opts.to) : store.list);
  const calls = new Map();
  const approvals = new Map();
  const out = [];
  let userTurn = -1;
  // count user turns before the tail for correct edit indices
  if (opts.tail) for (const e of store.list.slice(0, -opts.tail)) if (e.t === 'user') userTurn++;
  for (const e of store.list) if (e.t === 'approval_result') approvals.set(e.id, e.approved);
  const results = new Map();
  for (const e of store.list) if (e.t === 'tool_result') results.set(e.id, e);
  const base = opts.tail ? store.list.length - list.length : (opts.from || 0);
  if (opts.from) for (const e of store.list.slice(0, opts.from)) if (e.t === 'user') userTurn++;
  for (let k = 0; k < list.length; k++) {
    const e = list[k]; const idx = base + k;
    switch (e.t) {
      case 'user': {
        userTurn++;
        const imgs = (e.images || []).map((i) => attachmentHtml(sid, i)).join('');
        out.push(`<div class="msg msg-user" data-turn="${userTurn}" data-i="${idx}"><span class="who">you&gt;</span><div class="bubble">${esc(e.text)}${imgs ? `<div class="images">${imgs}</div>` : ''}</div>` +
          (opts.compact ? '' : `<div class="actions"><button data-act="undo" title="Undo to here: restore the worktree and the conversation to just before this message">↶</button><button data-act="edit" title="Edit and resend">✎</button><button data-act="fork" title="Fork from here">⑂</button><button data-act="copy" title="Copy message">⧉</button></div>`) + `</div>`);
        break;
      }
      case 'assistant_end':
        if (e.text) out.push(`<div class="msg msg-assistant" data-i="${idx}"><div class="who">kcoder&gt;<button class="copy-msg" data-act="copy" title="Copy as markdown">⧉ copy</button></div><div class="md">${renderMarkdown(e.text)}</div></div>`);
        break;
      case 'tool_call': {
        const res = results.get(e.id);
        const appr = approvals.get(e.id);
        let status;
        if (appr === false) status = '<span class="res declined">declined</span>';
        else if (res) status = `<span class="res${res.is_error ? ' err' : ''}">${res.is_error ? '✗ error' : '✓'}${res.elapsed != null ? ' ' + res.elapsed + 's' : ''}</span>`;
        else if ((e.name === 'run_bash' || e.name === 'Bash') && !(state.sessions.get(sid) || {}).pending_approval) status = `<span class="res pending">running… <button data-act="kill" data-cid="${esc(e.id)}" title="kill this command">■ kill</button></span>`;
        else status = `<span class="res pending">${(state.sessions.get(sid) || {}).pending_approval === e.id ? 'awaiting approval' : '…'}</span>`;
        const live = !res && store.toolLive && store.toolLive[e.id];
        out.push(`<details class="tool" data-cid="${esc(e.id)}"${(res && res.is_error) || live ? ' open' : ''}><summary><span class="gear">⚙</span><span class="desc">${esc(e.description)}</span>${status}</summary><div class="body">${toolBodyHtml(e, res)}${live ? `<div class="label">live output</div><pre>${esc(stripAnsi(live))}</pre>` : ''}</div></details>`);
        break;
      }
      case 'approval_request': {
        const decided = approvals.has(e.id) || results.has(e.id);
        const sess = state.sessions.get(sid);
        const live = !decided && sess && sess.pending_approval === e.id;
        if (live) out.push(`<div class="approval${e.kind === 'review' ? ' review' : e.kind === 'connector' ? ' connector' : ''}" data-rid="${esc(e.id)}"><span>${e.kind === 'review' ? 'Review' : e.kind === 'connector' ? 'Connector' : 'Allow'}</span><code>${esc(e.description)}</code>${e.kind === 'review' ? '<button data-act="changes" title="see the diff first">review changes</button>' : ''}<button class="primary" data-act="approve">${e.kind === 'review' ? 'approve' : 'yes'} <kbd>y</kbd></button><button class="danger" data-act="decline">${e.kind === 'review' ? 'decline' : 'no'} <kbd>n</kbd></button></div>`);
        break;
      }
      case 'usage':
        if (!opts.compact) out.push(`<div class="note usage">${e.recap ? '📍 recap written · ' : '✓ '}${e.elapsed != null ? e.elapsed.toFixed ? e.elapsed.toFixed(1) + 's · ' : e.elapsed + 's · ' : ''}${fmtInt(e.input)} in → ${fmtInt(e.output)} out tokens${e.plan ? ' · on your plan' : e.cost ? ' · ' + fmtUsd(e.cost) : ''}</div>`);
        break;
      case 'error': out.push(`<div class="note err">${esc(e.text)}${e.fix === 'claude-login' ? ' <button class="primary" data-fix="claude">Reconnect Claude</button>' : e.fix === 'plan-limit' ? ' <button data-fix="claude">Claude plan</button>' : ` <button data-err="${esc(sid)}" title="what happened, send again, copy a report">details</button>`}</div>`); break;
      case 'notice': out.push(`<div class="note warn">${esc(e.text)}</div>`); break;
      case 'retry': out.push(`<div class="note warn">↻ ${esc(e.reason)} - retrying in ${e.delay}s (${e.attempt}/${e.max})</div>`); break;
      case 'info': out.push(`<div class="note${e.kind === 'quota_shift' ? ' shift' : ''}">${e.kind === 'quota_shift' ? '⇣ ' : ''}${esc(e.text)}</div>`); break;
      case 'system': out.push(`<div class="note">${esc(e.text)}</div>`); break;
      case 'compaction': out.push(`<div class="note marker">✂ context compacted here (${e.messages_before} messages → summary)</div>`); break;
      case 'compaction_start': out.push(`<div class="note">✂ compacting context (${fmtInt(e.tokens)} tokens)…</div>`); break;
      case 'handoff_start': out.push(`<div class="note">⇢ context at ${fmtInt(e.tokens)} tokens - writing the handoff summary for a fresh session…</div>`); break;
      case 'handoff': out.push(`<div class="note marker">⇢ ${esc(e.text || '')} <button data-open="${esc(e.to)}">open ${esc(e.name)}</button></div>`); break;
      case 'queue': out.push(`<div class="note">▶ queued task started (${e.remaining} left): ${esc(e.started)}</div>`); break;
      case 'git': out.push(`<div class="note${e.kind === 'deploy' ? ' deploy' : ''}">${e.kind === 'deploy' ? '☁ ' : ''}${esc(e.text || '')}</div>`); break;
      case 'job': out.push(`<div class="note job ${esc(e.status || '')}">${e.status === 'running' ? '▶' : e.status === 'done' ? '✓' : '✗'} ${esc(e.text || '')} <button data-job="${e.id}" title="output, stop">output</button></div>`); break;
    }
  }
  if (!opts.noTail) out.push(trailerHtml(store, sid));
  return out.join('');
}
// ---- the working indicator: a live status line with a playful verb ----
// Edit these lists freely. Verbs rotate every few seconds, never repeating one of the last five;
// past LONG_HAUL_AFTER the long-haul set takes over. Compacting, retries and approvals use plain wording.
const WORK_VERBS = ['Wibbling', 'Woobling', 'Noodling', 'Percolating', 'Bamboozling', 'Fiddling', 'Tinkering', 'Schlepping', 'Puttering', 'Boondoggling',
  'Mining', 'Kickflipping', 'Carving', 'Shredding', 'Hodling', 'Bootstrapping', 'Doodling', 'Brewing', 'Summiting', 'Acclimatizing', 'Traversing',
  'Sending it', 'Waiting for the lift', 'Sherpaing', 'Grinding', 'Hashing it out', 'Underwriting', 'Rebalancing', 'Compounding'];
const LONG_HAUL_VERBS = ['Still summiting', 'Above the treeline', 'Are we there yet?', 'Hodling through it', 'Not selling', 'Just one more', 'Second to last lap'];
const VERB_EVERY_MS = 4000, LONG_HAUL_AFTER_MS = 10 * 60 * 1000;
function pickVerb(sid, elapsedMs) {
  const v = state.verbs.get(sid) || { verb: '', at: 0, recent: [] };
  const pool = elapsedMs >= LONG_HAUL_AFTER_MS ? LONG_HAUL_VERBS : workVerbs();   // the star shop can swap the set
  const now = Date.now();
  if (!v.verb || now - v.at >= VERB_EVERY_MS || !pool.includes(v.verb)) {
    const cands = pool.filter((x) => !v.recent.includes(x));
    const from = cands.length ? cands : pool;
    v.verb = from[Math.floor(Math.random() * from.length)]; v.at = now; v.recent = [v.verb, ...v.recent].slice(0, 5);
    try { const all = JSON.parse(localStorage.getItem('kcoder.verbCounts') || '{}'); const mo = new Date().toISOString().slice(0, 7); all[mo] = all[mo] || {}; all[mo][v.verb] = (all[mo][v.verb] || 0) + 1; for (const k of Object.keys(all)) if (k < new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 7)) delete all[k]; localStorage.setItem('kcoder.verbCounts', JSON.stringify(all)); } catch {}
  }
  state.verbs.set(sid, v);
  return v.verb;
}
function fmtElapsed(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`; }
const TOOL_SHORT = { run_bash: 'Bash', read_file: 'Read', write_file: 'Write', edit_file: 'Edit', list_dir: 'List' };
function turnInfo(sid) {
  const store = state.events.get(sid); const sess = state.sessions.get(sid);
  if (!store || !sess) return null;
  const list = store.list; let i = list.length - 1;
  while (i >= 0 && list[i].t !== 'turn_start') i--;
  const start = i >= 0 ? list[i].ts : (sess.last_activity || Date.now() / 1000);
  let phase = 'thinking', since = start, tool = null, retry = null; const open = new Map();
  for (let k = Math.max(i, 0); k < list.length; k++) {
    const e = list[k];
    switch (e.t) {
      case 'tool_call': open.set(e.id, e); phase = 'tool'; tool = e; since = e.ts; break;
      case 'tool_result': open.delete(e.id); tool = open.size ? Array.from(open.values()).pop() : null; phase = tool ? 'tool' : 'thinking'; since = e.ts; break;
      case 'assistant_start': phase = 'writing'; since = e.ts; break;
      case 'assistant_end': case 'approval_result': case 'compaction': phase = 'thinking'; since = e.ts; break;
      case 'compaction_start': phase = 'compacting'; since = e.ts; break;
      case 'retry': phase = 'retry'; retry = e; since = e.ts; break;
    }
  }
  if (store.streaming || store.live) phase = 'writing';
  if (sess.pending_approval) phase = 'approval';
  const t = store.turn || {};
  return { start, phase, since, tool, retry, inTok: t.input || 0, outTok: t.output || 0, ctx: sess.context_tokens || 0, cap: sess.compact_at || 150000 };
}
function statusLineHtml(sid, mini) {
  return `<span class="statusline${mini ? ' mini' : ''}" data-sid="${sid}"><span class="spin">◐</span><span class="verb"></span><span class="elapsed"></span>` +
    (mini ? '' : `<span class="sep">·</span><span class="tok"></span><span class="sep">·</span><span class="phase"></span><span class="sep">·</span><span class="ctx"></span><span class="sep">·</span><span class="hint">esc to interrupt</span>`) + '</span>';
}
function fillStatusLine(el) {
  const sid = el.dataset.sid; const info = turnInfo(sid); if (!info) return;
  const now = Date.now() / 1000; const elapsedMs = (now - info.start) * 1000;
  const sinceS = Math.max(0, now - info.since);
  const plain = info.phase === 'compacting' ? 'Compacting context' : info.phase === 'approval' ? 'Waiting for your approval'
    : info.phase === 'retry' ? (info.retry && sinceS < (info.retry.delay || 0) ? `Retrying in ${Math.ceil(info.retry.delay - sinceS)}s (${info.retry.attempt}/${info.retry.max})` : 'Retrying') : '';
  el.classList.toggle('plain', !!plain);
  if (el.classList.contains('mini')) {   // sidebar: spinner, verb (or a short plain word), compact elapsed
    $('.verb', el).textContent = plain ? { compacting: 'compacting', approval: 'needs approval', retry: 'retrying' }[info.phase] : pickVerb(sid, elapsedMs) + '…';
    $('.elapsed', el).textContent = elapsedMs >= 60000 ? fmtElapsed(elapsedMs).replace(/ \d+s$/, '') : fmtElapsed(elapsedMs);
    return;
  }
  $('.verb', el).textContent = plain || pickVerb(sid, elapsedMs) + '…';
  $('.elapsed', el).textContent = fmtElapsed(elapsedMs);
  $('.tok', el).textContent = `↑ ${fmtTokens(info.inTok)} in · ↓ ${fmtTokens(info.outTok)} out`;
  const name = info.tool ? (TOOL_SHORT[info.tool.name] || info.tool.name || 'tool') : '';
  $('.phase', el).textContent = info.phase === 'thinking' ? `thinking ${fmtElapsed(sinceS * 1000)}` : info.phase === 'tool' ? `running ${name}${sinceS >= 2 ? ' ' + fmtElapsed(sinceS * 1000) : ''}`
    : info.phase === 'writing' ? 'writing' : info.phase === 'compacting' ? 'compacting' : info.phase === 'retry' ? (info.retry ? esc(info.retry.reason || 'retrying') : 'retrying') : 'paused for approval';
  const pct = info.cap ? Math.round(info.ctx / info.cap * 100) : 0;
  const cx = $('.ctx', el); cx.textContent = `ctx ${pct}%`; cx.title = `${fmtTokens(info.ctx)} of ${fmtTokens(info.cap)} tokens before the context is compacted`; cx.classList.toggle('hot', pct >= 80);
}
function tickStatusLines() { for (const el of $$('.statusline')) { const s = state.sessions.get(el.dataset.sid); if (s && s.status === 'working') fillStatusLine(el); } }
setInterval(tickStatusLines, 1000);

function trailerHtml(store, sid) {
  const sess = state.sessions.get(sid);
  if (store.streaming || store.live) return `<div class="msg msg-assistant streaming"><div class="who">kcoder&gt;</div><div class="md">${store.live ? renderMarkdown(store.live) : ''}</div></div>` + (sess && sess.status === 'working' ? `<div class="note working">${statusLineHtml(sid)}</div>` : '');
  if (sess && sess.status === 'working') return `<div class="note working">${statusLineHtml(sid)}</div>`;
  if (sess && sess.status === 'paused') {   // the one place with the controls: the status line, the pane bar and the log line only say "paused"
    const rt = (sess.resume_text || '').trim();
    return `<div class="note paused"><b>paused</b> - ${rt ? `the interrupted turn: <code title="${esc(rt)}">${esc(rt.length > 90 ? rt.slice(0, 88) + '…' : rt)}</code>` : 'the interrupted turn is waiting'} <button class="primary" data-act="resume" title="send the interrupted turn again">resume</button> <button data-act="dismiss" title="drop the interrupted turn">dismiss</button></div>`;
  }
  return '';
}

// ----------------------------------------------------------------------
// event stream -> terminal DOM (looks like the CLI)
// ----------------------------------------------------------------------
function buildTermHtml(store, sid, opts = {}) {
  const list = opts.tail ? store.list.slice(-opts.tail) : store.list;
  const out = [];
  const approvals = new Map();
  for (const e of store.list) if (e.t === 'approval_result') approvals.set(e.id, e.approved);
  const sess = state.sessions.get(sid);
  if (!opts.tail && sess) {
    const trust = sess.trust || 'read';
    out.push(`<span class="t-panel">╭─ session ─────────────────────────────────╮</span>\n` +
      `<span class="t-panel">│</span>  <span class="t-dim">session</span>  <b>${esc(sess.name)}</b>  <span class="t-dim">${sess.id}</span>\n` +
      `<span class="t-panel">│</span> <span class="t-dim">provider</span>  <b>${esc(sess.provider)}</b>\n` +
      `<span class="t-panel">│</span>    <span class="t-dim">model</span>  <b>${esc(sess.model)}</b>\n` +
      `<span class="t-panel">│</span>      <span class="t-dim">cwd</span>  ${esc(shortHome(sess.cwd))}\n` +
      `<span class="t-panel">│</span>    <span class="t-dim">trust</span>  ${esc(trust)}\n` +
      `<span class="t-panel">╰───────────────────────────────────────────╯</span>\n<span class="t-dim">/help for commands</span>\n\n`);
  }
  for (const e of list) {
    switch (e.t) {
      case 'user': out.push(`<span class="t-you">you&gt;</span> ${esc(e.text)}${(e.images || []).map((i) => ` <span class="t-acc">🖼 ${esc(i)}</span>`).join('')}\n`); break;
      case 'assistant_end': out.push(`<span class="t-k">kcoder&gt;</span>\n${esc(e.text)}\n`); break;
      case 'usage': out.push(`<span class="t-dim">✓ ${e.elapsed != null ? Number(e.elapsed).toFixed(1) + 's · ' : ''}${fmtInt(e.input)} in → ${fmtInt(e.output)} out tokens</span>\n`); break;
      case 'tool_call': { out.push(`<span class="t-dim">⚙ ${esc(e.description)}</span>\n`); const live = store.toolLive && store.toolLive[e.id]; if (live) out.push(`<span class="t-dim">${esc(stripAnsi(live)).split('\n').slice(-12).join('\n')}</span>\n`); break; }
      case 'approval_request': {
        const decided = approvals.has(e.id);
        const live = !decided && sess && sess.pending_approval === e.id;
        if (live) out.push(`<span class="t-approval">Allow <b>${esc(e.description)}</b>? <button data-act="approve" data-rid="${esc(e.id)}">y</button><button data-act="decline" data-rid="${esc(e.id)}">n</button></span>\n`);
        break;
      }
      case 'approval_result': out.push(`<span class="t-dim">  ${e.approved ? '✓ approved' : '✗ declined'}</span>\n`); break;
      case 'tool_result': if (e.is_error) out.push(`<span class="t-dim">  ${e.dry_run ? '◌ dry run: not executed' : (e.rule ? '⛔ ' : '✗ ') + esc(stripAnsi(e.content || '').split('\n')[0])}</span>\n`); break;
      case 'error': case 'notice': out.push(`<span class="t-err">${esc(e.text)}</span>\n`); break;
      case 'retry': out.push(`<span class="t-warn">↻ ${esc(e.reason)} - retrying in ${e.delay}s (${e.attempt}/${e.max})</span>\n`); break;
      case 'info': case 'system': case 'git': case 'job': out.push(`<span class="t-dim">${esc(e.text || '')}</span>\n`); break;
      case 'compaction': out.push(`<span class="t-dim">✂ compacted ${e.messages_before} messages into a summary</span>\n`); break;
      case 'compaction_start': out.push(`<span class="t-dim">✂ context at ${fmtInt(e.tokens)} tokens - compacting…</span>\n`); break;
      case 'handoff_start': out.push(`<span class="t-dim">⇢ context at ${fmtInt(e.tokens)} tokens - writing the handoff summary…</span>\n`); break;
      case 'handoff': out.push(`<span class="t-dim">⇢ ${esc(e.text || '')}</span>\n`); break;
      case 'queue': out.push(`<span class="t-dim">▶ next queued task (${e.remaining} left): ${esc(e.started)}</span>\n`); break;
      case 'turn_end': out.push('\n'); break;
    }
  }
  if (store.streaming || store.live) out.push(`<span class="t-k">kcoder&gt;</span>\n${esc(store.live)}<span class="cursor">▍</span>\n`);
  if (sess && sess.status === 'working') out.push(statusLineHtml(sid) + '\n');
  return out.join('');
}

// ----------------------------------------------------------------------
// header
// ----------------------------------------------------------------------
const TAGLINES = ['ten agents, one keyboard.', 'ship it before the coffee cools.', 'parallel by default.', 'less typing, more shipping.', 'every session earns its keep.', 'small commits, big days.'];
const ABOUT_LINES = ['keep ripping lines.', 'rip lines, ship lines.', 'first chair, last commit.', 'fresh tracks, clean diffs.', 'send it.', 'no friends on a powder day, plenty of agents.'];   // the about dialog's italic line
const tabOf = (v) => (v === 'chat' ? 'wall' : v);   // the sessions tab covers the grid and the 1-3 pane layouts

function renderHeader() {
  // header: navigation and actions only; everything informational is in the status bar
  $('#banner').textContent = BANNER;
  const big = $('#wall-empty .banner'); if (big && !big.textContent) big.textContent = BANNER;
  const st = state.stats || {};
  const n = (st.pending_approvals || []).length;
  const needs = Math.max(n, st.waiting || 0);   // approvals + sessions waiting on an answer
  const c = $('#inbox-count'); c.hidden = !needs; c.textContent = needs;
  $('#btn-inbox').title = needs ? `${needs} waiting on you: approvals and questions  (a)` : 'Inbox: approvals and sessions waiting on you  (a)';
  const tk = (st.tasks || {}).counts || {}; const openTasks = (tk.queued || 0) + (tk.running || 0);
  const tc = $('#tasks-count'); if (tc) { tc.hidden = !openTasks; tc.textContent = openTasks; }
  for (const b of $$('.views button')) b.classList.toggle('active', b.dataset.view === tabOf(state.view));
  renderSessionsBar();
  renderStatusBar();
  const pinned = state.pins.length;
  document.title = (needs ? `(${needs}) ` : '') + 'kcoder' + (pinned ? ` · ${pinned} pinned` : '');
}

function renderSessionsBar() {
  const bar = $('#sessions-bar'); if (!bar) return;
  const on = state.view === 'wall' || state.view === 'chat';
  bar.hidden = !on;
  if (!on) return;
  const cur = state.view === 'wall' ? 'grid' : String(state.layout.panes.length);
  for (const b of $$('.layout-picker button', bar)) b.classList.toggle('active', b.dataset.layout === cur);
  const bc = $('#btn-broadcast'); bc.classList.toggle('active', !!state.broadcast); bc.hidden = state.view !== 'chat' || state.layout.panes.length < 2;
  const n = state.order.length;
  $('#sessions-hint').textContent = state.view === 'wall' ? (n ? `${n} live session${n === 1 ? '' : 's'} · click a pane to focus it · 1-9 jump` : '') : (state.broadcast ? 'broadcast on: a prompt goes to every pane' : 'drag a chat from the sidebar onto a pane');
}

function renderStatusBar() {
  const st = state.stats || {};
  const today = st.today || {};
  const tokens = (today.input || 0) + (today.output || 0);
  const items = [
    `<button class="status-item${st.cap_reached ? ' bad' : ''}" data-go="sessions" title="live sessions · open the sessions grid"><b>${st.sessions || 0}</b> active${st.cap_reached ? ' · paused (daily cap)' : ''}</button>`,
    `<button class="status-item" data-go="stats:tokens" title="tokens today · open stats"><b>${fmtTokens(tokens)}</b> tokens today</button>`,
    `<button class="status-item" data-go="stats:commits" title="commits today · open stats"><b>${st.commits_today || 0}</b> commit${st.commits_today === 1 ? '' : 's'} today</button>`,
  ];
  const qm = quotaItemHtml(st.quota); if (qm) items.push(qm);
  const up = st.update || {};
  if (st.restarting) items.push(`<span class="status-item warn">restarting kcoderd…</span>`);
  else if (up.available) items.push(`<button class="status-item warn" data-upd="1" title="${esc((up.commits || []).join('\n'))}">${up.behind} new commit${up.behind === 1 ? '' : 's'}${up.failed ? ' · failed, rolled back' : ' · click to update'}</button>`);
  $('#status-items').innerHTML = items.join('<span class="sep">·</span>');
  const v = state.version || {};
  const vb = $('#btn-version'); vb.textContent = 'kcoder ' + (v.running || ''); vb.title = `kcoder ${v.running || ''}${v.installed && v.installed !== v.running ? ` (${v.installed} on disk, restart to use it)` : ''}${v.dev ? ' · git checkout' : ''} · settings`;
}

// ---- the weekly plan limit meter (kcoder/quota.py): used, reset, pace, forecast; labelled by source
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
function quotaWhen(ts) { if (!ts) return ''; const d = new Date(ts * 1000); const now = new Date(); const sameDay = d.toDateString() === now.toDateString(); const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); return sameDay ? `today ${t}` : d.toLocaleDateString([], { weekday: 'short' }) + ' ' + t; }
function quotaPace(q) {
  if (!q || q.source === 'none' || q.utilization == null) return '';
  if (q.utilization >= 1) return 'limit reached';
  if (!q.forecast_reliable) return 'too early to forecast';
  if (q.forecast_hit && !q.on_track) return `at this pace you hit the limit ${quotaWhen(q.forecast_hit)}`;
  if (q.projected_at_reset != null) return `on pace: ~${Math.round(Math.min(1, q.projected_at_reset) * 100)}% at the reset`;
  return '';
}
function quotaLevelClass(q) { return !q ? '' : q.level === 'full' || q.level === 'warn90' ? 'bad' : q.level === 'warn75' || (q.forecast_reliable && !q.on_track) ? 'warn' : ''; }
function quotaItemHtml(q) {
  if (!q || q.source === 'none') return '';
  const pct = Math.round((q.utilization || 0) * 100);
  const bar = `<span class="qbar" aria-hidden="true"><i style="width:${Math.min(100, pct)}%"></i>${q.elapsed_fraction != null ? `<b style="left:${Math.round(q.elapsed_fraction * 100)}%" title="now"></b>` : ''}</span>`;
  const pace = quotaPace(q);
  const src = q.source === 'provider' ? 'from Claude Code' : 'estimate';
  const title = `weekly plan limit · ${pct}% used (${src})${q.resets_at ? ' · resets ' + quotaWhen(q.resets_at) : ''}${pace ? '\n' + pace : ''}${q.shift_active ? '\nquota shift on: small turns run on the cheaper model' : ''}\nclick for the full meter`;
  return `<button class="status-item quota ${quotaLevelClass(q)}" data-go="stats:quota" title="${esc(title)}">wk ${bar} <b>${pct}%</b>${q.resets_at ? ` <span class="dim">· resets ${esc(quotaWhen(q.resets_at))}</span>` : ''}${q.forecast_reliable && !q.on_track && q.utilization < 1 ? ` <span class="hit">· hits limit ${esc(quotaWhen(q.forecast_hit))}</span>` : ''}${q.shift_active ? ' <span class="shift" title="quota shift: small turns go to the cheaper model while the forecast says the limit runs out early">⇣ cheaper models</span>' : ''}</button>`;
}

function setView(v) {
  if (v === 'terminal') v = 'chat';
  state.view = v; localStorage.setItem('kcoder.view', v); syncUiState();
  if (v === 'wall' || v === 'chat') localStorage.setItem('kcoder.sessionsView', v);
  if (v === 'tasks') setTimeout(() => renderTasksView(true), 0);
  renderViews();
  if (v === 'chat') { if (!focusedSid() && state.order[0]) { state.layout.panes[state.layout.focus] = state.order[0]; saveLayout(); } for (const sid of state.layout.panes) if (sid) loadEvents(sid, -1); syncSid(); }
  else if (v === 'stats') statsData = null;
  renderAll();
  if (v === 'chat') focusComposer();
}
function renderViews() {
  for (const s of $$('.view')) s.hidden = s.id !== 'view-' + state.view;
  for (const b of $$('.views button')) b.classList.toggle('active', b.dataset.view === tabOf(state.view));
  renderSessionsBar();
}
// the sessions tab: the grid of every live session, or 1 to 3 panes side by side
function openSessions() { if (state.view === 'wall' || state.view === 'chat') return; setView(localStorage.getItem('kcoder.sessionsView') === 'chat' ? 'chat' : 'wall'); }
function setLayout(which) {
  if (which === 'grid') { if (state.view !== 'wall') setView('wall'); else renderSessionsBar(); return; }
  const n = Math.max(1, Math.min(3, Number(which) || 1));
  const L = state.layout;
  if (!Array.isArray(L.panes) || !L.panes.length) L.panes = [null];
  while (L.panes.length < n) L.panes.push(null);
  if (L.panes.length > n) L.panes = L.panes.slice(0, n);
  L.focus = Math.min(L.focus || 0, n - 1); L.zoom = null; saveLayout();
  if (state.view !== 'chat') setView('chat'); else { renderSplit(); renderSidebar(); renderSessionsBar(); }
}

// ----------------------------------------------------------------------
// wall
// ----------------------------------------------------------------------
function paneStatus(s) {
  if (s.status === 'paused') return 'paused';
  if (state.stats.cap_reached && s.status === 'idle') return 'capped';
  if (s.status === 'idle') return (s.usage && s.usage.turns) ? 'done' : 'idle';
  return s.status;
}
function visibleSessions() {
  let list = state.order.map((id) => state.sessions.get(id)).filter(Boolean);
  if (state.pins.length) { const pinned = list.filter((s) => state.pins.includes(s.id)); if (pinned.length) list = pinned; }
  return list;
}

function renderWall() {
  const wall = $('#wall');
  const list = visibleSessions();
  $('#wall-empty').hidden = list.length > 0;
  const n = list.length;
  wall.style.setProperty('--pane-min', n <= 2 ? '520px' : n <= 6 ? '400px' : n <= 9 ? '340px' : '300px');
  const seen = new Set();
  if (state.focus && !state.sessions.has(state.focus)) state.focus = null;
  wall.classList.toggle('focus', !!state.focus);
  list.forEach((s, i) => {
    seen.add(s.id);
    let pane = $(`.pane[data-sid="${s.id}"]`, wall);
    if (!pane) { pane = document.createElement('div'); pane.className = 'pane'; pane.dataset.sid = s.id; pane.innerHTML = paneSkeleton(); wall.appendChild(pane); wirePane(pane, s.id); }
    if (wall.children[i] !== pane) wall.insertBefore(pane, wall.children[i] || null);
    pane.classList.toggle('focused', s.id === state.focus);
    renderPaneChrome(pane, s, i + 1);
    renderPaneBody(pane, s.id);
  });
  for (const p of $$('.pane', wall)) if (!seen.has(p.dataset.sid)) { closeShell(p.dataset.sid); p.remove(); }
}

function paneSkeleton() {
  return `<div class="pane-title"><span class="num"></span><span class="dot"></span><span class="name"></span><span class="repo"></span><span class="model"></span><span class="spacer"></span><span class="window-pin" title="pin to this window">📌</span><span class="view-toggle" title="view: chat / terminal / shell  (v)"></span></div>
  <div class="pane-body"></div>
  <div class="shell-drawer" hidden></div>
  <div class="approval-bar" hidden></div>
  <div class="pane-actions" hidden></div>
  <div class="composer-slot" hidden></div>
  <div class="pane-status"></div>`;
}

function renderPaneChrome(pane, s, num) {
  const st = paneStatus(s);
  pane.className = 'pane st-' + st + (pane.classList.contains('focused') ? ' focused' : '') + (pane.classList.contains('dragging') ? ' dragging' : '') + (state.sid === s.id ? ' active' : '');
  $('.num', pane).textContent = num <= 9 ? num : '';
  $('.dot', pane).className = 'dot ' + st;
  $('.name', pane).textContent = s.title && s.title !== s.name ? `${s.name} · ${s.title}` : s.name;
  $('.name', pane).title = s.title || s.name;
  const proj = s.project || {};
  const branch = s.worktree ? s.worktree.branch : (state.gitInfo.get(s.id) || {}).branch;
  $('.repo', pane).textContent = proj.name ? proj.name + (branch ? ' @ ' + branch : '') : shortHome(s.cwd);
  const am = (s.active_model || '').split('/')[1];
  $('.model', pane).textContent = s.model === 'auto' ? (am && am !== 'auto' ? 'auto → ' + am : 'auto') : (s.model || '');
  $('.model', pane).title = s.model === 'auto' ? 'model routing: ' + (s.active_model || '') : (s.active_model || '');
  let chips = $('.chips', pane); if (!chips) { chips = document.createElement('span'); chips.className = 'chips'; $('.model', pane).after(chips); }
  chips.innerHTML = paneChips(s);
  $('.window-pin', pane).classList.toggle('on', state.pins.includes(s.id));
  const pv = paneViewOf(s.id);
  $('.view-toggle', pane).textContent = pv === 'term' ? '▤' : pv === 'shell' ? '$' : pv === 'preview' ? '▶' : '☰';
  const u = s.usage || {};
  const ctx = s.context_tokens || 0;
  const git = state.gitInfo.get(s.id);
  $('.pane-status', pane).innerHTML =
    `<span title="context used (last prompt)">ctx ${fmtTokens(ctx)}</span><span title="tokens in+out">${fmtTokens((u.input || 0) + (u.output || 0))} tok</span><span title="${s.plan ? 'covered by your Claude plan' : 'API spend'}">${s.plan ? 'plan' : fmtUsd(u.cost || 0)}</span>` +
    (s.queue && s.queue.length ? `<span title="queued tasks">▶ ${s.queue.length} queued</span>` : '') +
    (git ? `<span class="git-line" title="git">${esc(git.branch || '')}${git.dirty ? ` <span class="dirty">±${git.dirty}</span>` : ''}${git.ahead ? ` ↑${git.ahead}` : ''}</span>` : '') +
    `<span class="spacer"></span>` +
    (st === 'waiting' ? `<span class="waiting">WAITING ON YOU</span>` : st === 'paused' ? `<span class="waiting">PAUSED</span>` : st === 'capped' ? `<span>paused (cap)</span>` : st === 'error' ? `<span class="waiting errlabel">ERROR</span><button data-err="${esc(s.id)}" title="what happened, send again, copy a report">details</button>` : '') +
    `<span>${age(s.last_activity)} ago</span>`;
  // approval bar
  const bar = $('.approval-bar', pane);
  if (s.pending_approval) {
    const store = state.events.get(s.id);
    const req = store && store.list.slice().reverse().find((e) => e.t === 'approval_request' && e.id === s.pending_approval);
    bar.hidden = false;
    bar.innerHTML = `<span>allow</span><code title="${esc(req ? req.description : '')}">${esc(req ? req.description : 'pending tool call')}</code><button class="primary" data-act="approve" data-rid="${esc(s.pending_approval)}">yes</button><button class="danger" data-act="decline" data-rid="${esc(s.pending_approval)}">no</button><span class="keys" title="keyboard: y approves, shift+N declines, then the next waiting item comes up; w jumps to the next one">y · ⇧N · w</span>`;
  } else bar.hidden = true;
  // actions (focused only)
  const acts = $('.pane-actions', pane);
  const focused = pane.classList.contains('focused');
  acts.hidden = !focused;
  if (focused) {
    acts.innerHTML =
      `<button data-act="interrupt" ${s.status === 'working' || s.status === 'waiting' ? '' : 'disabled'}>■ interrupt</button>` +
      `<button data-act="queue">+ task</button>` +
      `<select data-act="trust" title="trust level"><option value="auto">trust: auto</option><option value="write">trust: write</option><option value="read">trust: read</option><option value="none">trust: none</option><option value="dry">trust: dry run</option></select>` +
      `<select data-act="model" title="model"></select>` +
      (s.project && s.project.git ? `<button data-act="git">git status</button><button data-act="pull" title="git pull --ff-only from the remote">⇣ pull</button>` : '') +
      (s.worktree ? `<button data-act="merge" title="merge this session's branch into the project">⇤ merge</button><button data-act="pr">open PR</button><button data-act="discard" class="danger">discard</button>` : '') +
      (s.worktree ? `<button data-act="changes" title="review this session's changes hunk by hunk">${s.needs_review ? '⚑ ' : ''}changes</button>` : '') +
      `<button data-act="preview" title="live preview: the dev server for this worktree, in this pane">▶ preview</button>` +
      `<button data-act="instructions" title="the repo's instruction file (KCODER.md / AGENTS.md / CLAUDE.md)">instructions</button>` +
      `<button data-act="open-chat">open in chat</button><button data-act="export">export</button><button data-act="archive">archive</button>`;
    $('select[data-act="trust"]', acts).value = s.trust || 'read';
    fillModelSelect($('select[data-act="model"]', acts), s);
  }
  const slot = $('.composer-slot', pane);
  slot.hidden = paneViewOf(s.id) === 'shell';
  if (!slot.hidden && !slot.firstChild) mountComposer(slot, s.id, paneViewOf(s.id) === 'term');
  else if (!slot.hidden) updateComposerState(slot, s.id);
  pane.classList.toggle('compact', !focused);
  const ta = $('.composer textarea', slot); if (ta) ta.placeholder = focused ? 'Message kcoder…  (Enter sends · Shift+Enter newline · / commands · @ files · Esc interrupts)' : 'Message ' + s.name + '…';
}

function fillModelSelect(sel, s) {
  const prov = (state.providers || []).find((p) => p.id === s.provider);
  const models = prov ? prov.models.slice() : [];
  if (prov && prov.auto && !models.includes('auto')) models.unshift('auto');
  if (s.model && !models.includes(s.model)) models.unshift(s.model);
  sel.innerHTML = models.map((m) => `<option value="${esc(m)}">${m === 'auto' ? `auto (${esc(((prov && prov.tiers) || {}).small || '')} / ${esc(((prov && prov.tiers) || {}).large || '')})` : claudeModelNote(s.provider, m) ? esc(m) + ' (' + claudeModelNote(s.provider, m) + ')' : esc(m)}</option>`).join('') + '<option value="__other">other model…</option>';
  sel.value = s.model;
}

function paneViewOf(sid) { return state.paneView.get(sid) || 'chat'; }

function renderPaneBody(pane, sid) {
  const body = $('.pane-body', pane);
  const store = state.events.get(sid) || { list: [], live: '' };
  const pv = paneViewOf(sid);
  const focused = pane.classList.contains('focused');
  if (pv === 'shell') { body.className = 'pane-body shell-box'; ensureShell(sid, body); return; }
  if (pv === 'preview') { body.className = 'pane-body preview-box'; renderPreviewPane(body, sid); return; }
  if (pv === 'term') {
    body.className = 'pane-body term';
    body.innerHTML = buildTermHtml(store, sid, { tail: focused ? 0 : 40 });
  } else {
    body.className = 'pane-body';
    if (!$('.chat-log', body)) body.innerHTML = '<div class="chat-log"></div>';
    renderLogInto(pane, $('.chat-log', body), sid, store, { tail: focused ? 0 : 30, compact: !focused }, body);
    return;
  }
  body.scrollTop = body.scrollHeight;
}

// Render a session's events into a .chat-log. After the first full render the
// log is only ever appended to or patched in place (new events, the streaming
// bubble, tool status changes), so text selections survive streaming.
function renderLogInto(holder, log, sid, store, opts, scroller) {
  scroller = scroller || log;
  const r = holder._rendered;
  const toolSig = store.toolLive ? Object.keys(store.toolLive).map((k) => k + ':' + store.toolLive[k].length).join(',') : '';
  const sess = state.sessions.get(sid);
  const status = sess ? sess.status + ':' + (sess.pending_approval || '') : '';
  const optsKey = `${opts.tail || 0}|${opts.compact ? 1 : 0}`;
  const streaming = !!(store.streaming || store.live);
  const stick = !r || nearBottom(scroller);
  const incremental = r && r.sid === sid && r.store === store && r.optsKey === optsKey && !opts.tail && r.count <= store.list.length;
  let changed = true;
  if (!incremental) {
    log.innerHTML = buildChatHtml(store, sid, opts);
  } else {
    changed = false;
    if (store.list.length > r.count) {
      changed = true;
      for (const el of $$(':scope > .msg.streaming, :scope > .note.working, :scope > .note.paused', log)) el.remove();
      log.insertAdjacentHTML('beforeend', buildChatHtml(store, sid, { from: r.count }));
      for (const e of store.list.slice(r.count)) {
        if (e.t === 'tool_result' || e.t === 'approval_result') {
          const k = store.list.findIndex((x) => x.t === 'tool_call' && x.id === e.id);
          if (k >= 0 && k < r.count) patchTool(log, store, sid, k, e.id);
          if (e.t === 'approval_result') { const a = log.querySelector(`.approval[data-rid="${CSS.escape(e.id)}"]`); if (a) a.remove(); }
        }
      }
    } else if (r.live !== store.live || r.streaming !== streaming || r.status !== status) {
      changed = true;
      let live = $(':scope > .msg.streaming', log);
      if (streaming) {
        if (!live) { const w = $(':scope > .note.working, :scope > .note.paused', log); if (w) w.remove(); log.insertAdjacentHTML('beforeend', trailerHtml(store, sid)); }
        else if (r.live !== store.live) $('.md', live).innerHTML = renderMarkdown(store.live);
      } else {
        if (live) live.remove();
        const w = $(':scope > .note.working, :scope > .note.paused', log); const want = trailerHtml(store, sid);   // the paused note is a trailer too: swap it, never stack a second one
        if (w && !want) w.remove(); else if (!w && want) log.insertAdjacentHTML('beforeend', want); else if (w && want && r.status !== status) w.outerHTML = want;
      }
    }
    if (r.toolSig !== toolSig) {
      changed = true;
      const ids = new Set(Object.keys(store.toolLive || {}).concat(r.toolIds || []));
      for (const cid of ids) { const k = store.list.findIndex((x) => x.t === 'tool_call' && x.id === cid); if (k >= 0) patchTool(log, store, sid, k, cid); }
    }
    if (r.status !== status) {
      changed = true;
      for (const el of $$('details.tool', log)) if ($('.res.pending', el)) { const cid = el.dataset.cid; const k = store.list.findIndex((x) => x.t === 'tool_call' && x.id === cid); if (k >= 0) patchTool(log, store, sid, k, cid); }
      for (const a of $$('.approval', log)) if (!sess || sess.pending_approval !== a.dataset.rid) a.remove();
      if (sess && sess.pending_approval && !log.querySelector(`.approval[data-rid="${CSS.escape(sess.pending_approval)}"]`)) {
        const k = store.list.findIndex((x) => x.t === 'approval_request' && x.id === sess.pending_approval);
        if (k >= 0) { const w = $(':scope > .msg.streaming, :scope > .note.working, :scope > .note.paused', log); const html = buildChatHtml(store, sid, { from: k, to: k + 1, noTail: true }); if (w) w.insertAdjacentHTML('beforebegin', html); else log.insertAdjacentHTML('beforeend', html); }
      }
    }
  }
  if (!incremental || changed) groupTools(log);
  holder._rendered = { sig: 1, sid, store, optsKey, count: store.list.length, live: store.live, streaming, status, toolSig, toolIds: Object.keys(store.toolLive || {}) };
  const jump = holder.querySelector ? holder.querySelector('.jump') : null;
  if (stick) { scroller.scrollTop = scroller.scrollHeight; if (jump) jump.hidden = true; holder._pin = true; requestAnimationFrame(() => { if (holder._pin !== false && scroller.isConnected) scroller.scrollTop = scroller.scrollHeight; }); }
  else if (jump && changed) jump.hidden = false;
}
// Consecutive tool calls fold into one row. Runs the same way after a full
// render and after an incremental append, moving the live elements so an
// open tool, its kill button and the group's open state all survive.
const TOOL_GROUP_MIN = 3;
function toolKind(desc) {
  if (/^(Read|Grep|Glob|LS|read_file|list_dir)\b/i.test(desc)) return 'read';
  if (/^(Edit|Write|MultiEdit|NotebookEdit|write_file|edit_file)\b/i.test(desc)) return 'edit';
  if (/^(WebFetch|WebSearch)\b/.test(desc)) return 'web';
  if (/^(Bash|run_bash):\s*(cat|sed -n|head|tail|grep|rg|ls|find|wc|pwd|tree|stat|git (log|diff|status|show|branch|blame)|echo)\b/.test(desc)) return 'read';
  return 'cmd';
}
const TOOL_KIND_LABEL = { read: 'reading files', edit: 'editing files', cmd: 'running commands', web: 'searching the web' };
function groupTools(log) {
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const tools = []; let group = null;
    for (const el of run) {
      if (el.classList.contains('tool-group')) { if (!group) group = el; tools.push(...$$(':scope > .tool-group-body > details.tool', el)); }
      else tools.push(el);
    }
    if (tools.length >= TOOL_GROUP_MIN) {
      if (!group) { group = document.createElement('details'); group.className = 'tool-group'; group.innerHTML = '<summary><span class="tri"></span><span class="desc"></span><span class="res"></span></summary><div class="tool-group-body"></div>'; run[0].before(group); }
      const body = $(':scope > .tool-group-body', group);
      for (const t of tools) body.appendChild(t);
      for (const el of run) if (el !== group && el.classList.contains('tool-group')) el.remove();
      const kinds = new Set(tools.map((t) => toolKind(($('.desc', t) || {}).textContent || '')));
      const pending = tools.filter((t) => $(':scope > summary .res.pending', t)).length;
      const errs = tools.filter((t) => $(':scope > summary .res.err, :scope > summary .res.declined', t)).length;
      $(':scope > summary .desc', group).textContent = `${tools.length} tool calls (${['read', 'edit', 'cmd', 'web'].filter((k) => kinds.has(k)).map((k) => TOOL_KIND_LABEL[k]).join(', ')})`;
      const res = $(':scope > summary .res', group);
      res.className = 'res' + (pending ? ' pending' : errs ? ' err' : '');
      res.textContent = pending ? `${pending} running…` : errs ? `${errs} failed` : '✓';
      if (!group.dataset.user) { group._auto = true; group.open = pending > 0; group._auto = false; }
    } else if (group) {
      for (const t of tools) group.before(t);
      for (const el of run) if (el.classList.contains('tool-group')) el.remove();
    }
    run = [];
  };
  for (const el of Array.from(log.children)) { if (el.matches('details.tool, details.tool-group')) run.push(el); else flush(); }
  flush();
}
document.addEventListener('toggle', (e) => { const g = e.target; if (g.classList && g.classList.contains('tool-group') && !g._auto) g.dataset.user = '1'; }, true);

function patchTool(log, store, sid, k, cid) {
  const el = log.querySelector(`details.tool[data-cid="${CSS.escape(cid)}"]`); if (!el) return;
  const wasOpen = el.open;
  const tmp = document.createElement('div'); tmp.innerHTML = buildChatHtml(store, sid, { from: k, to: k + 1, noTail: true });
  const nel = tmp.firstElementChild; if (!nel) return;
  if (wasOpen) nel.open = true;
  el.replaceWith(nel);
}

function wirePane(pane, sid) {
  $('.pane-title', pane).addEventListener('click', (e) => {
    if (e.target.classList.contains('window-pin')) { togglePin(sid); return; }
    if (e.target.classList.contains('view-toggle')) { cyclePaneView(sid); return; }
    if (e.target.closest('a')) return;
    const chip = e.target.closest('[data-act]'); if (chip) { handleAction(chip, sid); return; }
    focusPane(state.focus === sid ? null : sid);
  });
  pane.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) { handleAction(b, sid); e.stopPropagation(); return; }
    if (e.target.dataset.copy) { copyCode(e.target); return; }
    if (!pane.classList.contains('focused')) state.sid = sid;
  });
  pane.addEventListener('dblclick', (e) => { if (e.target.closest('.pane-body') && !pane.classList.contains('focused')) focusPane(sid); });
  $('select[data-act]', pane); // wired via change delegation below
  pane.addEventListener('change', (e) => { const s = e.target.closest('select[data-act]'); if (s) handleAction(s, sid); });
  wireDrag(pane, sid);
}

function saveOrder() { localStorage.setItem('kcoder.order', JSON.stringify(state.order)); syncUiState(); }
function movePane(from, to, before) {
  if (from === to) return;
  const order = state.order.filter((x) => x !== from);
  const i = order.indexOf(to);
  if (i < 0) return;
  order.splice(before ? i : i + 1, 0, from);
  state.order = order; saveOrder(); renderWall();
}
function wireDrag(pane, sid) {
  const title = $('.pane-title', pane);
  title.draggable = true;
  const clearMarks = () => { for (const p of $$('.pane')) p.classList.remove('drop-before', 'drop-after'); };
  title.addEventListener('dragstart', (e) => {
    if (state.focus || e.target.closest('.window-pin, .view-toggle')) { e.preventDefault(); return; }
    state.dragSid = sid; pane.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', sid);
  });
  title.addEventListener('dragend', () => { state.dragSid = null; pane.classList.remove('dragging'); clearMarks(); });
  pane.addEventListener('dragover', (e) => {
    if (!state.dragSid || state.dragSid === sid) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const r = pane.getBoundingClientRect();
    const before = (e.clientX - r.left) < r.width / 2;
    pane.classList.toggle('drop-before', before); pane.classList.toggle('drop-after', !before);
  });
  pane.addEventListener('dragleave', (e) => { if (!pane.contains(e.relatedTarget)) pane.classList.remove('drop-before', 'drop-after'); });
  pane.addEventListener('drop', (e) => {
    if (!state.dragSid || state.dragSid === sid) return;
    e.preventDefault();
    const before = pane.classList.contains('drop-before');
    const from = state.dragSid; state.dragSid = null; clearMarks();
    movePane(from, sid, before);
  });
}

function focusPane(sid) {
  state.focus = sid;
  if (sid) { state.sid = sid; localStorage.setItem('kcoder.sid', sid); loadEvents(sid, -1); const s = state.sessions.get(sid); if (s && s.project && s.project.git && !state.gitInfo.has(sid)) gitStatus(sid, false).catch(() => {}); }
  renderWall();
  if (sid) { const pane = $(`.pane[data-sid="${sid}"]`); if (pane) { renderPaneChrome(pane, state.sessions.get(sid), state.order.indexOf(sid) + 1); renderPaneBody(pane, sid); fitShell(sid); focusComposer(); } }
}
function cyclePaneView(sid) {
  const order = ['chat', 'term', 'shell', 'preview'];
  const cur = paneViewOf(sid);
  const next = order[(order.indexOf(cur) + 1) % order.length];
  setPaneView(sid, next);
}
function setPaneView(sid, v) {
  const pane = $(`.pane[data-sid="${sid}"]`);
  if (pane) closeShellDrawer(pane);
  if (v !== 'shell') closeShell(sid);
  state.paneView.set(sid, v);
  if (pane) { $('.composer-slot', pane).innerHTML = ''; renderPaneChrome(pane, state.sessions.get(sid), state.order.indexOf(sid) + 1); renderPaneBody(pane, sid); }
}
function togglePin(sid) {
  if (state.pins.includes(sid)) state.pins = state.pins.filter((x) => x !== sid); else state.pins.push(sid);
  savePins(); renderHeader(); renderWall();
  toast(state.pins.length ? `this window shows ${state.pins.length} pinned session(s)` : 'this window shows all sessions');
}
function cycleWaiting() {
  const waiting = state.order.filter((id) => (state.sessions.get(id) || {}).status === 'waiting');
  if (!waiting.length) { toast('nothing is waiting on you', 'ok'); return; }
  const i = waiting.indexOf(state.focus);
  const next = waiting[(i + 1) % waiting.length];
  if (state.view !== 'wall') setView('wall');
  focusPane(next);
}

// ----------------------------------------------------------------------
// actions
// ----------------------------------------------------------------------
async function handleAction(el, sid) {
  const act = el.dataset.act;
  const s = state.sessions.get(sid) || state.chats.find((c) => c.id === sid) || {};
  try {
    switch (act) {
      case 'approve': case 'decline': {
        const rid = el.dataset.rid || (el.closest('[data-rid]') || {}).dataset?.rid || s.pending_approval;
        await request('approve', { sid, rid, approved: act === 'approve' });
        break;
      }
      case 'interrupt': await request('interrupt', { sid }); break;
      case 'kill': await request('shell_kill_tool', { sid }); toast('killed', 'warn'); break;
      case 'resume': await request('resume_turn', { sid }); break;
      case 'dismiss': await request('resume_turn', { sid, discard: true }); break;
      case 'changes': changesDialog(sid); break;
      case 'doit': {
        const to = (state.config && state.config.default_trust && state.config.default_trust !== 'dry') ? state.config.default_trust : 'auto';
        if (!(await confirmDialog('Carry out the plan?', `The session leaves dry run (trust becomes ${to}) and is asked to make the changes it proposed.`))) break;
        await request('set', { sid, trust: to });
        await request('send', { sid, text: 'Go ahead: carry out the plan you proposed above, exactly as described. Say so if anything in it no longer applies.', images: [], queue_if_busy: true });
        toast('plan is being carried out', 'ok'); break;
      }
      case 'preview': { if (state.view !== 'wall') setView('wall'); setPaneView(sid, 'preview'); focusPane(sid); break; }
      case 'preview-start': { toast('starting the dev server…'); const r = await request('preview', { sid, action: 'start' }); toast(`preview on ${r.preview.url}`, 'ok'); renderSession(sid); break; }
      case 'preview-stop': await request('preview', { sid, action: 'stop' }); renderSession(sid); break;
      case 'instructions': instructionsDialog(sid); break;
      case 'deploy': deployDialog(sid); break;
      case 'undo': {
        const msg = el.closest('.msg-user'); const turn = Number(msg.dataset.turn);
        if (!s.worktree) { toast('undo needs a worktree session', 'warn'); break; }
        if (await confirmDialog('Undo to here?', `Files in the worktree go back to how they were just before message ${turn + 1}, and that message and everything after it are removed from the conversation. Commits the agent made since are undone too (the branch moves back).`)) {
          await request('undo', { sid, turn }); toast('restored files and conversation', 'ok'); loadEventsFresh(sid);
        }
        break;
      }
      case 'queue': { const t = await promptDialog('Add a follow-up task', 'It runs when the current turn finishes.'); if (t) await request('queue', { sid, action: 'add', text: t }); break; }
      case 'trust': await request('set', { sid, trust: el.value }); break;
      case 'model': {
        let m = el.value;
        if (m === '__other') { m = await promptDialog('Model name', ''); if (!m) { el.value = s.model; return; } }
        await request('set', { sid, model: m }); break;
      }
      case 'git': await gitStatus(sid, true); break;
      case 'pull': { try { const r = await request('pull', { sid }); toast(r.message || 'pulled', 'ok'); gitStatus(sid, false).catch(() => {}); } catch (e) { toast('pull: ' + e.message, 'err'); } break; }
      case 'merge': if (await confirmDialog(`Merge branch ${s.worktree.branch} into ${s.project.name}?`, 'Uncommitted changes in the worktree are committed first.')) { const r = await request('merge', { sid }); toast(r.message || 'merged', r.ok === false ? 'err' : 'ok'); } break;
      case 'pr': { toast('opening a draft PR… (commit, review check, push, description)'); const r = await request('pr', { sid }); if (r.url) { toast((r.pr && r.pr.draft ? 'draft PR opened: ' : 'PR opened: ') + r.url, 'ok'); openExternal(r.url); } else toast(r.message || 'PR created', 'ok'); break; }
      case 'discard': if (await confirmDialog(`Discard all work in ${s.worktree.branch}?`, 'The worktree and branch are deleted. This cannot be undone.')) { await request('discard', { sid }); toast('discarded', 'warn'); } break;
      case 'open-chat': assignPane(state.layout.focus, sid); setView('chat'); break;
      case 'export': await exportChat(sid); break;
      case 'archive': await archiveChat(sid); break;
      case 'new': openNewSession(); break;
      case 'edit': {
        const msg = el.closest('.msg-user'); const turn = Number(msg.dataset.turn);
        const text = $('.bubble', msg).firstChild ? $('.bubble', msg).textContent : '';
        const nt = await promptDialog('Edit and resend', 'Everything after this message is discarded.', text, true);
        if (nt) await request('edit', { sid, turn, text: nt });
        break;
      }
      case 'fork': { const msg = el.closest('.msg-user'); const r = await request('fork', { sid, turn: Number(msg.dataset.turn) }); toast('forked → ' + r.session.name, 'ok'); state.sid = r.session.id; loadEvents(r.session.id, -1); break; }
      case 'copy': { const msg = el.closest('.msg'); copyMessage(sid, msg ? Number(msg.dataset.i) : -1, msg); break; }
    }
  } catch (e) { toast(e.message, 'err'); }
}

async function gitStatus(sid, show) {
  const r = await request('git', { sid });
  state.gitInfo.set(sid, r.git || {});
  renderWall();
  if (show) {
    const g = r.git || {};
    infoDialog('git status · ' + (g.branch || ''), `<pre>${esc(g.status || '(clean)')}</pre>${g.diffstat ? `<div class="label">diff stat</div><pre>${esc(g.diffstat)}</pre>` : ''}`);
  }
}
async function exportChat(sid, format) {
  if (!format) { format = await chooseDialog('Export this session as…', [['html', 'HTML page - one file that reads well anywhere, secrets masked, tool output folded (share this)'], ['md', 'Markdown']]); if (!format) return; }
  let r; try { r = await request('export', { sid, format: format === 'html' ? 'html' : 'markdown' }); } catch (e) { toast(e.message, 'err'); return; }
  const name = (r.title || 'chat').replace(/[^\w.-]+/g, '_') + (format === 'html' ? '.html' : '.md');
  await saveFile(name, format === 'html' ? r.html : r.markdown, format === 'html' ? 'text/html' : 'text/markdown');
}
// ----------------------------------------------------------------------
// files and links: the window only ever shows the app. Saving goes through
// the native save dialog (Downloads, then "Show in Finder") in the app
// window and through the browser's download in a tab; a link that would
// leave the app opens in the default browser instead.
// ----------------------------------------------------------------------
function nativeApi() { return (window.pywebview && window.pywebview.api) || null; }
function isAppUrl(u) { try { const x = new URL(u, location.href); return x.origin === location.origin && /^https?:$/.test(x.protocol); } catch { return false; } }
function openExternal(url) {
  const api = nativeApi();
  if (api && api.open_external) { Promise.resolve(api.open_external(String(url))).catch(() => {}); return; }
  window.open(url, '_blank', 'noopener');
}
async function saveFile(name, text, mime, opts = {}) {
  const api = nativeApi();
  if (api && api.save_file) {
    let r; try { r = await api.save_file(name, text, !!opts.binary); } catch (e) { toast('could not save ' + name + ': ' + (e && e.message || e), 'err'); return null; }
    if (!r || r.cancelled) return null;
    if (r.error) { toast('could not save ' + name + ': ' + r.error, 'err'); return null; }
    const where = /Mac/i.test(navigator.platform) ? 'Show in Finder' : 'Show in folder';
    toast('saved ' + (r.name || name), 'ok', api.reveal ? { label: where, run: () => Promise.resolve(api.reveal(r.path)).catch(() => {}) } : null);
    return r.path;
  }
  const bytes = opts.binary ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0)) : text;
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.rel = 'noopener'; a.hidden = true;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('saved ' + name + ' to your downloads', 'ok');
  return name;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]'); if (!a) return;
  const href = a.getAttribute('href') || ''; if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
  if (isAppUrl(a.href)) return;
  if (nativeApi()) { e.preventDefault(); e.stopPropagation(); openExternal(a.href); return; }
  if (!a.target || a.target === '_self') { a.target = '_blank'; a.rel = 'noopener'; }
}, true);
// ---- images in messages: served by kcoderd from the session's uploads folder (token-gated), full size in a dialog
function uploadUrl(sid, name) { return `/uploads/${encodeURIComponent(sid)}/${encodeURIComponent(name)}?token=${encodeURIComponent(state.token || '')}`; }
function attachmentHtml(sid, name) {
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) return `<span class="att-label">🖼 ${esc(name)}</span>`;   // rebuilt from an old history: no file
  return `<img class="att-thumb" src="${uploadUrl(sid, name)}" alt="${esc(name)}" title="${esc(name)} · click to view" data-preview="${esc(uploadUrl(sid, name))}" data-name="${esc(name)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'), { className: 'att-label', textContent: '🖼 ' + this.alt }))">`;
}
function imagePreview(src, name) {
  const d = openDialog(`<h2>${esc(name || 'image')}<span class="spacer"></span><button data-x="close">✕</button></h2><div class="body image-preview"><img src="${esc(src)}" alt="${esc(name || '')}"></div>`, 'image');
  d.classList.add('wide');
  d.addEventListener('click', (e) => { if (e.target.closest('[data-x]') || e.target.tagName === 'IMG') closeDialog(); });
}
document.addEventListener('click', (e) => { const im = e.target.closest('[data-preview]'); if (im) { e.preventDefault(); imagePreview(im.dataset.preview, im.dataset.name || ''); } });

function copyCode(btn) { const code = btn.parentElement.querySelector('code'); navigator.clipboard.writeText(code ? code.textContent : btn.parentElement.textContent); btn.textContent = 'copied'; setTimeout(() => (btn.textContent = 'copy'), 1200); }

// ----------------------------------------------------------------------
// chat view: sidebar
// ----------------------------------------------------------------------
function renderSidebar() {
  const box = $('#projects');
  if (state.searchResults) {
    box.innerHTML = `<div class="project search-results"><div class="project-head"><span class="name">search results</span><button class="add" data-clear-search="1">✕</button></div>` +
      (state.searchResults.length ? state.searchResults.map((c) => chatItemHtml(c) + (c.hits || []).map((h) => `<div class="hit" data-jump="${esc(c.id)}:${h.turn || 0}" title="open at this message"><b>${esc(h.who)}:</b> ${esc(h.snippet)}</div>`).join('')).join('') : '<div class="hit">no matches</div>') +
      `<div class="hit"><button data-search-all="1" title="filters: repo, date, who; every hit opens the message">all results + filters ⏎</button></div></div>`;
    return;
  }
  const groups = new Map();
  for (const c of state.chats) { const pid = (c.project || {}).id || 'other'; if (!groups.has(pid)) groups.set(pid, { project: c.project || { name: 'other', path: '' }, chats: [] }); groups.get(pid).chats.push(c); }
  const collapsed = JSON.parse(localStorage.getItem('kcoder.collapsed') || '{}');
  const show = showArchived();
  let hiddenChats = 0, hiddenProjects = 0;
  box.innerHTML = Array.from(groups.entries()).map(([pid, g]) => {
    const active = g.chats.filter((c) => !c.archived);
    const archived = g.chats.filter((c) => c.archived);
    if (!show) { hiddenChats += archived.length; if (!active.length) { hiddenProjects++; return ''; } }
    const open = !collapsed[pid];
    const dep = ((state.projects || []).find((p) => p.id === pid) || {}).deploy;
    const depDot = dep && dep.state && dep.state !== 'untracked' ? `<span class="deploy-dot ${esc(dep.state)}" title="deploy: ${esc(dep.state)}${dep.at ? ' · ' + age(dep.at) + ' ago' : ''}">${DEPLOY_ICON[dep.state] || '?'}</span>` : '';
    return `<div class="project" data-pid="${esc(pid)}"><div class="project-head" title="${esc(g.project.path)}"><span>${open ? '▾' : '▸'}</span><span class="name">${esc(g.project.name)}</span>${depDot}<span>${active.length}${archived.length ? '+' + archived.length : ''}</span><button class="add" data-new-in="${esc(g.project.path)}" title="new chat in ${esc(g.project.name)}">+</button></div>` +
      (open ? active.map(chatItemHtml).join('') + (archived.length && show ? `<details class="archived-group"><summary class="chat-item archived"><span class="title">${archived.length} archived</span></summary>${archived.map(chatItemHtml).join('')}</details>` : '') : '') + '</div>';
  }).join('') || `<div class="hit">${hiddenChats ? 'no live chats' : 'no chats yet'} - press + to start one</div>`;
  const b = $('#btn-archived');
  b.hidden = !show && !hiddenChats;
  const idle = idleChats().length, ai = $('#btn-archive-idle');
  ai.hidden = idle < 2; ai.textContent = `archive ${idle} idle`; ai.title = `Archive the ${idle} chats that are not running, pinned, in a pane or the current one (undo on the toast)`;
  b.textContent = show ? 'hide archived' : `show ${hiddenChats} archived`; b.title = show ? 'Hide archived chats and projects with no live session' : `${hiddenChats} archived chat${hiddenChats === 1 ? '' : 's'}${hiddenProjects ? ` in ${hiddenProjects} project${hiddenProjects === 1 ? '' : 's'} with nothing live` : ''} are hidden`;
}
function showArchived() { return localStorage.getItem('kcoder.showArchived') === 'on'; }
$('#btn-archived').addEventListener('click', () => { localStorage.setItem('kcoder.showArchived', showArchived() ? 'off' : 'on'); renderSidebar(); });
function chatItemHtml(c) {
  const live = state.sessions.get(c.id);
  const st = c.archived ? 'archived' : (live ? live.status : c.status);
  const label = st === 'working' ? 'running' : st === 'waiting' ? (live && live.pending_approval ? 'needs approval' : 'needs you') : st === 'error' ? 'error' : st === 'idle' && live ? 'idle' : '';
  const inPane = state.layout.panes.indexOf(c.id);
  return `<div class="chat-item${c.archived ? ' archived' : ''}${c.id === state.sid ? ' current' : ''}${inPane >= 0 ? ' in-pane' : ''}" data-sid="${c.id}" draggable="true" title="${esc(c.name)} · ${esc(c.model || '')} · drag onto a pane"><span class="dot ${st}"></span><span class="title">${c.pinned ? '<span class="pin">📌 </span>' : ''}${esc(c.title || c.name)}</span>${st === 'working' ? `<span class="badge working">${statusLineHtml(c.id, true)}</span>` : st === 'error' ? `<button class="badge error" data-err="${c.id}" title="what happened, send again, copy a report">error · details</button>` : label ? `<span class="badge ${st}">${label}</span>` : ''}${inPane >= 0 ? `<span class="pane-no" title="open in pane ${inPane + 1}">${inPane + 1}</span>` : ''}<span class="age">${age(c.last_activity)}</span>${c.archived ? '' : `<button class="arch" data-archive="${c.id}" title="archive this chat (undo on the toast; it stays searchable and comes back from show archived)">✕</button>`}</div>`;
}
// one click archives a chat; the toast offers undo, which resumes it without opening it anywhere
async function archiveChat(sid) {
  const c = state.chats.find((x) => x.id === sid) || state.sessions.get(sid); if (!c) return false;
  const live = state.sessions.get(sid);
  if (live && live.status === 'working' && !(await confirmDialog(`Archive ${c.title || c.name}?`, 'It is still running: archiving interrupts the turn. Cancel to let it finish first.'))) return false;
  try { await request('archive', { sid }); } catch (e) { toast(e.message, 'err'); return false; }
  if (state.focus === sid) focusPane(null);
  toast(`archived ${c.title || c.name}`, 'ok', { label: 'undo', run: () => request('unarchive', { sid }).catch((e) => toast(e.message, 'err')) });
  return true;
}
// the chats a bulk archive takes: not archived, not pinned, not running or waiting, not in a pane and not the current one
function idleChats(pid) {
  return state.chats.filter((c) => {
    if (c.archived || c.pinned || c.id === state.sid || state.layout.panes.includes(c.id)) return false;
    if (pid && ((c.project || {}).id || 'other') !== pid) return false;
    const live = state.sessions.get(c.id); const st = live ? live.status : c.status;
    return st !== 'working' && st !== 'waiting';
  });
}
async function archiveIdle(pid) {
  const list = idleChats(pid);
  if (!list.length) { toast('nothing idle to archive: every chat is running, pinned, in a pane or the current one'); return; }
  const where = pid ? ` in ${(list[0].project || {}).name || 'this project'}` : '';
  const n = (k) => `${k} idle chat${k === 1 ? '' : 's'}`;
  if (!(await confirmDialog(`Archive ${n(list.length)}${where}?`, 'Pinned chats, the current one and the ones in your panes stay. Archived chats are still searchable and come back from "show archived", or with undo on the toast.'))) return;
  const done = [];
  for (const c of list) { try { await request('archive', { sid: c.id }); done.push(c.id); if (state.focus === c.id) focusPane(null); } catch (e) { toast(e.message, 'err'); } }
  toast(`archived ${n(done.length)}${where}`, 'ok', { label: 'undo', run: async () => { for (const sid of done) { try { await request('unarchive', { sid }); } catch (e) { toast(e.message, 'err'); } } } });
}
$('#btn-archive-idle').addEventListener('click', () => archiveIdle());
$('#projects').addEventListener('dragstart', (e) => { const item = e.target.closest('.chat-item[data-sid]'); if (!item) return; state.dragChat = item.dataset.sid; e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', item.dataset.sid); });
$('#projects').addEventListener('dragend', () => { state.dragChat = null; for (const p of $$('.cpane')) p.classList.remove('drop'); });

$('#projects').addEventListener('click', async (e) => {
  const clear = e.target.closest('[data-clear-search]'); if (clear) { state.searchResults = null; $('#search').value = ''; renderSidebar(); return; }
  const jmp = e.target.closest('[data-jump]'); if (jmp) { const [sid, turn] = jmp.dataset.jump.split(':'); jumpTo(sid, Number(turn)); return; }
  if (e.target.closest('[data-search-all]')) { searchDialog($('#search').value.trim()); return; }
  const add = e.target.closest('[data-new-in]'); if (add) { openNewSession({ cwd: add.dataset.newIn }); e.stopPropagation(); return; }
  const head = e.target.closest('.project-head'); if (head) { const pid = head.parentElement.dataset.pid; const c = JSON.parse(localStorage.getItem('kcoder.collapsed') || '{}'); c[pid] = !c[pid]; localStorage.setItem('kcoder.collapsed', JSON.stringify(c)); renderSidebar(); return; }
  const ar = e.target.closest('[data-archive]'); if (ar) { e.stopPropagation(); archiveChat(ar.dataset.archive); return; }
  const item = e.target.closest('.chat-item[data-sid]'); if (item) openChat(item.dataset.sid);
});
$('#projects').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.chat-item[data-sid]'); if (!item) return;
  e.preventDefault(); chatMenu(item.dataset.sid);
});
let searchTimer = null;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('#search').value.trim();
  if (!q) { state.searchResults = null; renderSidebar(); return; }
  searchTimer = setTimeout(async () => { try { state.searchResults = (await request('search', { q })).results; renderSidebar(); } catch {} }, 250);
});
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchDialog($('#search').value.trim()); } });
$('#btn-new-chat').addEventListener('click', () => openNewSession());

// open a session at a given user turn (search hits)
async function jumpTo(sid, turn) {
  state.sid = sid;
  if (state.view !== 'chat') setView('chat');
  await loadEvents(sid, -1);
  assignPane(state.layout.focus, sid);
  setTimeout(() => {
    const pane = $$('.pane[data-sid]').find((p) => p.dataset.sid === sid); if (!pane) return;
    const el = pane.querySelector(`.msg-user[data-turn="${turn}"]`) || pane.querySelector('.msg-user');
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
  }, 250);
}

// search across transcripts, with filters (repo, date, who)
async function searchDialog(initial = '') {
  const projects = (state.projects || []).map((p) => p.name).filter(Boolean).sort();
  const d = openDialog(`<h2>search <span class="help">words, "phrases", repo:name, since:2026-10-01, date:today | yesterday | 7d, who:me | agent</span><span class="spacer"></span><button data-x="close">✕</button></h2>
    <div class="body search">
      <div class="row"><input id="sd-q" placeholder="what are you looking for?" value="${esc(initial)}" autocomplete="off" style="flex:1">
        <select id="sd-repo" title="repo"><option value="">any repo</option>${projects.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select>
        <select id="sd-date" title="date"><option value="">any time</option><option value="today">today</option><option value="yesterday">yesterday</option><option value="7d">last 7 days</option><option value="30d">last 30 days</option></select>
        <select id="sd-who" title="who"><option value="">anyone</option><option value="me">me</option><option value="agent">kcoder</option></select></div>
      <div id="sd-results" class="list"><div class="empty-row">type to search</div></div>
    </div>`, 'search');
  d.classList.add('wide');
  const q = $('#sd-q', d), out = $('#sd-results', d);
  let timer = null, seq = 0;
  const run = async () => {
    const text = q.value.trim(); const my = ++seq;
    const date = $('#sd-date', d).value; const f = { q: text, repo: $('#sd-repo', d).value || null, who: $('#sd-who', d).value || null, since: date || null, until: date === 'yesterday' ? 'yesterday' : null, limit: 80 };
    if (!text && !f.repo && !f.since) { out.innerHTML = '<div class="empty-row">type to search</div>'; return; }
    let r; try { r = await request('search', f); } catch (e) { out.innerHTML = `<div class="empty-row">${esc(e.message)}</div>`; return; }
    if (my !== seq) return;
    const res = r.results || [];
    out.innerHTML = res.length ? res.map((c) => `<div class="sr"><div class="h"><button class="link" data-jump="${esc(c.id)}:0">${esc(c.title || c.name)}</button><span class="meta">${esc((c.project || {}).name || '')} · ${esc(c.status || '')} · ${c.last_activity ? age(c.last_activity) + ' ago' : ''}</span></div>${(c.hits || []).map((h) => `<div class="hit" data-jump="${esc(c.id)}:${h.turn || 0}" title="open at this message"><span class="k">turn ${(h.turn || 0) + 1} · ${esc(h.who)}</span>${esc(h.snippet)}</div>`).join('')}</div>`).join('') + `<div class="help plain">${res.length} session(s)${res.length >= 80 ? ' (first 80)' : ''}</div>` : '<div class="empty-row">no matches</div>';
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  for (const id of ['sd-repo', 'sd-date', 'sd-who']) $('#' + id, d).addEventListener('change', run);
  d.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) { closeDialog(); return; } const j = e.target.closest('[data-jump]'); if (j) { const [sid, turn] = j.dataset.jump.split(':'); closeDialog(); jumpTo(sid, Number(turn)); } });
  setTimeout(() => q.focus(), 20);
  if (initial) run();
}

async function openChat(sid) {
  state.events.delete(sid);
  const store = await loadEvents(sid, -1);      // resumes archived chats too
  if (!store) return;
  if (state.view === 'chat') { assignPane(state.layout.focus, sid); return; }
  state.sid = sid; localStorage.setItem('kcoder.sid', sid);
  renderSidebar(); renderTitlebars(); renderTermLog(); renderWall();
  focusComposer();
}

async function chatMenu(sid) {
  const c = state.chats.find((x) => x.id === sid) || state.sessions.get(sid); if (!c) return;
  const items = [
    ['rename', 'Rename title'], ['pin', c.pinned ? 'Unpin' : 'Pin'], ['export', 'Export markdown'],
    [c.archived ? 'unarchive' : 'archive', c.archived ? 'Resume' : 'Archive'], ['delete', 'Delete'],
  ];
  const choice = await chooseDialog(c.title || c.name, items);
  if (!choice) return;
  try {
    if (choice === 'rename') { const t = await promptDialog('Chat title', '', c.title || ''); if (t) await request('title', { sid, title: t }); }
    else if (choice === 'pin') await request('pin', { sid, pinned: !c.pinned });
    else if (choice === 'export') await exportChat(sid);
    else if (choice === 'archive') await archiveChat(sid);
    else if (choice === 'unarchive') await openChat(sid);
    else if (choice === 'delete' && await confirmDialog('Delete this chat?', 'Its history is removed from disk.')) { await request('delete', { sid }); if (state.sid === sid) state.sid = null; }
  } catch (e) { toast(e.message, 'err'); }
}

// ----------------------------------------------------------------------
// chat / terminal main areas
// ----------------------------------------------------------------------
function renderTitlebars() { /* the terminal view is now a per-pane toggle (see renderCpaneBar) */ }
function _renderTitlebarsLegacy() {
  const s = state.sid ? (state.sessions.get(state.sid) || state.chats.find((c) => c.id === state.sid)) : null;
  const html = !s ? '<span class="meta">pick a chat on the left, or press n for a new one</span>' :
    `<span class="dot ${s.archived ? 'archived' : s.status}"></span><span class="title">${esc(s.title || s.name)}</span><span class="meta">${esc((s.project || {}).name || '')}${s.worktree ? ' @ ' + esc(s.worktree.branch) : ''} · ${esc(shortHome(s.cwd))}</span><span class="spacer"></span>` +
    `<span class="meta">ctx ${fmtTokens(s.context_tokens || 0)} · ${s.plan ? (planShareText(s) ? 'plan ' + planShareText(s) : 'on your plan') : fmtUsd((s.usage || {}).cost || 0)}</span>` +
    `<select data-act="trust" title="trust"><option value="auto">auto</option><option value="write">write</option><option value="read">read</option><option value="none">none</option><option value="dry">dry run</option></select>` +
    `<select data-act="model" title="model"></select>` +
    `<button data-act="interrupt" title="Esc" ${s.status === 'working' || s.status === 'waiting' ? '' : 'disabled'}>■</button>` +
    `<button data-act="export" title="export markdown">⤓</button><button data-act="menu" title="more">⋯</button>`;
  return html;
}

function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 80; }
function renderTermLog() { /* terminal rendering lives in each pane now (cpaneView / paneView = 'term') */ }
function ensureComposer(slotSel, sid, termStyle) {
  const slot = $(slotSel);
  if (!sid) { slot.innerHTML = ''; slot.dataset.sid = ''; return; }
  if (slot.dataset.sid === sid && slot.firstChild) { updateComposerState(slot, sid); return; }
  slot.innerHTML = ''; slot.dataset.sid = sid; mountComposer(slot, sid, termStyle);
}
function focusComposer() {
  let ta;
  if (state.view === 'chat') { const p = $$('#split .cpane')[state.layout.focus]; ta = p && !p.hidden ? $('.composer textarea', p) : null; }
  else { const view = $('#view-' + state.view); ta = view && view.querySelector('.composer textarea:not([hidden])'); }
  if (ta && !ta.closest('[hidden]')) ta.focus();
}

// ----------------------------------------------------------------------
// composer (shared by chat view, terminal view, focused pane)
// ----------------------------------------------------------------------
function mountComposer(slot, sid, termStyle) {
  const frag = $('#tpl-composer').content.cloneNode(true);
  slot.appendChild(frag);
  const form = $('.composer', slot);
  const ta = $('textarea', form);
  const menu = $('.menu', form);
  const chips = $('.chips', form);
  const atts = $('.attachments', form);
  const comp = { sid, form, ta, menu, chips, atts, pastes: new Map(), images: [], menuItems: [], menuSel: 0, menuKind: null, histIdx: -1, draft: '' };
  if (termStyle) $('.prompt-label', form).hidden = false; else $('.prompt-label', form).hidden = true;
  if (slot.closest('.cpane')) ta.placeholder = 'Message kcoder…  (Enter sends)';
  form._comp = comp;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px'; };
  ta.addEventListener('input', () => { grow(); updateMenu(comp); });
  ta.addEventListener('keydown', (e) => onComposerKey(e, comp));
  // the $ button docks this session's shell under the chat (voice input stays on ⌘⇧M and in the palette)
  $('.sh', form).addEventListener('click', (e) => { e.preventDefault(); toggleShellDrawer(form); });
  ta.addEventListener('paste', (e) => onPaste(e, comp));
  form.addEventListener('drop', (e) => { if (state.dragChat) return; const files = Array.from(e.dataTransfer.files || []); if (files.length) { e.preventDefault(); e.stopPropagation(); addFiles(comp, files); } });
  form.addEventListener('dragover', (e) => { if (!state.dragChat) e.preventDefault(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); submitComposer(comp); });
  $('.stop', form).addEventListener('click', () => request('interrupt', { sid }).catch(() => {}));
  menu.addEventListener('mousedown', (e) => { const it = e.target.closest('.item'); if (it) { e.preventDefault(); comp.menuSel = Number(it.dataset.i); applyMenu(comp); } });
  chips.addEventListener('click', (e) => { const chip = e.target.closest('.chip'); if (!chip) return; if (e.target.classList.contains('x')) removeChip(comp, Number(chip.dataset.n)); else expandChip(comp, Number(chip.dataset.n)); });
  updateComposerState(slot, sid);
  grow();
}
function updateComposerState(slot, sid) {
  const form = $('.composer', slot); if (!form) return;
  const s = state.sessions.get(sid);
  const busy = s && (s.status === 'working' || s.status === 'waiting');
  $('.stop', form).hidden = !busy;
  $('.send', form).title = busy ? 'Queue (runs after this turn)' : 'Send (Enter)';
  $('.send', form).textContent = busy ? '⏭' : '➤';
}

function onComposerKey(e, comp) {
  const ta = comp.ta;
  if (comp.menuKind && !comp.menu.hidden) {
    if (e.key === 'ArrowDown') { e.preventDefault(); comp.menuSel = (comp.menuSel + 1) % comp.menuItems.length; renderMenu(comp); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); comp.menuSel = (comp.menuSel - 1 + comp.menuItems.length) % comp.menuItems.length; renderMenu(comp); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); applyMenu(comp); return; }
    if (e.key === 'Escape') { e.preventDefault(); hideMenu(comp); return; }
  }
  if (e.key === 'Escape') { e.preventDefault(); const s = state.sessions.get(comp.sid); if (s && (s.status === 'working' || s.status === 'waiting')) { request('interrupt', { sid: comp.sid }).catch(() => {}); toast('interrupting…', 'warn'); } else ta.blur(); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) { e.preventDefault(); submitComposer(comp); return; }
  if ((e.key === 'Enter') && (e.shiftKey || e.altKey)) { return; } // newline (default)
  if (e.key === 'ArrowUp' && (ta.selectionStart === 0 || !ta.value) && ta.value.indexOf('\n', 0) === -1 || (e.key === 'ArrowUp' && !ta.value)) {
    const hist = historyFor(comp.sid);
    if (!hist.length) return;
    e.preventDefault();
    if (comp.histIdx === -1) comp.draft = ta.value;
    comp.histIdx = Math.min(hist.length - 1, comp.histIdx + 1);
    ta.value = hist[hist.length - 1 - comp.histIdx]; ta.dispatchEvent(new Event('input'));
    return;
  }
  if (e.key === 'ArrowDown' && comp.histIdx >= 0 && ta.selectionEnd === ta.value.length) {
    const hist = historyFor(comp.sid);
    e.preventDefault();
    comp.histIdx -= 1;
    ta.value = comp.histIdx === -1 ? comp.draft : hist[hist.length - 1 - comp.histIdx]; ta.dispatchEvent(new Event('input'));
    return;
  }
}
function historyFor(sid) {
  if (!state.histories.has(sid)) {
    const store = state.events.get(sid);
    state.histories.set(sid, store ? store.list.filter((e) => e.t === 'user').map((e) => e.text) : []);
  }
  return state.histories.get(sid);
}

function onPaste(e, comp) {
  const items = Array.from(e.clipboardData.items || []);
  const imgs = items.filter((i) => i.type.startsWith('image/'));
  if (imgs.length) { e.preventDefault(); imgs.forEach((i) => addImage(comp, i.getAsFile())); return; }
  const text = e.clipboardData.getData('text/plain');
  if (!text) return;
  const lines = text.split(/\r\n|\r|\n/).length;
  if (lines >= 3 || text.length >= 400) {
    e.preventDefault();
    addChip(comp, text, lines, null);
  }
}
let chipSeq = 0;
function addChip(comp, text, lines, name) {
  const n = ++chipSeq;
  const tag = name ? `[File ${name} · ${lines} lines]` : `[Pasted #${n} · ${lines} lines]`;
  comp.pastes.set(n, { text, lines, expanded: false, tag, name });
  insertAtCursor(comp.ta, tag);
  renderChips(comp);
}
function addFiles(comp, files) {
  for (const f of files) {
    if (f.type.startsWith('image/')) { addImage(comp, f); continue; }
    if (f.size > 2 * 1024 * 1024) { toast(`${f.name}: too big to attach (2 MB max)`, 'warn'); continue; }
    const reader = new FileReader();
    reader.onload = () => { const text = String(reader.result || ''); if (/[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 2000))) { toast(`${f.name}: not a text file`, 'warn'); return; } const body = `--- ${f.name} ---\n${text}`; addChip(comp, body, text.split(/\r\n|\r|\n/).length, f.name); };
    reader.readAsText(f);
  }
}
function insertAtCursor(ta, s) { const a = ta.selectionStart, b = ta.selectionEnd; ta.value = ta.value.slice(0, a) + s + ta.value.slice(b); ta.selectionStart = ta.selectionEnd = a + s.length; ta.dispatchEvent(new Event('input')); }
function renderChips(comp) {
  comp.chips.hidden = comp.pastes.size === 0;
  comp.chips.innerHTML = Array.from(comp.pastes.entries()).map(([n, p]) => `<span class="chip${p.expanded ? ' expanded' : ''}" data-n="${n}" title="click to expand into the message">${esc(p.tag)}<span class="x" title="remove">✕</span></span>`).join('');
}
function expandChip(comp, n) {
  const p = comp.pastes.get(n); if (!p) return;
  const tag = p.tag;
  if (comp.ta.value.includes(tag)) { comp.ta.value = comp.ta.value.replace(tag, p.text); p.expanded = true; comp.pastes.delete(n); comp.ta.dispatchEvent(new Event('input')); renderChips(comp); }
}
function removeChip(comp, n) { const p = comp.pastes.get(n); if (!p) return; comp.ta.value = comp.ta.value.replace(p.tag, ''); comp.pastes.delete(n); comp.ta.dispatchEvent(new Event('input')); renderChips(comp); }
function expandAll(comp, text) { for (const [, p] of comp.pastes) text = text.split(p.tag).join(p.text); return text; }

// Images: pasted (⌘V), dropped, or picked. Oversized Retina screenshots are scaled so the long side is at most
// MAX_IMAGE_SIDE px (what the model is served anyway; a 2x screenshot of a 1440-wide window lands at 1x, text intact).
// Screenshots stay PNG so text stays crisp; photos become JPEG.
const MAX_IMAGE_SIDE = 1568, MAX_IMAGES = 12;
async function prepareImage(file) {
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('could not read ' + (file.name || 'the image'))); r.readAsDataURL(file); });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('not an image: ' + (file.name || file.type))); i.src = dataUrl; });
  const w = img.naturalWidth, h = img.naturalHeight; const long = Math.max(w, h);
  const png = /png|gif|bmp|webp/.test(file.type) || !file.type;
  const name = file.name && file.name !== 'image.png' ? file.name : `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${png ? 'png' : 'jpg'}`;
  if (long <= MAX_IMAGE_SIDE && file.size <= 4 * 1024 * 1024) return { name, data_url: dataUrl, w, h, scaled: false };
  const k = Math.min(1, MAX_IMAGE_SIDE / long); const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, cw, ch);
  return { name: name.replace(/\.[a-z0-9]+$/i, png ? '.png' : '.jpg'), data_url: png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9), w: cw, h: ch, scaled: k < 1, from: [w, h] };
}
async function addImage(comp, file) {
  if (!file) return;
  if (comp.images.length >= MAX_IMAGES) { toast(`at most ${MAX_IMAGES} images per message`, 'warn'); return; }
  const slot = { name: file.name || 'image', data_url: '', pending: true };   // keeps paste order while the images are prepared
  comp.images.push(slot);
  try { const im = await prepareImage(file); Object.assign(slot, im, { pending: false }); renderAtts(comp); if (im.scaled) toast(`${im.name}: scaled ${im.from[0]}×${im.from[1]} → ${im.w}×${im.h} to save tokens`, ''); }
  catch (e) { comp.images.splice(comp.images.indexOf(slot), 1); renderAtts(comp); toast(e.message, 'err'); }
}
// does the session's model take images? (providers report which models do; "auto" needs both tiers to)
function modelSeesImages(s) {
  if (!s) return true;
  const p = (state.providers || []).find((x) => x.id === s.provider); if (!p || p.vision === 'all') return true;
  const list = Array.isArray(p.vision) ? p.vision : [];
  const ok = (m) => !!m && list.includes(m);
  if (s.model === 'auto') { const t = p.tiers || {}; return ok(t.small) && ok(t.large); }
  return ok(s.model);
}
function renderAtts(comp) {
  comp.atts.hidden = comp.images.length === 0;
  const s = state.sessions.get(comp.sid);
  const warn = comp.images.length && s && !modelSeesImages(s) ? `<div class="att-warn">⚠ ${esc(s.model)} can't take images: switch the model (/model) or they are left out</div>` : '';
  comp.atts.innerHTML = comp.images.map((im, i) => im.pending ? `<span class="attachment pending" title="preparing ${esc(im.name)}…">…</span>` : `<span class="attachment" title="${esc(im.name)}${im.w ? ` · ${im.w}×${im.h}` : ''} · click to view"><img src="${im.data_url}" alt="${esc(im.name)}" data-preview="${im.data_url}" data-name="${esc(im.name)}"><span class="x" data-i="${i}" title="remove">✕</span></span>`).join('') + warn;
  for (const x of $$('.x', comp.atts)) x.onclick = (e) => { e.stopPropagation(); comp.images.splice(Number(x.dataset.i), 1); renderAtts(comp); };
}

// slash + @ menus
function updateMenu(comp) {
  const ta = comp.ta;
  const before = ta.value.slice(0, ta.selectionStart);
  const slash = before.match(/^(\/[a-z]*)$/);
  const at = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (slash) {
    comp.menuKind = 'slash';
    comp.menuItems = SLASH.filter(([c]) => c.startsWith(slash[1])).map(([c, d]) => ({ text: c + ' ', label: c, meta: d, replace: slash[1].length }));
    comp.menuSel = 0; renderMenu(comp); return;
  }
  if (at) {
    comp.menuKind = 'at';
    const q = at[1];
    request('files', { sid: comp.sid, q, limit: 25 }).then((r) => {
      if (comp.menuKind !== 'at') return;
      comp.menuItems = r.files.map((f) => ({ text: '@' + f + ' ', label: f, meta: '', replace: q.length + 1 }));
      comp.menuSel = 0; renderMenu(comp);
    }).catch(() => hideMenu(comp));
    return;
  }
  hideMenu(comp);
}
function renderMenu(comp) {
  if (!comp.menuItems.length) { hideMenu(comp); return; }
  comp.menu.hidden = false;
  comp.menu.innerHTML = comp.menuItems.slice(0, 40).map((it, i) => `<div class="item${i === comp.menuSel ? ' sel' : ''}" data-i="${i}"><span>${esc(it.label)}</span><span class="meta">${esc(it.meta)}</span></div>`).join('');
  const sel = $('.item.sel', comp.menu); if (sel) sel.scrollIntoView({ block: 'nearest' });
}
function hideMenu(comp) { comp.menu.hidden = true; comp.menuKind = null; comp.menuItems = []; }
function applyMenu(comp) {
  const it = comp.menuItems[comp.menuSel]; if (!it) { hideMenu(comp); return; }
  const ta = comp.ta; const pos = ta.selectionStart;
  ta.value = ta.value.slice(0, pos - it.replace) + it.text + ta.value.slice(pos);
  ta.selectionStart = ta.selectionEnd = pos - it.replace + it.text.length;
  hideMenu(comp); ta.dispatchEvent(new Event('input'));
}

async function submitComposer(comp) {
  const sid = comp.sid;
  let text = expandAll(comp, comp.ta.value).trim();
  if (!text && !comp.images.length) return;
  const s = state.sessions.get(sid);
  if (text.startsWith('/') && /^\/[a-z]+/.test(text)) {
    const handled = await slashCommand(sid, text);
    if (handled) { resetComposer(comp); return; }
  }
  // @file references: attach the file contents so the model sees them
  const refs = Array.from(text.matchAll(/(?:^|\s)@([^\s@]+)/g)).map((m) => m[1]);
  if (refs.length) text += '\n\n(referenced files: ' + refs.map((r) => `${(s && s.project && s.project.path) || ''}/${r}`).join(', ') + ' - read them with read_file as needed)';
  const targets = (state.broadcast && state.view === 'chat' && comp.form.closest('.cpane')) ? Array.from(new Set(state.layout.panes.filter(Boolean))) : [sid];
  if (comp.images.some((im) => im.pending)) { toast('one moment: an image is still being prepared', ''); return; }
  let images = comp.images;
  if (images.length) {
    const blind = targets.map((t) => state.sessions.get(t)).filter((ts) => ts && !modelSeesImages(ts));
    if (blind.length) {
      const ok = await confirmDialog(`${blind.map((b) => b.model).join(', ')} can't take images`, `${images.length} image${images.length === 1 ? '' : 's'} would be left out. Send the text alone? Cancel to keep the images and switch the model with /model first.`);
      if (!ok) return;
      images = [];
      if (!text) return;
    }
  }
  try {
    for (const t of targets) {
      const ts = state.sessions.get(t);
      const busy = ts && (ts.status === 'working' || ts.status === 'waiting');
      const r = await request('send', { sid: t, text, images: images.map((im) => ({ name: im.name, data_url: im.data_url })), queue_if_busy: busy });
      historyFor(t).push(text);
      if (r.queued) toast(`${ts ? ts.name + ': ' : ''}queued as follow-up #${r.position}`, 'ok');
    }
    if (targets.length > 1) toast(`sent to ${targets.length} panes`, 'ok');
    resetComposer(comp);
  } catch (e) { toast(e.message, 'err'); }
}
function resetComposer(comp) { comp.ta.value = ''; comp.pastes.clear(); comp.images = []; comp.histIdx = -1; renderChips(comp); renderAtts(comp); hideMenu(comp); comp.ta.dispatchEvent(new Event('input')); }

async function slashCommand(sid, line) {
  const [cmd, ...rest] = line.split(/\s+/); const arg = rest.join(' ').trim();
  const s = state.sessions.get(sid) || {};
  try {
    switch (cmd) {
      case '/help': helpDialog(); return true;
      case '/clear': await request('clear', { sid }); return true;
      case '/cd': if (arg) await request('set', { sid, cwd: arg }); return true;
      case '/model': {
        if (!arg) { modelPicker(sid); return true; }
        const [p, ...m] = arg.split('/'); const prov = (state.providers || []).find((x) => x.id === p);
        if (prov && m.length) await switchModel(sid, p, m.join('/')); else await request('set', { sid, model: arg });
        return true;
      }
      case '/provider': modelPicker(sid); return true;
      case '/trust': if (arg) await request('set', { sid, trust: arg }); else toast('trust: ' + s.trust); return true;
      case '/auto': await request('set', { sid, trust: s.trust === 'auto' ? 'read' : 'auto' }); return true;
      case '/title': if (arg) await request('title', { sid, title: arg }); return true;
      case '/name': if (arg) await request('rename', { sid, name: arg }); return true;
      case '/queue': if (arg) { const r = await request('queue', { sid, action: 'add', text: arg }); toast(`queued (${r.queue.length} waiting)`, 'ok'); } else toast((s.queue || []).map((q, i) => `${i + 1}. ${q.text}`).join('\n') || 'queue is empty'); return true;
      case '/fork': { const r = await request('fork', { sid }); toast('forked → ' + r.session.name, 'ok'); return true; }
      case '/compact': await request('compact', { sid }); toast('compacting…'); return true;
      case '/export': await exportChat(sid); return true;
      case '/recap': { if (state.view !== 'chat') setLayout('1'); const p = $$('#split .cpane').find((x) => x.dataset.sid === sid); if (!p) { assignPane(state.layout.focus, sid); } state.recapShown.set(sid, Date.now() / 1000); showRecap(sid, arg === 'new' || arg === 'fresh' || arg === 'refresh'); return true; }
      case '/archive': await request('archive', { sid }); return true;
      case '/shell': setPaneView(sid, paneViewOf(sid) === 'shell' ? 'chat' : 'shell'); if (state.view !== 'wall') { setView('wall'); } focusPane(sid); return true;
      case '/wall': case '/grid': setLayout('grid'); return true;
      case '/chat': case '/panes': setLayout(arg && /^[123]$/.test(arg) ? arg : (state.view === 'chat' ? String(state.layout.panes.length) : '1')); return true;
      case '/terminal': { const p = state.view === 'chat' ? $$('#split .cpane').find((x) => x.dataset.sid === sid) : null; if (p) toggleCpaneView(p); else { setPaneView(sid, paneViewOf(sid) === 'term' ? 'chat' : 'term'); if (state.view !== 'wall') setView('wall'); focusPane(sid); } return true; }
      default: return false;
    }
  } catch (e) { toast(e.message, 'err'); return true; }
}

// ----------------------------------------------------------------------
// ----------------------------------------------------------------------
// conditions: the header's ridgeline accent. The daemon reads fresh snow at the place in settings
// (Alta) and bitcoin's 24 h move every 30 minutes and pushes them; the moon is arithmetic. One
// condition shows at a time (snow, then a big bitcoin day, then the full moon in dark mode); the
// thin bitcoin line under the header is separate and only tints. A reading older than 12 hours is
// nothing, so an offline laptop fades back to the plain header by itself.
// ----------------------------------------------------------------------
const COND_STALE = 12 * 3600;
function onConditions(msg) {
  const prev = state.conditions; state.conditions = msg;
  renderConditions();
}
function condReduced() { return matchMedia('(prefers-reduced-motion: reduce)').matches; }
function condNight() { const h = new Date().getHours(); return h >= 18 || h < 6; }
function condPick(C) {
  const st = C.settings || {}; if (!st.enabled) return { kind: null, line: null, snow: 0, btc: null };
  const now = Date.now() / 1000; const fresh = (src) => !!(src && src.at && now - src.at <= COND_STALE);
  const snow = st.snow && fresh(C.snow) ? Number(C.snow.inches || 0) : 0;
  const btc = st.btc && fresh(C.btc) ? Number(C.btc.pct || 0) : null;
  const moon = !!(st.moon && C.moon && C.moon.near_full && condNight() && effectiveTheme() === 'dark');
  const kind = snow >= 1 ? 'snow' : btc != null && Math.abs(btc) >= 5 ? 'btc' : moon ? 'moon' : null;
  return { kind, snow, btc, line: btc };
}
function condRand(seed) { let t = seed * 2654435761 >>> 0; return () => { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
function renderConditions() {
  const ridge = $('#ridge'), tag = $('#cond-tag'); if (!ridge || !tag) return;
  const C = state.conditions; const P = C ? condPick(C) : { kind: null, line: null, snow: 0, btc: null };
  const still = condReduced();
  const line = $('.btcline', ridge);
  if (P.line != null && Math.abs(P.line) >= 0.2) { line.hidden = false; line.style.background = P.line > 0 ? 'var(--green)' : 'var(--red)'; line.style.opacity = Math.min(0.85, 0.15 + Math.abs(P.line) / 5 * 0.7).toFixed(2); }
  else line.hidden = true;
  ridge.hidden = !P.kind && line.hidden;
  ridge.classList.toggle('static', still);
  ridge.dataset.kind = P.kind || '';
  ridge.dataset.light = effectiveTheme() === 'light' ? 'true' : 'false';
  const flakes = $('.flakes', ridge);
  if (P.kind === 'snow') {
    const n = Math.min(48, Math.round(8 + P.snow * 3)); const key = `${n}:${still ? 's' : 'm'}`;
    if (flakes.dataset.key !== key) { flakes.dataset.key = key; flakes.innerHTML = Array.from({ length: n }, (_, i) => { const r = condRand(i + 7); return `<i style="left:${(r() * 100).toFixed(1)}%;--d:${(5 + r() * 6).toFixed(1)}s;--o:${(-r() * 11).toFixed(1)}s;--s:${(1.5 + r() * 2).toFixed(1)}px;top:${still ? (r() * 90).toFixed(0) + '%' : '-6px'}"></i>`; }).join(''); }
  } else { flakes.innerHTML = ''; delete flakes.dataset.key; }
  if (P.kind === 'snow') { tag.hidden = false; tag.className = 'cond-tag snow'; tag.textContent = `${Math.round(P.snow)}" fresh at ${C.snow.place || 'the hill'}`; tag.title = `fresh snow in the last 24 h at ${C.snow.place || 'the place in settings'} (Open-Meteo) · read ${age(C.snow.at)} ago`; }
  else if (P.kind === 'btc') { tag.hidden = false; tag.className = 'cond-tag btc ' + (P.btc > 0 ? 'up' : 'down'); tag.textContent = `₿ ${P.btc > 0 ? '+' : ''}${P.btc.toFixed(1)}%`; tag.title = `bitcoin's 24 h move${C.btc.price ? ' · ' + fmtUsd(C.btc.price) : ''} (CoinGecko) · read ${age(C.btc.at)} ago`; }
  else tag.hidden = true;
  if (P.kind === 'moon') document.documentElement.dataset.cond = 'moon'; else delete document.documentElement.dataset.cond;
}
setInterval(renderConditions, 5 * 60 * 1000);   // staleness, nightfall and the hour move on their own
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', renderConditions);

// terminal here: this session's shell (the daemon's pty, in the session's folder) docked under the chat,
// in a grid pane or a chat-view pane alike. The $ button in the composer and ⌘J toggle it.
function toggleShellDrawer(el) {
  const pane = el.closest('.pane, .cpane'); const drawer = pane && $('.shell-drawer', pane); const sid = pane && pane.dataset.sid;
  if (!drawer || !sid) return;
  if (pane.classList.contains('pane') && paneViewOf(sid) === 'shell') { setPaneView(sid, 'chat'); return; }
  if (!drawer.hidden && drawer.dataset.sid === sid) { closeShellDrawer(pane); focusComposer(); return; }
  const s = state.sessions.get(sid) || {}; const cwd = s.cwd || '';
  drawer.innerHTML = `<div class="bar"><span class="path" title="${esc(cwd)}">$ ${esc(cwd.replace(/^\/(Users|home)\/[^/]+/, '~'))}</span><span class="help">this session's folder · ⌘J toggles</span><span class="spacer"></span><button class="sec" data-sh="close" title="Close the terminal (ends the shell)">✕</button></div><div class="box shell-box"></div>`;
  drawer.dataset.sid = sid; drawer.hidden = false;
  ensureShell(sid, $('.box', drawer));
}
function closeShellDrawer(pane) {
  const drawer = $('.shell-drawer', pane); if (!drawer || drawer.hidden) return;
  closeShell(drawer.dataset.sid); drawer.hidden = true; drawer.innerHTML = ''; delete drawer.dataset.sid;
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-sh="close"]'); if (!b) return; const pane = b.closest('.pane, .cpane'); if (pane) { closeShellDrawer(pane); focusComposer(); } });

// shell pane (xterm.js over the daemon's pty)
// ----------------------------------------------------------------------
function ensureShell(sid, box) {
  let sh = state.shells.get(sid);
  if (sh && sh.box === box) return;
  if (sh) { sh.term.dispose(); state.shells.delete(sid); }
  box.innerHTML = '';
  const term = new Terminal({ fontFamily: fontChoice().family ? fontStack(fontChoice().family) : 'ui-monospace, Menlo, monospace', fontSize: Math.round(fontChoice().size), theme: xtermTheme(), cursorBlink: true, scrollback: 5000, allowProposedApi: true });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(box); fit.fit();
  sh = { term, fit, box, open: false };
  state.shells.set(sid, sh);
  term.onData((d) => send('shell_input', { sid, data: btoa(unescape(encodeURIComponent(d))) }));
  term.onResize(({ cols, rows }) => send('shell_resize', { sid, cols, rows }));
  request('shell_open', { sid, cols: term.cols, rows: term.rows }).then(() => { sh.open = true; term.focus(); }).catch((e) => term.writeln('\x1b[31m' + e.message + '\x1b[0m'));
  const ro = new ResizeObserver(() => { try { fit.fit(); } catch {} }); ro.observe(box); sh.ro = ro;
}
function fitShell(sid) { const sh = state.shells.get(sid); if (sh) setTimeout(() => { try { sh.fit.fit(); } catch {} }, 30); }
function closeShell(sid) { const sh = state.shells.get(sid); if (!sh) return; try { sh.ro.disconnect(); sh.term.dispose(); } catch {} state.shells.delete(sid); send('shell_close', { sid }); }
function onShellData(sid, b64, exit) {
  const sh = state.shells.get(sid); if (!sh) return;
  if (b64) { const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); sh.term.write(bytes); }
  if (exit != null) sh.term.writeln(`\r\n\x1b[2m[shell exited ${exit}]\x1b[0m`);
}

// ----------------------------------------------------------------------
// dialogs
// ----------------------------------------------------------------------
function openDialog(html, name) {
  const ov = $('#overlay'); ov.hidden = false; ov.innerHTML = `<div class="dialog">${html}</div>`; state.dialog = name;
  const first = ov.querySelector('input, textarea, select, button'); if (first) setTimeout(() => first.focus(), 10);
  return ov.firstElementChild;
}
function closeDialog() { const ov = $('#overlay'); ov.hidden = true; ov.innerHTML = ''; state.dialog = null; if (state._dialogReject) { const r = state._dialogReject; state._dialogReject = null; r(null); } }
$('#overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDialog(); });

function promptDialog(title, help, value = '', multiline = false) {
  return new Promise((resolve) => {
    state._dialogReject = resolve;
    const d = openDialog(`<h2>${esc(title)}</h2><div class="body">${help ? `<div class="help">${esc(help)}</div>` : ''}${multiline ? `<textarea id="dlg-in">${esc(value)}</textarea>` : `<input id="dlg-in" value="${esc(value)}">`}</div><div class="foot"><button data-x="cancel">cancel</button><button class="primary" data-x="ok">ok</button></div>`, 'prompt');
    const inp = $('#dlg-in', d);
    const done = (v) => { state._dialogReject = null; closeDialog(); resolve(v); };
    d.addEventListener('click', (e) => { const b = e.target.closest('[data-x]'); if (!b) return; done(b.dataset.x === 'ok' ? inp.value.trim() : null); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); done(inp.value.trim()); } if (e.key === 'Escape') done(null); });
  });
}
function confirmDialog(title, help) {
  return new Promise((resolve) => {
    state._dialogReject = resolve;
    const d = openDialog(`<h2>${esc(title)}</h2><div class="body"><div class="help">${esc(help || '')}</div></div><div class="foot"><button data-x="cancel">cancel</button><button class="primary" data-x="ok">confirm</button></div>`, 'confirm');
    d.addEventListener('click', (e) => { const b = e.target.closest('[data-x]'); if (!b) return; state._dialogReject = null; closeDialog(); resolve(b.dataset.x === 'ok'); });
  });
}
function chooseDialog(title, items) {
  return new Promise((resolve) => {
    state._dialogReject = resolve;
    const d = openDialog(`<h2>${esc(title)}</h2><div class="list">${items.map(([k, l, h], i) => `<div class="item${i === 0 ? ' sel' : ''}" data-k="${esc(k)}"><span>${esc(l)}</span>${h ? `<span class="meta"><kbd>${esc(h)}</kbd></span>` : ''}</div>`).join('')}</div>`, 'choose');
    d.addEventListener('click', (e) => { const it = e.target.closest('[data-k]'); if (!it) return; state._dialogReject = null; closeDialog(); resolve(it.dataset.k); });
  });
}
function infoDialog(title, html) { openDialog(`<h2>${esc(title)}<span class="spacer"></span><button data-x="close">✕</button></h2><div class="body">${html}</div>`, 'info').addEventListener('click', (e) => { if (e.target.closest('[data-x]')) closeDialog(); }); }

function helpDialog() {
  const rows = SHORTCUTS.filter((sc) => !sc.hidden && sc.scope !== 'alias' || sc.group === 'queue');
  const render = (q) => {
    q = (q || '').toLowerCase().trim();
    return KEY_GROUPS.map((g) => {
      const items = rows.filter((sc) => sc.group === g && (!q || (shortcutKeys(sc) + ' ' + sc.label + ' ' + g).toLowerCase().includes(q)));
      return items.length ? `<section><h3>${esc(g)}</h3><div class="help-grid">${items.map((sc) => `<kbd>${esc(shortcutKeys(sc))}</kbd><span>${esc(sc.label)}${sc.scope === 'mouse' ? ' <span class="help">(mouse)</span>' : ''}</span>`).join('')}</div></section>` : '';
    }).join('') || '<div class="empty-row">no shortcut matches</div>';
  };
  const d = openDialog(`<h2>keyboard shortcuts<span class="spacer"></span><input id="keys-q" class="keys-q" placeholder="search shortcuts…" autocomplete="off"><button data-x="close">✕</button></h2><div class="body"><div class="keys" id="keys-list">${render('')}</div></div>`, 'keys');
  d.classList.add('sheet');
  const q = $('#keys-q', d);
  q.addEventListener('input', () => { $('#keys-list', d).innerHTML = render(q.value); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (q.value) { q.value = ''; q.dispatchEvent(new Event('input')); } else closeDialog(); } });
  d.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) closeDialog(); });
  setTimeout(() => q.focus(), 10);
}

// approval inbox
// everything waiting on you, oldest first: approvals, then questions, reviews, errors
function waitingItems() {
  const items = [];
  for (const s of state.sessions.values()) {
    if (s.pending_approval) {
      const store = state.events.get(s.id);
      const req = store && store.list.slice().reverse().find((e) => e.t === 'approval_request' && e.id === s.pending_approval);
      items.push({ kind: 'approval', sid: s.id, name: s.name, rid: s.pending_approval, desc: req ? req.description : 'pending tool call', ts: req ? req.ts : (s.last_activity || 0) });
    } else if (s.status === 'waiting') items.push({ kind: 'question', sid: s.id, name: s.name, desc: s.title || 'waiting for your answer', ts: s.last_activity || 0 });
    if (s.needs_review) items.push({ kind: 'review', sid: s.id, name: s.name, desc: 'changes wait for your review', ts: s.last_activity || 0 });
    if (s.status === 'error') items.push({ kind: 'error', sid: s.id, name: s.name, desc: lastErrorText(s.id) || 'the last turn failed', ts: s.last_activity || 0 });
  }
  const rank = { approval: 0, question: 1, review: 2, error: 3 };
  return items.sort((a, b) => rank[a.kind] - rank[b.kind] || a.ts - b.ts);
}
// show one waiting item: approvals and questions in a pane, reviews in the changes view, errors in their details
function showWaiting(it) {
  if (!it) return;
  if (it.kind === 'review') { changesDialog(it.sid); return; }
  if (it.kind === 'error') { errorDialog(it.sid); return; }
  state.sid = it.sid;
  if (state.view === 'chat') assignPane(state.layout.focus, it.sid);
  else { if (state.view !== 'wall') setView('wall'); focusPane(it.sid); }
}
function currentWaitingSid() { return state.view === 'chat' ? focusedSid() : state.focus; }
// w: the next item waiting on you (after the one on screen); after y / N the next one comes up by itself
function cycleWaiting() {
  const items = waitingItems();
  if (!items.length) { toast('nothing is waiting on you', 'ok'); return; }
  const cur = currentWaitingSid();
  const i = items.findIndex((it) => it.sid === cur);
  showWaiting(items[(i + 1) % items.length]);
}
function advanceWaiting(fromSid) {
  const items = waitingItems().filter((it) => it.sid !== fromSid);
  if (!items.length) { toast('that was the last one: nothing else is waiting on you', 'ok'); return; }
  showWaiting(items[0]);
}
function renderInbox() {
  const items = waitingItems();
  const sel = Math.min(state.inboxSel || 0, Math.max(0, items.length - 1)); state.inboxSel = sel;
  const n = (k) => items.filter((x) => x.kind === k).length;
  const row = (it, i) => `<div class="item${i === sel ? ' sel' : ''}" data-i="${i}"><span class="sess">${esc(it.name)}</span><span class="kind ${it.kind}">${it.kind}</span><code${it.kind === 'error' ? ' class="warn"' : ''}>${esc(it.desc)}</code><span class="meta">${age(it.ts)} ago</span>` +
    (it.kind === 'approval' ? `<button class="primary" data-ap="1" data-sid="${it.sid}" data-rid="${esc(it.rid)}">yes</button><button class="danger" data-ap="0" data-sid="${it.sid}" data-rid="${esc(it.rid)}">no</button>`
      : it.kind === 'review' ? `<button class="primary" data-go="${i}">changes</button>` : it.kind === 'error' ? `<button data-go="${i}">details</button>` : `<button class="primary" data-go="${i}">open</button>`) + '</div>';
  const html = `<h2>inbox <span class="help">${n('approval')} approval${n('approval') === 1 ? '' : 's'}${n('question') ? ` · ${n('question')} question${n('question') === 1 ? '' : 's'}` : ''}${n('review') ? ` · ${n('review')} in review` : ''}${n('error') ? ` · ${n('error')} error${n('error') === 1 ? '' : 's'}` : ''} · ↑↓ or j k move · y approve · n decline · ↩ open · a approve all · esc</span><span class="spacer"></span><button data-x="close">✕</button></h2>` +
    `<div class="list">${items.map(row).join('') || '<div class="empty-row">nothing waiting on you</div>'}</div>`;
  state.inboxItems = items;
  if (state.dialog === 'inbox') { $('#overlay .dialog').innerHTML = html; }
  else openDialog(html, 'inbox');
  const el = $(`#overlay .item[data-i="${sel}"]`); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}
function openInbox() { state.inboxSel = 0; renderInbox(); }
$('#overlay').addEventListener('click', async (e) => {
  if (state.dialog !== 'inbox') return;
  if (e.target.closest('[data-x]')) { closeDialog(); return; }
  const b = e.target.closest('[data-ap]');
  if (b) { await approve(b.dataset.sid, b.dataset.rid, b.dataset.ap === '1'); return; }
  const g = e.target.closest('[data-go]');
  if (g) { const it = (state.inboxItems || [])[Number(g.dataset.go)]; closeDialog(); showWaiting(it); return; }
  const it = e.target.closest('.item[data-i]'); if (it) { state.inboxSel = Number(it.dataset.i); renderInbox(); }
});
async function approve(sid, rid, ok, advance = false) {
  try { await request('approve', { sid, rid, approved: ok }); } catch (e) { toast(e.message, 'err'); return; }
  setTimeout(() => { if (state.dialog === 'inbox') renderInbox(); else if (advance) advanceWaiting(sid); }, 350);
}
function inboxKey(e) {
  const items = state.inboxItems || []; const cur = items[state.inboxSel || 0];
  if (e.key === 'ArrowDown' || e.key === 'j') { state.inboxSel = Math.min(items.length - 1, (state.inboxSel || 0) + 1); renderInbox(); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { state.inboxSel = Math.max(0, (state.inboxSel || 0) - 1); renderInbox(); }
  else if (e.key === 'y' && cur && cur.kind === 'approval') approve(cur.sid, cur.rid, true);
  else if (e.key === 'n' && cur && cur.kind === 'approval') approve(cur.sid, cur.rid, false);
  else if (e.key === 'Enter' && cur) { closeDialog(); showWaiting(cur); }
  else if (e.key === 'a') items.filter((p) => p.kind === 'approval').forEach((p) => approve(p.sid, p.rid, true));
  else if (e.key === 'Escape') closeDialog();
  else return; e.preventDefault();
}

// new session
async function openNewSession(pre = {}) {
  if (!state.providers) { try { state.providers = (await request('providers')).providers; } catch {} }
  const provs = state.providers || [];
  const def = provs.find((p) => p.default && p.configured) || provs.find((p) => p.configured) || provs[0];
  const cfg = state.config || {};
  const cwd = pre.cwd || (state.sid && state.sessions.get(state.sid) ? state.sessions.get(state.sid).cwd : '');
  const tpls = (cfg.templates || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const d = openDialog(`<h2>new session</h2><div class="body">
    <div class="row tplrow"><label>template<select id="ns-tpl"><option value="">none (fill in below)</option>${tpls.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label><button data-x="tpl-save" title="save the fields below as a template: one click (or kcoder start NAME) starts a session like this">save as template</button><button data-x="tpl-del" title="delete the selected template" hidden>delete template</button></div>
    <label>repo / folder <span class="help" style="text-transform:none;letter-spacing:0">local path, owner/name, or a GitHub URL (cloned into ${esc(shortHome(cfg.projects_dir || '~/kcoder-projects'))} on first use)</span>
      <input id="ns-cwd" value="${esc(cwd)}" placeholder="/path/to/project  ·  owner/repo  ·  https://github.com/owner/repo" autocomplete="off">
      <div class="menu repo-menu" id="ns-repos" hidden></div>
    </label>
    <div class="row">
      <label>provider<select id="ns-provider">${provs.map((p) => `<option value="${p.id}"${p === def ? ' selected' : ''}${p.configured ? '' : ' disabled'}>${esc(p.label)}${p.configured ? '' : ' (not set up)'}</option>`).join('')}</select></label>
      <label>model<select id="ns-model"></select></label>
      <label>trust<select id="ns-trust"><option value="auto">auto (never ask)</option><option value="write">write (gate shell)</option><option value="read">read (gate writes + shell)</option><option value="none">none (ask for everything)</option><option value="dry">dry run (plan + diff only, changes nothing)</option></select></label>
    </div>
    <label>session name (optional)<input id="ns-name" placeholder="defaults to the folder name"></label>
    <label>initial task<textarea id="ns-task" placeholder="what should it do first? A GitHub issue URL works too: the issue becomes the task and the PR closes it"></textarea></label>
    <label>follow-up tasks, one per line (optional)<textarea id="ns-queue" placeholder="run the tests&#10;open a PR"></textarea></label>
    <label class="check"><input type="checkbox" id="ns-wt" ${cfg.worktrees === false ? '' : 'checked'}> use a separate git worktree + branch (recommended when running several sessions on one repo)</label>
    <div class="help" style="text-transform:none;letter-spacing:0">Provider not set up yet? <a href="#" id="ns-setup">Connect your AI</a></div>
  </div><div class="foot"><span class="help" id="ns-status"></span><span class="spacer" style="flex:1"></span><button data-x="cancel">cancel</button><button class="primary" data-x="ok">start</button></div>`, 'new');
  const modelSel = $('#ns-model', d), provSel = $('#ns-provider', d), cwdIn = $('#ns-cwd', d), repoMenu = $('#ns-repos', d), status = $('#ns-status', d), tplSel = $('#ns-tpl', d);
  const collect = () => ({ cwd: cwdIn.value.trim(), provider: provSel.value, model: modelSel.value, trust: $('#ns-trust', d).value, task: $('#ns-task', d).value.trim(), queue: $('#ns-queue', d).value.split('\n').map((x) => x.trim()).filter(Boolean), worktree: $('#ns-wt', d).checked });
  const applyTpl = (t) => { if (!t) return; cwdIn.value = t.cwd || ''; if (t.provider && provs.some((p) => p.id === t.provider)) { provSel.value = t.provider; provSel.dispatchEvent(new Event('change')); } if (t.model) { if (!Array.from(modelSel.options).some((o) => o.value === t.model)) modelSel.insertBefore(new Option(t.model, t.model), modelSel.lastElementChild); modelSel.value = t.model; } if (t.trust) $('#ns-trust', d).value = t.trust; $('#ns-task', d).value = t.task || ''; $('#ns-queue', d).value = (t.queue || []).join('\n'); if (t.worktree != null) $('#ns-wt', d).checked = !!t.worktree; $('[data-x="tpl-del"]', d).hidden = false; };
  tplSel.addEventListener('change', () => { const t = tpls.find((x) => x.id === tplSel.value); if (t) applyTpl(t); else $('[data-x="tpl-del"]', d).hidden = true; });
  if (pre.template) { tplSel.value = pre.template; applyTpl(tpls.find((x) => x.id === pre.template)); }
  $('#ns-setup', d).addEventListener('click', (e) => { e.preventDefault(); const pid = provSel.value; closeDialog(); setupDialog(pid); });
  $('#ns-trust', d).value = state.config && state.config.default_trust ? state.config.default_trust : 'auto';
  const fill = () => { const p = provs.find((x) => x.id === provSel.value) || {}; const auto = p.auto && (!state.config || !state.config.routing || state.config.routing.enabled !== false); modelSel.innerHTML = (auto ? `<option value="auto" selected>auto (${esc((p.tiers || {}).small || '')} for small tasks, ${esc((p.tiers || {}).large || '')} for large)</option>` : '') + (p.models || []).map((m) => `<option${!auto && m === p.default_model ? ' selected' : ''}>${esc(m)}</option>`).join('') + '<option value="__other">other…</option>'; };
  provSel.addEventListener('change', fill); fill();
  // repo picker: local git repos + GitHub repos via gh
  let repos = state.repoCache;
  const renderRepos = () => {
    if (!repos) { repoMenu.hidden = false; repoMenu.innerHTML = '<div class="item"><span class="meta">looking for repos…</span></div>'; return; }
    const q = cwdIn.value.trim().toLowerCase();
    const local = repos.local.filter((r) => !q || fuzzy((r.name + ' ' + r.path).toLowerCase(), q)).slice(0, 12);
    const gh = repos.github.filter((r) => !local.some((l) => l.path === r.path) && (!q || fuzzy(r.spec.toLowerCase(), q))).slice(0, 12);
    const pub = !!(state.config && state.config.auto_publish === true);
    const items = local.map((r) => ({ v: r.path, label: r.name, meta: shortHome(r.path) + (!r.remote && pub ? ' · will publish to GitHub' : '') })).concat(gh.map((r) => ({ v: r.path || r.spec, label: r.spec, meta: r.path ? 'github · cloned' : 'github · clone' })));
    repoMenu.hidden = items.length === 0;
    repoMenu.innerHTML = items.map((it) => `<div class="item" data-v="${esc(it.v)}"><span>${esc(it.label)}</span><span class="meta">${esc(it.meta)}</span></div>`).join('');
  };
  const loadRepos = async () => { try { repos = await request('repos'); state.repoCache = repos; } catch { repos = { local: [], github: [] }; } renderRepos(); };
  cwdIn.addEventListener('focus', () => { renderRepos(); if (!repos) loadRepos(); });
  cwdIn.addEventListener('input', renderRepos);
  cwdIn.addEventListener('blur', () => setTimeout(() => (repoMenu.hidden = true), 150));
  repoMenu.addEventListener('mousedown', (e) => { const it = e.target.closest('[data-v]'); if (it) { e.preventDefault(); cwdIn.value = it.dataset.v; repoMenu.hidden = true; $('#ns-task', d).focus(); } });
  if (!cwd) { setTimeout(() => cwdIn.focus(), 20); } else $('#ns-task', d).focus();
  const submit = async () => {
    let model = modelSel.value; if (model === '__other') { model = await promptDialog('Model name', ''); if (!model) return; }
    const spec = cwdIn.value.trim();
    const fields = { cwd: spec, provider: provSel.value, model, trust: $('#ns-trust', d).value, name: $('#ns-name', d).value.trim() || undefined, task: $('#ns-task', d).value.trim(), queue: $('#ns-queue', d).value.split('\n').map((x) => x.trim()).filter(Boolean), worktree: $('#ns-wt', d).checked };
    if (/^(https?:\/\/github\.com\/|git@github\.com:)?[\w.-]+\/[\w.-]+\/?$/.test(spec) && !spec.startsWith('/') && !spec.startsWith('~') && !spec.startsWith('.')) status.textContent = 'cloning ' + spec + '…';
    $('[data-x="ok"]', d).disabled = true;
    try { const r = await request('create', fields); closeDialog(); state.repoCache = null; state.sid = r.session.id; localStorage.setItem('kcoder.sid', r.session.id); loadEvents(r.session.id, -1); if (state.view === 'wall') focusPane(r.session.id); else if (state.view === 'chat') assignPane(pre.pane != null ? pre.pane : state.layout.focus, r.session.id); toast('started ' + r.session.name + ' in ' + shortHome(r.session.cwd), 'ok'); }
    catch (e) { toast(e.message, 'err'); status.textContent = e.message; $('[data-x="ok"]', d).disabled = false; }
  };
  d.addEventListener('click', async (e) => { const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x === 'tpl-save') { const cur = tpls.find((x) => x.id === tplSel.value); const name = await promptDialog('Template name', 'A saved template starts a session with these fields in one click: ⌘K → "start: name", or kcoder start "name" in a terminal.', cur ? cur.name : ''); if (!name) return; try { const r = await request('templates', { action: 'save', template: cur && cur.name === name ? cur.id : undefined, name, ...collect() }); state.config = { ...(state.config || {}), templates: r.templates }; toast('template saved: ' + name, 'ok'); closeDialog(); openNewSession({ ...pre, template: (r.templates.find((x) => x.name === name) || {}).id }); } catch (err) { toast(err.message, 'err'); } return; }
    if (b.dataset.x === 'tpl-del') { const cur = tpls.find((x) => x.id === tplSel.value); if (!cur || !(await confirmDialog(`Delete template ${cur.name}?`, ''))) return; try { const r = await request('templates', { action: 'remove', template: cur.id }); state.config = { ...(state.config || {}), templates: r.templates }; toast('template deleted', 'warn'); closeDialog(); openNewSession(pre); } catch (err) { toast(err.message, 'err'); } return; }
    b.dataset.x === 'ok' ? submit() : closeDialog(); });
  d.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
}

// command palette
function paletteItems() {
  const items = SHORTCUTS.filter((sc) => sc.palette).map((sc) => [sc.palette, () => sc.run({ key: '' }), shortcutKeys(sc)]);
  items.push(
    ['brief: what every session did, what waits on you, what is in review', () => briefDialog()],
    ['search transcripts with filters (repo, date, who)', () => searchDialog($('#search').value.trim())],
    ['settings', () => settingsDialog()], ['about kcoder', () => aboutDialog()], ['your Claude plan (connect, limits)', () => claudeDialog()],
    ['connect your AI (sign in to a provider)', () => setupDialog()], ['connect GitHub (commit identity)', () => setupDialog()], 
['toggle broadcast (send to all panes)', toggleBroadcast], 
    ['toggle sound', toggleSound], ['enable browser notifications', () => Notification.requestPermission().then((p) => toast('notifications: ' + p))],
    ['set default trust for new sessions', async () => { const v = await chooseDialog('Default trust for new sessions', [['auto', 'auto - never ask'], ['write', 'write - gate shell'], ['read', 'read - gate writes + shell'], ['none', 'none - ask for everything']]); if (v) { const r = await request('config', { default_trust: v }); state.config = r.config; toast('default trust: ' + v, 'ok'); } }],
    ['toggle auto-publish of local folders to GitHub', async () => { const on = !(state.config && state.config.auto_publish === true); const r = await request('config', { auto_publish: on }); state.config = r.config; toast('auto-publish to GitHub: ' + (on ? 'on' : 'off'), 'ok'); }],
    ['set daily spend cap', async () => { const v = await promptDialog('Daily spend cap (USD, 0 = none)', 'Sessions pause when today\'s spend reaches it.', String(state.stats.daily_cap_usd || 0)); if (v != null) await request('config', { daily_cap_usd: Number(v) || 0 }); }],
    ['unpin all sessions from this window', () => { state.pins = []; savePins(); renderHeader(); renderWall(); }],
    ['text font and size (settings)', () => settingsDialog()],
    ['density: comfortable / compact', async () => { const v = await chooseDialog('Density', [['comfortable', 'comfortable (default)'], ['compact', 'compact - tighter spacing, more on screen']]); if (v) { setDensity(v); toast('density: ' + v, 'ok'); } }],
    ['theme: dark / light / system', async () => { const v = await chooseDialog('Theme', [['dark', 'dark (default)'], ['light', 'light'], ['system', 'follow the system setting']]); if (v) { setTheme(v); toast('theme: ' + v, 'ok'); } }],
    ['phone approvals (pair, revoke, enable)', remoteDialog],
    ['toggle model routing (auto = cheap for small tasks, strong for large)', async () => { const on = !(state.config && state.config.routing && state.config.routing.enabled !== false); const r = await request('config', { routing_enabled: !on }); state.config = r.config; toast('model routing: ' + (!on ? 'on' : 'off'), 'ok'); }],
    ['set review policy (when the changes view must approve)', async () => { const v = await chooseDialog('Review required before…', [['push', 'push - PRs, pushes and merges need an approved review (default)'], ['commit', 'commit - every commit needs an approved review'], ['none', 'none - review is optional']]); if (v) { const r = await request('config', { review_required: v }); state.config = r.config; toast('review required before: ' + v, 'ok'); } }],
    ['check for new commits', checkUpdates], ['pull + rebuild + restart kcoderd', updateNow], ['restart kcoderd', restartDaemon],
    ['uninstall kcoder…', uninstallDialog],
  );
  for (const t of ((state.config || {}).templates || [])) items.push([`start: ${t.name}`, async () => { try { const r = await request('templates', { action: 'run', template: t.id }); state.sid = r.session.id; loadEvents(r.session.id, -1); if (state.view === 'chat') assignPane(state.layout.focus, r.session.id); else { if (state.view !== 'wall') setView('wall'); focusPane(r.session.id); } toast('started ' + r.session.name + ' from template ' + t.name, 'ok'); } catch (e) { toast(e.message, 'err'); } }, 'template']);
  for (const s of state.sessions.values()) {
    items.push([`focus: ${s.name}${s.title ? ' · ' + s.title : ''}`, () => { if (state.view !== 'wall') setView('wall'); focusPane(s.id); }]);
    items.push([`open: ${s.name}`, () => { state.sid = s.id; if (state.view === 'chat') assignPane(state.layout.focus, s.id); else setView('chat'); }]);
    if (s.status === 'working' || s.status === 'waiting') items.push([`interrupt: ${s.name}`, () => request('interrupt', { sid: s.id })]);
    if (s.status === 'error') items.push([`error details: ${s.name}`, () => errorDialog(s.id)]);
    items.push([`archive: ${s.name}`, () => archiveChat(s.id)]);
    items.push([`export: ${s.name}`, () => exportChat(s.id)]);
    items.push([`shell: ${s.name}`, () => { if (state.view !== 'wall') setView('wall'); setPaneView(s.id, 'shell'); focusPane(s.id); }]);
    if (s.project && s.project.git) items.push([`pull from remote: ${s.name}`, () => handleAction({ dataset: { act: 'pull' } }, s.id)]);
    if (s.worktree) { items.push([`changes: ${s.name}${s.needs_review ? ' (needs review)' : ''}`, () => changesDialog(s.id)]); items.push([`merge: ${s.name}`, () => handleAction({ dataset: { act: 'merge' } }, s.id)]); items.push([`open PR: ${s.name}`, () => handleAction({ dataset: { act: 'pr' } }, s.id)]); }
    items.push([`instructions: ${s.name}`, () => instructionsDialog(s.id)]);
  }
  const perProject = new Map();
  for (const c of idleChats()) { const pid = (c.project || {}).id || 'other'; perProject.set(pid, (perProject.get(pid) || { name: (c.project || {}).name || 'other', n: 0 })); perProject.get(pid).n++; }
  for (const [pid, g] of perProject) items.push([`archive ${g.n} idle chat${g.n === 1 ? '' : 's'}: ${g.name}`, () => archiveIdle(pid)]);
  for (const c of state.chats.filter((c) => c.archived).slice(0, 50)) items.push([`resume: ${c.title || c.name}`, () => openChat(c.id)]);
  return items;
}
function openPalette(initial) {
  const all = paletteItems();
  let sel = 0, shown = all;
  const d = openDialog(`<div class="palette"><input id="pal-in" placeholder="search sessions, or type a command…"><div class="list" id="pal-list"></div></div>`, 'palette');
  const inp = $('#pal-in', d), list = $('#pal-list', d);
  const render = () => { list.innerHTML = shown.slice(0, 30).map(([l, , k], i) => `<div class="item${i === sel ? ' sel' : ''}" data-i="${i}"><span>${esc(l)}</span>${k ? `<span class="meta"><kbd>${esc(k)}</kbd></span>` : ''}</div>`).join('') || '<div class="empty-row">no match</div>'; const s = $('.sel', list); if (s) s.scrollIntoView({ block: 'nearest' }); };
  const filter = () => {
    const q = inp.value.toLowerCase().trim();
    // exact substring matches first (sessions by name, then commands), fuzzy matches after
    shown = q ? all.map((it, i) => [it, it[0].toLowerCase().includes(q) ? 0 : fuzzy(it[0].toLowerCase(), q) ? 1 : 2, i]).filter((x) => x[1] < 2).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map((x) => x[0]) : all;
    sel = 0; render();
  };
  const run = (i) => { const it = shown[i]; closeDialog(); if (it) it[1](); };
  inp.addEventListener('input', filter);
  inp.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); render(); e.preventDefault(); } else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); } else if (e.key === 'Enter') { run(sel); } else if (e.key === 'Escape') closeDialog(); });
  list.addEventListener('click', (e) => { const it = e.target.closest('[data-i]'); if (it) run(Number(it.dataset.i)); });
  if (typeof initial === 'string' && initial) { inp.value = initial; filter(); } else render();
}
function fuzzy(text, q) { let i = 0; for (const ch of q) { i = text.indexOf(ch, i); if (i < 0) return false; i++; } return true; }

// first-run setup: connect an AI provider (API key, or Claude Code for a Claude plan)
async function refreshProviders() { try { const r = await request('providers'); state.providers = r.providers; state.github = r.github || state.github; const c = (r.providers || []).find((p) => p.kind === 'claude'); if (c) { state.claude = { usage: c.usage, installed: c.installed, logged_in: c.logged_in, email: c.email, on_plan: c.on_plan, method: c.method, problem: c.problem, limits: c.limits || [] }; renderClaudeButton(); } } catch {} return state.providers || []; }
async function refreshClaude(clear) { try { state.claude = (await request('claude_plan', clear ? { action: 'clear_limits' } : {})).claude; } catch {} renderClaudeButton(); return state.claude || {}; }
function claudeLimitText(l) { const when = l.until ? new Date(l.until * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'later'; return `${l.scope === 'all' ? 'all Claude models' : l.scope[0].toUpperCase() + l.scope.slice(1)}: ${l.label || 'plan limit'} · back ${when}`; }
function planPct(u) { return Math.round((u.utilization || 0) * 100) + '%'; }
function planWhen(ts) { return ts ? new Date(ts * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'unknown'; }
const PLAN_SHORT = { five_hour: '5h', seven_day: 'wk', seven_day_opus: 'opus wk', seven_day_sonnet: 'sonnet wk', seven_day_overage_included: 'fable wk', overage: 'extra' };
function planUsageText(u) { return `${u.label || u.limit}: ${planPct(u)} used${u.stale ? ' (window reset; updates on the next turn)' : u.resets_at ? ', resets ' + planWhen(u.resets_at) : ''}`; }
function planShareText(s) { const sh = s.plan_share || {}; const parts = Object.keys(PLAN_SHORT).filter((k) => sh[k]).map((k) => `${Math.round(sh[k] * 100)}% of ${PLAN_SHORT[k]}`); return parts.length ? parts.join(', ') : ''; }
function renderClaudeButton() {
  const b = $('#btn-claude'); const c = state.claude; if (!b) return;
  if (!state.connected) { b.textContent = 'plan ?'; b.className = 'warn'; b.title = 'kcoderd is not running, so the Claude plan status is unknown; it comes back when kcoderd starts'; return; }
  if (!c || !c.installed && !c.logged_in && c.on_plan === undefined) { b.textContent = 'Claude'; b.className = ''; return; }
  const lim = c.limits || [];
  b.className = !c.on_plan ? 'warn' : lim.length ? 'warn' : '';
  const meter = ((state.stats || {}).quota || {}).source && (state.stats.quota.source !== 'none');   // the status bar's weekly meter covers the week
  const use = (c.usage || []).filter((u) => !u.stale && (u.limit === 'five_hour' || (u.limit === 'seven_day' && !meter)));
  b.textContent = !c.on_plan ? 'connect Claude' : lim.length ? `plan limit${lim.some((l) => l.scope === 'all') ? '' : ' · ' + lim.map((l) => l.scope).join(', ')}` : use.length ? 'plan ' + use.map((u) => `${PLAN_SHORT[u.limit]} ${planPct(u)}`).join(' · ') : 'plan ✓';
  if (!lim.length && use.some((u) => u.utilization >= 0.8)) b.className = 'warn';
  b.title = !c.on_plan ? (c.problem || 'not connected') : lim.length ? lim.map(claudeLimitText).join('\n') : `On your Claude plan${c.email ? ' as ' + c.email : ''}. kcoder never uses credits or an API key.` + ((c.usage || []).length ? '\n' + c.usage.map(planUsageText).join('\n') + '\nFrom Claude Code\'s rate-limit reports; updated on every turn. Click for the per-session share.' : '');
}
// ---- voice input: in the app window the Mac's on-device recognition (audio never leaves the machine, words biased
// towards repo names and dev terms); in a browser tab the Web Speech API. Either way the words only land in the
// composer for editing; nothing is ever sent by voice. ----
function nativeDictation() { const a = nativeApi(); return a && typeof a.dictate_start === 'function' ? a : null; }
function speechSupported() { return !!(nativeDictation() || window.SpeechRecognition || window.webkitSpeechRecognition); }
function dictationContext() {
  const words = new Set();
  for (const p of state.projects || []) if (p.name) words.add(p.name);
  for (const s of state.sessions.values()) { if (s.project && s.project.name) words.add(s.project.name); if (s.worktree && s.worktree.branch) words.add(s.worktree.branch); if (s.name) words.add(s.name); }
  for (const c of (state.chats || []).slice(0, 60)) if (c.project && c.project.name) words.add(c.project.name);
  return Array.from(words).slice(0, 120);
}
let voiceComp = null;   // the composer dictation is going into (one at a time)
window.kcoderDictation = (m) => {   // called by the app window with partial and final results
  const comp = voiceComp; if (!comp) return;
  const ta = comp.ta;
  if (m.text != null) { ta.value = comp._voiceBase + m.text; ta.dispatchEvent(new Event('input')); if (m.final) comp._voiceBase = ta.value.replace(/\s*$/, ' '); }
  if (m.done) {
    endVoice(comp);
    if (m.error) toast('dictation: ' + m.error, 'err');
  }
};
function endVoice(comp) {
  const mic = $('.mic', comp.form); if (mic) { mic.classList.remove('listening'); mic.title = micTitle(); }
  comp._voice = false; if (voiceComp === comp) voiceComp = null;
  const ta = comp.ta; ta.value = ta.value.replace(/\s+$/, ''); ta.dispatchEvent(new Event('input')); ta.focus();
}
function micTitle() { return nativeDictation() ? 'Voice input, on-device: click to start / stop, hold to talk, ⌥Space push-to-talk, ⌘⇧M toggle. Words land here for you to edit; nothing is sent by itself.' : 'Voice input: speak, the words land here; click again or pause to stop (⌘⇧M, hold ⌥Space to talk)'; }
function voiceActive(comp) { return !!(comp._voice || comp._rec); }
async function startVoice(comp) {
  if (voiceActive(comp)) return;
  if (voiceComp && voiceComp !== comp) stopVoice(voiceComp);
  const api = nativeDictation();
  if (!api) { toggleVoice(comp); return; }
  const mic = $('.mic', comp.form); const ta = comp.ta;
  comp._voiceBase = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
  comp._voice = true; voiceComp = comp;
  if (mic) { mic.classList.add('listening'); mic.title = 'Listening (on-device)… click or release to stop'; }
  let r; try { r = await api.dictate_start(dictationContext(), navigator.language || 'en-US'); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { endVoice(comp); toast(r && r.error ? r.error : 'dictation could not start', 'err'); }
}
function stopVoice(comp) {
  if (comp._rec) { comp._rec.stop(); return; }
  if (!comp._voice) return;
  const api = nativeDictation(); if (api) api.dictate_stop().catch(() => endVoice(comp)); else endVoice(comp);
}
function toggleVoice(comp) {
  if (voiceActive(comp)) { stopVoice(comp); return; }
  if (nativeDictation()) { startVoice(comp); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('voice input is not available in this browser', 'warn'); return; }
  const rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
  const mic = $('.mic', comp.form); const ta = comp.ta;
  const base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
  let finals = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finals += t.trim() + ' '; else interim += t; }
    ta.value = base + finals + interim; ta.dispatchEvent(new Event('input'));
  };
  rec.onerror = (e) => { if (e.error === 'not-allowed') toast('microphone access was refused; allow it for kcoder and try again', 'err'); else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('voice input: ' + e.error, 'err'); };
  rec.onend = () => { comp._rec = null; if (mic) { mic.classList.remove('listening'); mic.title = micTitle(); } ta.value = (base + finals).replace(/\s+$/, ''); ta.dispatchEvent(new Event('input')); ta.focus(); };
  try { rec.start(); } catch (e) { toast('voice input could not start: ' + e.message, 'err'); return; }
  comp._rec = rec; if (mic) { mic.classList.add('listening'); mic.title = 'Listening… click to stop'; }
}

// ---- the morning brief: what every session did, what waits on you, what is in review ----
async function briefDialog(opts = {}) {
  let r; try { r = await request('brief', { since: opts.since || null }); } catch (e) { toast(e.message, 'err'); return; }
  const b = r.brief, t = b.totals;
  const when = (ts) => ts ? new Date(ts * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const item = (x) => `<div class="item" data-open="${esc(x.sid)}"><span class="sess">${esc(x.name)}</span><code>${esc(x.kind)}: ${esc(x.text)}${x.checks ? ' · checks ' + esc(x.checks) : ''}${x.draft ? ' · draft' : ''}</code><span class="meta">${x.ts ? age(x.ts) + ' ago' : ''}</span>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">open PR</a>` : ''}<button data-open="${esc(x.sid)}">open</button></div>`;
  const sess = (s) => `<div class="brief-s"><div class="h"><button class="link" data-open="${esc(s.sid)}">${esc(s.name)}</button>${s.title && s.title !== s.name ? ` · ${esc(s.title)}` : ''}<span class="meta">${esc(s.project)} · ${esc(s.status)} · ${s.last_activity ? age(s.last_activity) + ' ago' : ''}</span></div>
      ${s.asked ? `<div class="l"><span class="k">asked</span>${esc(s.asked)}</div>` : ''}${s.did ? `<div class="l"><span class="k">last reply</span>${esc(s.did)}</div>` : ''}
      ${s.commit_count ? `<div class="l"><span class="k">commits</span>${s.commit_count} · ${s.files} file(s) · <span class="add">+${s.added}</span> <span class="del">-${s.removed}</span>: ${esc(s.commits.map((c) => c.subject.slice(0, 70)).join('; '))}</div>` : ''}
      ${s.pr ? `<div class="l"><span class="k">PR</span><a href="${esc(s.pr.url)}" target="_blank" rel="noopener">#${esc(s.pr.number)}</a> · checks ${esc(s.pr.checks || 'none')}</div>` : ''}${s.needs_review ? `<div class="l"><span class="k">review</span>changes wait for your review <button data-changes="${esc(s.sid)}">changes</button></div>` : ''}
      ${s.jobs.length ? `<div class="l"><span class="k">jobs</span>${esc(s.jobs.map((j) => j.name + ' (' + j.status + ')').join(', '))}</div>` : ''}${s.handed_off_to ? `<div class="l"><span class="k">handoff</span>continued in a fresh session</div>` : ''}
      <div class="l dim">${s.turns} turn(s) · ${fmtTokens(s.tokens)} tokens${s.cost ? ' · ' + fmtUsd(s.cost) : ''}</div></div>`;
  const d = openDialog(`<h2>brief <span class="help">since ${esc(when(b.since))}</span><span class="spacer"></span><button data-b="24">24h</button><button data-b="72">3 days</button><button data-b="168">week</button><button data-b="copy" title="copy as markdown">copy</button><button data-x="close">✕</button></h2>
    <div class="body brief">
      <div class="status"><span><b>${t.sessions}</b> session(s)</span><span><b>${t.turns}</b> turn(s)</span><span><b>${fmtTokens(t.tokens)}</b> tokens</span><span><b>${t.commits}</b> commit(s) · ${t.files} file(s) · <span class="add">+${t.added}</span> <span class="del">-${t.removed}</span></span>${t.cost ? `<span>${fmtUsd(t.cost)} on API keys</span>` : ''}${(b.plan || []).map((p) => `<span>${esc(p.label)} <b>${Math.round(p.utilization * 100)}%</b></span>`).join('')}</div>
      <div class="label-h">waiting on you · ${b.waiting.length}</div><div class="list">${b.waiting.map(item).join('') || '<div class="empty-row">nothing</div>'}</div>
      <div class="label-h">in review · ${b.review.length}</div><div class="list">${b.review.map(item).join('') || '<div class="empty-row">nothing</div>'}</div>
      ${(b.tasks.queued || b.tasks.running || b.tasks.review || b.tasks.failed) ? `<div class="help plain">task queue: ${b.tasks.running} running · ${b.tasks.queued} queued · ${b.tasks.review} in review · ${b.tasks.failed} failed${b.tasks.paused ? ' · paused' : ''} <button data-tasks="1">open</button></div>` : ''}
      <div class="label-h">sessions · ${b.sessions.length}</div>${b.sessions.map(sess).join('') || '<div class="empty-row">no session was active</div>'}
    </div>`, 'brief');
  d.classList.add('wide');
  localStorage.setItem('kcoder.brief.seen', String(Date.now()));
  d.addEventListener('click', async (e) => {
    const bb = e.target.closest('[data-b]'); if (bb) { if (bb.dataset.b === 'copy') { try { await navigator.clipboard.writeText(r.markdown); toast('brief copied as markdown', 'ok'); } catch { toast('copy failed', 'err'); } } else { closeDialog(); briefDialog({ since: Date.now() / 1000 - Number(bb.dataset.b) * 3600 }); } return; }
    if (e.target.closest('[data-x]')) { closeDialog(); return; }
    const c = e.target.closest('[data-changes]'); if (c) { closeDialog(); changesDialog(c.dataset.changes); return; }
    if (e.target.closest('[data-tasks]')) { closeDialog(); setView('tasks'); return; }
    const o = e.target.closest('[data-open]'); if (o) { closeDialog(); state.sid = o.dataset.open; if (state.view === 'chat') assignPane(state.layout.focus, o.dataset.open); else { if (state.view !== 'wall') setView('wall'); focusPane(o.dataset.open); } }
  });
}
function maybeMorningBrief() {
  // once a day, on the first open: show the brief when something happened or waits
  const seen = Number(localStorage.getItem('kcoder.brief.seen') || 0);
  if (seen && new Date(seen).toDateString() === new Date().toDateString()) return;
  if (state.dialog) return;
  request('brief', {}).then((r) => { const b = r.brief; if (!b.sessions.length && !b.waiting.length && !b.review.length) { localStorage.setItem('kcoder.brief.seen', String(Date.now())); return; } if (!state.dialog) briefDialog(); }).catch(() => {});
}

// ---- what went wrong: the last error of a session, with send-again and a copyable report ----
function lastErrorText(sid) { const st = state.events.get(sid); if (!st) return ''; for (let i = st.list.length - 1; i >= 0; i--) if (st.list[i].t === 'error') return st.list[i].text || ''; return ''; }
async function errorDialog(sid) {
  const s = state.sessions.get(sid) || state.chats.find((c) => c.id === sid) || { id: sid, name: sid };
  const d = openDialog(`<h2>${esc(s.name || sid)} · what went wrong<span class="spacer"></span><button data-x="close">✕</button></h2><div class="body"><div class="help plain" id="err-body">loading…</div></div>
    <div class="foot"><span class="help plain" id="err-status"></span><span class="spacer" style="flex:1"></span><button data-x="copy">Copy report</button><button data-x="open">Open session</button><button class="primary" data-x="again" hidden>Send again</button></div>`, 'error');
  d.classList.add('errdlg');
  let store = state.events.get(sid);
  if (!store || !store.loaded) { try { await loadEvents(sid, -1); } catch {} store = state.events.get(sid) || { list: [] }; }
  const list = store.list; let i = list.length - 1; while (i >= 0 && list[i].t !== 'turn_start') i--;
  const turn = list.slice(Math.max(0, i));
  const errors = turn.filter((e) => e.t === 'error'); const lastErr = errors[errors.length - 1] || [...list].reverse().find((e) => e.t === 'error');
  let lastUser = null; for (let k = list.length - 1; k >= 0; k--) if (list[k].t === 'user') { lastUser = list[k]; break; }
  const when = (e) => new Date(e.ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const trail = turn.filter((e) => e.t !== 'text' && e.t !== 'progress').slice(-14).map((e) => `${when(e)}  ${e.t}${e.t === 'tool_call' ? '  ' + (e.description || e.name || '') : e.t === 'tool_result' ? (e.is_error ? '  ✗ failed' : '  ✓') : e.t === 'turn_end' ? '  ' + (e.result || '') : e.t === 'error' || e.t === 'notice' ? '  ' + (e.text || '') : ''}`.slice(0, 160));
  const v = state.version || {};
  const report = [`kcoder ${v.running || ''} · session ${s.name || ''} (${sid}) · ${s.provider || ''}/${s.model || ''} · status ${s.status || ''}`, '', 'error:', lastErr ? `${when(lastErr)}  ${lastErr.text}` : '(no error event recorded)', '', 'last prompt:', lastUser ? (lastUser.text || '').slice(0, 500) : '(none)', '', 'last events of the turn:', ...trail, '', `daemon log: ~/.local/share/kcoder/daemon.log · session log: ~/.local/share/kcoder/sessions/${sid}/events.jsonl`].join('\n');
  $('#err-body', d).innerHTML = `${lastErr ? `<div class="note err" style="margin:0 0 8px">${esc(lastErr.text)}</div>` : '<div class="dim">No error text was recorded for this session; the trail below shows what ran last.</div>'}
    <div class="label-h">last events of the turn</div><pre class="trail">${esc(trail.join('\n') || '(nothing recorded)')}</pre>
    <div class="dim">Press <b>Send again</b> to resend your last prompt in this session, or copy the report and paste it into a kcoder session so it can look into the bug.</div>`;
  const again = $('[data-x="again"]', d); again.hidden = !lastUser || !state.sessions.has(sid);
  d.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    const x = b.dataset.x;
    if (x === 'close') { closeDialog(); return; }
    if (x === 'copy') { try { await navigator.clipboard.writeText(report); $('#err-status', d).textContent = 'report copied'; } catch { $('#err-status', d).textContent = 'could not copy; select the text instead'; } return; }
    if (x === 'open') { closeDialog(); state.sid = sid; if (state.view === 'chat') assignPane(state.layout.focus, sid); else setView('chat'); return; }
    if (x === 'again') { closeDialog(); try { await request('send', { sid, text: lastUser.text, images: [] }); toast('sent again', 'ok'); } catch (err) { toast(err.message, 'err'); } }
  });
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-err]'); if (b && !e.target.closest('a')) { e.stopPropagation(); errorDialog(b.dataset.err); } }, true);

// ---- background jobs: output and a stop button ----
async function jobDialog(sid, id) {
  let r;
  try { r = await request('job_tail', { sid, job: id, lines: 400 }); } catch (e) { toast(e.message, 'err'); return; }
  const j = r.job; state.jobOpen = sid + ':' + id;
  if (!state.jobTails.get(state.jobOpen)) state.jobTails.set(state.jobOpen, r.tail || '');
  const live = j.status === 'running' || j.status === 'stopping';
  const d = openDialog(`<h2>job ${j.id} · ${esc(j.name)}<span class="help" id="job-status">${esc(j.status)}${j.exit != null ? ' · exit ' + j.exit : ''} · ${fmtElapsed(j.seconds * 1000)}</span><span class="spacer"></span>${live ? '<button class="danger" data-x="stop">■ stop</button>' : ''}<button data-x="close">✕</button></h2>
    <div class="body"><code class="dim">${esc(j.cmd)}</code><pre class="joblog" id="job-log"></pre><div class="help plain">log: ${esc(j.log)}</div></div>`, 'job');
  renderJobDialogTail();
  d.addEventListener('click', async (e) => { const b = e.target.closest('[data-x]'); if (!b) return; if (b.dataset.x === 'stop') { try { await request('job_stop', { sid, job: id }); toast('stopping job ' + id, 'warn'); } catch (err) { toast(err.message, 'err'); } } else { state.jobOpen = null; closeDialog(); } });
}
function renderJobDialogTail() { const pre = $('#job-log'); if (!pre) return; const stick = nearBottom(pre); pre.textContent = state.jobTails.get(state.jobOpen) || '(no output yet)'; if (stick) pre.scrollTop = pre.scrollHeight; }
document.addEventListener('click', (e) => { const o = e.target.closest('.chat-log [data-open], .note [data-open]'); if (o && o.dataset.open) { e.stopPropagation(); state.sid = o.dataset.open; if (state.view === 'chat') { const pane = o.closest('.pane[data-sid]'); const idx = pane ? state.layout.panes.indexOf(pane.dataset.sid) : -1; assignPane(idx >= 0 ? idx : state.layout.focus, o.dataset.open); } else { if (state.view !== 'wall') setView('wall'); focusPane(o.dataset.open); } } }, true);
document.addEventListener('click', (e) => { const b = e.target.closest('[data-job]'); if (!b) return; const pane = b.closest('[data-sid]'); const sid = (pane && pane.dataset.sid) || state.sid; if (sid) { e.stopPropagation(); jobDialog(sid, Number(b.dataset.job)); } }, true);

function aboutDialog() {
  const v = state.version || {};
  const d = openDialog(`<div class="body"><img class="logo" src="icon-192.png" alt=""><pre class="banner" aria-label="KCODER">${esc(BANNER)}</pre>
    <div class="tagline">${esc(ABOUT_LINES[Math.floor(Math.random() * ABOUT_LINES.length)])}</div>
    <div class="credits">© Kyle Niedzwiecki<br><span class="ver">kcoder ${esc(v.running || '')}</span></div>
    <div class="row"><button data-x="settings">Settings</button><button data-x="keys">Keyboard shortcuts</button><button class="primary" data-x="close">Close</button></div></div>`, 'about');
  d.classList.add('about');
  d.addEventListener('click', (e) => { const b = e.target.closest('[data-x]'); if (!b) return; closeDialog(); if (b.dataset.x === 'settings') settingsDialog(); else if (b.dataset.x === 'keys') helpDialog(); });
}

async function settingsDialog() {
  try { state.config = (await request('config')).config; } catch {}
  const cfg = state.config || {};
  const chk = (id, on, label, help) => `<label class="setting"><span>${label}${help ? ` <span class="help">${help}</span>` : ''}</span><input type="checkbox" data-set="${id}"${on ? ' checked' : ''}></label>`;
  const sel = (id, val, label, opts) => `<label class="setting"><span>${label}</span><select data-set="${id}">${opts.map(([k, l]) => `<option value="${k}"${k === val ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const d = openDialog(`<h2>settings<span class="spacer"></span><button data-x="close">✕</button></h2><div class="body">
    ${sel('theme', themeChoice(), 'Theme', [['dark', 'dark'], ['light', 'light'], ['system', 'follow the system']])}
    ${sel('density', densityChoice(), 'Density', [['comfortable', 'comfortable'], ['compact', 'compact - tighter spacing, more on screen']])}
    ${(() => { const f = fontChoice(); const known = FONT_PRESETS.some(([k]) => k === f.family); return `<label class="setting"><span>Text font <span class="help">any font installed on this computer; the system monospace is used if it is missing</span></span><select data-set="font">${FONT_PRESETS.map(([k, l]) => `<option value="${esc(k)}"${k === f.family ? ' selected' : ''}>${esc(l)}</option>`).join('')}<option value="__custom"${known ? '' : ' selected'}>other…</option></select></label>
    <label class="setting" id="font-custom"${known ? ' hidden' : ''}><span>Font name <span class="help">exactly as it is installed, for example "Victor Mono"</span></span><input type="text" data-set="font_custom" value="${esc(known ? '' : f.family)}" placeholder="font family"></label>
    <label class="setting"><span>Text size</span><select data-set="font_size">${FONT_SIZES.map((n) => `<option value="${n}"${n === f.size ? ' selected' : ''}>${n} px</option>`).join('')}</select></label>
    <div class="sample" id="font-sample">kcoder> the quick brown fox jumps over the lazy dog  0O 1lI {} =&gt; -&gt;</div>`; })()}
    ${chk('sound', state.sound, 'Sound', 'a ping when a session needs you')}
    ${sel('default_trust', cfg.default_trust || 'auto', 'Default trust for new sessions', [['auto', 'auto - never ask'], ['write', 'write - gate shell'], ['read', 'read - gate writes + shell'], ['none', 'none - ask for everything']])}
    ${chk('routing_enabled', !(cfg.routing && cfg.routing.enabled === false), 'Model routing', 'auto picks a cheap model for small turns, a strong one for large')}
    ${sel('review_required', cfg.review_required || 'push', 'Review required before', [['push', 'push - PRs, pushes and merges'], ['commit', 'commit - every commit'], ['none', 'none - review is optional']])}
    ${chk('auto_publish', cfg.auto_publish === true, 'Auto-publish local folders to GitHub', 'a private repo is created and pushed for folders with no remote')}
    ${chk('connector_approvals', cfg.connector_approvals !== false, 'Connector approvals', 'reads (Gmail, Calendar, Drive, Linear…) run by themselves; sends and changes wait for your approval')}
    ${chk('ci_autofix', cfg.ci_autofix !== false, 'Auto-fix on CI failure', 'a red check on a session\'s PR sends the failing log to that session; its fix is pushed through the usual review gate (at most three rounds per PR)')}
    ${chk('handoff', cfg.handoff !== false, 'Automatic handoff', 'at the compaction point the session writes a handoff summary and continues as a fresh session in the same worktree (off: the history is summarised in place)')}
    <label class="setting"><span>Claude plan price (USD / month) <span class="help">the stats page's "paid for itself" badges compare API-equivalent usage with it</span></span><input type="number" min="0" step="1" data-set="plan_price_usd" value="${Number(cfg.plan_price_usd == null ? 200 : cfg.plan_price_usd)}"></label>
    <div class="label-h">weekly plan limit</div>
    ${(() => { const q = cfg.quota || {}; return `<label class="setting"><span>Weekly limit (tokens, 0 = none) <span class="help">used when Claude Code has not reported the real weekly number: the meter estimates from plan tokens since the reset</span></span><input type="number" min="0" step="1000000" data-set="quota_limit_tokens" value="${Number(q.limit_tokens || 0)}"></label>
    ${sel('quota_reset_weekday', String(q.reset_weekday || 0), 'Resets on', WEEKDAYS.map((d, i) => [String(i), d]))}
    ${sel('quota_reset_hour', String(q.reset_hour || 0), 'at (hour, local time)', Array.from({ length: 24 }, (_, h) => [String(h), `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`]))}
    ${chk('quota_shift', !!q.shift, 'Quota shift', 'when the forecast says the weekly limit runs out before the reset, small turns in sessions pinned to the big model run on the cheaper tier (always shown in the status bar while active)')}`; })()}
    <label class="setting"><span>Daily spend cap (USD, 0 = none) <span class="help">sessions on paid API keys pause when today's spend reaches it</span></span><input type="number" min="0" step="1" data-set="daily_cap_usd" value="${Number((state.stats || {}).daily_cap_usd || 0)}"></label>
    <div class="label-h">conditions</div>
    ${(() => { const c = cfg.conditions || {}; const pl = c.place || {}; return `${chk('conditions_enabled', c.enabled !== false, 'Conditions in the header', 'an ambient accent on the header\'s ridgeline: fresh snow, bitcoin\'s day, the full moon; one at a time (snow first), refreshed every 30 minutes, kept while offline and gone after 12 hours; with reduced motion on, nothing moves')}
    ${chk('conditions_snow', c.snow !== false, 'Fresh snow', 'light falling snow and a tag with the inches when the place below had snow in the last 24 h (Open-Meteo, no key; the place is fixed here, never your location)')}
    <label class="setting"><span>Snow place <span class="help">the name in the tag</span></span><input type="text" data-set="conditions_place" value="${esc(pl.name || 'Alta')}" placeholder="Alta"></label>
    <label class="setting"><span>Snow place lat, lon <span class="help">decimal degrees</span></span><input type="text" data-set="conditions_latlon" value="${esc(`${pl.lat ?? 40.5884}, ${pl.lon ?? -111.6386}`)}" placeholder="40.5884, -111.6386"></label>
    ${chk('conditions_btc', c.btc !== false, 'Bitcoin', 'a thin line under the header, green or red with the 24 h move and stronger the bigger it is; a 5% day gets a badge on the ridgeline (CoinGecko, no key)')}
    ${chk('conditions_moon', c.moon !== false, 'Full moon', 'in dark mode on full-moon nights: a small moon over the ridgeline and slightly cooler tones')}`; })()}
    <div class="label-h">accounts</div>
    <div class="links"><button data-x="claude">Claude plan</button><button data-x="setup">AI providers + GitHub</button><button data-x="remote">Phone approvals</button><button data-x="notif">Browser notifications</button></div>
    <div class="label-h">kcoder</div>
    <div class="links"><button data-x="update">Check for new commits</button><button data-x="restart">Restart kcoderd</button><button data-x="keys">Keyboard shortcuts</button><button data-x="about">About</button><button class="danger" data-x="uninstall">Uninstall…</button></div>
  </div><div class="foot"><button class="primary" data-x="close">Done</button></div>`, 'settings');
  d.classList.add('settings');
  d.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-set]'); if (!el) return;
    const k = el.dataset.set;
    try {
      if (k === 'theme') { setTheme(el.value); toast('theme: ' + el.value, 'ok'); return; }
      if (k === 'density') { setDensity(el.value); toast('density: ' + el.value, 'ok'); return; }
      if (k === 'font') { const custom = el.value === '__custom'; $('#font-custom', d).hidden = !custom; if (custom) { $('[data-set="font_custom"]', d).focus(); return; } setFont(el.value, null); toast('font: ' + (el.value || 'system monospace'), 'ok'); return; }
      if (k === 'font_custom') { setFont(el.value.trim(), null); toast('font: ' + (el.value.trim() || 'system monospace'), 'ok'); return; }
      if (k === 'font_size') { setFont(null, Number(el.value)); toast('text size: ' + el.value + ' px', 'ok'); return; }
      if (k === 'sound') { if (state.sound !== el.checked) toggleSound(); return; }
      const fields = k.startsWith('conditions_') ? { [k]: el.type === 'checkbox' ? el.checked : el.value } : k === 'routing_enabled' ? { routing_enabled: el.checked } : k === 'auto_publish' ? { auto_publish: el.checked } : k === 'connector_approvals' ? { connector_approvals: el.checked } : k === 'handoff' ? { handoff: el.checked } : k === 'ci_autofix' ? { ci_autofix: el.checked } : k === 'plan_price_usd' ? { plan_price_usd: Number(el.value) } : k === 'daily_cap_usd' ? { daily_cap_usd: Number(el.value) || 0 } : k === 'quota_shift' ? { quota_shift: el.checked } : k === 'quota_limit_tokens' ? { quota_limit_tokens: Number(el.value) || 0 } : k === 'quota_reset_weekday' || k === 'quota_reset_hour' ? { [k]: Number(el.value) } : { [k]: el.value };
      const r = await request('config', fields); state.config = r.config; toast('saved', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });
  d.addEventListener('click', (e) => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    const x = b.dataset.x; closeDialog();
    ({ claude: claudeDialog, setup: () => setupDialog(), remote: remoteDialog, notif: () => Notification.requestPermission().then((p) => toast('notifications: ' + p)),
       update: checkUpdates, restart: restartDaemon, keys: helpDialog, about: aboutDialog, uninstall: uninstallDialog }[x] || (() => {}))();
  });
}

async function claudeDialog() {
  if (!state.connected) { toast('kcoderd is not running: Claude is fine, the app just cannot reach kcoderd. ' + (window.pywebview ? 'It is being started; try again in a few seconds.' : 'Run `kcoder app` in a terminal.'), 'warn'); return; }
  const d = openDialog(`<h2>your Claude plan<span class="spacer"></span><button data-x="close">✕</button></h2><div class="body setup"><div id="cl-body" class="help plain">checking…</div></div>
    <div class="foot"><span class="help plain" id="cl-status"></span><span class="spacer" style="flex:1"></span><button data-cl="check">Check again</button><button class="primary" data-cl="login">Reconnect Claude</button></div>`, 'claude');
  const body = $('#cl-body', d), status = $('#cl-status', d);
  const render = (c) => {
    const lim = c.limits || [];
    body.innerHTML = `<div class="status"><span>Claude Code: ${c.installed ? '<b class="ok">installed</b>' : '<b class="warn">not installed</b>'}</span>
      <span>Account: ${c.on_plan ? `<b class="ok">your Claude plan${c.email ? ' (' + esc(c.email) + ')' : ''}</b>` : `<b class="warn">${esc(c.problem || 'not connected')}</b>`}</span></div>
      <div class="help plain">kcoder only runs Claude on your subscription. It never uses an API key or extra usage credits: when a limit is reached the turn stops and kcoder waits for the reset.</div>
      ${(c.usage || []).length ? `<div class="label-h">plan limits in use</div>${c.usage.map((u) => `<div class="row planrow" title="${esc(planUsageText(u))}"><span class="pl">${esc(u.label || u.limit)}</span><span class="meter"><span class="fill ${u.utilization >= 0.8 ? 'hot' : ''}" style="width:${Math.round(u.utilization * 100)}%"></span></span><span class="pv">${planPct(u)}</span><span class="help plain">${u.stale ? 'window reset · updates on the next turn' : u.resets_at ? 'resets ' + esc(planWhen(u.resets_at)) : ''}</span></div>`).join('')}
        ${(() => { const rows = Array.from(state.sessions.values()).filter((s) => s.plan_share && (s.plan_share.five_hour || s.plan_share.seven_day)).sort((a, b) => ((b.plan_share.five_hour || 0) + (b.plan_share.seven_day || 0)) - ((a.plan_share.five_hour || 0) + (a.plan_share.seven_day || 0))).slice(0, 8); return rows.length ? `<div class="label-h">share by session</div>${rows.map((s) => `<div class="row"><span class="sess">${esc(s.name)}</span><span class="help plain">${esc(planShareText(s))}</span></div>`).join('')}<div class="help plain">The increase in each limit seen during a session's turns. Sessions running at the same time share the credit, so treat it as a guide.</div>` : ''; })()}` : '<div class="help plain">How much of the 5-hour and weekly limits is used appears here after the first Claude turn.</div>'}
      ${lim.length ? `<div class="label-h">limits reached</div>${lim.map((l) => `<div class="row"><span>${esc(claudeLimitText(l))}</span></div>`).join('')}
        <div class="row"><button data-cl="clear">Clear: I reset my limit</button><span class="help plain">Only if you reset it on claude.ai. If it is still used up, the next turn stops again before spending anything.</span></div>` : ''}`;
    $('[data-cl="login"]', d).textContent = !c.installed ? 'Install Claude Code' : c.on_plan ? 'Reconnect Claude' : 'Connect my Claude plan';
  };
  state._renderClaude = render;
  render(await refreshClaude());
  let poll = null;
  const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
  d.addEventListener('click', async (e) => {
    if (e.target.closest('[data-x]')) { stopPoll(); closeDialog(); return; }
    const b = e.target.closest('[data-cl]'); if (!b) return;
    status.textContent = '';
    try {
      if (b.dataset.cl === 'check') { status.textContent = 'checking…'; render(await refreshClaude()); status.textContent = ''; }
      else if (b.dataset.cl === 'clear') { render(await refreshClaude(true)); toast('limit cleared; the next turn checks it again', 'ok'); }
      else if (b.dataset.cl === 'login') {
        const c = state.claude || {};
        const r = await request('connect', { provider: 'claude', action: c.installed ? 'login' : 'install' });
        status.textContent = r.message + ' Waiting for you to sign in…';
        const was = c.email; let n = 0; stopPoll();
        poll = setInterval(async () => {
          if (state.dialog !== 'claude' || ++n > 90) { stopPoll(); return; }
          const now = await refreshClaude();
          if (now.on_plan && (n > 3 || now.email !== was || !c.on_plan)) { stopPoll(); render(now); status.textContent = ''; toast(`Claude plan connected${now.email ? ' as ' + now.email : ''}`, 'ok'); }
        }, 2000);
      }
    } catch (err) { status.textContent = err.message; }
  });
}
async function refreshGithub(refresh) { try { state.github = (await request('github', { refresh: !!refresh })).github; } catch {} return state.github || {}; }
function githubHtml() {
  const g = state.github || {};
  if (!g.connected) return `<div class="status"><span>GitHub: <b class="warn">not connected</b></span>${g.gh_installed ? '' : '<span class="dim">(the GitHub CLI will be installed)</span>'}</div>
    <div class="help plain">Commits kcoder makes are authored as <b>your</b> GitHub account, never as kcoder or an AI, so every commit shows your avatar. Until GitHub is connected, commits are blocked.</div>
    <div class="row"><button class="primary" data-gh="login">Connect GitHub</button><button data-gh="check">Check again</button></div>`;
  return `<div class="status"><span>GitHub: <b class="ok">@${esc(g.login)}</b>${g.name ? ' <span class="dim">' + esc(g.name) + '</span>' : ''}</span><span>Push: ${g.push_ready ? '<b class="ok">uses this account</b>' : '<b class="warn">git credential helper not set</b>'}</span></div>
    <div class="help plain">Commits are authored as <code>${esc(g.commit_as || '')}</code>. Switching accounts in gh changes this for the next commit.</div>
    <div class="row wrap">
      <label class="check"><input type="radio" name="gh-email" value="noreply" ${g.commit_email !== 'public' ? 'checked' : ''}> noreply address (links to your profile, hides your email)</label>
      <label class="check"><input type="radio" name="gh-email" value="public" ${g.commit_email === 'public' ? 'checked' : ''} ${g.public_email ? '' : 'disabled'}> public email${g.public_email ? ' (' + esc(g.public_email) + ')' : ' (none set on GitHub)'}</label>
    </div>
    <label>ai trailer on commits (empty = none, the default)<input id="gh-trailer" value="${esc(g.ai_trailer || '')}" placeholder="e.g. Co-Authored-By: Claude <noreply@anthropic.com>"></label>
    <div class="row"><button data-gh="trailer">Save trailer</button><button data-gh="switch">Switch account</button><button data-gh="check">Check again</button></div>`;
}
async function setupDialog(pid) {
  let provs = await refreshProviders();
  if (!provs.length) return;
  const cur = pid || (provs.find((p) => p.default) || provs[0]).id;
  const d = openDialog(`<h2>connect your AI<span class="spacer"></span><button data-x="close">✕</button></h2><div class="body setup">
    <div class="help plain">kcoder runs on a model you already have access to. Pick where your model lives and sign in once.</div>
    <label>provider<select id="su-prov">${provs.map((p) => `<option value="${p.id}"${p.id === cur ? ' selected' : ''}>${esc(p.label)}${p.configured ? ' ✓' : ''}</option>`).join('')}</select></label>
    <div id="su-panel"></div>
    <div class="label-h">github</div>
    <div id="su-github" class="setup">${githubHtml()}</div>
  </div><div class="foot"><span class="help plain" id="su-status"></span><span class="spacer" style="flex:1"></span><button data-x="close">close</button></div>`, 'setup');
  const sel = $('#su-prov', d), panel = $('#su-panel', d), status = $('#su-status', d);
  const render = () => {
    const p = provs.find((x) => x.id === sel.value) || {};
    if (p.kind === 'claude') {
      panel.innerHTML = `<div class="status"><span>Claude Code: ${p.installed ? '<b class="ok">installed</b>' : '<b class="warn">not installed</b>'}</span><span>Account: ${p.on_plan ? `<b class="ok">your Claude plan${p.email ? ' (' + esc(p.email) + ')' : ''}</b>` : p.logged_in ? `<b class="warn">${esc(p.problem || 'not on your Claude plan')}</b>` : '<b class="warn">not signed in</b>'}</span></div>
        <div class="help plain">Uses your Claude subscription from claude.ai. No API key and no per-token billing.${p.installed ? '' : ' Installing opens a Terminal window; follow the steps there, then come back and click Check again.'}</div>
        <div class="row">${!p.installed ? '<button class="primary" data-su="install">Install Claude Code and sign in</button>' : !p.on_plan ? '<button class="primary" data-su="login">Connect my Claude plan</button>' : '<button class="primary" data-su="use-claude">Use my Claude plan</button><button data-su="login">Reconnect</button>'}<button data-su="check">Check again</button></div>`;
    } else {
      panel.innerHTML = `<div class="help plain">${p.configured ? 'Already connected. Paste a new key to replace it.' : 'Paste an API key from your account.'}${p.key_url ? ` <a href="${esc(p.key_url)}" target="_blank" rel="noopener">Get a ${esc(p.label)} key ↗</a>` : ''}</div>
        <label>api key<input id="su-key" type="password" placeholder="paste your key" autocomplete="off"></label>
        <div class="row"><button class="primary" data-su="connect">Connect</button>${p.configured && !p.default ? '<button data-su="default">Make default</button>' : ''}</div>`;
    }
  };
  render();
  sel.addEventListener('change', render);
  d.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'su-key') { e.preventDefault(); $('[data-su="connect"]', d).click(); } });
  d.addEventListener('change', async (e) => { const r = e.target.closest('input[name="gh-email"]'); if (r) { try { await request('config', { commit_email: r.value }); await refreshGithub(false); $('#su-github', d).innerHTML = githubHtml(); toast('commits use the ' + r.value + ' email', 'ok'); } catch (err) { status.textContent = err.message; } } });
  d.addEventListener('click', async (e) => {
    if (e.target.closest('[data-x]')) { closeDialog(); return; }
    const gb = e.target.closest('[data-gh]');
    if (gb) {
      status.textContent = '';
      try {
        switch (gb.dataset.gh) {
          case 'login': case 'switch': { const r = await request('connect', { provider: 'github', action: gb.dataset.gh }); status.textContent = r.message; return; }
          case 'check': { status.textContent = 'checking…'; const r = await request('connect', { provider: 'github' }); state.github = r.github || state.github; $('#su-github', d).innerHTML = githubHtml(); status.textContent = r.message; return; }
          case 'trailer': { await request('config', { ai_trailer: $('#gh-trailer', d).value }); await refreshGithub(false); $('#su-github', d).innerHTML = githubHtml(); toast('commit trailer saved', 'ok'); return; }
        }
      } catch (err) { status.textContent = err.message; }
      return;
    }
    const b = e.target.closest('[data-su]'); if (!b) return;
    const id = sel.value; status.textContent = '';
    try {
      switch (b.dataset.su) {
        case 'connect': { status.textContent = 'checking the key…'; const r = await request('connect', { provider: id, api_key: $('#su-key', d).value }); state.providers = r.providers || state.providers; toast(r.message, 'ok'); closeDialog(); return; }
        case 'default': { const r = await request('connect', { provider: id, action: 'default' }); state.providers = r.providers || state.providers; provs = state.providers; toast(r.message, 'ok'); render(); return; }
        case 'install': case 'login': { const r = await request('connect', { provider: 'claude', action: b.dataset.su }); status.textContent = r.message; return; }
        case 'check': { status.textContent = 'checking…'; provs = await refreshProviders(); render(); status.textContent = ''; return; }
        case 'use-claude': { const r = await request('connect', { provider: 'claude' }); state.providers = r.providers || state.providers; toast(r.message, 'ok'); closeDialog(); return; }
      }
    } catch (err) { status.textContent = err.message; }
  });
}

// token gate (first launch without #token=)
// ---- pane chips: instruction file, PR + CI, review flag ----
function paneChips(s) {
  let h = '';
  for (const j of (s.jobs || []).filter((j) => j.status === 'running' || j.status === 'stopping')) h += `<span class="chip job" data-job="${j.id}" title="background job: ${esc(j.cmd)} (click for output, stop)">▶ ${esc(j.name.slice(0, 28))} · ${fmtElapsed((Date.now() / 1000 - j.started) * 1000)}</span>`;
  const ins = s.instructions || [];
  h += `<span class="chip" data-act="instructions" title="${ins.length ? 'instruction file(s) loaded for every turn: ' + esc(ins.join(', ')) + (s.rules ? ' · ' + s.rules + ' plain-English rule' + (s.rules === 1 ? '' : 's') + ' enforced as checks' : '') + ' (click to edit)' : 'no instruction file in this repo (click to create KCODER.md)'}">${ins.length ? '📄 ' + esc(ins[0]) + (ins.length > 1 ? ' +' + (ins.length - 1) : '') + (s.rules ? ' · ' + s.rules + ' rule' + (s.rules === 1 ? '' : 's') : '') : '📄 none'}</span>`;
  if (s.issue && s.issue.url) h += `<a class="chip" href="${esc(s.issue.url)}" target="_blank" rel="noopener" title="GitHub issue this session works on: ${esc(s.issue.title || '')}. The PR says Closes #${esc(s.issue.number)} and links back.">◉ #${esc(s.issue.number)}</a>`;
  if (s.pr && s.pr.url) {
    const ck = s.pr.checks || 'none'; const icon = ck === 'success' ? '✓' : ck === 'failure' ? '✗' : ck === 'pending' ? '◐' : '';
    h += `<a class="chip pr ${esc(ck)}" href="${esc(s.pr.url)}" target="_blank" rel="noopener" title="${esc(s.pr.title || '')} · ${esc((s.pr.state || '').toLowerCase())}${s.pr.draft ? ' · draft' : ''} · checks: ${esc(ck)}">PR #${esc(s.pr.number)}${s.pr.draft ? ' draft' : ''} ${icon}</a>`;
  }
  if (s.trust === 'dry') h += `<span class="chip dry" data-act="doit" title="dry run: the agent reads and plans, every change comes back unexecuted. Click to carry out the plan for real.">◌ dry run · do it</span>`;
  if (s.needs_review) h += `<span class="chip warn" data-act="changes" title="a task finished; its changes wait for your review">⚑ review</span>`;
  if (s.fallback && s.fallback.provider) h += `<span class="chip warn" title="running on a fallback provider since ${esc(new Date((s.fallback.since || 0) * 1000).toLocaleTimeString())}: ${esc(s.fallback.reason || '')}">⇄ ${esc(s.fallback.provider)}/${esc(s.fallback.model)} · ${age(s.fallback.since)}</span>`;
  if (s.preview && s.preview.running) h += `<span class="chip ok" data-act="preview" title="dev server ${esc(s.preview.label)} on port ${esc(s.preview.port)} (click to show)">▶ :${esc(s.preview.port)}</span>`;
  if (s.deploy && s.deploy.targets && s.deploy.targets.length) h += deployChipHtml(s.deploy);
  return h;
}
// ---- deploy status per repo (read-only, from the provider CLIs): a chip on the pane, a dot on the sidebar project ----
const DEPLOY_LABEL = { cloudflare: 'cf', railway: 'railway', supabase: 'supabase' };
const DEPLOY_ICON = { live: '●', building: '◐', failed: '✗', none: '○', error: '?', untracked: '' };
function deployTitle(d) { return (d.targets || []).map((t) => `${t.provider} ${t.kind || ''} ${t.name}: ${t.state}${t.at ? ' · ' + age(t.at) + ' ago' : ''}${t.detail ? ' · ' + t.detail : ''}`).join('\n') + (d.checked ? `\nchecked ${age(d.checked)} ago · click for details` : ''); }
function deployChipHtml(d) {
  const t = d.targets.find((x) => x.state === d.state) || d.targets[0];
  const names = d.targets.length > 1 ? `${DEPLOY_LABEL[t.provider] || t.provider} +${d.targets.length - 1}` : (DEPLOY_LABEL[t.provider] || t.provider);
  const when = d.at ? ' · ' + age(d.at) : '';
  return `<span class="chip deploy ${esc(d.state)}" data-act="deploy" title="${esc(deployTitle(d))}">${DEPLOY_ICON[d.state] || ''} ${esc(names)} · ${esc(d.state)}${when}</span>`;
}
async function deployDialog(sid) {
  const s = state.sessions.get(sid) || state.chats.find((c) => c.id === sid) || {};
  const root = (s.project || {}).path;
  const d = openDialog(`<h2>deploys · ${esc((s.project || {}).name || s.name || '')}<span class="help" id="dp-status"></span><span class="spacer"></span><button data-x="refresh" title="ask the provider CLIs now">↻ refresh</button><button data-x="close">✕</button></h2><div class="body"><div id="dp-body" class="help plain">loading…</div><div class="help plain">Read-only: kcoder only lists deployments through the CLIs you are logged into (wrangler, railway, supabase) and never triggers one. Status refreshes after a turn in this repo and every few minutes.</div></div>`, 'deploys');
  const body = $('#dp-body', d);
  const render = (dep, targets) => {
    const list = dep && dep.targets && dep.targets.length ? dep.targets : (targets || []).map((t) => ({ ...t, state: 'unknown', detail: 'not checked yet' }));
    body.innerHTML = list.length ? list.map((t) => `<div class="row dp-row"><span class="chip deploy ${esc(t.state)}">${DEPLOY_ICON[t.state] || '?'} ${esc(t.state)}</span><b>${esc(t.provider)} ${esc(t.kind || '')} · ${esc(t.name)}</b><span class="help plain">${t.at ? esc(new Date(t.at * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })) + ' · ' : ''}${esc(t.detail || '')}</span><span class="spacer"></span>${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">site</a>` : ''}${t.dashboard ? `<a href="${esc(t.dashboard)}" target="_blank" rel="noopener">dashboard</a>` : ''}<button data-open="${esc(t.name)}" class="${t.state === 'failed' ? 'primary' : ''}" title="load the deploy log into this repo's session so the agent can fix it">open in session</button></div>`).join('') : '<div class="empty-row">no deploy config in this repo (wrangler.toml / .json / .jsonc, railway.json / .toml, supabase/config.toml)</div>';
    $('#dp-status', d).textContent = dep && dep.checked ? `checked ${age(dep.checked)} ago` : '';
  };
  const load = async (refresh) => { try { if (refresh) { $('#dp-status', d).textContent = 'asking the CLIs…'; const r = await request('deploys', { action: 'refresh', root }); render(r.deploy, []); if (s.id) renderSession(s.id); } else { const r = await request('deploys', { action: 'list', root }); render(r.deploys[root], r.targets[root]); } } catch (e) { body.innerHTML = `<div class="empty-row">${esc(e.message)}</div>`; } };
  d.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]'); if (x) { if (x.dataset.x === 'close') closeDialog(); else load(true); return; }
    const o = e.target.closest('[data-open]'); if (!o) return;
    try { const r = await request('deploys', { action: 'open', root, sid: state.sessions.has(sid) ? sid : null, target: o.dataset.open }); closeDialog(); toast(r.queued ? 'deploy log queued for the session' : 'deploy log sent to the session', 'ok'); assignPane(state.layout.focus, r.sid); setView('chat'); }
    catch (err) { toast(err.message, 'err'); }
  });
  load(false);
}

// ---- changes view: file list + diff, accept / reject / edit per hunk, approve ----
function hunkNewSide(h) { return h.text.split('\n').slice(1).filter((l) => l && (l[0] === '+' || l[0] === ' ')).map((l) => l.slice(1)).join('\n'); }
function hunkHtml(h, i, accepted) {
  const body = h.text.split('\n').slice(1).map((l) => `<span class="l ${l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : l.startsWith('\\') ? 'meta' : ''}">${esc(l) || ' '}</span>`).join('');
  return `<div class="hunk${accepted ? ' accepted' : ''}" data-h="${i}" id="hunk-${i}"><div class="hunk-head"><code>${esc(h.path)}</code><span class="hdr">${esc(h.header)}</span><span class="spacer"></span>` +
    (h.binary ? '<span class="help">binary</span>' : `<button data-h-act="accept" title="keep this change">${accepted ? 'accepted' : 'accept'}</button><button data-h-act="edit" title="edit the resulting lines">edit</button><button data-h-act="reject" class="danger" title="undo this change in the worktree">reject</button>`) +
    `</div><pre class="hunk-body">${body}</pre></div>`;
}
async function changesDialog(sid) {
  const s = state.sessions.get(sid) || {};
  const d = openDialog(`<h2>changes · ${esc(s.name || sid)}<span class="help" id="ch-status"></span><span class="spacer"></span><button data-x="allow" title="add a secret-scan allowlist entry for a false positive">allowlist…</button><button data-x="refresh">refresh</button><button data-x="close">✕</button></h2>
    <div class="body changes"><div class="ch-files"></div><div class="ch-diff"><div class="empty-row">loading…</div></div></div>
    <div class="foot"><span class="help" id="ch-policy"></span><span class="spacer" style="flex:1"></span>${s.worktree ? '<button data-x="pr">open draft PR</button><button data-x="merge">merge</button>' : ''}<button class="primary" data-x="approve">approve</button></div>`, 'changes');
  d.classList.add('wide');
  const accepted = new Set(); let data = null;
  const key = (h) => h.path + '|' + h.header;
  const render = () => {
    const files = $('.ch-files', d), diff = $('.ch-diff', d);
    if (!data) return;
    const n = data.hunks.length, acc = data.hunks.filter((h) => accepted.has(key(h))).length;
    $('#ch-status', d).textContent = `${data.files.length} file(s) · ${n} hunk(s) · ${acc} accepted · ${data.approved ? 'approved ✓' : 'not approved'}`;
    $('#ch-policy', d).textContent = `review required before: ${data.policy}` + (data.approved ? ' · the current tree is approved; commits/pushes go through' : ' · approve records the current tree so the git hooks let it through');
    files.innerHTML = data.files.length ? data.files.map((f) => `<div class="item" data-f="${esc(f.path)}"><span class="st ${esc(f.status)}">${esc(f.status)}</span><code>${esc(f.path)}</code><span class="meta">+${f.additions}/-${f.deletions}</span></div>`).join('') : '<div class="empty-row">no changes relative to the base branch</div>';
    diff.innerHTML = n ? data.hunks.map((h, i) => hunkHtml(h, i, accepted.has(key(h)))).join('') : '<div class="empty-row">nothing to review</div>';
  };
  const load = async () => { try { data = await request('changes', { sid }); render(); } catch (e) { $('.ch-diff', d).innerHTML = `<div class="empty-row">${esc(e.message)}</div>`; } };
  d.addEventListener('click', async (e) => {
    const x = e.target.closest('[data-x]');
    if (x) {
      const a = x.dataset.x;
      if (a === 'close') closeDialog();
      else if (a === 'refresh') load();
      else if (a === 'approve') { try { data = await request('review', { sid, action: 'approve', base: data && data.base }); toast('changes approved', 'ok'); render(); } catch (err) { toast(err.message, 'err'); } }
      else if (a === 'allow') { const v = await promptDialog('Secret-scan allowlist entry', 'From the block message: secret:<fingerprint>, path:<glob> or kind:<kind>. Saved to .kcoder/allowlist in the worktree.'); if (v) { try { await request('secrets_allow', { sid, entry: v.trim() }); toast('allowlisted ' + v.trim(), 'ok'); } catch (err) { toast(err.message, 'err'); } } }
      else if (a === 'pr') { await handleAction({ dataset: { act: 'pr' } }, sid); load(); }
      else if (a === 'merge') { await handleAction({ dataset: { act: 'merge' } }, sid); load(); }
      return;
    }
    const f = e.target.closest('[data-f]'); if (f) { const i = data.hunks.findIndex((h) => h.path === f.dataset.f); const el = $('#hunk-' + i, d); if (el) el.scrollIntoView({ block: 'start' }); return; }
    const b = e.target.closest('[data-h-act]'); if (!b) return;
    const hunkEl = b.closest('.hunk'); const h = data.hunks[Number(hunkEl.dataset.h)]; const act = b.dataset.hAct;
    if (act === 'accept') { accepted.has(key(h)) ? accepted.delete(key(h)) : accepted.add(key(h)); render(); return; }
    if (act === 'reject') { if (!(await confirmDialog(`Reject this hunk in ${h.path}?`, 'The change is undone in the worktree.'))) return; try { data = await request('review', { sid, action: 'reject', hunk: h }); toast('hunk rejected', 'warn'); render(); } catch (err) { toast(err.message, 'err'); } return; }
    if (act === 'edit') {
      const nt = await promptDialog(`Edit ${h.path} ${h.header}`, 'These are the resulting lines of this hunk. Save to replace them in the worktree.', hunkNewSide(h), true);
      if (nt == null) return;
      try { data = await request('review', { sid, action: 'edit', hunk: h, text: nt }); toast('hunk edited', 'ok'); render(); } catch (err) { toast(err.message, 'err'); }
    }
  });
  load();
}

// ---- per-repo instructions ----
async function instructionsDialog(sid) {
  const s = state.sessions.get(sid) || state.chats.find((c) => c.id === sid) || {};
  let info; try { info = await request('instructions', { sid }); } catch (e) { toast(e.message, 'err'); return; }
  const names = info.files.length ? info.files.map((f) => f.name) : ['KCODER.md'];
  let cur = names[0];
  const d = openDialog(`<h2>instructions · ${esc((s.project || {}).name || s.name || '')}<span class="spacer"></span><button data-x="close">✕</button></h2>
    <div class="body"><div class="seg" id="ins-tabs"></div><p class="help plain" id="ins-help"></p><textarea id="ins-text" style="min-height:40vh;font-family:ui-monospace,monospace"></textarea><div id="ins-rules" class="rules"></div></div>
    <div class="foot"><span class="help" id="ins-path"></span><span class="spacer" style="flex:1"></span><button data-x="cancel">cancel</button><button class="primary" data-x="save">save</button></div>`, 'instructions');
  const tabs = $('#ins-tabs', d), ta = $('#ins-text', d);
  const show = () => {
    tabs.innerHTML = names.map((n) => `<button data-n="${esc(n)}" class="${n === cur ? 'active' : ''}">${esc(n)}</button>`).join('') + (names.includes('KCODER.md') ? '' : '<button data-n="KCODER.md">+ KCODER.md</button>');
    const f = info.files.find((x) => x.name === cur);
    ta.value = f ? f.text : '';
    $('#ins-path', d).textContent = f ? f.path : `${info.root}/${cur} (new)`;
    $('#ins-help', d).textContent = cur === 'CLAUDE.md' && s.provider === 'claude' ? 'Claude Code reads CLAUDE.md itself, so kcoder does not append it a second time.' : 'Loaded into the system prompt of every turn in this repo. Saving writes the project root and, for this session, its worktree.';
    const rules = (info.rules || []).filter((r) => r.source === cur);
    $('#ins-rules', d).innerHTML = `<div class="help">rules enforced as checks${rules.length ? '' : ' · none yet'}: bullet lines like "never touch migrations", "only change files under src/", "never commit .env files", "never run git push --force", "run the tests before committing", "run npm run lint before pushing"</div>` +
      rules.map((r) => `<div class="rule"><span class="rtext">${esc(r.text)}</span><span class="rwhat">${esc(r.what)}</span></div>`).join('');
  };
  tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-n]'); if (b) { cur = b.dataset.n; show(); } });
  d.addEventListener('click', async (e) => { const b = e.target.closest('[data-x]'); if (!b) return; if (b.dataset.x !== 'save') { closeDialog(); return; }
    try { await request('instructions', { sid, name: cur, text: ta.value }); toast('saved ' + cur, 'ok'); closeDialog(); } catch (err) { toast(err.message, 'err'); } });
  show();
}

// ---- task queue view ----
let tasksData = null, tasksTimer = null, schedulesData = null; const tasksImages = [];   // images attached to the task being written (kept across re-renders)
async function renderTasksView(force) {
  if (state.view !== 'tasks') return;
  if (!force && tasksTimer) return;
  tasksTimer = setTimeout(() => (tasksTimer = null), 1500);
  try { tasksData = await request('tasks', { action: 'list' }); if (!schedulesData || force) schedulesData = (await request('schedules', { action: 'list' })).schedules; } catch (e) { $('#tasks-body').innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; return; }
  const body = $('#tasks-body'); const t = tasksData; const provs = state.providers || [];
  const def = provs.find((p) => p.default && p.configured) || provs.find((p) => p.configured) || provs[0] || {};
  const row = (x, drag) => { const s = state.sessions.get(x.sid) || state.chats.find((c) => c.id === x.sid); return `<div class="task ${esc(x.status)}" data-id="${esc(x.id)}" ${drag ? 'draggable="true"' : ''}>
      ${drag ? '<span class="grip" title="drag to reorder">⋮⋮</span>' : '<span class="grip"></span>'}
      <span class="st">${esc(x.status)}</span>
      <div class="txt"><div class="t1">${x.issue ? `<a href="${esc(x.issue.url)}" target="_blank" rel="noopener" title="${esc(x.issue.url)}">#${esc(x.issue.number)}</a> ${esc(x.issue.title || '')}` : esc(x.text.length > 140 ? x.text.slice(0, 140) + '…' : x.text)}</div><div class="t2">${esc(shortHome(x.repo))} · ${esc(x.model || (x.provider || def.id || '') + ' default')} · trust ${esc(x.trust || state.config && state.config.default_trust || 'auto')}${s ? ' · session ' + esc(s.name) : ''}${x.error ? ' · ' + esc(x.error) : ''}</div></div>
      <span class="when">${age(x.finished || x.started || x.created)} ago</span>
      ${x.sid ? `<button data-t="open" title="open the session">open</button>` : ''}${x.status === 'review' && x.sid ? `<button data-t="review" class="primary" title="review the changes">⚑ review</button>` : ''}
      ${x.status === 'queued' || x.status === 'running' ? `<button data-t="cancel" class="danger">cancel</button>` : `<button data-t="remove" title="remove from the list">✕</button>`}
    </div>`; };
  const by = (st) => t.tasks.filter((x) => x.status === st);
  body.innerHTML = `
    <div class="stats-head"><h2>task queue</h2><span class="help">${t.paused ? 'paused' : 'running'} · ${by('running').length} running · ${by('queued').length} queued · up to <input id="tq-max" type="number" min="1" max="20" value="${esc(t.max_concurrent || 3)}" style="width:48px"> at once</span><span class="spacer"></span>
      <button data-tq="${t.paused ? 'resume' : 'pause'}">${t.paused ? '▶ resume queue' : '❚❚ pause queue'}</button><button data-tq="clear">clear finished</button></div>
    <form class="task-add card" id="tq-form">
      <div class="row"><label>repo / folder<input name="repo" list="tq-repos" placeholder="/path/to/project or owner/name" required autocomplete="off"><datalist id="tq-repos">${(state.projects || []).map((p) => `<option value="${esc(p.path)}">${esc(p.name)}</option>`).join('')}</datalist></label>
        <label>provider<select name="provider">${provs.map((p) => `<option value="${esc(p.id)}" ${p.id === def.id ? 'selected' : ''} ${p.configured ? '' : 'disabled'}>${esc(p.label)}</option>`).join('')}</select></label>
        <label>model<select name="model"><option value="">provider default</option>${(def.models || []).map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
        <label>trust<select name="trust"><option value="auto">auto</option><option value="write">write</option><option value="read">read</option><option value="none">none</option><option value="dry">dry run</option></select></label></div>
      <label>task<textarea name="text" placeholder="what should it do? It runs in its own worktree as soon as a slot is free, and lands in review when done. Paste a GitHub issue URL and the issue becomes the task (repo optional); the PR closes it. Paste or drop screenshots too." required></textarea></label>
      <div class="attachments" id="tq-atts" hidden></div>
      <div class="row"><span class="help">finished tasks wait in review; nothing is pushed on its own · ⌘V or drop images to attach them</span><span class="spacer" style="flex:1"></span><button class="primary" type="submit">add to queue</button></div>
    </form>
    <h3>running</h3><div class="task-list">${by('running').map((x) => row(x, false)).join('') || '<div class="empty-row">nothing running</div>'}</div>
    <h3>queued</h3><div class="task-list" id="tq-queued">${by('queued').map((x) => row(x, true)).join('') || '<div class="empty-row">queue is empty</div>'}</div>
    <h3>finished</h3><div class="task-list">${t.tasks.filter((x) => !['running', 'queued'].includes(x.status)).reverse().map((x) => row(x, false)).join('') || '<div class="empty-row">none yet</div>'}</div>
    ${schedulesHtml(schedulesData || [])}`;
  const sform = $('#sc-form', body);
  sform.addEventListener('submit', async (e) => { e.preventDefault(); const fd = new FormData(sform); try { await request('schedules', { action: 'add', name: fd.get('name'), repo: fd.get('repo'), text: fd.get('text'), every: fd.get('every'), at: fd.get('at'), weekday: Number(fd.get('weekday')), pr: fd.get('pr') === 'on' }); toast('schedule added', 'ok'); schedulesData = null; renderTasksView(true); } catch (err) { toast(err.message, 'err'); } });
  $('#sc-list', body).addEventListener('click', async (e) => { const b = e.target.closest('[data-s]'); if (!b) return; const id = b.closest('.task').dataset.sid; try { if (b.dataset.s === 'remove' && !(await confirmDialog('Remove this schedule?', ''))) return; await request('schedules', { action: b.dataset.s, id }); if (b.dataset.s === 'run') toast('queued a run', 'ok'); schedulesData = null; renderTasksView(true); } catch (err) { toast(err.message, 'err'); } });
  const form = $('#tq-form', body);
  // the task composer takes images like a session composer: a stand-in comp whose model is the picked one
  const tcomp = { sid: null, form, ta: form.querySelector('[name=text]'), atts: $('#tq-atts', body), images: tasksImages, pastes: new Map() };
  tcomp.ta.addEventListener('paste', (e) => { const imgs = Array.from(e.clipboardData.items || []).filter((i) => i.type.startsWith('image/')); if (imgs.length) { e.preventDefault(); imgs.forEach((i) => addImage(tcomp, i.getAsFile())); } });
  form.addEventListener('dragover', (e) => e.preventDefault());
  form.addEventListener('drop', (e) => { const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); files.forEach((f) => addImage(tcomp, f)); } });
  renderAtts(tcomp);
  const taskModel = () => { const fd = new FormData(form); return { provider: fd.get('provider'), model: fd.get('model') || ((provs.find((x) => x.id === fd.get('provider')) || {}).default_model) }; };
  form.querySelector('[name=provider]').addEventListener('change', (e) => { const p = provs.find((x) => x.id === e.target.value) || {}; form.querySelector('[name=model]').innerHTML = '<option value="">provider default</option>' + (p.models || []).map((m) => `<option>${esc(m)}</option>`).join(''); });
  form.querySelector('[name=trust]').value = (state.config && state.config.default_trust) || 'auto';
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); const fd = new FormData(form);
    let images = tasksImages;
    if (images.length && !modelSeesImages(taskModel())) { const ok = await confirmDialog(`${taskModel().model} can't take images`, `${images.length} image${images.length === 1 ? '' : 's'} would be left out. Queue the text alone? Cancel to pick a model that takes images.`); if (!ok) return; images = []; }
    try { await request('tasks', { action: 'add', text: fd.get('text'), repo: fd.get('repo'), provider: fd.get('provider'), model: fd.get('model') || null, trust: fd.get('trust'), images: images.map((im) => ({ name: im.name, data_url: im.data_url })) }); tasksImages.length = 0; toast('task queued', 'ok'); renderTasksView(true); } catch (err) { toast(err.message, 'err'); }
  });
  $('#tq-max', body).addEventListener('change', async (e) => { try { const r = await request('config', { max_concurrent: Number(e.target.value) }); state.config = r.config; toast('up to ' + r.config.max_concurrent + ' at once', 'ok'); } catch (err) { toast(err.message, 'err'); } });
  body.onclick = async (e) => {
    const q = e.target.closest('[data-tq]'); if (q) { try { await request('tasks', { action: q.dataset.tq }); renderTasksView(true); } catch (err) { toast(err.message, 'err'); } return; }
    const b = e.target.closest('[data-t]'); if (!b) return; const id = b.closest('.task').dataset.id; const task = t.tasks.find((x) => x.id === id) || {};
    try {
      if (b.dataset.t === 'cancel') { if (await confirmDialog('Cancel this task?', task.status === 'running' ? 'Its session is interrupted; the worktree stays for review.' : '')) await request('tasks', { action: 'cancel', id }); }
      else if (b.dataset.t === 'remove') await request('tasks', { action: 'remove', id });
      else if (b.dataset.t === 'open') { if (task.sid) { assignPane(state.layout.focus, task.sid); setView('chat'); } return; }
      else if (b.dataset.t === 'review') { if (task.sid) changesDialog(task.sid); return; }
      renderTasksView(true);
    } catch (err) { toast(err.message, 'err'); }
  };
  // drag to reorder the queued tasks
  const list = $('#tq-queued', body); let dragId = null;
  list.addEventListener('dragstart', (e) => { const r = e.target.closest('.task'); if (!r) return; dragId = r.dataset.id; r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  list.addEventListener('dragend', () => { dragId = null; for (const r of $$('.task', list)) r.classList.remove('dragging', 'drop-before', 'drop-after'); });
  list.addEventListener('dragover', (e) => { const r = e.target.closest('.task'); if (!r || !dragId || r.dataset.id === dragId) return; e.preventDefault(); const rect = r.getBoundingClientRect(); const before = (e.clientY - rect.top) < rect.height / 2; r.classList.toggle('drop-before', before); r.classList.toggle('drop-after', !before); });
  list.addEventListener('drop', async (e) => { const r = e.target.closest('.task'); if (!r || !dragId) return; e.preventDefault(); const before = r.classList.contains('drop-before'); const ids = $$('.task', list).map((x) => x.dataset.id).filter((x) => x !== dragId); const i = ids.indexOf(r.dataset.id); ids.splice(before ? i : i + 1, 0, dragId); dragId = null; try { await request('tasks', { action: 'reorder', ids }); renderTasksView(true); } catch (err) { toast(err.message, 'err'); } });
}

// ---- /model: every provider and its models in one list ----
// on Kyle's Max plan Fable turns are billed as overage credits, not plan usage
const claudeModelNote = (pid, m) => {
  if (pid !== 'claude' || !m || m === 'auto') return '';
  const fam = /fable/i.test(m) ? 'fable' : /sonnet/i.test(m) ? 'sonnet' : /haiku/i.test(m) ? 'haiku' : 'opus';
  if (((state.claude || {}).limits || []).some((l) => l.scope === 'all' || l.scope === fam)) return 'limit reached';
  return fam === 'fable' ? 'weekly Fable limit' : '';
};
async function switchModel(sid, pid, model) {
  const s = state.sessions.get(sid) || {};
  if (pid === s.provider) { await request('set', { sid, model }); toast(`model → ${model}`, 'ok'); return; }
  const prov = (state.providers || []).find((x) => x.id === pid) || {};
  if (!prov.configured) { setupDialog(pid); return; }
  if (s.messages && !(await confirmDialog(`Switch to ${prov.label}?`, 'Message formats differ between providers, so this conversation\'s history is cleared. Files in the worktree are not touched.'))) return;
  await request('set', { sid, provider: pid, model });
  toast(`${prov.label} · ${model}`, 'ok');
}
async function modelPicker(sid) {
  await refreshProviders();
  const s = state.sessions.get(sid) || {};
  const rows = [];
  for (const p of state.providers || []) {
    const models = (p.auto ? ['auto'] : []).concat(p.models || []);
    if (!p.configured) { rows.push({ pid: p.id, model: p.default_model, label: p.label, meta: 'not set up · connect', off: true }); continue; }
    for (const m of models) rows.push({ pid: p.id, model: m, label: p.label, meta: m === 'auto' ? `auto (${(p.tiers || {}).small || ''} / ${(p.tiers || {}).large || ''})` : claudeModelNote(p.id, m) ? `${m} · ${claudeModelNote(p.id, m)}` : m, cur: p.id === s.provider && m === s.model });
  }
  let sel = Math.max(0, rows.findIndex((r) => r.cur)), shown = rows;
  const d = openDialog(`<div class="palette"><input id="mp-in" placeholder="model or provider… (provider/model to type any model)"><div class="list" id="mp-list"></div></div>`, 'palette');
  const inp = $('#mp-in', d), list = $('#mp-list', d);
  const render = () => {
    let last = null;
    list.innerHTML = shown.map((r, i) => { const head = r.pid !== last ? `<div class="group-h">${esc(r.label)}</div>` : ''; last = r.pid; return head + `<div class="item${i === sel ? ' sel' : ''}${r.off ? ' off' : ''}" data-i="${i}"><span>${esc(r.meta)}</span>${r.cur ? '<span class="meta">current</span>' : ''}</div>`; }).join('') || '<div class="empty-row">no match · press enter to use what you typed</div>';
    const el = $('.item.sel', list); if (el) el.scrollIntoView({ block: 'nearest' });
  };
  const filter = () => { const q = inp.value.toLowerCase().trim(); shown = q ? rows.filter((r) => fuzzy((r.label + ' ' + r.pid + ' ' + r.meta).toLowerCase(), q)) : rows; sel = 0; render(); };
  const run = async (i) => {
    const r = shown[i]; const typed = inp.value.trim(); closeDialog();
    try {
      if (r) await switchModel(sid, r.pid, r.model);
      else if (typed) { const [p, ...m] = typed.split('/'); if (m.length && (state.providers || []).some((x) => x.id === p)) await switchModel(sid, p, m.join('/')); else await switchModel(sid, s.provider, typed); }
    } catch (e) { toast(e.message, 'err'); }
  };
  inp.addEventListener('input', filter);
  inp.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); render(); e.preventDefault(); } else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); } else if (e.key === 'Enter') { e.preventDefault(); run(sel); } });
  list.addEventListener('click', (e) => { const it = e.target.closest('[data-i]'); if (it) run(Number(it.dataset.i)); });
  render(); inp.focus();
}

// ---- live preview pane ----
const previewPolls = new Map();
function renderPreviewPane(body, sid) {
  const s = state.sessions.get(sid) || {};
  const pv = s.preview;
  if (!body.querySelector('.pv-bar')) body.innerHTML = `<div class="pv-bar"><button data-act="preview-start" class="primary">▶ start</button><button data-act="preview-stop">■ stop</button><button data-pv="reload" title="reload">↻</button><button data-pv="desktop" title="desktop width">⌨</button><button data-pv="mobile" title="phone width">📱</button><a class="pv-url" target="_blank" rel="noopener"></a><span class="spacer"></span><span class="pv-status help"></span></div><div class="pv-frame"><iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerpolicy="no-referrer"></iframe></div>`;
  const frame = $('iframe', body), url = $('.pv-url', body), st = $('.pv-status', body);
  $('[data-act="preview-start"]', body).hidden = !!(pv && pv.running);
  $('[data-act="preview-stop"]', body).hidden = !(pv && pv.running);
  if (pv && pv.running) {
    url.textContent = pv.url; url.href = pv.url; st.textContent = `${pv.label} · port ${pv.port}${pv.hmr ? ' · hot reload' : ' · reloads on change'}`;
    if (frame.dataset.src !== pv.url) { frame.src = pv.url; frame.dataset.src = pv.url; }
    if (!pv.hmr && !previewPolls.has(sid)) {
      let last = null;
      previewPolls.set(sid, setInterval(async () => {
        const p = $(`.pane[data-sid="${sid}"] .preview-box`); if (!p) { clearInterval(previewPolls.get(sid)); previewPolls.delete(sid); return; }
        try { const r = await request('preview', { sid, action: 'signature' }); if (last && r.signature !== last) { const f = $('iframe', p); f.src = f.src; } last = r.signature; } catch {}
      }, 2500));
    }
  } else {
    url.textContent = ''; url.removeAttribute('href'); st.textContent = 'no dev server running for this worktree';
    if (frame.dataset.src) { frame.removeAttribute('src'); delete frame.dataset.src; }
    if (previewPolls.has(sid)) { clearInterval(previewPolls.get(sid)); previewPolls.delete(sid); }
  }
  if (!body._wired) {
    body._wired = true;
    body.addEventListener('click', (e) => { const b = e.target.closest('[data-pv]'); if (!b) return; const f = $('iframe', body), fr = $('.pv-frame', body); if (b.dataset.pv === 'reload') f.src = f.src; else fr.classList.toggle('mobile', b.dataset.pv === 'mobile'); });
  }
}

// ---- schedules (in the tasks tab) ----
function schedulesHtml(list) {
  const row = (s) => `<div class="task ${s.enabled ? 'queued' : 'cancelled'}" data-sid="${esc(s.id)}"><span class="grip"></span><span class="st">${s.enabled ? 'on' : 'off'}</span>
    <div class="txt"><div class="t1"><b>${esc(s.name)}</b> · every ${esc(s.every)}${s.every !== 'hour' ? ' at ' + esc(s.at) : ' at :' + esc((s.at || '00:00').split(':')[1])}${s.every === 'week' ? ' on ' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][s.weekday || 0] : ''}${s.pr ? ' · opens a draft PR when something changed' : ' · lands in review'}</div>
    <div class="t2">${esc(s.text.slice(0, 120))} · ${esc(shortHome(s.repo))} · next ${esc(new Date((s.next_run || 0) * 1000).toLocaleString())}${s.last_result ? ' · last: ' + esc(s.last_result.text || '') : ''}</div></div>
    <button data-s="run" title="run now">run</button><button data-s="${s.enabled ? 'disable' : 'enable'}">${s.enabled ? 'pause' : 'enable'}</button><button data-s="remove" class="danger">✕</button></div>`;
  return `<h3>schedules</h3><form class="task-add card" id="sc-form">
    <div class="row"><label>name<input name="name" placeholder="weekly dependency update" required></label><label>repo / folder<input name="repo" list="tq-repos" placeholder="/path or owner/name" required autocomplete="off"></label>
      <label>every<select name="every"><option value="day">day</option><option value="week">week</option><option value="hour">hour</option></select></label><label>at<input name="at" type="time" value="09:00"></label>
      <label>weekday (weekly)<select name="weekday">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => `<option value="${i}">${d}</option>`).join('')}</select></label></div>
    <label>task<textarea name="text" placeholder="e.g. Update dependencies to their latest compatible versions and run the tests." required></textarea></label>
    <div class="row"><label class="check"><input type="checkbox" name="pr" checked> open a draft PR when something changed (otherwise just log)</label><span class="spacer" style="flex:1"></span><button class="primary" type="submit">add schedule</button></div></form>
    <div class="task-list" id="sc-list">${list.map(row).join('') || '<div class="empty-row">no schedules</div>'}</div>`;
}

// ---- phone approvals ----
async function remoteDialog() {
  let r; try { r = await request('remote', { action: 'status' }); } catch (e) { toast(e.message, 'err'); return; }
  const d = openDialog(`<h2>phone approvals<span class="spacer"></span><button data-x="close">✕</button></h2><div class="body" id="rm-body"></div>`, 'remote');
  const render = (res, pairing) => {
    const st = res.remote || {};
    $('#rm-body', d).innerHTML = `
      <p class="help plain">Off by default. Your Mac never opens a port: kcoderd keeps one outbound connection to a relay you host (see <code>relay/README.md</code>). Paired phones get a push notification whenever a session waits for you and can approve or deny from a page that shows the command and a diff summary. Approvals expire after ${esc(res.ttl_minutes || 10)} minutes.</p>
      ${st.enabled ? `<p>relay <code>${esc(st.relay)}</code> · ${st.connected ? '<b class="ok-t" style="color:var(--green)">connected</b>' : '<b style="color:var(--yellow)">not connected</b>'}${st.error ? ' · ' + esc(st.error) : ''}</p>
        <div class="row"><button class="primary" data-x="pair">pair a phone</button><button data-x="disable" class="danger">disable + forget devices</button></div>
        ${pairing ? `<div class="card" style="text-align:center"><div id="rm-qr"></div><p>scan on the phone, or open <code>${esc(pairing.url)}</code><br><span class="help">code ${esc(pairing.code)} · valid 5 minutes</span></p></div>` : ''}
        <div class="label-h">paired devices</div>
        ${(st.devices || []).length ? st.devices.map((v) => `<div class="row" style="align-items:center"><span><b>${esc(v.name)}</b> <span class="help">${v.push ? 'push on' : 'no push subscription'} · paired ${age(v.created)} ago</span></span><span class="spacer" style="flex:1"></span><button data-x="revoke" data-dev="${esc(v.id)}" class="danger">revoke</button></div>`).join('') : '<p class="help">none yet</p>'}`
      : `<label>relay URL<input id="rm-relay" placeholder="https://kcoder-relay.you.workers.dev" value="${esc(st.relay || '')}"></label><div class="row"><button class="primary" data-x="enable">enable</button></div>`}`;
    if (pairing && window.qrcode) { try { const q = qrcode(0, 'M'); q.addData(pairing.url); q.make(); $('#rm-qr', d).innerHTML = q.createSvgTag({ cellSize: 5, margin: 2 }); } catch (e) { $('#rm-qr', d).textContent = pairing.url; } }
  };
  render(r);
  d.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    try {
      if (b.dataset.x === 'close') closeDialog();
      else if (b.dataset.x === 'enable') { r = await request('remote', { action: 'enable', relay: $('#rm-relay', d).value.trim() }); toast('phone approvals enabled', 'ok'); render(r); }
      else if (b.dataset.x === 'disable') { if (await confirmDialog('Disable phone approvals?', 'All paired devices are forgotten.')) { r = await request('remote', { action: 'disable' }); render(r); } }
      else if (b.dataset.x === 'pair') { const p = await request('remote', { action: 'pair' }); render(p, p.pairing); }
      else if (b.dataset.x === 'revoke') { r = await request('remote', { action: 'revoke', device: b.dataset.dev }); toast('device revoked', 'warn'); render(r); }
    } catch (err) { toast(err.message, 'err'); }
  });
}

// ---- updates, restart, uninstall ----
async function checkUpdates() {
  toast('checking for new commits…');
  try {
    const up = (await request('update', { action: 'check' })).update || {};
    if (up.error) toast('update check: ' + up.error, 'warn');
    else if (up.available) updateNow(); else toast('kcoder is up to date', 'ok');
    renderHeader();
  } catch (e) { toast(e.message, 'err'); }
}
async function updateNow() {
  const up = (state.stats || {}).update || {};
  if (!up.available) { toast('no new commits', 'warn'); return; }
  const busy = Array.from(state.sessions.values()).filter((s) => s.status === 'working' || s.status === 'waiting');
  const failed = up.failed ? `These commits failed last time and were rolled back (${up.failed.error || 'unknown error'}). See update.log in the kcoder data folder (kcoder update shows it).  ·  ` : '';
  const ok = await confirmDialog(`Pull ${up.behind} new commit${up.behind === 1 ? '' : 's'}, rebuild and restart kcoderd?`, failed + (up.commits || []).slice(0, 8).join(' · ') + (busy.length ? `  ·  ${busy.length} working session(s) will be interrupted and come back paused.` : '') + '  If the new code does not start, kcoder rolls back.');
  if (!ok) return;
  try { await request('update', { action: 'apply', force: true }); toast('pulling… kcoderd is restarting', 'warn'); } catch (e) { toast(e.message, 'err'); }
}
async function restartDaemon() {
  const busy = Array.from(state.sessions.values()).filter((s) => s.status === 'working' || s.status === 'waiting');
  if (busy.length && !(await confirmDialog('Restart kcoderd?', `${busy.length} working session(s) will be interrupted and come back paused.`))) return;
  try { await request('restart', { force: busy.length > 0 }); toast('kcoderd is restarting…', 'warn'); } catch (e) { toast(e.message, 'err'); }
}
function uninstallDialog() {
  const d = openDialog(`<h2>uninstall kcoder</h2><div class="body">
    <p>This removes the kcoder app, the login item, the daemon, caches and the Python package from this Mac.</p>
    <label class="check"><input type="checkbox" id="un-hist"> also delete session history, stats and worktrees (default: keep)</label>
    <label class="check"><input type="checkbox" id="un-keys"> also delete saved provider keys (default: keep)</label>
    <p class="help">Kept data stays in ~/.local/share/kcoder and ~/.config/kcoder so a reinstall picks up where you left off.</p>
  </div><div class="foot"><span class="spacer" style="flex:1"></span><button data-x="cancel">cancel</button><button class="danger" data-x="ok">remove kcoder</button></div>`, 'uninstall');
  d.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-x]'); if (!b) return;
    if (b.dataset.x !== 'ok') { closeDialog(); return; }
    const fields = { delete_history: $('#un-hist', d).checked, delete_keys: $('#un-keys', d).checked, force: true };
    try { await request('uninstall', fields); closeDialog(); infoDialog('removing kcoder', '<p>kcoder is being removed. This window will stop responding; close it.</p>'); }
    catch (err) { toast(err.message, 'err'); }
  });
}

function tokenGate(msg) {
  $('#main').innerHTML = `<div class="token-gate"><p>${esc(msg || 'This page needs the daemon token.')}</p><p>Run <code>kcoder ui</code> in a terminal - it opens this page with the token attached - or paste the contents of <code>~/.local/share/kcoder/token</code>:</p><input id="tok" placeholder="token"><button class="primary" id="tok-go">connect</button></div>`;
  const go = () => { const v = $('#tok').value.trim(); if (v) { localStorage.setItem('kcoder.token', v); location.reload(); } };
  $('#tok-go').onclick = go; $('#tok').onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

// ----------------------------------------------------------------------
// notifications, sound, toasts
// ----------------------------------------------------------------------
// toasts never stack: one shows at a time and the rest wait their turn (a repeat of the one showing or waiting is dropped)
const toastQueue = []; let toastShowing = null;
function toast(text, kind = '', action = null) {
  const blocked = /GitHub is (not )?connected|Connect GitHub/i.test(text) && /block/i.test(text);
  if (blocked) { kind = 'warn'; action = { label: 'Connect GitHub', run: () => setupDialog() }; }
  if (!action && ((toastShowing && toastShowing.text === text) || toastQueue.some((t) => t.text === text))) return;
  toastQueue.push({ text, kind, action }); toastPump();
}
function toastPump() {
  if (toastShowing || !toastQueue.length) return;
  const t = toastQueue.shift(); const el = document.createElement('div'); el.className = 'toast ' + t.kind; el.appendChild(document.createTextNode(t.text));
  const done = () => { if (toastShowing && toastShowing.el === el) toastShowing = null; el.remove(); toastPump(); };
  if (t.action) { const b = document.createElement('button'); b.textContent = t.action.label; b.className = 'primary'; b.style.marginLeft = '8px'; b.onclick = (e) => { e.stopPropagation(); done(); t.action.run(); }; el.appendChild(b); }
  $('#toasts').appendChild(el); toastShowing = { ...t, el }; el.onclick = done; setTimeout(done, t.action ? 12000 : 5000);
}
let audioCtx = null;
function ping(kind) {
  if (!state.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const notes = kind === 'wait' ? [660, 880] : kind === 'err' ? [330, 220] : [523, 784];
    notes.forEach((f, i) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t + i * 0.12); g.gain.exponentialRampToValueAtTime(0.08, t + i * 0.12 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.25); o.connect(g).connect(audioCtx.destination); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.3); });
  } catch {}
}
function notify(title, body, sid, kind) {
  ping(kind);
  toast(title + (body ? ' · ' + body : ''), kind === 'wait' ? 'warn' : kind === 'err' ? 'err' : 'ok');
  const winFocused = document.hasFocus() && !document.hidden;
  const focusedHere = winFocused && ((state.view === 'chat' && focusedSid() === sid) || (state.view === 'wall' && state.focus === sid));
  if (!focusedHere) {
    const api = window.pywebview && window.pywebview.api;
    if (api && api.notify) { try { api.notify(title, body || ''); } catch {} }
    else if ('Notification' in window && Notification.permission === 'granted') {
      try { const n = new Notification(title, { body, tag: sid, silent: true }); n.onclick = () => { window.focus(); if (state.view === 'chat') assignPane(state.layout.focus, sid); else { if (state.view !== 'wall') setView('wall'); focusPane(sid); } n.close(); }; } catch {}
    } else if (!('Notification' in window)) request('notify', { title, body, sid }).catch(() => {});
  }
  renderHeader();
}
function toggleBroadcast() { state.broadcast = !state.broadcast; localStorage.setItem('kcoder.broadcast', state.broadcast ? 'on' : 'off'); renderHeader(); toast(state.broadcast ? 'broadcast on: prompts go to every open pane' : 'broadcast off', state.broadcast ? 'warn' : ''); }
function toggleFullscreen() {
  const api = window.pywebview && window.pywebview.api;
  if (api && api.toggle_fullscreen) { api.toggle_fullscreen(); return; }
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => toast('full screen is not available here', 'warn'));
}
function toggleSound() { state.sound = !state.sound; localStorage.setItem('kcoder.sound', state.sound ? 'on' : 'off'); renderHeader(); toast(state.sound ? 'sound on' : 'sound off'); }

// ----------------------------------------------------------------------
// keyboard
// ----------------------------------------------------------------------
// ----------------------------------------------------------------------
// keyboard shortcuts: ONE registry. The global key handler dispatches from
// it, the ⌘K palette and pane menus take their hints from it, and the ⌘/
// sheet is rendered from it, so documentation can't drift from behaviour.
//   combo   'mod+shift+w' style (mod = ⌘ or Ctrl); plain keys match e.key exactly
//   test(e) custom matcher (when one combo isn't enough, e.g. 1 … 9)
//   when()  only active when this returns true
//   scope   'global' (also with a dialog open), 'app' (default: no dialog),
//           'plain' (no dialog, not typing in a field), or a component name
//           ('composer', 'inbox', 'find', 'mouse') for keys handled locally;
//           those rows are listed in the sheet but dispatched by their component
//   palette label for the ⌘K palette (omit to keep it out of the palette)
// ----------------------------------------------------------------------
const chatPane = () => $$('#split .cpane')[state.layout.focus];
const focusedSession = () => (state.view === 'chat' ? state.sessions.get(focusedSid()) : (state.focus && state.sessions.get(state.focus)));
const toChat = () => { if (state.view !== 'chat') setView('chat'); };
const SHORTCUTS = [
  // navigation
  { id: 'palette', group: 'navigation', combo: 'mod+k', label: 'command palette', scope: 'global', run: () => (state.dialog ? closeDialog() : openPalette()) },
  { id: 'sheet', group: 'navigation', combo: 'mod+/', label: 'keyboard shortcuts (this sheet)', scope: 'global', palette: 'keyboard shortcuts', run: () => (state.dialog === 'keys' ? closeDialog() : helpDialog()) },
  { id: 'sheet2', group: 'navigation', combo: '?', label: 'keyboard shortcuts (outside a text field)', scope: 'plain', run: () => helpDialog() },
  { id: 'v-sessions', group: 'navigation', combo: 'alt+1', label: 'sessions', scope: 'app', palette: 'sessions', run: () => openSessions() },
  { id: 'v-tasks', group: 'navigation', combo: 'alt+2', label: 'task queue + schedules', scope: 'app', palette: 'task queue + schedules', run: () => setView('tasks') },
  { id: 'v-stats', group: 'navigation', combo: 'alt+3', label: 'stats', scope: 'app', palette: 'stats', run: () => setView('stats') },
  { id: 'v-fun', group: 'navigation', combo: 'alt+4', label: 'just for fun: the mine and the arcade', scope: 'app', palette: 'just for fun', run: () => setView('fun') },
  { id: 'v-mine', group: 'navigation', label: 'just for fun: the token mine', scope: 'alias', palette: 'just for fun: the token mine', run: () => funSelect('mine') },
  { id: 'v-2048', group: 'navigation', label: 'just for fun: 2048', scope: 'alias', palette: 'just for fun: 2048', run: () => funSelect('2048') },
  { id: 'v-mahjong', group: 'navigation', label: 'just for fun: mahjong solitaire', scope: 'alias', palette: 'just for fun: mahjong', run: () => funSelect('mahjong') },
  { id: 'l-grid', group: 'navigation', combo: 'alt+g', label: 'sessions: grid of every live session', scope: 'app', palette: 'sessions: grid', run: () => setLayout('grid') },
  { id: 'l-1', group: 'navigation', keys: '⌥⇧1 … 3', label: 'sessions: 1, 2 or 3 panes side by side', scope: 'app', test: (e) => e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && /^(Digit[123]|[123!@#])$/.test(e.code || e.key), palette: 'sessions: 1 pane', run: (e) => setLayout(e.code ? e.code.replace('Digit', '') : '1') },
  { id: 'l-2', group: 'navigation', label: 'sessions: 2 panes', scope: 'alias', palette: 'sessions: 2 panes', run: () => setLayout('2') },
  { id: 'l-3', group: 'navigation', label: 'sessions: 3 panes', scope: 'alias', palette: 'sessions: 3 panes', run: () => setLayout('3') },
  { id: 'settings', group: 'navigation', combo: 'mod+,', label: 'settings', scope: 'app', palette: 'settings', run: () => settingsDialog() },
  { id: 'about', group: 'navigation', label: 'about kcoder', scope: 'alias', palette: 'about kcoder', run: () => aboutDialog() },
  { id: 'fullscreen', group: 'navigation', combo: 'ctrl+mod+f', label: 'full screen', scope: 'app', palette: 'full screen', run: () => toggleFullscreen() },
  { id: 'search', group: 'navigation', combo: 'mod+shift+f', label: 'search across sessions', scope: 'app', palette: 'search across sessions', run: () => { toChat(); const si = $('#search'); si.focus(); si.select(); } },
  { id: 'escape', group: 'navigation', combo: 'Escape', label: 'close dialog · back to the grid', scope: 'plain', when: () => !!state.focus, run: () => focusPane(null) },
  // sessions
  { id: 'new', group: 'sessions', combo: 'n', label: 'new session', scope: 'plain', palette: 'new session', run: () => openNewSession() },
  { id: 'waiting', group: 'sessions', combo: 'w', label: 'next item waiting on you (approval, question, review, error)', scope: 'plain', palette: 'next item waiting on you', run: () => cycleWaiting() },
  { id: 'jump', group: 'sessions', keys: '1 … 9', label: 'jump to pane on the wall', scope: 'plain', test: (e) => !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key), run: (e) => { const s = visibleSessions()[Number(e.key) - 1]; if (s) { if (state.view !== 'wall') setView('wall'); focusPane(s.id); } } },
  { id: 'open', group: 'sessions', combo: 'Enter', label: 'focus the current session on the wall', scope: 'plain', when: () => state.view === 'wall' && !state.focus && !!state.sid, run: () => focusPane(state.sid) },
  { id: 'view', group: 'sessions', combo: 'v', label: 'pane view: chat ↔ terminal (grid panes also: shell → preview)', scope: 'plain', run: () => { if (state.focus) cyclePaneView(state.focus); else if (state.view === 'chat') { const p = chatPane(); if (p && p.dataset.sid) toggleCpaneView(p); } } },
  { id: 'pin', group: 'sessions', combo: 'p', label: 'pin the focused session to this window', scope: 'plain', when: () => !!state.focus, run: () => togglePin(state.focus) },
  { id: 'archive', group: 'sessions', combo: 'e', label: 'archive the focused session (undo on the toast)', scope: 'plain', when: () => !!(state.focus || (state.view === 'chat' && focusedSid())), run: () => archiveChat(state.focus || focusedSid()) },
  { id: 'archive-idle', group: 'sessions', label: 'archive every idle chat (not running, pinned, in a pane or current)', scope: 'alias', palette: 'archive idle chats', run: () => archiveIdle() },
  { id: 'voice', group: 'sessions', combo: 'mod+shift+m', label: 'voice input into the composer (start / stop)', scope: 'app', palette: 'voice input (dictate into the composer)', when: () => speechSupported(), run: () => { const comp = activeComposer(); if (comp) toggleVoice(comp); } },
  { id: 'shellhere', group: 'sessions', combo: 'mod+j', label: 'terminal here: this session\'s shell docked under the chat (toggle)', scope: 'app', palette: 'terminal here (a shell in the session\'s folder, under the chat)', run: () => { const comp = activeComposer(); if (comp) toggleShellDrawer(comp.form); } },
  { id: 'ptt', group: 'sessions', keys: '⌥Space (hold)', label: 'push-to-talk: dictate while held, release to stop (also: hold the 🎤 button)', scope: 'composer' },
  { id: 'slash', group: 'sessions', combo: '/', label: 'slash commands (/model, /trust, …)', scope: 'plain', when: () => state.view !== 'wall' || !!state.focus, run: () => { focusComposer(); const ta = document.activeElement; if (ta && ta.tagName === 'TEXTAREA') { ta.value = '/'; ta.dispatchEvent(new Event('input')); } } },
  { id: 'send', group: 'sessions', keys: '↩', label: 'send', scope: 'composer' },
  { id: 'newline', group: 'sessions', keys: '⇧↩', label: 'newline', scope: 'composer' },
  { id: 'interrupt', group: 'sessions', keys: 'esc', label: 'interrupt the running turn (while typing)', scope: 'composer' },
  { id: 'history', group: 'sessions', keys: '↑ / ↓', label: 'prompt history', scope: 'composer' },
  { id: 'files', group: 'sessions', keys: '@', label: 'reference a project file', scope: 'composer' },
  { id: 'paste', group: 'sessions', keys: '⌘V', label: 'paste never submits; big pastes become chips', scope: 'composer' },
  // panes
  { id: 'split', group: 'panes', combo: 'mod+\\', label: 'add a pane (up to 3)', scope: 'app', palette: 'split: add a pane', run: () => { toChat(); splitAdd(null); } },
  { id: 'pane1', group: 'panes', keys: '⌘1 / 2 / 3', label: 'focus chat pane 1 / 2 / 3', scope: 'app', test: (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && ['1', '2', '3'].includes(e.key), when: () => state.view === 'chat', run: (e) => splitFocus(Number(e.key) - 1) },
  { id: 'close', group: 'panes', combo: 'mod+shift+w', label: 'close pane', scope: 'app', when: () => state.view === 'chat', run: () => splitClose(state.layout.focus) },
  { id: 'zoom', group: 'panes', combo: 'mod+shift+enter', label: 'pop out the pane / back to the grid', scope: 'app', palette: 'pop out / restore pane', run: () => { toChat(); toggleZoom(); } },
  { id: 'find', group: 'panes', combo: 'mod+f', label: 'find in this session', scope: 'app', when: () => state.view === 'chat', run: () => { const p = chatPane(); if (p) openFind(p); } },
  { id: 'find-close', group: 'panes', combo: 'Escape', label: 'close find', scope: 'plain-esc', when: () => { const p = state.view === 'chat' && chatPane(); return !!(p && p._find); }, run: () => closeFind(chatPane()) },
  { id: 'select', group: 'panes', combo: 'mod+a', label: 'select the whole transcript', scope: 'app', when: () => !!focusedLog(), noField: true, run: () => { const r = document.createRange(); r.selectNodeContents(focusedLog()); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); } },
  { id: 'copy', group: 'panes', keys: '⌘C', label: 'copy the selection as clean text', scope: 'native' },
  { id: 'drag-pane', group: 'panes', keys: 'drag title bar', label: 'reorder wall panes', scope: 'mouse' },
  { id: 'drag-chat', group: 'panes', keys: 'drag a chat', label: 'from the sidebar onto a pane', scope: 'mouse' },
  // review
  { id: 'inbox', group: 'review', combo: 'a', label: 'approval inbox', scope: 'plain', palette: 'approval inbox', run: () => openInbox() },
  { id: 'inbox2', group: 'review', combo: 'i', label: 'approval inbox', scope: 'plain', hidden: true, run: () => openInbox() },
  { id: 'approve', group: 'review', combo: 'y', label: 'approve the focused pane\'s request', scope: 'plain', when: () => { const f = focusedSession(); return !!(f && f.pending_approval); }, run: () => { const f = focusedSession(); approve(f.id, f.pending_approval, true, true); } },
  { id: 'decline', group: 'review', combo: 'N', label: 'decline the focused pane\'s request', scope: 'plain', when: () => { const f = focusedSession(); return !!(f && f.pending_approval); }, run: () => { const f = focusedSession(); approve(f.id, f.pending_approval, false, true); } },
  { id: 'inbox-move', group: 'review', keys: '↑ / ↓ · j / k', label: 'move in the inbox', scope: 'inbox' },
  { id: 'inbox-yn', group: 'review', keys: 'y / n', label: 'approve / decline in the inbox (the next item is selected)', scope: 'inbox' },
  { id: 'inbox-open', group: 'review', keys: '↩', label: 'open the selected item (question, changes, error details)', scope: 'inbox' },
  { id: 'inbox-all', group: 'review', keys: 'a', label: 'approve everything in the inbox', scope: 'inbox' },
  { id: 'undo', group: 'review', keys: '↶ on a message', label: 'undo to here (files + conversation)', scope: 'mouse' },
  { id: 'changes', group: 'review', keys: 'changes', label: 'accept / reject / edit each hunk, then approve', scope: 'mouse' },
  // queue
  { id: 'queue-view', group: 'queue', combo: 'alt+2', label: 'task queue + schedules', scope: 'alias' },
  { id: 'queue-drag', group: 'queue', keys: 'drag a queued task', label: 'reorder the queue', scope: 'mouse' },
  { id: 'queue-add', group: 'queue', keys: '+ task', label: 'queue a follow-up on a session', scope: 'mouse' },
  { id: 'dialog-submit', group: 'navigation', keys: '⌘↩', label: 'submit a multi-line dialog', scope: 'dialog' },
];
const KEY_GROUPS = ['panes', 'sessions', 'review', 'queue', 'navigation'];
function activeComposer() { focusComposer(); const f = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.composer') : null; const form = f || $('.pane.focused .composer') || $('.composer'); return form && form._comp ? form._comp : null; }
// push-to-talk: hold ⌥Space (release either key to stop); repeats are ignored so holding never restarts it
document.addEventListener('keydown', (e) => {
  if (!(e.altKey && e.code === 'Space') || e.metaKey || e.ctrlKey || e.repeat || state.dialog) return;
  e.preventDefault(); if (!speechSupported()) return;
  const comp = activeComposer(); if (!comp || voiceActive(comp)) return;
  comp._ptt = true; startVoice(comp);
}, true);
document.addEventListener('keyup', (e) => {
  if (e.code !== 'Space' && e.key !== 'Alt') return;
  const comp = voiceComp || (($('.composer:focus-within') || {})._comp); if (!comp || !comp._ptt) return;
  comp._ptt = false; stopVoice(comp);
}, true);
function parseCombo(c) {
  const parts = c.split('+'); const key = parts.pop();
  return { key, mod: parts.includes('mod'), shift: parts.includes('shift'), alt: parts.includes('alt'), ctrl: parts.includes('ctrl'), plain: !parts.length };
}
function comboLabel(c) {
  const p = parseCombo(c);
  const k = { Escape: 'esc', Enter: '↩', enter: '↩', '\\': '\\' }[p.key] ?? (p.key.length === 1 ? p.key.toUpperCase() : p.key);
  if (p.plain) return { Escape: 'esc', Enter: '↩', N: '⇧N' }[p.key] ?? p.key;
  return (p.ctrl ? '⌃' : '') + (p.alt ? '⌥' : '') + (p.shift ? '⇧' : '') + (p.mod ? '⌘' : '') + k;
}
function shortcutKeys(sc) { return sc.keys || (sc.combo ? comboLabel(sc.combo) : ''); }
function keyHint(id) { const sc = SHORTCUTS.find((x) => x.id === id); return sc ? shortcutKeys(sc) : ''; }
function comboMatches(c, e) {
  const p = parseCombo(c);
  if (p.plain) return !e.metaKey && !e.ctrlKey && !e.altKey && e.key === p.key;
  const key = /^Digit\d$/.test(e.code || '') ? e.code.slice(5) : (e.key || '').toLowerCase();
  if (key !== p.key.toLowerCase()) return false;
  if (p.ctrl ? !(e.ctrlKey && e.metaKey) : (p.mod !== (e.metaKey || e.ctrlKey) || (e.ctrlKey && e.metaKey))) return false;
  return p.shift === e.shiftKey && p.alt === e.altKey;
}
document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName) || (e.target && e.target.isContentEditable);
  if (state.dialog === 'inbox') { inboxKey(e); return; }
  if (state.dialog && e.key === 'Escape') { closeDialog(); return; }
  for (const sc of SHORTCUTS) {
    if (!sc.run) continue;
    if (sc.scope === 'global') { /* always */ }
    else if (sc.scope === 'app') { if (state.dialog) continue; }
    else if (sc.scope === 'plain' || sc.scope === 'plain-esc') { if (state.dialog || inField) continue; }
    else continue;
    if (sc.noField && inField) continue;
    if (!(sc.test ? sc.test(e) : comboMatches(sc.combo, e))) continue;
    if (sc.when && !sc.when()) continue;
    e.preventDefault();
    sc.run(e);
    return;
  }
});

// header buttons
for (const b of $$('.views button')) b.addEventListener('click', () => (b.dataset.view === 'wall' ? openSessions() : setView(b.dataset.view)));
$('#btn-inbox').addEventListener('click', openInbox);
$('#btn-new').addEventListener('click', () => openNewSession());
$('#brand').addEventListener('click', () => aboutDialog());
// the search field is the command palette's front door: focusing it opens the palette with whatever was typed
$('#omni').addEventListener('focus', () => { const o = $('#omni'); const q = o.value; o.value = ''; o.blur(); if (!state.dialog) openPalette(q); });
$('#omni').addEventListener('input', () => { const o = $('#omni'); if (o.value && !state.dialog) { const q = o.value; o.value = ''; o.blur(); openPalette(q); } });
$('#sessions-bar').addEventListener('click', (e) => { const b = e.target.closest('[data-layout]'); if (b) setLayout(b.dataset.layout); });
$('#statusbar').addEventListener('click', (e) => {
  if (e.target.closest('[data-upd]')) { updateNow(); return; }
  const b = e.target.closest('[data-go]'); if (!b) return;
  const [where, metric] = b.dataset.go.split(':');
  if (where === 'sessions') setLayout('grid'); else if (where === 'stats') openStats(metric);
});
$('#btn-version').addEventListener('click', () => settingsDialog());
$('#btn-claude').addEventListener('click', () => claudeDialog());
document.addEventListener('click', (e) => { if (e.target.closest('[data-fix="claude"]')) claudeDialog(); });
setInterval(() => { if (state.connected) refreshClaude(); }, 5 * 60 * 1000);
$('#btn-broadcast').addEventListener('click', toggleBroadcast);
if (window.addEventListener) window.addEventListener('pywebviewready', () => document.body.classList.add('native'));
$('#view-wall').addEventListener('click', (e) => { const b = e.target.closest('[data-action="new"]'); if (b) openNewSession(); });
$('#tagline').textContent = TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
document.addEventListener('click', () => { if ('Notification' in window && Notification.permission === 'default' && !localStorage.getItem('kcoder.askedNotif')) { localStorage.setItem('kcoder.askedNotif', '1'); Notification.requestPermission(); } }, { once: true });
setInterval(() => { renderHeader(); if (state.view === 'wall') for (const p of $$('.pane')) { const s = state.sessions.get(p.dataset.sid); if (s) renderPaneChrome(p, s, state.order.indexOf(s.id) + 1); } }, 15000);
window.addEventListener('resize', () => { for (const sid of state.shells.keys()) fitShell(sid); });

// ----------------------------------------------------------------------
// split view: 1 to 3 session panes side by side, each fully independent
// ----------------------------------------------------------------------
function saveLayout() { localStorage.setItem('kcoder.layout', JSON.stringify(state.layout)); syncUiState(); }
function paneSid(i) { return state.layout.panes[i] || null; }
function focusedSid() { return paneSid(state.layout.focus); }
function syncSid() { const sid = focusedSid(); if (sid) { state.sid = sid; localStorage.setItem('kcoder.sid', sid); } }
function focusedLog() {
  if (state.view === 'chat') { const p = $$('#split .cpane')[state.layout.focus]; return p && !p.hidden ? $('.chat-log', p) : null; }
  if (state.view === 'wall' && state.focus) { const p = $(`.pane[data-sid="${state.focus}"]`); return p ? $('.chat-log', p) || $('.pane-body', p) : null; }
  if (state.view === 'terminal') return $('#term-log');
  return null;
}
function assignPane(i, sid) {
  i = Math.max(0, Math.min(i, state.layout.panes.length - 1));
  state.layout.panes[i] = sid || null; state.layout.focus = i; saveLayout(); syncSid();
  if (sid) {
    const st = state.events.get(sid);
    if (!st || !st.loaded) loadEvents(sid, -1);
    const s = state.sessions.get(sid); if (s && s.project && s.project.git && !state.gitInfo.has(sid)) gitStatus(sid, false).catch(() => {});
  }
  renderSplit(); renderSidebar(); renderTitlebars(); focusComposer();
}
function splitAdd(sid) {
  if (state.layout.panes.length >= 3) { toast('up to 3 panes side by side', 'warn'); return; }
  state.layout.panes.push(sid || null); state.layout.focus = state.layout.panes.length - 1; state.layout.zoom = null; saveLayout();
  if (sid) loadEvents(sid, -1);
  renderSplit(); renderSidebar();
  if (!sid) pickSession(state.layout.focus);
}
function splitClose(i) {
  if (state.layout.panes.length <= 1) { toast('the last pane stays open', 'warn'); return; }
  state.layout.panes.splice(i, 1); state.layout.focus = Math.min(state.layout.focus, state.layout.panes.length - 1); state.layout.zoom = null; saveLayout(); syncSid();
  renderSplit(); renderSidebar(); focusComposer();
}
function splitFocus(i) { if (i < 0 || i >= state.layout.panes.length) return; state.layout.focus = i; if (state.layout.zoom != null) state.layout.zoom = i; saveLayout(); syncSid(); renderSplit(); renderSidebar(); renderTitlebars(); focusComposer(); }
function toggleZoom(i) { const idx = i == null ? state.layout.focus : i; state.layout.zoom = state.layout.zoom === idx ? null : idx; state.layout.focus = idx; saveLayout(); renderSplit(); focusComposer(); }
async function pickSession(i) {
  const items = []; const seen = new Set();
  const mark = (s) => (s.status === 'working' ? '● ' : s.status === 'waiting' ? '◐ ' : '○ ');
  for (const s of visibleSessions()) { seen.add(s.id); items.push([s.id, `${mark(s)}${s.title || s.name} · ${(s.project || {}).name || shortHome(s.cwd)}`]); }
  for (const c of state.chats) if (!seen.has(c.id) && !c.archived) { seen.add(c.id); items.push([c.id, `○ ${c.title || c.name} · ${(c.project || {}).name || ''}`]); }
  items.push(['__new', '+ new session']);
  if (state.layout.panes[i]) items.push(['__empty', '(empty this pane)']);
  const v = await chooseDialog(`Session for pane ${i + 1}`, items);
  if (!v) return;
  if (v === '__new') { openNewSession({ pane: i }); return; }
  assignPane(i, v === '__empty' ? null : v);
}

function renderSplit() {
  const split = $('#split'); if (!split) return;
  const L = state.layout;
  if (!Array.isArray(L.panes) || !L.panes.length) L.panes = [null];
  L.panes = L.panes.slice(0, 3);
  L.focus = Math.max(0, Math.min(L.focus || 0, L.panes.length - 1));
  if (L.zoom != null && L.zoom >= L.panes.length) L.zoom = null;
  split.dataset.n = L.panes.length;
  split.classList.toggle('zoomed', L.zoom != null);
  while (split.children.length > L.panes.length) split.lastElementChild.remove();
  while (split.children.length < L.panes.length) { const el = $('#tpl-cpane').content.querySelector('.cpane').cloneNode(true); split.appendChild(el); wireCpane(el); }
  L.panes.forEach((sid, i) => {
    const pane = split.children[i];
    pane.dataset.pane = i;
    if (pane.dataset.sid !== (sid || '')) { closeShellDrawer(pane); pane.dataset.sid = sid || ''; $('.composer-slot', pane).innerHTML = ''; $('.chat-log', pane).innerHTML = ''; pane._rendered = null; if (pane._find) closeFind(pane, true); }
    pane.classList.toggle('focused', i === L.focus);
    pane.classList.toggle('zoom', L.zoom === i);
    pane.hidden = L.zoom != null && L.zoom !== i;
    renderCpaneBar(pane); renderCpaneLog(pane);
    const slot = $('.composer-slot', pane);
    if (sid) { if (!slot.firstChild) mountComposer(slot, sid, false); else updateComposerState(slot, sid); } else slot.innerHTML = '';
  });
}
function renderSplitBars() { if (state.view !== 'chat') return; for (const p of $$('#split .cpane')) { renderCpaneBar(p); const slot = $('.composer-slot', p); if (p.dataset.sid && slot.firstChild) updateComposerState(slot, p.dataset.sid); } }

function renderCpaneBar(pane) {
  const sid = pane.dataset.sid; const s = sid ? (state.sessions.get(sid) || state.chats.find((c) => c.id === sid)) : null;
  const bar = $('.cpane-bar', pane);
  $('.dot', bar).className = 'dot ' + (s ? (s.archived ? 'archived' : s.status) : '');
  $('.picker', bar).textContent = s ? (s.title && s.title !== s.name ? `${s.name} · ${s.title}` : s.name) : 'pick a session ▾';
  $('.picker', bar).title = s ? `${s.name}${s.title ? ' · ' + s.title : ''}  (click to switch sessions)` : 'Pick a session for this pane';
  $('.meta', bar).innerHTML = s ? `${esc((s.project || {}).name || shortHome(s.cwd))}${s.worktree ? ' @ ' + esc(s.worktree.branch) : ''} ${paneChips(s)}` : '';
  $('.ctx', bar).textContent = s ? `ctx ${fmtTokens(s.context_tokens || 0)} · ${s.plan ? (planShareText(s) ? 'plan ' + planShareText(s) : 'plan') : fmtUsd((s.usage || {}).cost || 0)}` : '';
  $('.ctx', bar).title = s && s.plan ? 'context size · this session\'s share of your Claude plan limits (approximate; click the plan button in the status bar for the whole picture)' : 'context size · spend';
  let errChip = $('.err-chip', bar); if (s && s.status === 'error') { if (!errChip) { errChip = document.createElement('button'); errChip.className = 'err-chip'; errChip.dataset.err = s.id; errChip.title = 'what happened, send again, copy a report'; errChip.textContent = 'error · details'; $('.ctx', bar).before(errChip); } } else if (errChip) errChip.remove();
  for (const el of $$('select[data-act], button[data-act]', bar)) el.disabled = !s;
  if (s) {
    const ts = $('select[data-act="trust"]', bar); if (ts.value !== (s.trust || 'read')) ts.value = s.trust || 'read';
    const ms = $('select[data-act="model"]', bar); if (ms.dataset.for !== sid + ':' + s.model + ':' + s.provider) { fillModelSelect(ms, s); ms.dataset.for = sid + ':' + s.model + ':' + s.provider; }
    $('button[data-act="interrupt"]', bar).disabled = !(s.status === 'working' || s.status === 'waiting');
  }
  const tb = $('[data-pane="timeline"]', bar); if (tb) tb.classList.toggle('active', timelineOn());
  const tv = cpaneViewOf(sid) === 'term';
  const vt = $('[data-pane="view"]', bar); vt.textContent = tv ? '▤' : '☰'; vt.title = (tv ? 'terminal view · click for chat' : 'chat view · click for terminal') + '  (v)'; vt.classList.toggle('active', tv);
  $('[data-pane="zoom"]', bar).textContent = state.layout.zoom != null ? '⤡' : '⤢';
  $('[data-pane="zoom"]', bar).hidden = state.layout.panes.length <= 1 && state.layout.zoom == null;
  $('[data-pane="close"]', bar).hidden = state.layout.panes.length <= 1;
}

function cpaneViewOf(sid) { return (sid && state.cpaneView.get(sid)) || 'chat'; }
function toggleCpaneView(pane) {
  const sid = pane.dataset.sid; if (!sid) return;
  const term = cpaneViewOf(sid) !== 'term';
  state.cpaneView.set(sid, term ? 'term' : 'chat');
  pane._rendered = null; $('.chat-log', pane).innerHTML = '';
  const slot = $('.composer-slot', pane); slot.innerHTML = ''; mountComposer(slot, sid, term);
  renderCpaneBar(pane); renderCpaneLog(pane); focusComposer();
}
// ---- "where we left off": a cached recap (kcoder/recap.py) over the transcript, with the live branch state
function recapIdle(s) { return Math.max(0, Date.now() / 1000 - (s && s.last_activity || 0)); }
function maybeRecap(pane, sid) {
  const slot = $('.recap-slot', pane); if (!slot) return;
  if (pane._recapSid !== sid) { pane._recapSid = sid; slot.hidden = true; slot.innerHTML = ''; }
  const s = state.sessions.get(sid); if (!s || (s.messages || 0) < 2 || cpaneViewOf(sid) === 'term') return;
  const shown = state.recapShown.get(sid);
  const idle = recapIdle(s);
  if (shown && !(idle >= 86400 && (s.last_activity || 0) > shown)) { if (state.recaps.has(sid)) renderRecap(pane, sid); return; }
  state.recapShown.set(sid, Date.now() / 1000);
  request('recap', { sid, action: 'peek' }).then((r) => {
    const c = r.recap;
    if (c && !c.stale && c.dismissed) return;          // dismissed, and nothing happened since
    showRecap(sid, false);
  }).catch(() => {});
}
async function showRecap(sid, refresh) {
  const panes = $$('#split .cpane').filter((p) => p.dataset.sid === sid); if (!panes.length) return;
  for (const p of panes) { const slot = $('.recap-slot', p); slot.hidden = false; slot.innerHTML = `<div class="recap-card loading"><span class="spin">◐</span> ${refresh ? 'rewriting' : 'writing'} the recap with a small model…</div>`; }
  try { const r = await request('recap', { sid, action: refresh ? 'refresh' : 'get' }); state.recaps.set(sid, r.recap); }
  catch (e) { for (const p of panes) { const slot = $('.recap-slot', p); slot.innerHTML = `<div class="recap-card err">recap: ${esc(e.message)} <button data-recap="close">✕</button></div>`; } return; }
  for (const p of panes) renderRecap(p, sid);
}
function branchBits(b) {
  if (!b || !b.git) return '';
  const parts = [`⎇ <b>${esc(b.branch || '?')}</b>`];
  if (b.dirty) parts.push(`<span class="warn">${b.dirty} uncommitted</span>`);
  if (b.unpushed) parts.push(`<span class="warn">${b.unpushed} unpushed</span>`);
  if (!b.dirty && !b.unpushed) parts.push('clean, pushed');
  if (b.behind) parts.push(`${b.behind} behind`);
  if (b.pr) parts.push(`<a href="${esc(b.pr.url)}" target="_blank" rel="noopener">PR #${esc(b.pr.number)}</a> ${esc((b.pr.state || 'open').toLowerCase())}${b.pr.draft ? ' (draft)' : ''}${b.pr.checks ? ', checks ' + esc(b.pr.checks) : ''}`);
  return `<span class="branch" title="branch state now">· ${parts.join(' · ')}</span>`;
}
function renderRecap(pane, sid) {
  const slot = $('.recap-slot', pane); const r = state.recaps.get(sid); if (!slot || !r) return;
  slot.hidden = false;
  const fold = localStorage.getItem('kcoder.recapFold') === '1';
  const idle = r.idle_seconds != null ? r.idle_seconds : recapIdle(state.sessions.get(sid));
  slot.innerHTML = `<div class="recap-card${fold ? ' fold' : ''}"><div class="rh"><button class="t" data-recap="fold" title="${fold ? 'show' : 'fold'} the recap">${fold ? '▸' : '▾'} where we left off</button><span class="dim">· ${age(Date.now() / 1000 - idle)} ago</span>${branchBits(r.branch)}<span class="spacer"></span><button data-recap="refresh" title="rewrite the recap (${esc((r.model || '').split('/').pop())}, ${r.cached ? 'cached' : 'just written'}${r.at ? ' ' + age(r.at) + ' ago' : ''})">↻</button><button data-recap="close" title="dismiss (comes back after new activity)">✕</button></div><div class="md">${renderMarkdown(r.text || '')}</div></div>`;
}
function hideRecap(sid) { state.recaps.delete(sid); for (const p of $$('#split .cpane')) if (p.dataset.sid === sid) { const slot = $('.recap-slot', p); if (slot) { slot.hidden = true; slot.innerHTML = ''; } } }
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-recap]'); if (!b) return;
  const pane = b.closest('.cpane'); const sid = pane && pane.dataset.sid; if (!sid) return;
  if (b.dataset.recap === 'refresh') showRecap(sid, true);
  else if (b.dataset.recap === 'fold') { localStorage.setItem('kcoder.recapFold', localStorage.getItem('kcoder.recapFold') === '1' ? '0' : '1'); for (const p of $$('#split .cpane')) if (p.dataset.sid === sid) renderRecap(p, sid); }
  else { hideRecap(sid); request('recap', { sid, action: 'dismiss' }).catch(() => {}); }
});

// ---- session timeline: one mark per turn with tools, files changed, errors and tokens; click for the turn's diff ----
function timelineOn() { return localStorage.getItem('kcoder.timeline') === 'on'; }
function turnMarks(store) {
  const turns = [];
  let cur = null; const calls = new Map();
  for (let i = 0; i < store.list.length; i++) {
    const e = store.list[i];
    if (e.t === 'user') { cur = { turn: turns.length, i, text: e.text || '', tools: 0, files: new Set(), errors: 0, tokens: 0, ts: e.ts, images: (e.images || []).length }; turns.push(cur); continue; }
    if (!cur) continue;
    if (e.t === 'tool_call') { cur.tools++; calls.set(e.id, e); const inp = e.input || {}; const path = inp.file_path || inp.path || inp.notebook_path; if (path && /^(Edit|Write|MultiEdit|NotebookEdit|write_file|edit_file)$/.test(e.name)) cur.files.add(path); }
    else if (e.t === 'tool_result' && e.is_error) cur.errors++;
    else if (e.t === 'error') cur.errors++;
    else if (e.t === 'usage') cur.tokens += (e.input || 0) + (e.output || 0);
  }
  return turns;
}
function renderTimeline(pane) {
  const tl = $('.timeline', pane); const sid = pane.dataset.sid;
  if (!tl) return;
  if (!sid || !timelineOn() || cpaneViewOf(sid) === 'term') { tl.hidden = true; tl.innerHTML = ''; return; }
  const store = state.events.get(sid) || { list: [] };
  const turns = turnMarks(store);
  const filter = state.tlFilter || 'all';
  const shown = turns.filter((t) => filter === 'all' || (filter === 'files' && t.files.size) || (filter === 'errors' && t.errors));
  const maxTok = Math.max(1, ...turns.map((t) => t.tokens));
  const cur = state.tlTurn && state.tlTurn.sid === sid ? state.tlTurn.turn : -1;
  tl.hidden = false;
  tl.innerHTML = `<span class="tl-label" title="one mark per turn: height = tokens; blue = files changed; red = an error">⧗ ${turns.length} turn${turns.length === 1 ? '' : 's'}</span>
    <span class="tl-track">${shown.map((t) => `<button class="tl-mark${t.files.size ? ' files' : ''}${t.errors ? ' err' : ''}${t.turn === cur ? ' cur' : ''}" data-turn="${t.turn}" style="--h:${Math.max(18, Math.round(t.tokens / maxTok * 100))}%" title="turn ${t.turn + 1}: ${esc(t.text.slice(0, 80))}${t.text.length > 80 ? '…' : ''}\n${t.tools} tool call${t.tools === 1 ? '' : 's'} · ${t.files.size} file${t.files.size === 1 ? '' : 's'} changed · ${t.errors} error${t.errors === 1 ? '' : 's'} · ${fmtTokens(t.tokens)} tokens${t.images ? ' · ' + t.images + ' image(s)' : ''}\nclick: jump there and show the diff of this turn"><i></i></button>`).join('') || '<span class="dim">no turns match</span>'}</span>
    <span class="seg sm tl-filter"><button data-tlf="all" class="${filter === 'all' ? 'active' : ''}" title="every turn">all</button><button data-tlf="files" class="${filter === 'files' ? 'active' : ''}" title="only turns that changed files">files</button><button data-tlf="errors" class="${filter === 'errors' ? 'active' : ''}" title="only turns that hit an error">errors</button></span>
    <button class="tl-close" data-tl="close" title="hide the timeline">✕</button>`;
}
function toggleTimeline(pane) { localStorage.setItem('kcoder.timeline', timelineOn() ? 'off' : 'on'); for (const p of $$('#split .cpane')) { renderTimeline(p); renderCpaneBar(p); } }
document.addEventListener('click', (e) => {
  const tl = e.target.closest('.timeline'); if (!tl) return;
  const pane = tl.closest('.cpane'); const sid = pane.dataset.sid;
  const f = e.target.closest('[data-tlf]'); if (f) { state.tlFilter = f.dataset.tlf; renderTimeline(pane); return; }
  if (e.target.closest('[data-tl="close"]')) { toggleTimeline(pane); return; }
  const m = e.target.closest('.tl-mark'); if (!m) return;
  const turn = Number(m.dataset.turn);
  state.tlTurn = { sid, turn }; renderTimeline(pane);
  const el = pane.querySelector(`.msg-user[data-turn="${turn}"]`);
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600); }
  turnDiffDialog(sid, turn);
});
function diffHunkHtml(h) {
  const lines = h.text.split('\n').slice(1).map((l) => `<div class="dl ${l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : ''}">${esc(l)}</div>`).join('');
  return `<div class="hunk ro"><div class="hh"><code>${esc(h.path)}</code> <span class="dim">${esc(h.header)}</span></div><div class="dls">${lines}</div></div>`;
}
async function turnDiffDialog(sid, turn) {
  const s = state.sessions.get(sid) || {};
  const store = state.events.get(sid) || { list: [] }; const turns = turnMarks(store); const t = turns[turn] || { text: '', tools: 0, files: new Set(), errors: 0, tokens: 0 };
  const d = openDialog(`<h2>turn ${turn + 1} of ${turns.length}<span class="help" id="td-status"></span><span class="spacer"></span><button data-td="prev" ${turn <= 0 ? 'disabled' : ''} title="previous turn">←</button><button data-td="next" ${turn >= turns.length - 1 ? 'disabled' : ''} title="next turn">→</button><button data-td="undo" class="danger" title="undo to here: files and conversation go back to just before this turn">↶ undo to here</button><button data-x="close">✕</button></h2>
    <div class="body changes"><div class="td-head"><div class="md">${renderMarkdown(t.text.slice(0, 600))}</div><div class="help plain">${t.tools} tool call(s) · ${t.files.size} file(s) touched · ${t.errors} error(s) · ${fmtTokens(t.tokens)} tokens${t.ts ? ' · ' + new Date(t.ts * 1000).toLocaleString() : ''}</div></div><div class="ch-files"></div><div class="ch-diff"><div class="empty-row">loading the diff…</div></div></div>`, 'turndiff');
  d.classList.add('wide');
  const files = $('.ch-files', d), diff = $('.ch-diff', d), status = $('#td-status', d);
  try {
    const r = await request('turn_diff', { sid, turn });
    status.textContent = `${r.files.length} file(s) changed by this turn${r.through_now ? (r.partial ? ' (still running: the diff grows)' : ' (through the worktree now)') : ''}`;
    files.innerHTML = r.files.length ? r.files.map((f) => `<div class="item" data-f="${esc(f.path)}"><span class="st ${esc(f.status)}">${esc(f.status)}</span><code>${esc(f.path)}</code><span class="meta">+${f.additions}/-${f.deletions}</span></div>`).join('') : '<div class="empty-row">this turn changed no files</div>';
    diff.innerHTML = r.hunks.length ? r.hunks.map(diffHunkHtml).join('') : `<div class="empty-row">${r.files.length ? 'binary changes only' : 'no diff'}</div>`;
  } catch (e) { status.textContent = ''; diff.innerHTML = `<div class="empty-row">${esc(e.message)}</div>`; files.innerHTML = ''; }
  d.addEventListener('click', async (e) => {
    if (e.target.closest('[data-x]')) { closeDialog(); return; }
    const b = e.target.closest('[data-td]'); if (!b) return;
    if (b.dataset.td === 'prev' || b.dataset.td === 'next') { closeDialog(); const k = turn + (b.dataset.td === 'next' ? 1 : -1); state.tlTurn = { sid, turn: k }; for (const p of $$('#split .cpane')) if (p.dataset.sid === sid) renderTimeline(p); turnDiffDialog(sid, k); return; }
    if (b.dataset.td === 'undo') {
      if (!s.worktree) { toast('undo needs a worktree session', 'warn'); return; }
      closeDialog();
      if (await confirmDialog('Undo to here?', `Files in the worktree go back to how they were just before turn ${turn + 1}, and that message and everything after it are removed from the conversation. Commits the agent made since are undone too.`)) {
        try { await request('undo', { sid, turn }); toast('restored files and conversation', 'ok'); loadEventsFresh(sid); } catch (err) { toast(err.message, 'err'); }
      }
    }
  });
}

function pinLog(pane) { const log = $('.chat-log', pane); log.scrollTop = log.scrollHeight; pane._pin = true; $('.jump', pane).hidden = true; }
function renderCpaneLog(pane) {
  const sid = pane.dataset.sid; const log = $('.chat-log', pane);
  const term = cpaneViewOf(sid) === 'term';
  log.classList.toggle('term-log', !!sid && term);
  if (!sid) { log.innerHTML = '<div class="empty"><p>No session in this pane.</p><p><button class="primary" data-pane="pick">Pick a session</button> or drag one from the sidebar.</p></div>'; pane._rendered = null; $('.jump', pane).hidden = true; return; }
  const store = state.events.get(sid) || { list: [], live: '', streaming: false };
  if (term) { const stick = nearBottom(log); log.innerHTML = buildTermHtml(store, sid, {}); if (stick) log.scrollTop = log.scrollHeight; pane._rendered = null; $('.jump', pane).hidden = true; return; }
  renderLogInto(pane, log, sid, store, {}, log);
  if (pane._find && pane._find.q) runFind(pane, false);
  if (store.loaded) maybeRecap(pane, sid);
  renderTimeline(pane);
}

function wireCpane(pane) {
  const idx = () => Number(pane.dataset.pane);
  pane.addEventListener('mousedown', () => {
    if (state.layout.focus === idx()) return;
    state.layout.focus = idx(); saveLayout(); syncSid();
    for (const p of $$('#split .cpane')) p.classList.toggle('focused', p === pane);
    renderSidebar(); renderTitlebars();
  }, true);
  const bar = $('.cpane-bar', pane);
  bar.addEventListener('click', (e) => {
    const sid = pane.dataset.sid;
    const pb = e.target.closest('button[data-pane]');   // the pane element itself carries data-pane=<index>: buttons only
    if (pb) { const a = pb.dataset.pane; if (a === 'zoom') toggleZoom(idx()); else if (a === 'close') splitClose(idx()); else if (a === 'menu') paneMenu(pane); else if (a === 'find') openFind(pane); else if (a === 'view') toggleCpaneView(pane); else if (a === 'timeline') toggleTimeline(pane); return; }
    if (e.target.closest('.picker')) { pickSession(idx()); return; }
    if (e.target.closest('a')) return;
    const b = e.target.closest('[data-act]'); if (b && sid) handleAction(b, sid);
  });
  bar.addEventListener('change', (e) => { const s = e.target.closest('select[data-act]'); if (s && pane.dataset.sid) handleAction(s, pane.dataset.sid); });
  const log = $('.chat-log', pane);
  log.addEventListener('click', (e) => {
    const sid = pane.dataset.sid;
    if (e.target.closest('[data-pane="pick"]')) { pickSession(idx()); return; }
    const b = e.target.closest('[data-act]'); if (b && sid) { handleAction(b, sid); return; }
    if (e.target.dataset.copy) copyCode(e.target);
  });
  // The log stays pinned to the newest message until the reader scrolls up: when its box changes
  // (the recap card or the composer growing, a resize, the view coming on screen) or an image in it
  // finishes loading, a pinned log goes back to the bottom instead of leaving "jump to latest" to click.
  log.addEventListener('scroll', () => { pane._pin = nearBottom(log); if (pane._pin) $('.jump', pane).hidden = true; });
  $('.jump', pane).addEventListener('click', () => pinLog(pane));
  if (window.ResizeObserver) new ResizeObserver(() => { if (pane._pin !== false) pinLog(pane); }).observe(log);
  log.addEventListener('load', () => { if (pane._pin !== false) pinLog(pane); }, true);
  const fb = $('.cpane-find', pane); const fin = $('input', fb);
  fin.addEventListener('input', () => runFind(pane, true));
  fin.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stepFind(pane, e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { e.preventDefault(); closeFind(pane); } });
  fb.addEventListener('click', (e) => { const b = e.target.closest('[data-find]'); if (!b) return; if (b.dataset.find === 'close') closeFind(pane); else stepFind(pane, b.dataset.find === 'next' ? 1 : -1); });
  pane.addEventListener('dragover', (e) => { const files = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'); if (state.dragChat || files) { e.preventDefault(); e.dataTransfer.dropEffect = state.dragChat ? 'move' : 'copy'; pane.classList.add('drop'); } });
  pane.addEventListener('dragleave', (e) => { if (!pane.contains(e.relatedTarget)) pane.classList.remove('drop'); });
  pane.addEventListener('drop', (e) => {
    pane.classList.remove('drop');
    if (state.dragChat) { e.preventDefault(); const sid = state.dragChat; state.dragChat = null; assignPane(idx(), sid); return; }
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) { e.preventDefault(); const form = $('.composer', pane); if (form && form._comp) addFiles(form._comp, files); else toast('pick a session for this pane first', 'warn'); }
  });
}

async function paneMenu(pane) {
  const sid = pane.dataset.sid; const s = sid && state.sessions.get(sid);
  const i = Number(pane.dataset.pane);
  const items = [['pick', 'Switch session…'], ['find', 'Find in session', keyHint('find')], ['zoom', state.layout.zoom != null ? 'Back to the grid' : 'Pop out this pane', keyHint('zoom')], ['split', 'Add a pane', keyHint('split')], ['close', 'Close this pane', keyHint('close')], ['fullscreen', 'Full screen', keyHint('fullscreen')]];
  if (s) {
    items.push(['model', `Model: ${s.provider}/${s.model}`, '/model'], ['trust', `Trust: ${s.trust}`, '/trust']);
    if (s.status === 'working' || s.status === 'waiting') items.push(['interrupt', 'Interrupt', keyHint('interrupt')]);
    if (s.project && s.project.git) items.push(['git', 'Git status'], ['pull', 'Pull from remote']);
    if (s.worktree) items.push(['merge', 'Merge into project'], ['pr', 'Open PR'], ['discard', 'Discard worktree']);
    items.push(['queue', 'Add a follow-up task'], ['export', 'Export markdown'], ['rename', 'Rename title'], ['archive', 'Archive session']);
  }
  const v = await chooseDialog(`Pane ${i + 1}${s ? ' · ' + (s.title || s.name) : ''}`, items); if (!v) return;
  try {
    switch (v) {
      case 'pick': pickSession(i); break;
      case 'find': openFind(pane); break;
      case 'zoom': toggleZoom(i); break;
      case 'split': splitAdd(null); break;
      case 'close': splitClose(i); break;
      case 'fullscreen': toggleFullscreen(); break;
      case 'model': modelPicker(sid); break;
      case 'trust': { const t = await chooseDialog('Trust', [['auto', 'auto - never ask'], ['write', 'write - gate shell'], ['read', 'read - gate writes + shell'], ['none', 'none - ask for everything'], ['dry', 'dry run - plan and diff only, changes nothing']]); if (t) await request('set', { sid, trust: t }); break; }
      case 'rename': { const t = await promptDialog('Chat title', '', s.title || ''); if (t) await request('title', { sid, title: t }); break; }
      default: handleAction({ dataset: { act: v } }, sid);
    }
  } catch (e) { toast(e.message, 'err'); }
}

// ----------------------------------------------------------------------
// copying: clean text (markdown source for whole messages, fences kept)
// ----------------------------------------------------------------------
function copyMessage(sid, i, el) {
  const store = state.events.get(sid);
  let text = store && store.list[i] && store.list[i].text != null ? store.list[i].text : null;
  if (text == null && el) text = domToText(el.querySelector('.md') || el.querySelector('.bubble') || el);
  if (text == null) return;
  navigator.clipboard.writeText(text).then(() => toast('copied'), () => toast('copy failed', 'err'));
}
function domToText(root) {
  const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'BLOCKQUOTE', 'DETAILS', 'SUMMARY', 'TABLE', 'UL', 'OL', 'HR']);
  let out = '';
  const walk = (n) => {
    if (n.nodeType === 3) { out += n.nodeValue; return; }
    if (n.nodeType !== 1) return;
    const cs = n.ownerDocument.defaultView ? getComputedStyle(n) : null;
    if (n.matches && n.matches('button, .who, .actions, .copy, .copy-msg, [hidden]')) return;
    if (cs && cs.userSelect === 'none') return;
    if (n.tagName === 'BR') { out += '\n'; return; }
    if (n.tagName === 'PRE') { const code = n.querySelector('code'); const lang = code && (code.className.match(/language-(\S+)/) || [])[1]; const body = (code || n).textContent.replace(/\n$/, ''); out += (out && !out.endsWith('\n') ? '\n' : '') + '```' + (lang || '') + '\n' + body + '\n```\n'; return; }
    if (n.tagName === 'LI') { const ol = n.parentElement && n.parentElement.tagName === 'OL'; const k = ol ? Array.from(n.parentElement.children).indexOf(n) + 1 + '. ' : '- '; out += k; }
    if (n.tagName === 'TD' || n.tagName === 'TH') { for (const c of n.childNodes) walk(c); out += '\t'; return; }
    for (const c of n.childNodes) walk(c);
    if (BLOCK.has(n.tagName) && !out.endsWith('\n')) out += '\n';
    if ((n.tagName === 'P' || n.tagName === 'PRE' || /^H[1-6]$/.test(n.tagName)) && !out.endsWith('\n\n')) out += '\n';
  };
  walk(root);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
document.addEventListener('copy', (e) => {
  const sel = window.getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const anc = range.commonAncestorContainer; const ancEl = anc.nodeType === 1 ? anc : anc.parentElement;
  if (!ancEl || ancEl.closest('textarea, input')) return;
  const log = ancEl.closest('.chat-log, .term-log'); if (!log) return;
  const sid = log.closest('[data-sid]') ? log.closest('[data-sid]').dataset.sid : state.sid;
  const store = state.events.get(sid);
  const parts = [];
  const blocks = $$('.msg, .tool, .note, .approval', log);
  if (!blocks.length) return;
  for (const el of blocks) {
    if (!range.intersectsNode(el)) continue;
    const i = el.dataset.i;
    const er = document.createRange(); er.selectNodeContents(el);
    const whole = range.compareBoundaryPoints(Range.START_TO_START, er) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, er) >= 0;
    if (el.classList.contains('msg') && whole && store && i != null && store.list[i] && store.list[i].text != null) { parts.push(store.list[i].text); continue; }
    const r = range.cloneRange();
    if (r.compareBoundaryPoints(Range.START_TO_START, er) < 0) r.setStart(er.startContainer, er.startOffset);
    if (r.compareBoundaryPoints(Range.END_TO_END, er) > 0) r.setEnd(er.endContainer, er.endOffset);
    const frag = r.cloneContents(); const box = document.createElement('div'); box.appendChild(frag);
    const t = domToText(box); if (t) parts.push(t);
  }
  if (!parts.length) return;
  e.preventDefault(); e.clipboardData.setData('text/plain', parts.join('\n\n'));
});

// ----------------------------------------------------------------------
// find in a pane (CSS custom highlights when the engine has them)
// ----------------------------------------------------------------------
const HAS_HL = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && CSS.highlights;
function openFind(pane) { const fb = $('.cpane-find', pane); fb.hidden = false; pane._find = pane._find || { q: '', ranges: [], cur: 0 }; const inp = $('input', fb); inp.focus(); inp.select(); if (inp.value) runFind(pane, false); }
function closeFind(pane, silent) {
  const fb = $('.cpane-find', pane); fb.hidden = true; pane._find = null; $('.count', fb).textContent = '';
  if (HAS_HL) { CSS.highlights.delete('kc-find-' + pane.dataset.pane); CSS.highlights.delete('kc-cur-' + pane.dataset.pane); }
  if (!silent) focusComposer();
}
function runFind(pane, reset) {
  const fb = $('.cpane-find', pane); const q = $('input', fb).value; const f = pane._find || (pane._find = { q: '', ranges: [], cur: 0 });
  f.q = q; f.ranges = [];
  if (q) {
    const log = $('.chat-log', pane); const ql = q.toLowerCase();
    const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && n.parentElement.closest('button, .who, .actions') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    let n;
    while ((n = walker.nextNode())) { const t = n.nodeValue.toLowerCase(); let p = t.indexOf(ql); while (p >= 0) { const r = document.createRange(); r.setStart(n, p); r.setEnd(n, p + q.length); f.ranges.push(r); p = t.indexOf(ql, p + q.length); } }
  }
  f.cur = reset ? 0 : Math.min(f.cur, Math.max(0, f.ranges.length - 1));
  paintFind(pane);
}
function stepFind(pane, d) { const f = pane._find; if (!f || !f.ranges.length) return; f.cur = (f.cur + d + f.ranges.length) % f.ranges.length; paintFind(pane); }
function paintFind(pane) {
  const f = pane._find; if (!f) return; const fb = $('.cpane-find', pane); const k = pane.dataset.pane;
  $('.count', fb).textContent = f.q ? (f.ranges.length ? `${f.cur + 1} of ${f.ranges.length}` : 'no matches') : '';
  if (HAS_HL) { CSS.highlights.set('kc-find-' + k, new Highlight(...f.ranges)); CSS.highlights.set('kc-cur-' + k, new Highlight(...(f.ranges[f.cur] ? [f.ranges[f.cur]] : []))); }
  const r = f.ranges[f.cur];
  if (r) { const log = $('.chat-log', pane); const rect = r.getBoundingClientRect(); const lr = log.getBoundingClientRect(); if (rect.top < lr.top + 20 || rect.bottom > lr.bottom - 20) log.scrollTop += rect.top - lr.top - lr.height / 2; }
}

// ----------------------------------------------------------------------
// stats view
// ----------------------------------------------------------------------
let statsData = null;
function openStats(metric) { state.statsMetric = metric || null; statsData = null; setView('stats'); }
const fmtDur = (sec) => { sec = Math.round(sec || 0); if (sec < 60) return sec + 's'; const m = Math.round(sec / 60); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return `${h}h ${m % 60}m`; };
const fmtDate = (d) => { if (!d) return ''; const t = new Date(d + 'T00:00:00'); return isNaN(t) ? d : t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + (t.getFullYear() !== new Date().getFullYear() ? ' ' + t.getFullYear() : ''); };
const fmtPct = (x) => `${Math.round((x || 0) * 100)}%`;
const fmtNum = (v) => (v == null ? '-' : Number.isInteger(v) ? fmtInt(v) : Math.abs(v) >= 100 ? fmtInt(Math.round(v)) : v.toFixed(1));
const fmtCompact = (v) => { v = Math.round(v || 0); const a = Math.abs(v); const body = a >= 1e9 ? (a / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e5 ? Math.round(a / 1e3) + 'k' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'k' : String(a); return (v < 0 ? '\u2212' : '') + body; };
const fmtSigned = (v) => (v > 0 ? '+' : '') + fmtCompact(v);
const plus = (v) => `<span class="ok">+${fmtInt(Math.round(v || 0))}</span>`, minus = (v) => `<span class="warn">-${fmtInt(Math.round(v || 0))}</span>`;
const TOOL_NAMES = { run_bash: 'Bash', read_file: 'Read', write_file: 'Write', edit_file: 'Edit', list_dir: 'List' };
const toolCategory = (n) => (/^(Bash|run_bash)$/.test(n) ? 'shell' : /^(Edit|Write|MultiEdit|NotebookEdit|write_file|edit_file)$/.test(n) ? 'edit' : /^(Read|read_file|list_dir|LS)$/.test(n) ? 'read' : /^(Grep|Glob|WebSearch|WebFetch)$/.test(n) ? 'search' : 'other');
// one sortable table: cols [{k, label, f, cls:'l' for text (numbers are right-aligned by default), sort}]; sort state is kept per table id
function sortableTable(id, cols, rows, opts = {}) {
  const st = state.statsSorts[id] || opts.sort || { key: cols[0].k, dir: 1 };
  const col = cols.find((c) => c.k === st.key) || cols[0];
  const val = (r) => (col.sort ? col.sort(r) : r[col.k]);
  const sorted = rows.slice().sort((a, b) => { const x = val(a), y = val(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * st.dir; });
  const head = cols.map((c) => `<th class="${c.cls || ''}${st.key === c.k ? ' on' : ''}${opts.hl === c.k ? ' hl' : ''}" data-sort="${c.k}" title="sort by ${esc(c.label)}">${c.label}${st.key === c.k ? (st.dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('');
  const body = sorted.length ? sorted.map((r) => `<tr${opts.row ? opts.row(r) : ''}>${cols.map((c) => `<td class="${c.cls || ''}${opts.hl === c.k ? ' hl' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('') : `<tr><td class="l" colspan="${cols.length}">${opts.empty || 'nothing in this range'}</td></tr>`;
  const total = opts.total && sorted.length ? `<tr class="total">${cols.map((c, i) => `<td class="${c.cls || ''}">${i === 0 ? esc(opts.total.label) : c.f(opts.total.row)}</td>`).join('')}</tr>` : '';
  return `<div class="grid-wrap${opts.tall ? ' tall' : ''}${opts.fixed ? ' fixed' : ''}" data-table="${id}"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}${total}</tbody></table></div>`;
}
function sumRows(rows) { const t = {}; for (const r of rows) for (const k of Object.keys(r)) if (typeof r[k] === 'number') t[k] = (t[k] || 0) + r[k]; return t; }
const verbCountsBest = () => {   // this month's counts; a fresh month falls back to the last one that has any, and failing that to the verbs on screen right now
  let all = {}; try { all = JSON.parse(localStorage.getItem('kcoder.verbCounts') || '{}'); } catch {}
  const months = Object.keys(all).filter((k) => all[k] && Object.keys(all[k]).length).sort();
  const mo = new Date().toISOString().slice(0, 7); if (all[mo] && Object.keys(all[mo]).length) return all[mo];
  if (months.length) return all[months[months.length - 1]];
  const live = {}; for (const v of state.verbs.values()) if (v && v.verb) live[v.verb] = (live[v.verb] || 0) + 1; return live;
};

async function renderStatsView(force) {
  if (state.view !== 'stats') return;
  const box = $('#stats-body');
  const RG = state.statsRange || null;
  const sameRange = (a, b) => (!a && !b) || (a && b && a.start === b.start && a.end === b.end);
  if (force || !statsData || statsData.days !== state.statsDays || (statsData.date || null) !== (state.statsDate || null) || !sameRange(statsData.range, RG)) {
    if (!statsData) box.innerHTML = '<div class="empty"><p>loading stats…</p></div>';
    try { statsData = await request('stats_full', { days: state.statsDays, date: state.statsDate || null, start: RG && RG.start, end: RG && RG.end }); } catch (e) { box.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; return; }
    if (state.view !== 'stats') return;
  }
  if (!statsData.quota || force) { try { statsData.quota = (await request('quota')).quota; } catch { statsData.quota = { source: 'none' }; } }
  if (!statsData.wrapped || force) { try { statsData.wrapped = await request('wrapped', { action: 'list' }); } catch { statsData.wrapped = { cards: [], keys: {} }; } }
  const d = statsData; const S = d.summary; const m = state.statsMetric;
  // the period every number on the page is for: a day, today, the last N days, or all time
  const P = d.range ? `${fmtDate(d.range.start)} – ${fmtDate(d.range.end)}` : d.date ? fmtDate(d.date) : d.days === 1 ? 'today' : d.days === 0 ? 'all time' : `${d.days} days`;
  const PW = S.window || S.today, isDay = !!d.date || d.days === 1;
  const Ps = d.range ? `${d.days}d range` : d.date ? fmtDate(d.date) : d.days === 1 ? 'today' : d.days === 0 ? 'all time' : `${d.days}d`;   // short, for card titles
  const prior = d.date ? 'the day before' : `prior ${d.days} days`;
  // when history is shorter than the 30-day window the averages divide by the days that have data; one muted note per card says so
  const dataNote = S.history_days && S.history_days < 30 ? `<div class="note-dim" title="kcoder has ${S.history_days} day${S.history_days === 1 ? '' : 's'} of history: the 30-day average divides by ${S.avg30_days}${S.history_days < 7 ? ', the 7-day average by ' + S.avg7_days : ''}">(${S.history_days} day${S.history_days === 1 ? '' : 's'} of data)</div>` : '';
  const delta = (cur, prev, dirBy) => {   // "↑ 38% vs prior 7 days", coloured by direction (dirBy overrides the sign that decides the colour)
    if (!S.prev || d.days === 0) return '';
    if (!S.prev_has_data) return `<div class="delta flat" title="no history for the ${prior}">no ${prior} to compare</div>`;
    const diff = (cur || 0) - (prev || 0); const sign = dirBy == null ? diff : dirBy;
    const pct = prev ? Math.abs(diff) / Math.abs(prev) : null;
    const txt = pct == null ? (cur ? 'new' : 'no change') : pct < 0.005 ? 'no change' : (diff > 0 ? '↑ ' : '↓ ') + (pct >= 10 ? Math.round(pct) + '×' : Math.round(pct * 100) + '%');
    return `<div class="delta ${diff === 0 || pct != null && pct < 0.005 ? 'flat' : sign >= 0 ? 'up' : 'down'}" title="${esc(txt)} vs ${prior}">${txt} <span class="dim">vs ${prior}</span></div>`;
  };
  const mk = ['tokens', 'lines', 'commits', 'sessions', 'active', 'api'].includes(m) ? m : 'tokens';   // the card that drives the chart below
  const metricCard = (key, title, pick, fmt, opts = {}) => `<div class="card metric${mk === key ? ' hl' : ''}" data-metric="${key}" title="click to chart this below">
    <h3><span class="t">${title} · ${Ps}</span>${opts.info ? ` <span class="info" title="${esc(opts.info)}">i</span>` : ''}${mk === key ? '<span class="badge">charted</span>' : ''}</h3>
    <div class="big">${fmt(pick(PW))}</div>${delta(opts.num ? opts.num(pick(PW)) : pick(PW), opts.num ? opts.num(pick(S.prev || {})) : pick(S.prev || {}), opts.dir ? opts.dir(PW, S.prev || {}) : null)}
    ${d.days === 1 ? '' : `<div class="row"><span>today</span><b>${fmt(pick(S.today))}</b></div>`}
    <div class="row"><span>7-day avg</span><b>${fmt(pick(S.avg7))}</b></div>
    <div class="row"><span>30-day avg</span><b>${fmt(pick(S.avg30))}</b></div>
    ${d.days === 0 ? '' : `<div class="row"><span title="${S.first_date ? 'since ' + esc(fmtDate(S.first_date)) : ''}">all time</span><b>${fmt(pick(S.all))}</b></div>`}
    ${opts.foot || ''}${dataNote}</div>`;
  const linesFmt = (r) => `<span class="ok">+${fmtCompact(r.insertions)}</span> <span class="warn">−${fmtCompact(r.deletions)}</span> <span class="dim">net ${fmtSigned(r.net)}</span>`;
  const summary = [
    metricCard('tokens', 'tokens', (r) => r.total, fmtTokens),
    metricCard('lines', 'lines of code', (r) => r, linesFmt, { num: (r) => (r.insertions || 0) + (r.deletions || 0), dir: (a, b) => (a.net || 0) - (b.net || 0),
      foot: `<div class="row"><span>files changed · all time</span><b>${fmtCompact(PW.files)} · ${fmtCompact(S.all.files)}</b></div>` }).replace('<div class="card metric', '<div class="card metric wide'),
    metricCard('commits', 'commits', (r) => r.commits, fmtCompact),
    metricCard('sessions', 'sessions', (r) => r.sessions, fmtCompact),
    metricCard('active', 'agent time', (r) => r.active_seconds, fmtDur),
    metricCard('api', 'API equiv.', (r) => r.api_equivalent, fmtUsd, { info: 'an estimate of what this usage would cost at API rates; usage on your Claude plan is not billed' }),
  ].join('');
  // daily tokens chart
  const ser = d.series; const W = 900, H = 150, pad = 4; const slot = (W - pad * 2) / Math.max(1, ser.length); const bw = Math.max(2, slot - 2);
  const label = (i, r) => ((ser.length <= 31 || i % 7 === 0) && (i === 0 || i === ser.length - 1 || i % Math.ceil(ser.length / 10) === 0) ? `<text x="${pad + i * slot}" y="${H - 4}">${fmtDate(r.date)}</text>` : '');
  const mx = Math.max(1, ...ser.map((r) => r.total));
  const tokBars = ser.map((r, i) => { const x = pad + i * slot; const hi = Math.round(r.input / mx * (H - 20)); const ho = Math.round(r.output / mx * (H - 20)); return `<g><title>${r.date}: ${fmtInt(r.total)} tokens (${fmtInt(r.input)} in, ${fmtInt(r.output)} out)${r.commits ? ' · ' + r.commits + ' commits' : ''}</title><rect class="in" x="${x}" y="${H - 16 - hi}" width="${bw}" height="${hi}"></rect><rect class="out" x="${x}" y="${H - 16 - hi - ho}" width="${bw}" height="${ho}"></rect>${label(i, r)}</g>`; }).join('');
  const tokChart = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${tokBars}</svg><div class="legend"><span><i class="in"></i> tokens in</span><span><i class="out"></i> tokens out</span><span class="dim">peak ${fmtTokens(mx)} / day</span></div>`;
  // daily lines chart: added above the zero line, removed below
  const ml = Math.max(1, ...ser.map((r) => Math.max(r.insertions, r.deletions))); const zero = Math.round((H - 16) * 0.6);
  const lineBars = ser.map((r, i) => { const x = pad + i * slot; const ha = Math.round(r.insertions / ml * (zero - 4)); const hr = Math.round(r.deletions / ml * (H - 20 - zero)); return `<g><title>${r.date}: +${fmtInt(r.insertions)} / -${fmtInt(r.deletions)} (net ${fmtSigned(r.net)}) · ${r.commits} commit${r.commits === 1 ? '' : 's'} · ${fmtInt(r.files)} files</title><rect class="add" x="${x}" y="${zero - ha}" width="${bw}" height="${ha}"></rect><rect class="del" x="${x}" y="${zero}" width="${bw}" height="${hr}"></rect>${label(i, r)}</g>`; }).join('');
  const linesChart = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line class="zero" x1="0" x2="${W}" y1="${zero}" y2="${zero}"></line>${lineBars}</svg><div class="legend"><span><i class="add"></i> lines added</span><span><i class="del"></i> lines removed</span><span class="dim">peak ${fmtInt(ml)} / day</span></div>`;
  // a plain daily chart for the other charted metrics (commits, sessions, agent time, API equivalent)
  const plainChart = (k, f) => { const mp = Math.max(1e-9, ...ser.map((r) => r[k] || 0)); const bars = ser.map((r, i) => { const x = pad + i * slot; const h = Math.round((r[k] || 0) / mp * (H - 20)); return `<g><title>${r.date}: ${f(r[k] || 0)}</title><rect class="in" x="${x}" y="${H - 16 - h}" width="${bw}" height="${h}"></rect>${label(i, r)}</g>`; }).join(''); return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg><div class="legend"><span class="dim">peak ${f(mp)} / day</span></div>`; };
  const CHARTS = { tokens: ['daily tokens', tokChart], lines: ['daily lines of code', linesChart], commits: ['daily commits', plainChart('commits', fmtCompact)], sessions: ['daily sessions', plainChart('sessions', fmtCompact)], active: ['daily agent time', plainChart('active_seconds', fmtDur)], api: ['daily API equivalent', plainChart('api_equivalent', fmtUsd)] };
  const charted = CHARTS[m] ? m : 'tokens'; const other = charted === 'lines' ? 'tokens' : 'lines';
  // breakdown tables
  // what the row's usage would cost at API rates; "est." whenever some of it ran on the plan (so was not billed)
  const costCol = { k: 'api_equivalent', label: 'API equiv.', f: (r) => (r.api_equivalent > (r.cost || 0) + 0.005 ? `<span class="dim" title="estimate at API rates${r.cost ? '; ' + fmtUsd(r.cost) + ' actually billed on API keys' : '; this usage ran on your plan'}">${fmtUsd(r.api_equivalent)} est.</span>` : fmtUsd(r.cost)) };
  const linesCols = [{ k: 'commits', label: 'commits', f: (r) => fmtInt(r.commits) }, { k: 'insertions', label: '+', f: (r) => plus(r.insertions) }, { k: 'deletions', label: '-', f: (r) => minus(r.deletions) }, { k: 'net', label: 'net', f: (r) => fmtSigned(r.net) }, { k: 'tokens_per_line', label: 'tokens / line', f: (r) => (r.tokens_per_line == null ? '<span class="dim">-</span>' : fmtTokens(r.tokens_per_line)) }];
  const byModel = sortableTable('model', [{ k: 'key', label: 'model', f: (r) => esc(r.key), cls: 'l' }, { k: 'total', label: 'tokens', f: (r) => `<b>${fmtTokens(r.total)}</b>` }, { k: 'fresh', label: 'fresh in', f: (r) => fmtTokens(r.fresh) }, { k: 'cache_read', label: 'cache read', f: (r) => fmtTokens(r.cache_read) }, { k: 'cache_write', label: 'cache write', f: (r) => fmtTokens(r.cache_write) }, { k: 'cache_hit', label: 'hit', f: (r) => fmtPct(r.cache_hit) }, { k: 'output', label: 'out', f: (r) => fmtTokens(r.output) }, { k: 'calls', label: 'calls', f: (r) => fmtInt(r.calls) }, ...linesCols, costCol], d.by_model, { sort: { key: 'total', dir: -1 } });
  const byProvider = sortableTable('provider', [{ k: 'key', label: 'provider', f: (r) => esc(r.key), cls: 'l' }, { k: 'billing', label: 'billing', f: (r) => esc(r.billing || (r.plan ? 'subscription' : 'api key')), cls: 'l' }, { k: 'total', label: 'tokens', f: (r) => `<b>${fmtTokens(r.total)}</b>` }, { k: 'cache_hit', label: 'cache hit', f: (r) => fmtPct(r.cache_hit) }, { k: 'calls', label: 'calls', f: (r) => fmtInt(r.calls) }, { k: 'sessions', label: 'sessions', f: (r) => fmtInt(r.sessions) }, { k: 'cost', label: 'cost', f: (r) => (r.plan ? '<span class="dim">plan</span>' : fmtUsd(r.cost)) }, costCol], d.by_provider, { sort: { key: 'total', dir: -1 } });
  const byProject = sortableTable('project', [{ k: 'key', label: 'repo / project', f: (r) => esc(r.key), cls: 'l' }, { k: 'total', label: 'tokens', f: (r) => `<b>${fmtTokens(r.total)}</b>` }, { k: 'sessions', label: 'sessions', f: (r) => fmtInt(r.sessions) }, ...linesCols, { k: 'files', label: 'files', f: (r) => fmtInt(r.files) }, costCol], d.by_project, { sort: { key: 'total', dir: -1 } });
  const top = sortableTable('top', [{ k: 'name', label: 'session', f: (r) => `<span class="ell" title="${esc((r.name || r.key) + (r.title ? ' · ' + r.title : ''))}">${esc(r.name || r.key)}${r.title && r.title !== r.name ? ' <span class="dim">· ' + esc(r.title) + '</span>' : ''}</span>${r.archived ? ' <span class="badge archived">archived</span>' : ''}`, cls: 'l name', sort: (r) => r.name || r.key }, { k: 'model', label: 'model', f: (r) => esc(r.model || ''), cls: 'l' }, { k: 'total', label: 'tokens', f: (r) => `<b>${fmtTokens(r.total)}</b>` }, { k: 'turns', label: 'turns', f: (r) => fmtInt(r.turns) }, { k: 'active_seconds', label: 'active', f: (r) => fmtDur(r.active_seconds) }, { k: 'commits', label: 'commits', f: (r) => fmtInt(r.commits) }, { k: 'net', label: 'lines', f: (r) => (r.commits ? `${plus(r.insertions)} ${minus(r.deletions)}` : '<span class="dim">-</span>') }, costCol], d.top_sessions, { sort: { key: 'total', dir: -1 }, fixed: true, row: (r) => ` class="click" data-open="${esc(r.key)}" title="open in the focused pane"`, empty: 'no usage in this range' });
  // cache split
  const c = d.cache; const ci = Math.max(1, c.input);
  const cacheCard = `<div class="card"><h3>input tokens · ${P}</h3><div class="tokbar"><i class="fresh" style="width:${c.fresh / ci * 100}%" title="fresh input"></i><i class="cread" style="width:${c.cache_read / ci * 100}%" title="cache reads"></i><i class="cwrite" style="width:${c.cache_write / ci * 100}%" title="cache writes"></i></div>
    <div class="row"><span><i class="sw fresh"></i> fresh input</span><b>${fmtTokens(c.fresh)}</b></div><div class="row"><span><i class="sw cread"></i> cache reads</span><b>${fmtTokens(c.cache_read)}</b></div><div class="row"><span><i class="sw cwrite"></i> cache writes</span><b>${fmtTokens(c.cache_write)}</b></div>
    <div class="row"><span>cache hit rate</span><b>${fmtPct(c.hit_rate)}</b></div><div class="row"><span>API equivalent <span class="dim">(estimate)</span></span><b>${fmtUsd(c.api_equivalent)}</b></div>${c.cost ? `<div class="row"><span>actually billed (API keys)</span><b>${fmtUsd(c.cost)}</b></div>` : ''}</div>`;
  // activity calendar
  const cal = d.calendar; const key = state.statsCal === 'lines' ? 'lines' : 'tokens';
  const vals = cal.map((r) => r[key]).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] || 0;
  const level = (v) => (!v ? 0 : v <= q(0.25) ? 1 : v <= q(0.5) ? 2 : v <= q(0.75) ? 3 : 4);
  const first = new Date(cal[0].date + 'T00:00:00'); const offset = (first.getDay() + 6) % 7;
  const cells = cal.map((r, i) => { const n = i + offset; const x = Math.floor(n / 7) * 13, y = (n % 7) * 13; return `<rect class="c l${level(r[key])}" data-day="${r.date}" x="${x}" y="${y}" width="11" height="11" rx="2"><title>${fmtDate(r.date)}: ${key === 'tokens' ? fmtInt(r.tokens) + ' tokens' : fmtInt(r.lines) + ' lines'} · ${r.commits} commit${r.commits === 1 ? '' : 's'}</title></rect>`; }).join('');
  const months = []; let lastM = -1; cal.forEach((r, i) => { const dt = new Date(r.date + 'T00:00:00'); if (dt.getMonth() !== lastM) { lastM = dt.getMonth(); if (i > 6) months.push(`<text x="${Math.floor((i + offset) / 7) * 13}" y="-3">${dt.toLocaleDateString(undefined, { month: 'short' })}</text>`); } });
  const weeks = Math.ceil((cal.length + offset) / 7);
  const calendar = `<div class="card"><h3>activity · last year <span class="seg sm" id="cal-toggle"><button data-cal="tokens" class="${key === 'tokens' ? 'active' : ''}">tokens</button><button data-cal="lines" class="${key === 'lines' ? 'active' : ''}">lines</button></span><span class="spacer"></span><span class="dim">current streak <b>${d.streaks.current}</b> day${d.streaks.current === 1 ? '' : 's'} · longest <b>${d.streaks.longest}</b> · active days <b>${d.streaks.active_days}</b></span></h3>
    <div class="cal-wrap"><svg class="cal" viewBox="-2 -14 ${weeks * 13 + 2} ${7 * 13 + 14}" width="${weeks * 13 + 2}" height="${7 * 13 + 14}">${months.join('')}${cells}</svg></div></div>`;
  // hour of day / day of week
  const hm = Math.max(1, ...d.hours.flat()); const dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hours = `<div class="card"><h3>when sessions run · ${P} <span class="dim">(active agent time by local hour)</span></h3><div class="hours"><div class="hrow head"><span></span>${Array.from({ length: 24 }, (_, h) => `<span>${h % 3 === 0 ? h : ''}</span>`).join('')}</div>${d.hours.map((row, i) => `<div class="hrow"><span>${dows[i]}</span>${row.map((v, h) => `<i style="opacity:${v ? 0.15 + 0.85 * v / hm : 0}" title="${dows[i]} ${h}:00 · ${fmtDur(v)}"></i>`).join('')}</div>`).join('')}</div></div>`;
  // parallelism, waiting, health, records, verbs
  const PA = d.parallel, Wt = d.waiting, Hh = d.health, R = d.records;
  const small = (title, rows) => `<div class="card"><h3>${title}</h3>${rows.map(([k, v, hint]) => `<div class="row"${hint ? ` title="${esc(hint)}"` : ''}><span>${k}</span><b>${v}</b></div>`).join('')}</div>`;
  const parallel = small(`parallelism · ${P}`, [['agent-hours', `${PA.agent_hours}h`, 'sum of every session\'s active time'], ['peak concurrent sessions', fmtInt(PA.max_peak)], ['avg daily peak', PA.avg_peak], ['avg concurrency while busy', PA.avg_concurrency, 'active session-seconds divided by wall-clock seconds with at least one session running']]);
  const waiting = small(`time waiting on you · ${P}`, [['total', fmtDur(Wt.total_seconds)], ['median wait', fmtDur(Wt.median_seconds)], ['times a session waited', fmtInt(Wt.count), 'approvals and questions; waits over a day are not counted']]);
  const health = small(`session health · ${P}`, [['interrupts (esc)', fmtInt(Hh.interrupts)], ['undos', fmtInt(Hh.undos)], ['compactions', fmtInt(Hh.compactions)], ['sessions ended with no commit', `${fmtInt(Hh.sessions_no_commit)} <span class="dim">of ${fmtInt(Hh.sessions_with_turns)}</span>`]]);
  const rec = (label, v) => `<div class="row stack"><span>${label}</span><b>${v || '<span class="dim">-</span>'}</b></div>`;
  const records = `<div class="card"><h3>records · ${P}</h3>` +
    rec('biggest commit', R.biggest_commit && `${R.biggest_commit.url ? `<a href="${esc(R.biggest_commit.url)}" target="_blank" rel="noopener">${R.biggest_commit.sha.slice(0, 7)} ↗</a>` : R.biggest_commit.sha.slice(0, 7)} · ${fmtInt(R.biggest_commit.lines)} lines <span class="dim">· ${esc(R.biggest_commit.project || '')} · ${fmtDate(R.biggest_commit.date)}</span>`) +
    rec('longest turn', R.longest_turn && `${fmtDur(R.longest_turn.seconds)} <span class="dim">· <a href="#" data-open-session="${esc(R.longest_turn.sid)}">${esc(R.longest_turn.name || R.longest_turn.sid)}</a> · ${fmtDate(R.longest_turn.date)}</span>`) +
    rec('most tokens in a day', R.most_tokens_day && `${fmtTokens(R.most_tokens_day.tokens)} <span class="dim">· ${fmtDate(R.most_tokens_day.date)}</span>`) +
    rec('most lines in a day', R.most_lines_day && `${fmtInt(R.most_lines_day.lines)} <span class="dim">· ${fmtDate(R.most_lines_day.date)}</span>`) + '</div>';
  // just for fun: the verbs this browser showed while sessions worked (this month, else the last month that has any, else
  // the ones on screen right now), the Wrapped-style equivalent for the period, the secret badges and the arcade
  const vc = Object.entries(verbCountsBest()).sort((a, b) => b[1] - a[1]);
  const lh = vc.filter(([v]) => LONG_HAUL_VERBS.includes(v)), topV = vc.filter(([v]) => !LONG_HAUL_VERBS.includes(v)).slice(0, 6);
  const secret = ((d.achievements || {}).badges || []).filter((b) => b.hidden && b.earned);
  const latestWrapped = ((d.wrapped || {}).cards || [])[0];
  const chips = (list, cls = '') => `<div class="verbs">${list.map(([v, n]) => `<span class="${cls}">${esc(v)}<b>${fmtInt(n)}</b></span>`).join('')}</div>`;
  const mg = mineLoad(); const arc = mg.arcade || {};
  const gameRow = (id, label, text) => rec(label, `${text} <span class="dim">· <button class="link" data-go-game="${id}">play</button></span>`);
  const fun = `<div class="card fun"><h3>just for fun</h3>
    <div class="fun-verbs"><div class="lbl">most-shown verbs this month <span class="dim">· counted in this browser</span></div>${topV.length ? chips(topV) : '<div class="dim">none counted yet: they show in the status line while a session works</div>'}</div>
    ${lh.length ? `<div class="fun-verbs"><div class="lbl">long hauls <span class="dim">· verbs past ten minutes</span></div>${chips(lh, 'lh')}</div>` : ''}
    ${rec(`${P} is`, S.fun ? esc(S.fun) : null)}
    ${rec('secret badges', secret.length ? secret.map((b) => `<span title="${esc(b.desc)}">${esc(b.name)}</span>`).join(' · ') : '<span class="dim">none found yet</span>')}
    ${rec('token mine', `${fmtFull(mg.bank)} tokens banked · ${fmtMine(Math.round(mineRate(mg) * 10) / 10)}/s${mg.starsEver ? ` · ${fmtInt(mg.stars)} star${mg.stars === 1 ? '' : 's'}${mg.spent ? ` (${fmtInt(mg.starsEver)} earned)` : ''}` : ''}${mg.shares ? ` · ${fmtInt(mg.shares)} share${mg.shares === 1 ? '' : 's'} at ${fmtPx(mg.px)}` : ''}${mineRankLine(mg) ? ` · rank: ${esc(mineRankLine(mg))}` : ''} <span class="dim">· <button class="link" data-go-fun>open the fun tab</button></span>`)}
    ${(arc.t2048 || {}).played ? gameRow('2048', '2048', `best ${fmtInt(arc.t2048.best)} · best tile ${fmtInt(arc.t2048.bestTile)} · ${fmtInt(arc.t2048.played)} game${arc.t2048.played === 1 ? '' : 's'} · ${fmtInt(arc.t2048.wins)} win${arc.t2048.wins === 1 ? '' : 's'}${arc.t2048.stars ? ` · ${fmtInt(arc.t2048.stars)} stars to the mine` : ''}`) : ''}
    ${(arc.mahjong || {}).played ? gameRow('mahjong', 'mahjong', `${fmtInt(arc.mahjong.played)} deal${arc.mahjong.played === 1 ? '' : 's'} · ${fmtInt(arc.mahjong.wins)} win${arc.mahjong.wins === 1 ? '' : 's'}${Object.keys(arc.mahjong.bestTime || {}).length ? ` · best ${fmtDur(Math.min(...Object.values(arc.mahjong.bestTime)))}` : ''}${arc.mahjong.stars ? ` · ${fmtInt(arc.mahjong.stars)} stars to the mine` : ''}`) : ''}
    <div class="row"><span>${latestWrapped ? `<button class="link" data-wrapped="${esc(latestWrapped.key)}">latest Wrapped: ${esc(wrappedPeriodLabel(latestWrapped))}</button>` : '<span class="dim">no Wrapped card yet</span>'}</span></div></div>`;
  // achievements: next up (three closest locked badges) above the badge wall; hidden badges show only once earned
  const A = d.achievements || { badges: [], next_up: [], records: {} };
  const fmtBadge = (b, v) => ({ tokens: fmtTokens, int: fmtCompact, usd: fmtUsd, dur: fmtDur, days: (x) => `${Math.round(x)} day${Math.round(x) === 1 ? '' : 's'}`, pct: fmtPct, ratio: (x) => `${Math.round(x * 100)}%`, flag: (x) => (x ? 'done' : 'not yet') }[b.fmt] || fmtCompact)(v);
  const byId = Object.fromEntries(A.badges.map((b) => [b.id, b]));
  const bar = (b) => `<div class="abar"><i style="width:${Math.round(b.progress * 100)}%"></i></div>`;
  const nextUp = A.next_up.map((id) => byId[id]).filter(Boolean).map((b) => `<div class="next"><div class="nh"><b>${esc(b.name)}</b><span class="dim" title="${esc(b.desc)}">${esc(b.desc)}</span></div>${bar(b)}<div class="nv"><span>${fmtBadge(b, b.value)} of ${fmtBadge(b, b.threshold)}</span><span class="dim">${Math.round(b.progress * 100)}%</span></div></div>`).join('');
  const GROUPS = [['tokens', 'tokens'], ['commits', 'commits'], ['lines', 'lines'], ['api', 'API equivalent'], ['time', 'agent time'], ['sessions', 'sessions'], ['streaks', 'streaks'], ['habits', 'habits'], ['hidden', 'secret']];
  const badge = (b) => `<div class="badge-t ${b.earned ? 'on' : 'off'}" title="${esc(b.desc)}${b.earned ? ' · earned ' + esc(fmtDate(b.earned)) : ' · ' + fmtBadge(b, b.value) + ' of ' + fmtBadge(b, b.threshold)}"><span class="ic">${b.earned ? '★' : '☆'}</span><span class="nm">${esc(b.name)}</span>${b.earned ? `<span class="dt">${esc(fmtDate(b.earned))}</span>` : `<span class="dt">${Math.round(b.progress * 100)}%</span>`}</div>`;
  const wall = GROUPS.map(([g, label]) => { const bs = A.badges.filter((b) => b.group === g && (!b.hidden || b.earned)); return bs.length ? `<div class="agroup"><div class="gl">${label}${g === 'hidden' ? ' <span class="dim">(these only show once earned)</span>' : ''}</div><div class="badges">${bs.map(badge).join('')}</div></div>` : ''; }).join('');
  const pr = (A.records || {}).powder_day;
  const recordLine = pr ? `<div class="row"><span>Powder Day record <span class="dim">(re-earned every time it is beaten)</span></span><b>${fmtTokens(pr.tokens)} on ${fmtDate(pr.date)}${pr.times_beaten ? ` · beaten ${pr.times_beaten}×` : ''}</b></div>` : `<div class="row"><span class="dim">Powder Day record: the first 100M-token day starts it; every bigger day earns it again</span></div>`;
  const achievementsCard = `<div class="card achievements"><h3>achievements <span class="dim">· ${A.earned} of ${A.total} earned</span><span class="spacer"></span><span class="dim" title="the 'paid for itself' badges compare API-equivalent usage with the plan price (Settings)">plan ${fmtUsd(A.plan_price || 0)}/month</span></h3>
    ${nextUp ? `<div class="label-h">next up</div><div class="nextup">${nextUp}</div>` : ''}${recordLine}${wall}</div>`;
  // tools
  const toolRows = Object.values(d.tools.reduce((acc, r) => { const n = TOOL_NAMES[r.name] || r.name; const a = acc[n] || (acc[n] = { name: n, category: toolCategory(r.name), count: 0, errors: 0 }); a.count += r.count; a.errors += r.errors; return acc; }, {})).map((r) => ({ ...r, error_rate: r.count ? r.errors / r.count : 0 }));
  const toolsT = sortableTable('tools', [{ k: 'name', label: 'tool', f: (r) => esc(r.name), cls: 'l' }, { k: 'category', label: 'kind', f: (r) => esc(r.category), cls: 'l' }, { k: 'count', label: 'calls', f: (r) => fmtInt(r.count) }, { k: 'errors', label: 'failed', f: (r) => (r.errors ? `<span class="warn">${fmtInt(r.errors)}</span>` : '0') }, { k: 'error_rate', label: 'failure rate', f: (r) => fmtPct(r.error_rate) }], toolRows, { sort: { key: 'count', dir: -1 }, empty: 'no tool calls in this range', total: toolRows.length ? { label: 'total', row: { ...sumRows(toolRows), error_rate: sumRows(toolRows).count ? sumRows(toolRows).errors / sumRows(toolRows).count : 0 } } : null });
  // commits
  const ct = d.commit_totals;
  const commitsT = sortableTable('commits', [
    { k: 'ts', label: 'when', f: (c) => `<span title="${new Date(c.ts * 1000).toLocaleString()}">${fmtDate(c.date)} ${new Date(c.ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>`, cls: 'l' },
    { k: 'sha', label: 'commit', f: (c) => (c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener" title="open on GitHub">${c.sha.slice(0, 7)} ↗</a>` : `<code>${c.sha.slice(0, 7)}</code>`), cls: 'l' },
    { k: 'subject', label: 'subject', f: (c) => `<span class="subject" title="click to expand">${esc(c.subject)}</span>`, cls: 'l subj' },
    { k: 'project', label: 'repo', f: (c) => `${esc(c.project || '')}${c.branch ? ' <span class="dim">@ ' + esc(c.branch) + '</span>' : ''}`, cls: 'l' },
    { k: 'session', label: 'session', f: (c) => esc(c.session || c.sid || ''), cls: 'l' },
    { k: 'insertions', label: '+', f: (c) => plus(c.insertions) }, { k: 'deletions', label: '-', f: (c) => minus(c.deletions) }, { k: 'files', label: 'files', f: (c) => fmtInt(c.files) },
    { k: 'pushed', label: 'state', f: (c) => `<span class="badge ${c.pushed ? 'pushed' : 'local'}">${c.pushed ? 'pushed' : 'local only'}</span>`, cls: 'l', sort: (c) => (c.pushed ? 1 : 0) },
  ], d.commits, { sort: { key: 'ts', dir: -1 }, tall: true, fixed: true, row: (c) => ` data-sha="${esc(c.sha)}"`, empty: 'no commits from sessions in this range' });
  const quotaCard = quotaCardHtml(d.quota, m === 'quota');
  box.innerHTML = `
    <div class="stats-head"><h2>stats</h2>
      <div class="seg" id="stats-range">${[[1, 'today'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'all time']].map(([n, l]) => `<button data-days="${n}" class="${!state.statsDate && !RG && state.statsDays === n ? 'active' : ''}">${l}</button>`).join('')}</div>
      <label class="help day-pick" title="Show one day: pick it here, or click a day in the daily table or the calendar">or a day <input type="date" id="stats-day" max="${d.today}" value="${esc(state.statsDate || '')}"></label>
      <label class="help day-pick" title="Any range, for example a Wrapped week or month">or from <input type="date" id="stats-from" max="${d.today}" value="${esc(RG ? RG.start : '')}"> to <input type="date" id="stats-to" max="${d.today}" value="${esc(RG ? RG.end : '')}"></label>
      ${state.statsDate ? `<span class="chip day-chip">${fmtDate(state.statsDate)} <button data-clear-day="1" title="back to a period">✕</button></span>` : ''}
      ${RG ? `<span class="chip day-chip">${fmtDate(RG.start)} – ${fmtDate(RG.end)} <button data-clear-day="1" title="back to a period">✕</button></span>` : ''}
      <span class="help">today is ${fmtDate(d.today)} · days roll over at local midnight</span>
      <span class="spacer"></span>
      <button id="stats-csv" title="save the daily table for this range as CSV">⤓ export CSV</button><button id="stats-refresh" title="refresh">↻</button>
    </div>
    ${quotaCard}
    <div class="summary six">${summary}</div>
    ${(d.window || {}).n === 1 ? '' : `<div class="two"><div class="card hl"><h3>${CHARTS[charted][0]} · ${P} <span class="badge">charted</span></h3>${CHARTS[charted][1]}</div><div class="card"><h3>${CHARTS[other][0]} · ${P}</h3>${CHARTS[other][1]}</div></div>`}
    <div class="card"><h3>daily</h3><div id="stats-daily"></div></div>
    <div class="card"><h3>by model · ${P} <span class="dim">(aliases and full ids merged)</span></h3>${byModel}</div>
    <div class="two"><div class="card"><h3>by provider · ${P}</h3>${byProvider}</div>${cacheCard}</div>
    <div class="card"><h3>by repo / project · ${P}</h3>${byProject}</div>
    <div class="card${m === 'sessions' ? ' hl' : ''}"><h3>top sessions by tokens · ${P}</h3>${top}</div>
    ${calendar}
    ${hours}
    <div class="summary four">${parallel}${waiting}${health}${fun}</div>
    ${achievementsCard}
    ${wrappedCardHtml(d.wrapped)}
    <div class="two"><div class="card"><h3>tool usage · ${P}</h3>${toolsT}</div>${records}</div>
    <div class="card${m === 'commits' ? ' hl' : ''}"><h3>commits from kcoder sessions · ${P} · ${fmtInt(ct.total)} total · <span class="ok">${fmtInt(ct.pushed)} pushed</span> · <span class="${ct.unpushed ? 'warn' : ''}">${fmtInt(ct.unpushed)} local only</span></h3>${commitsT}</div>`;
  renderDailyTable();
  $('#stats-range').addEventListener('click', (e) => { const b = e.target.closest('[data-days]'); if (!b) return; state.statsDays = Number(b.dataset.days); state.statsDate = null; state.statsRange = null; localStorage.setItem('kcoder.statsDays', state.statsDays); renderStatsView(true); });
  $('#stats-day').addEventListener('change', (e) => { state.statsDate = e.target.value || null; state.statsRange = null; renderStatsView(true); });
  const rangeChange = () => { const a = $('#stats-from').value, b = $('#stats-to').value; if (a && b) { state.statsRange = { start: a <= b ? a : b, end: a <= b ? b : a }; state.statsDate = null; renderStatsView(true); } };
  $('#stats-from').addEventListener('change', rangeChange); $('#stats-to').addEventListener('change', rangeChange);
  $('#stats-csv').addEventListener('click', exportStatsCsv);
  $('#stats-refresh').addEventListener('click', () => renderStatsView(true));
  box.onclick = (e) => {
    const th = e.target.closest('th[data-sort]'); const tb = th && th.closest('[data-table]');
    if (th && tb) { const id = tb.dataset.table, k = th.dataset.sort; const cur = state.statsSorts[id]; state.statsSorts[id] = { key: k, dir: cur && cur.key === k ? -cur.dir : -1 }; localStorage.setItem('kcoder.statsSorts', JSON.stringify(state.statsSorts)); renderStatsView(false); return; }
    const cb = e.target.closest('[data-cal]'); if (cb) { state.statsCal = cb.dataset.cal; localStorage.setItem('kcoder.statsCal', state.statsCal); renderStatsView(false); return; }
    const mc = e.target.closest('.card.metric[data-metric]'); if (mc) { state.statsMetric = mc.dataset.metric; renderStatsView(false); return; }
    if (e.target.closest('[data-clear-day]')) { state.statsDate = null; state.statsRange = null; renderStatsView(true); return; }
    const wb = e.target.closest('[data-wrapped]'); if (wb) { wrappedDialog(wb.dataset.wrapped); return; }
    if (e.target.closest('[data-go-fun]')) { funSelect('mine'); return; }
    const gg = e.target.closest('[data-go-game]'); if (gg) { funSelect(gg.dataset.goGame); return; }
    if (e.target.closest('[data-x="settings"]')) { settingsDialog(); return; }
    const dd = e.target.closest('[data-day]'); if (dd && !e.target.closest('th')) { state.statsDate = dd.dataset.day; state.statsRange = null; renderStatsView(true); return; }
    const os = e.target.closest('[data-open-session]'); if (os) { e.preventDefault(); assignPane(state.layout.focus, os.dataset.openSession); setView('chat'); return; }
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-open]'); if (tr) { assignPane(state.layout.focus, tr.dataset.open); setView('chat'); return; }
    const cr = e.target.closest('tr[data-sha]'); if (cr) cr.classList.toggle('open');
  };
}
// ---- kcoder Wrapped: the archive on the stats page, the card itself in a dialog, PNG through the save dialog ----
function wrappedPeriodLabel(c) { const k = c.key || ''; return c.kind === 'week' || /W/.test(k) ? `week ${k.split('W')[1]} · ${fmtDate(c.start)} – ${fmtDate(c.end)}` : `${new Date(c.start + 'T00:00:00').toLocaleDateString([], { month: 'long', year: 'numeric' })}`; }
function wrappedCardHtml(w) {
  const keys = (w && w.keys) || {}; const cards = (w && w.cards) || [];
  const rows = cards.map((c) => `<div class="row wr-row"><button class="link" data-wrapped="${esc(c.key)}">${esc(wrappedPeriodLabel(c))}</button><span class="dim">${c.complete ? '' : 'so far · '}${fmtTokens(c.tokens)} tokens · ${fmtInt(c.commits)} commits · <span class="ok">+${fmtCompact(c.lines_added)}</span> <span class="warn">−${fmtCompact(c.lines_removed)}</span>${c.top_repo ? ' · ' + esc(c.top_repo.name) : ''}</span></div>`).join('');
  return `<div class="card wrapped"><h3>kcoder wrapped <span class="dim">· every Monday for the week, on the 1st for the month</span><span class="spacer"></span>
    <button data-wrapped="${esc(keys.this_week || '')}">this week so far</button><button data-wrapped="${esc(keys.last_week || '')}">last week</button><button data-wrapped="${esc(keys.this_month || '')}">this month so far</button><button data-wrapped="${esc(keys.last_month || '')}">last month</button></h3>
    ${rows || '<div class="row"><span class="dim">no cards yet: open one above; finished weeks and months are kept here</span></div>'}</div>`;
}
function verbForPeriod(start) { try { const all = JSON.parse(localStorage.getItem('kcoder.verbCounts') || '{}'); const m = all[(start || '').slice(0, 7)] || {}; const top = Object.entries(m).sort((a, b) => b[1] - a[1])[0]; return top ? { name: top[0], count: top[1] } : null; } catch { return null; } }
async function wrappedDialog(key, opts = {}) {
  if (!key) return;
  let card; try { card = (await request('wrapped', { action: 'get', key, verb: verbForPeriod(key.includes('W') ? null : key + '-01') || verbForPeriod(null), fresh: !!opts.fresh })).card; } catch (e) { toast(e.message, 'err'); return; }
  if (!card.verb) { const v = verbForPeriod(card.start) || (() => { const t = Object.entries(verbCountsBest()).sort((a, b) => b[1] - a[1])[0]; return t ? { name: t[0], count: t[1] } : null; })(); if (v) card.verb = v; }
  const hours = (sec) => { const m = Math.round((sec || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : fmtDur(sec); };
  const tile = (label, value, sub) => `<div class="wtile"><div class="wl">${label}</div><div class="wv">${value}</div>${sub ? `<div class="ws">${sub}</div>` : ''}</div>`;
  const paid = card.paid_multiple != null ? `${card.paid_multiple}× the plan's share (${fmtUsd(card.plan_share)})` : '';
  const html = `<div class="wrapped-card" id="wrapped-card">
    <pre class="banner compact">${BANNER}</pre>
    <div class="wh"><span class="wt">kcoder wrapped</span><span class="wp">${esc(wrappedPeriodLabel(card))}${card.complete ? '' : ' · so far'}${mineRankLine(mineLoad()) ? ` · ${esc(mineRankLine(mineLoad()))}` : ''}</span></div>
    <div class="wgrid">
      ${tile('tokens', fmtTokens(card.tokens), `${fmtTokens(card.input)} in · ${fmtTokens(card.output)} out`)}
      ${tile('lines', `<span class="ok">+${fmtCompact(card.lines_added)}</span> <span class="warn">−${fmtCompact(card.lines_removed)}</span>`, `net ${fmtSigned(card.net)} · ${fmtInt(card.files)} files`)}
      ${tile('commits', fmtInt(card.commits), `${fmtInt(card.sessions)} sessions · ${hours(card.active_seconds)} agent time`)}
      ${tile('top repo', card.top_repo ? esc(card.top_repo.name) : '-', card.top_repo ? `${fmtTokens(card.top_repo.tokens)} tokens · ${fmtInt(card.top_repo.commits)} commits` : '')}
      ${tile('longest session', card.longest_session ? esc(card.longest_session.name) : '-', card.longest_session ? `${hours(card.longest_session.active_seconds)} · ${fmtTokens(card.longest_session.tokens)} tokens` : '')}
      ${tile('biggest commit', card.biggest_commit ? `${fmtInt(card.biggest_commit.lines)} lines` : '-', card.biggest_commit ? `${esc((card.biggest_commit.subject || '').slice(0, 60))}` : '')}
      ${tile('API equivalent', fmtUsd(card.api_equivalent), paid ? `plan paid for itself ${esc(paid)}` : '')}
      ${tile('badges earned', card.badges.length ? card.badges.map((b) => '★ ' + esc(b.name)).join('<br>') : 'none this time', '')}
      ${tile('most-shown verb', card.verb ? esc(card.verb.name) : '-', card.verb ? `${fmtInt(card.verb.count)} times (counted in this browser)` : 'counted while sessions work')}
    </div>
    <div class="wfun">That is ${esc(card.fun)}.</div>
  </div>`;
  const d = openDialog(`<h2>wrapped<span class="spacer"></span><button data-w="png" title="save as PNG through the save dialog">⤓ save PNG</button><button data-w="refresh" title="recompute">↻</button><button data-w="stats" title="the stats page for exactly this range">check on stats</button><button data-x="close">✕</button></h2><div class="body wrapped-body">${html}</div>`, 'wrapped');
  d.classList.add('wide');
  const done = () => { closeDialog(); if (opts.due) request('wrapped', { action: 'seen', key }).catch(() => {}); };
  d.addEventListener('click', async (e) => {
    if (e.target.closest('[data-x]')) { done(); return; }
    const b = e.target.closest('[data-w]'); if (!b) return;
    if (b.dataset.w === 'png') { await saveWrappedPng(card); return; }
    if (b.dataset.w === 'refresh') { done(); wrappedDialog(key, { ...opts, fresh: true }); return; }
    if (b.dataset.w === 'stats') { done(); state.statsRange = { start: card.start, end: card.end }; state.statsDate = null; statsData = null; setView('stats'); }
  });
}
function maybeWrapped() {
  if (state.dialog) return;
  request('wrapped', { action: 'due' }).then((r) => { const k = (r.due || [])[0]; if (k && !state.dialog) wrappedDialog(k, { due: true }); }).catch(() => {});
}
// the PNG is drawn with the canvas API (no foreignObject: WebKit taints that), styled with the brand tokens
async function saveWrappedPng(card) {
  const W = 1200, H = 1500, S = 2;
  const c = document.createElement('canvas'); c.width = W * S; c.height = H * S; const x = c.getContext('2d'); x.scale(S, S);
  const T = { bg: '#0C0E12', bg2: '#11161C', line: '#2E4559', fg: '#D9E2EC', dim: '#8597AB', accent: '#7FC5FF', green: '#4ADE80', red: '#F87171', yellow: '#FBBF24' };
  const mono = '"SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
  x.fillStyle = T.bg; x.fillRect(0, 0, W, H);
  x.fillStyle = T.accent; x.font = `bold 15px ${mono}`; x.textBaseline = 'top';
  BANNER.split('\n').forEach((l, i) => x.fillText(l, 60, 50 + i * 17));
  x.fillStyle = T.fg; x.font = `bold 34px ${mono}`; x.fillText('kcoder wrapped', 60, 175);
  x.fillStyle = T.dim; x.font = `18px ${mono}`; x.fillText(wrappedPeriodLabel(card) + (card.complete ? '' : ' · so far'), 60, 222);
  const hours = (sec) => { const m = Math.round((sec || 0) / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : fmtDur(sec); };
  const tiles = [
    ['tokens', fmtTokens(card.tokens), `${fmtTokens(card.input)} in · ${fmtTokens(card.output)} out`],
    ['lines', `+${fmtCompact(card.lines_added)}  −${fmtCompact(card.lines_removed)}`, `net ${fmtSigned(card.net)} · ${fmtInt(card.files)} files`, 'lines'],
    ['commits', fmtInt(card.commits), `${fmtInt(card.sessions)} sessions · ${hours(card.active_seconds)} agent time`],
    ['top repo', card.top_repo ? card.top_repo.name : '-', card.top_repo ? `${fmtTokens(card.top_repo.tokens)} tokens · ${fmtInt(card.top_repo.commits)} commits` : ''],
    ['longest session', card.longest_session ? card.longest_session.name : '-', card.longest_session ? `${hours(card.longest_session.active_seconds)} · ${fmtTokens(card.longest_session.tokens)} tokens` : ''],
    ['biggest commit', card.biggest_commit ? `${fmtInt(card.biggest_commit.lines)} lines` : '-', card.biggest_commit ? (card.biggest_commit.subject || '').slice(0, 40) : ''],
    ['API equivalent', fmtUsd(card.api_equivalent), card.paid_multiple != null ? `plan paid for itself ${card.paid_multiple}×` : ''],
    ['badges earned', card.badges.length ? `${card.badges.length}` : 'none', card.badges.slice(0, 3).map((b) => '★ ' + b.name).join('  ')],
    ['most-shown verb', card.verb ? card.verb.name : '-', card.verb ? `${fmtInt(card.verb.count)} times` : ''],
  ];
  const cols = 3, tw = (W - 120 - 20 * (cols - 1)) / cols, th = 150;
  tiles.forEach((t, i) => {
    const cx = 60 + (i % cols) * (tw + 20), cy = 275 + Math.floor(i / cols) * (th + 20);
    x.fillStyle = T.bg2; x.strokeStyle = T.line; x.lineWidth = 1.5; x.beginPath(); x.roundRect(cx, cy, tw, th, 10); x.fill(); x.stroke();
    x.fillStyle = T.dim; x.font = `13px ${mono}`; x.fillText(t[0].toUpperCase(), cx + 18, cy + 16);
    x.fillStyle = t[3] === 'lines' ? T.green : T.fg; x.font = `bold ${String(t[1]).length > 14 ? 24 : 34}px ${mono}`;
    if (t[3] === 'lines') { const parts = String(t[1]).split('  '); x.fillText(parts[0], cx + 18, cy + 44); const w1 = x.measureText(parts[0] + ' ').width; x.fillStyle = T.red; x.fillText(parts[1] || '', cx + 18 + w1, cy + 44); }
    else x.fillText(String(t[1]).slice(0, 22), cx + 18, cy + 44);
    x.fillStyle = T.dim; x.font = `13px ${mono}`; x.fillText(String(t[2]).slice(0, 44), cx + 18, cy + 100);
  });
  x.fillStyle = T.accent; x.font = `bold 22px ${mono}`;
  const fun = `That is ${card.fun}.`; const words = fun.split(' '); let line = '', ly = 820; for (const w of words) { const test = line ? line + ' ' + w : w; if (x.measureText(test).width > W - 120) { x.fillText(line, 60, ly); ly += 32; line = w; } else line = test; } x.fillText(line, 60, ly);
  // the period's days as bars
  const days = card.daily || []; if (days.length) { const bx = 60, by = 920, bw = W - 120, bh = 260; const mx = Math.max(1, ...days.map((r) => r.tokens)); const slot = bw / days.length; x.fillStyle = T.dim; x.font = `13px ${mono}`; x.fillText('TOKENS PER DAY', bx, by - 24); days.forEach((r, i) => { const h = Math.round(r.tokens / mx * (bh - 30)); x.fillStyle = r.tokens ? T.accent : T.line; x.fillRect(bx + i * slot + 2, by + bh - 30 - h, Math.max(2, slot - 4), Math.max(2, h)); if (days.length <= 31 && (days.length <= 7 || i % Math.ceil(days.length / 10) === 0)) { x.fillStyle = T.dim; x.font = `11px ${mono}`; x.fillText(r.date.slice(5), bx + i * slot + 2, by + bh - 22); } }); }
  x.fillStyle = T.dim; x.font = `14px ${mono}`; x.fillText(`${card.commits} commits · ${hours(card.active_seconds)} of agent time · streak ${card.streak || 0} day${card.streak === 1 ? '' : 's'}`, 60, 1230);
  x.fillStyle = T.line; x.fillRect(60, 1400, W - 120, 1.5);
  x.fillStyle = T.dim; x.font = `13px ${mono}`; x.fillText('kcoder · © Kyle Niedzwiecki', 60, 1420);
  x.fillStyle = T.accent; x.font = `bold 13px ${mono}`; x.textAlign = 'right'; x.fillText('ten agents, one keyboard.', W - 60, 1420); x.textAlign = 'left';
  const dataUrl = c.toDataURL('image/png');
  await saveFile(`kcoder-wrapped-${card.key}.png`, dataUrl.split(',')[1], 'image/png', { binary: true });
}
function quotaCardHtml(q, hl) {
  q = q || { source: 'none' };
  const pct = Math.round((q.utilization || 0) * 100);
  const src = q.source === 'provider' ? '<span class="badge">from Claude Code</span>' : q.source === 'estimate' ? '<span class="badge est">estimate</span>' : '<span class="badge est">no data</span>';
  const days = (q.daily || []); const mx = Math.max(1, ...days.map((r) => r.tokens));
  const bars = days.length ? `<div class="qdays">${days.map((r) => `<span title="${esc(fmtDate(r.date))}: ${fmtInt(r.tokens)} plan tokens"><i style="height:${Math.max(2, Math.round(r.tokens / mx * 36))}px"></i><b>${esc(new Date(r.date + 'T00:00:00').toLocaleDateString([], { weekday: 'narrow' }))}</b></span>`).join('')}</div>` : '';
  const pace = quotaPace(q);
  const five = q.five_hour ? `<div class="row"><span>5-hour window</span><b>${Math.round(q.five_hour.utilization * 100)}% <span class="dim">· resets ${esc(quotaWhen(q.five_hour.resets_at))}</span></b></div>` : '';
  const body = q.source === 'none'
    ? `<div class="help plain">${esc(q.source_label || '')}</div><div class="row"><span>plan tokens this week <span class="dim">(since ${esc(quotaWhen(q.window_start))})</span></span><b>${fmtTokens(q.used_tokens || 0)}</b></div>${bars}${five}<div class="row"><button data-x="settings">Set a weekly limit in Settings</button></div>`
    : `<div class="qmeter ${quotaLevelClass(q)}"><div class="qfill" style="width:${Math.min(100, pct)}%"></div>${q.elapsed_fraction != null ? `<div class="qnow" style="left:${Math.round(q.elapsed_fraction * 100)}%" title="where the week is now: ${Math.round(q.elapsed_fraction * 100)}% of the window has passed"></div>` : ''}<span class="qpct">${pct}%</span></div>
      <div class="row"><span>used</span><b>${pct}%${q.source === 'estimate' ? ` <span class="dim">· ${fmtTokens(q.used_tokens || 0)} of ${fmtTokens(q.limit_tokens || 0)} tokens</span>` : q.used_tokens ? ` <span class="dim">· ${fmtTokens(q.used_tokens)} plan tokens this window</span>` : ''}</b></div>
      <div class="row"><span>resets</span><b>${esc(quotaWhen(q.resets_at))} <span class="dim">· ${Math.round((q.elapsed_fraction || 0) * 100)}% of the week has passed</span></b></div>
      <div class="row"><span>pace</span><b class="${q.forecast_reliable && !q.on_track ? 'warn' : ''}">${esc(pace || '-')}</b></div>
      ${q.projected_at_reset != null && q.forecast_reliable ? `<div class="row"><span>projected at the reset</span><b>${Math.round(Math.min(2, q.projected_at_reset) * 100)}%</b></div>` : ''}
      ${five}${bars}
      <div class="row"><span>quota shift</span><b>${q.shift_active ? '<span class="warn">on: small turns run on the cheaper model</span>' : q.shift_enabled ? 'armed · the forecast is fine' : 'off <span class="dim">(Settings)</span>'}</b></div>
      <div class="help plain">${esc(q.source_label || '')}. Warnings at 75% and 90%.</div>`;
  return `<div class="card quota${hl ? ' hl' : ''}" id="quota-card"><h3>weekly plan limit ${src}<span class="spacer"></span><span class="dim">${q.seen ? 'reported ' + age(q.seen) + ' ago' : ''}</span></h3>${body}</div>`;
}
const DAILY_COLS = [
  { k: 'date', label: 'day', f: (r) => fmtDate(r.date), cls: 'l' }, { k: 'input', label: 'tokens in', f: (r) => fmtTokens(r.input) }, { k: 'output', label: 'out', f: (r) => fmtTokens(r.output) }, { k: 'total', label: 'total', f: (r) => fmtTokens(r.total) },
  { k: 'cache_hit', label: 'cache hit', f: (r) => (r.input ? fmtPct(r.cache_read / r.input) : '-'), sort: (r) => (r.input ? r.cache_read / r.input : -1) }, { k: 'sessions', label: 'sessions', f: (r) => fmtInt(r.sessions) }, { k: 'commits', label: 'commits', f: (r) => fmtInt(r.commits) },
  { k: 'insertions', label: '+', f: (r) => plus(r.insertions) }, { k: 'deletions', label: '-', f: (r) => minus(r.deletions) }, { k: 'net', label: 'net', f: (r) => fmtSigned(r.net) }, { k: 'files', label: 'files', f: (r) => fmtInt(r.files) },
  { k: 'active_seconds', label: 'active', f: (r) => fmtDur(r.active_seconds) }, { k: 'api_equivalent', label: 'API equiv.', f: (r) => (r.api_equivalent ? `<span class="dim" title="estimate at API rates${r.cost ? '; ' + fmtUsd(r.cost) + ' actually billed on API keys' : ''}">${fmtUsd(r.api_equivalent)} est.</span>` : '-') },
];
function renderDailyTable() {
  const el = $('#stats-daily'); if (!el || !statsData) return;
  const w = statsData.window || {}; const rows = statsData.daily.filter((r) => (!w.start || r.date >= w.start) && (!w.end || r.date <= w.end));
  const tot = sumRows(rows); tot.date = `total · ${rows.length} day${rows.length === 1 ? '' : 's'}`;
  const metricCol = { tokens: 'total', commits: 'commits', sessions: 'sessions', active: 'active_seconds', lines: 'net', api: 'api_equivalent' }[state.statsMetric];
  el.innerHTML = sortableTable('daily', DAILY_COLS, rows, { sort: { key: 'date', dir: -1 }, tall: true, hl: metricCol, empty: 'nothing in this period', total: rows.length ? { label: tot.date, row: tot } : null, row: (r) => ` data-day="${r.date}" title="show ${fmtDate(r.date)}"` + (r.date === statsData.today ? ' class="today click"' : ' class="click"') });
}
async function exportStatsCsv() {
  if (!statsData) return;
  // the daily table for the range on screen, built by kcoderd: every day of the range, zeros where nothing happened
  let r; try { r = await request('stats_csv', { days: statsData.days, date: statsData.date || null, start: statsData.range && statsData.range.start, end: statsData.range && statsData.range.end }); } catch (e) { toast(e.message, 'err'); return; }
  await saveFile(r.filename, r.csv, 'text/csv');
}

// ----------------------------------------------------------------------
// just for fun: the token mine, a clicker on the fun tab
// ----------------------------------------------------------------------
// Click the banner for tokens and spend them on agents that mine on their own. Real work feeds it:
// every finished turn pays its output tokens into the bank and every commit a session makes pays a
// bonus. Fast clicking builds a combo, surprises pop up now and then (catch one for a lump or a
// timed boost), milestones each add 2% to the mine, and once enough has been mined all time you
// can cut a release: agents and bank go, stars stay (+10% each, forever). Progress lives in
// localStorage (kcoder.mine) and is mirrored into the daemon's ui_state so the app window and a
// browser tab share one mine; the mine keeps going up to eight hours while away.
const MINE_WORDS = ['million', 'billion', 'trillion', 'quadrillion', 'quintillion', 'sextillion', 'septillion', 'octillion', 'nonillion', 'decillion', 'undecillion', 'duodecillion', 'tredecillion', 'quattuordecillion', 'quindecillion', 'sexdecillion', 'septendecillion', 'octodecillion', 'novemdecillion', 'vigintillion'];
const fmtFull = (n) => fmtInt(Math.floor(Number(n) || 0));   // the bank and the totals: every digit, with separators
const fmtMine = (n) => {   // prices and rates: full up to a million, then "4.5 billion"
  n = Number(n) || 0; if (n < 1000) return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10); if (n < 1e6) return fmtInt(Math.round(n));
  let v = n, i = -2; while (v >= 1000 && i < MINE_WORDS.length - 1) { v /= 1000; i++; }   // two divisions reach a million, the first word
  if (v >= 1000) return n.toExponential(2).replace('e+', 'e');   // past a vigintillion the words run out
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : fmtInt(Math.round(v))} ${MINE_WORDS[i]}`;
};
const MINE_UNITS = [
  { id: 'intern', glyph: '·', name: 'Haiku intern', desc: 'fetches tokens one at a time, very fast, slightly wrong', cost: 15, rate: 0.1, tiers: ['prompt caching', 'extended thinking', 'a second opinion', 'the batch API'] },
  { id: 'builder', glyph: '▪', name: 'Sonnet builder', desc: 'ships the feature while you are still reading the plan', cost: 100, rate: 1, tiers: ['plan mode', 'MCP tools', 'hooks', 'parallel tool calls'] },
  { id: 'architect', glyph: '◆', name: 'Opus architect', desc: 'thinks for a while, then everything works', cost: 1100, rate: 8, tiers: ['1M context', 'a good CLAUDE.md', 'ultrareview', 'ultraplan'] },
  { id: 'pane', glyph: '▯', name: 'second pane', desc: 'two sessions side by side, one keyboard', cost: 12000, rate: 47, tiers: ['third pane', 'broadcast', 'a bigger monitor', 'a wall of monitors'] },
  { id: 'worktree', glyph: '⑂', name: 'worktree', desc: 'a branch of its own so nobody steps on anybody', cost: 130000, rate: 260, tiers: ['review gate', 'auto-merge', 'stacked branches', 'a monorepo'] },
  { id: 'cron', glyph: '◷', name: 'cron schedule', desc: 'runs at 6 AM whether you are up or not', cost: 1.4e6, rate: 1400, tiers: ['morning brief', 'nightly dependency bumps', 'weekend releases', 'every minute'] },
  { id: 'queue', glyph: '≣', name: 'task queue', desc: 'the whole backlog, one slot at a time', cost: 2e7, rate: 7800, tiers: ['trust: auto', 'more slots', 'a priority lane', 'auto-scaling'] },
  { id: 'fleet', glyph: '⚑', name: 'the fleet', desc: 'ten agents, one keyboard', cost: 3.3e8, rate: 44000, tiers: ['Wrapped', 'paid for itself', 'a second fleet', 'an armada'] },
  { id: 'daemon', glyph: '⚙', name: 'the daemon', desc: 'kcoderd itself, mining between restarts', cost: 5.1e9, rate: 2.6e5, tiers: ['launch agent', 'self-update', 'a second daemon', 'a daemon per machine'], need: 'daemon' },
  { id: 'mythos', glyph: '✶', name: 'Mythos', desc: 'the one above Opus; it mines in ways nobody can explain', cost: 7.5e10, rate: 1.6e6, tiers: ['an approved organisation', 'the long context', 'the overnight run', 'a constellation'], need: 'mythos' },
  { id: 'factory', glyph: '⌂', name: 'the software factory', desc: 'plans, builds, reviews and ships with nobody in the loop', cost: 1.2e12, rate: 1.2e7, tiers: ['a second line', 'robots', 'lights out', 'a second factory'], need: 'factory' },
  { id: 'founder', glyph: '♛', name: 'the founder', desc: 'types with two fingers, ships anyway', cost: 2.5e13, rate: 1e8, tiers: ['coffee', 'a standing desk', 'noise-cancelling headphones', 'a co-founder'], need: 'founder' },
  { id: 'board', glyph: '▣', name: 'the board', desc: 'meets quarterly, mines constantly', cost: 5e14, rate: 1e9, tiers: ['a quorum', 'an off-site', 'a proxy fight', 'unanimous'], need: 'board' },
  { id: 'acquirer', glyph: '⇄', name: 'the acquirer', desc: 'bought the company for the tokens', cost: 1e16, rate: 3e10, tiers: ['due diligence', 'a term sheet', 'the earn-out', 'synergies'], need: 'acquirer' },
  { id: 'regulator', glyph: '§', name: 'the regulator', desc: 'files a finding, keeps the fine', cost: 2e17, rate: 1e12, tiers: ['a filing', 'a consent decree', 'a loophole', 'regulatory capture'], need: 'regulator' },
  { id: 'agi', glyph: '∞', name: 'the AGI', desc: 'mines tokens about itself', cost: 5e18, rate: 4e13, tiers: ['a benchmark', 'self-improvement', 'the alignment team', 'the takeoff'], need: 'agi' },
  { id: 'fork', glyph: 'Ψ', name: 'the open-source fork', desc: 'everyone works for free, somehow it ships', cost: 1e20, rate: 1.5e15, tiers: ['a star on GitHub', 'a maintainer', 'the foundation', 'upstream'], need: 'fork' },
];   // `need` names the star shop perk that makes the agent hireable
// past the open-source fork the agents never run out: each one costs 25 times and mines 12 times the one before, and the
// next shows up once the last is hired (the names cycle with a numeral), so there is always something to save for
const MINE_X_UNITS = [['the second universe', '✧'], ['the time loop', '⟲'], ['the Dyson sphere', '◉'], ['the Boltzmann brain', '☁'], ['the omega point', 'Ω'], ['the tenth dimension', '⬡'], ['the simulation', '▦'], ['the reboot', '⟳']];
const mineRoman = (n) => { const R = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]; let out = ''; for (const [v, r] of R) while (n >= v) { out += r; n -= v; } return out; };
function mineExtraUnits(g) {
  const out = []; let prev = MINE_UNITS[MINE_UNITS.length - 1];
  for (let i = 0; i < 400; i++) {
    const [nm, glyph] = MINE_X_UNITS[i % MINE_X_UNITS.length]; const round = Math.floor(i / MINE_X_UNITS.length);
    const u = { id: `x${i}`, glyph, name: round ? `${nm} ${mineRoman(round + 1)}` : nm, desc: 'past the fork: it mines in ways nobody has named yet', cost: prev.cost * 25, rate: prev.rate * 12, tiers: ['a theory', 'a proof', 'a paper', 'a prize'], gen: true };
    if (!Number.isFinite(u.cost)) break;
    out.push(u); if (!((g.units[u.id] || 0) > 0)) break; prev = u;
  }
  return out;
}
const mineUnitsAll = (g) => ((g.units.fork || 0) >= 1 ? MINE_UNITS.concat(mineExtraUnits(g)) : MINE_UNITS);
const MINE_X_TIERS = ['beyond the singularity', 'the second singularity', 'the third singularity', 'the recursion', 'the recursion again', 'the stack overflow', 'the heat death', 'the big bounce'];
function mineExtraTiers(u, owned) {   // past a thousand owned: a ×10 tier every hundred more, priced like ten more of the agent at that count, the next one showing once the last is in reach
  const out = []; const upto = Math.max(1100, Math.floor(owned / 100) * 100 + 100);
  for (let k = 1100, i = 0; k <= upto && i < 400; k += 100, i++) { const round = Math.floor(i / MINE_X_TIERS.length); const cost = u.cost * 10 * Math.pow(1.15, k); if (!Number.isFinite(cost)) break; out.push({ id: `${u.id}_t${k}`, name: `${MINE_X_TIERS[i % MINE_X_TIERS.length]}${round ? ' ' + mineRoman(round + 1) : ''} (${u.name})`, desc: `${u.name} mines 10 times as fast`, cost, unit: u.id, mult: 10, owned: k, gen: true }); }
  return out;
}
function mineExtraClicks(g) {   // past a thousand hands: the next thousand-fold, ten thousand times the price, once the last is bought
  const out = []; let cost = 1e24, need = 'hands';
  for (let i = 2; i < 400; i++) { cost *= 1e4; if (!Number.isFinite(cost)) break; const id = `hands${i}`; out.push({ id, name: `a thousand hands ${mineRoman(i)}`, desc: 'clicks are worth a thousand times as much', cost, click: 1000, need, gen: true }); if (!g.ups.includes(id)) break; need = id; }
  return g.ups.includes('hands') ? out : [];
}
let mineUpsCache = { key: '', list: [], byId: new Map() };
function mineUpgradesAll(g) {   // every upgrade that exists for this mine: the static ones for the agents that are open, the generated tiers and clicks
  const open = mineUnitsOpen(g); const key = `${open.map((u) => `${u.id}:${g.units[u.id] || 0}`).join(',')}|${g.ups.length}`;
  if (mineUpsCache.key === key) return mineUpsCache.list;
  const openIds = new Set(open.map((u) => u.id));
  const list = MINE_UPGRADES.filter((up) => !up.unit || openIds.has(up.unit)).concat(mineExtraClicks(g));
  for (const u of open) { if (u.gen) for (const [owned, x, mult, tname] of MINE_TIERS) list.push({ id: `${u.id}_${owned}`, name: tname ? `${tname} (${u.name})` : u.tiers[Math.min(3, MINE_TIERS.findIndex((t) => t[0] === owned))], desc: `${u.name} mines ${mult === 2 ? 'twice' : `${fmtInt(mult)} times`} as fast`, cost: u.cost * x, unit: u.id, mult, owned }); if ((g.units[u.id] || 0) >= 1000) list.push(...mineExtraTiers(u, g.units[u.id] || 0)); }
  mineUpsCache = { key, list, byId: new Map(list.map((up) => [up.id, up])) }; return list;
}
const mineUpById = (g, id) => { mineUpgradesAll(g); return mineUpsCache.byId.get(id) || MINE_UPGRADES.find((x) => x.id === id) || null; };
function mineUnitMults(g) { const m = {}; for (const id of g.ups) { const up = mineUpById(g, id); if (up && up.unit) m[up.unit] = (m[up.unit] || 1) * up.mult; } return m; }
const MINE_TIERS = [[10, 10, 2], [25, 100, 2], [50, 1000, 2], [100, 10000, 4],   // [agents owned to unlock, cost as a multiple of the agent's base price, multiplier, shared name]; the fourth tier is the scale-up
  ...[[200, 10, 'overtime'], [300, 10, 'the night shift'], [400, 10, 'a second office'], [500, 1000, 'the thousand-fold'], [600, 10, 'offshore'], [700, 10, 'a merger'], [800, 10, 'an acquisition'], [900, 10, 'the IPO'], [1000, 1000, 'the singularity']]
    .map(([owned, mult, name]) => [owned, (mult >= 1000 ? 100 : 10) * Math.pow(1.15, owned), mult, name])];   // the late tiers: a hundred agents apart, priced like ten more of the agent (a hundred more for a thousand-fold)
const MINE_UPGRADES = [
  { id: 'kbd', name: 'mechanical keyboard', desc: 'clicks are worth twice as much', cost: 100, click: 2 },
  { id: 'dictation', name: 'dictation', desc: 'clicks are worth twice as much', cost: 2000, click: 2, need: 'kbd' },
  { id: 'macro', name: 'macro pad', desc: 'clicks are worth twice as much', cost: 50000, click: 2, need: 'dictation' },
  { id: 'omni', name: 'command palette', desc: 'each click also earns a second of the mine', cost: 1e6, clickSec: 1, need: 'macro' },
  { id: 'thinking', name: 'ultrathink', desc: 'each click also earns three seconds of the mine', cost: 5e8, clickSec: 3, need: 'omni' },
  { id: 'voice', name: 'voice control', desc: 'clicks are worth twice as much', cost: 1e11, click: 2, need: 'thinking' },
  { id: 'mouse2', name: 'a second mouse', desc: 'clicks are worth twice as much', cost: 1e14, click: 2, need: 'voice' },
  { id: 'pedal', name: 'a foot pedal', desc: 'clicks are worth twice as much', cost: 1e17, click: 2, need: 'mouse2' },
  { id: 'batchclick', name: 'the batch click', desc: 'each click also earns ten seconds of the mine', cost: 1e20, clickSec: 10, need: 'pedal' },
  { id: 'hands', name: 'a thousand hands', desc: 'clicks are worth a thousand times as much', cost: 1e24, click: 1000, need: 'batchclick' },
  ...MINE_UNITS.flatMap((u) => MINE_TIERS.map(([owned, x, mult, tname], i) => ({ id: `${u.id}${i + 1}`, name: tname ? `${tname} (${u.name})` : u.tiers[i], desc: `${u.name} mines ${mult === 2 ? 'twice' : `${fmtInt(mult)} times`} as fast`, cost: u.cost * x, unit: u.id, mult, owned }))),
];
// surprises: a bubble that shows up now and then while the tab is on screen; click it before it goes
const MINE_SURPRISES = [
  { id: 'retry', name: 'a free retry', weight: 45, kind: 'lump' },
  { id: 'cache', name: 'prompt cache hit', weight: 30, kind: 'frenzy', mult: 7, sec: 77 },
  { id: 'limit', name: 'rate limit lifted', weight: 15, kind: 'frenzy', mult: 3, sec: 180 },
  { id: 'stash', name: 'the intern found a stash', weight: 10, kind: 'clicks', mult: 50, sec: 13 },
];
const mineAgents = (g) => Object.values(g.units).reduce((s, n) => s + (Number(n) || 0), 0);
const MINE_MILESTONES = [
  { id: 'click1', name: 'first click', desc: 'click the banner once', test: (g) => g.clicks >= 1 },
  { id: 'click100', name: 'warm keyboard', desc: '100 clicks', test: (g) => g.clicks >= 100 },
  { id: 'click1k', name: 'carpal tunnel', desc: '1,000 clicks', test: (g) => g.clicks >= 1000 },
  { id: 'click10k', name: 'macro pad, surely', desc: '10,000 clicks', test: (g) => g.clicks >= 10000 },
  { id: 'combo', name: 'on a roll', desc: 'a ×3 click combo (40 fast clicks in a row)', test: (g) => g.bestCombo >= 3 },
  { id: 'combo5', name: 'unstoppable', desc: 'a ×5 click combo (80 fast clicks in a row)', test: (g) => g.bestCombo >= 5 },
  { id: 'hire1', name: 'first hire', desc: 'hire a Haiku intern', test: (g) => (g.units.intern || 0) >= 1 },
  { id: 'agents10', name: 'a team', desc: 'ten agents at once', test: (g) => mineAgents(g) >= 10 },
  { id: 'agents100', name: 'an org chart', desc: 'a hundred agents at once', test: (g) => mineAgents(g) >= 100 },
  { id: 'agents500', name: 'a campus', desc: 'five hundred agents at once', test: (g) => mineAgents(g) >= 500 },
  { id: 'oneofeach', name: 'the full stack', desc: 'one of every agent', test: (g) => mineUnitsOpen(g).every((u) => g.units[u.id]) },
  { id: 'fleet', name: 'admiral', desc: 'buy the fleet', test: (g) => (g.units.fleet || 0) >= 1 },
  { id: 'allups', name: 'maxed out', desc: 'every upgrade on offer bought, with at least fifty owned', test: (g) => g.ups.length >= 50 && !mineUpgradesOpen(g).length },
  { id: 'total1k', name: 'a thousand', desc: '1,000 tokens mined all time', test: (g) => g.total >= 1e3 },
  { id: 'total1m', name: 'a million', desc: '1,000,000 tokens mined all time', test: (g) => g.total >= 1e6 },
  { id: 'total1b', name: 'a billion', desc: '1,000,000,000 tokens mined all time', test: (g) => g.total >= 1e9 },
  { id: 'total1t', name: 'a trillion', desc: '1,000,000,000,000 tokens mined all time', test: (g) => g.total >= 1e12 },
  { id: 'real1', name: 'honest work', desc: 'a real turn pays in', test: (g) => g.real.turns >= 1 },
  { id: 'real100', name: 'a hundred turns', desc: '100 real turns paid in', test: (g) => g.real.turns >= 100 },
  { id: 'real500', name: 'five hundred turns', desc: '500 real turns paid in', test: (g) => g.real.turns >= 500 },
  { id: 'commit1', name: 'shipped', desc: 'a real commit pays in', test: (g) => g.real.commits >= 1 },
  { id: 'commit50', name: 'fifty commits', desc: '50 real commits paid in', test: (g) => g.real.commits >= 50 },
  { id: 'gold1', name: 'quick hands', desc: 'catch a surprise', test: (g) => g.caught >= 1 },
  { id: 'gold25', name: 'lucky streak', desc: 'catch 25 surprises', test: (g) => g.caught >= 25 },
  { id: 'night', name: 'night shift', desc: 'click between 2 and 5 AM', test: (g) => !!g.night },
  { id: 'away', name: 'well rested', desc: 'come back after the away cap (eight hours to start)', test: (g) => !!g.capped },
  { id: 'release1', name: 'v1.0', desc: 'cut a release', test: (g) => g.releases >= 1 },
  { id: 'release5', name: 'semver veteran', desc: 'cut five releases', test: (g) => g.releases >= 5 },
  { id: 'stars10', name: 'trending', desc: 'ten stars earned', test: (g) => g.starsEver >= 10 },
  { id: 'spend1', name: 'patron', desc: 'spend a star in the star shop', test: (g) => g.spent >= 1 },
  { id: 'spend10', name: 'a regular', desc: 'spend ten stars in the star shop', test: (g) => g.spent >= 10 },
  { id: 'daemon1', name: 'self-hosted', desc: 'hire the daemon', test: (g) => (g.units.daemon || 0) >= 1 },
  { id: 'mythos1', name: 'approved organisation', desc: 'hire Mythos', test: (g) => (g.units.mythos || 0) >= 1 },
  { id: 'agents1k', name: 'a city', desc: 'a thousand agents at once', test: (g) => mineAgents(g) >= 1000 },
  { id: 'total1q', name: 'a quadrillion', desc: '1,000,000,000,000,000 tokens mined all time', test: (g) => g.total >= 1e15 },
  { id: 'total1qi', name: 'a quintillion', desc: '1,000,000,000,000,000,000 tokens mined all time', test: (g) => g.total >= 1e18 },
  { id: 'stars100', name: 'a hundred stars', desc: 'a hundred stars earned', test: (g) => g.starsEver >= 100 },
  { id: 'stars1k', name: 'a thousand stars', desc: 'a thousand stars earned', test: (g) => g.starsEver >= 1000 },
  { id: 'tier200', name: 'overtime', desc: 'buy an agent\'s tier at 200 owned', test: (g) => g.ups.some((id) => (mineUpById(g, id) || {}).owned >= 200) },
  { id: 'tier1k', name: 'thousand-fold', desc: 'buy a ×1,000 tier', test: (g) => g.ups.some((id) => (mineUpById(g, id) || {}).mult >= 1000) },
  { id: 'factory1', name: 'lights out', desc: 'hire the software factory', test: (g) => (g.units.factory || 0) >= 1 },
  { id: 'founder1', name: 'founder mode', desc: 'hire the founder', test: (g) => (g.units.founder || 0) >= 1 },
  { id: 'sprint1', name: 'sprinter', desc: 'finish a sprint', test: (g) => g.sprintsDone >= 1 },
  { id: 'sprint3', name: 'a clean sprint', desc: 'finish all three sprints in a day', test: (g) => g.sprintDays >= 1 },
  { id: 'streak7', name: 'a week of sprints', desc: 'all three sprints done seven days in a row', test: (g) => g.streak >= 7 },
  { id: 'board1', name: 'the quorum', desc: 'hire the board', test: (g) => (g.units.board || 0) >= 1 },
  { id: 'acquirer1', name: 'acquired', desc: 'hire the acquirer', test: (g) => (g.units.acquirer || 0) >= 1 },
  { id: 'regulator1', name: 'compliant', desc: 'hire the regulator', test: (g) => (g.units.regulator || 0) >= 1 },
  { id: 'agi1', name: 'the takeoff', desc: 'hire the AGI', test: (g) => (g.units.agi || 0) >= 1 },
  { id: 'fork1', name: 'upstream', desc: 'hire the open-source fork', test: (g) => (g.units.fork || 0) >= 1 },
  { id: 'vp10', name: 'a management layer', desc: 'ten VPs of engineering', test: (g) => mineLevel(g, 'vp') >= 10 },
  { id: 'round1', name: 'series A', desc: 'raise a funding round', test: (g) => mineLevel(g, 'round') >= 1 },
  { id: 'bounty1', name: 'bought out', desc: 'buy a sprint out with a bounty', test: (g) => mineLevel(g, 'bounty') >= 1 },
  { id: 'fast1', name: 'speedrun', desc: 'cut a release inside the day\'s speed sprint', test: (g) => g.fastRel >= 1 },
  { id: 'fast30', name: 'the thirty-minute release', desc: 'a release cut within thirty minutes of the last', test: (g) => g.bestRel > 0 && g.bestRel <= 1800 },
  { id: 'hard1', name: 'the hard way', desc: 'finish a hard sprint', test: (g) => g.hardDone >= 1 },
  { id: 'week1', name: 'a long week', desc: 'finish a weekly sprint', test: (g) => g.weeksDone >= 1 },
  { id: 'dip', name: 'bought the dip', desc: 'buy shares while the price sits 5% or more under fair value', test: (g) => g.dipBuys >= 1 },
  { id: 'cashout', name: 'took profits', desc: 'sell shares for more stars than they cost', test: (g) => g.gains >= 1 },
  // families: one chip at a time shows until it is earned, then the next, so there is always a next one
  ...MINE_WORDS.slice(5).map((w, i) => ({ id: `total_${w}`, fam: 'total', name: `${/^[aeiou]/.test(w) ? 'an' : 'a'} ${w}`, desc: `${fmtMine(1e21 * Math.pow(1000, i))} tokens mined all time`, test: (g) => g.total >= 1e21 * Math.pow(1000, i) })),
  ...Array.from({ length: 80 }, (_, i) => 66 + 3 * i).map((e) => ({ id: `total_e${e}`, fam: 'total', name: e === 99 ? 'a googol, nearly' : `ten to the ${e}th`, desc: `10^${e} tokens mined all time (${e >= 300 ? 'the edge of what a number can hold' : 'past the words'})`, test: (g) => g.total >= Math.pow(10, e) })),
  ...[[10, 'double digits'], [15, 'v15'], [20, 'a score of releases'], [30, 'thirty releases'], [50, 'fifty releases'], [75, 'seventy-five'], [100, 'a hundred releases'], [250, 'release 250'], [500, 'release 500'], [1000, 'release 1,000']].map(([n, name]) => ({ id: `rel${n}`, fam: 'rel', name, desc: `cut ${fmtInt(n)} releases, over every listing`, test: (g) => g.releases + g.ipoReleases >= n })),
  ...[100, 250, 500, 1000, 2500, 5000, 10000, 25000].map((n) => ({ id: `commit${n}`, fam: 'commit', name: `${fmtInt(n)} commits`, desc: `${fmtInt(n)} real commits paid in`, test: (g) => g.real.commits >= n })),
  ...[1000, 2500, 5000, 10000, 25000, 50000, 100000].map((n) => ({ id: `real${n}`, fam: 'real', name: `${fmtInt(n)} turns`, desc: `${fmtInt(n)} real turns paid in`, test: (g) => g.real.turns >= n })),
  ...[25000, 50000, 100000, 250000, 1000000, 10000000, 1e8, 1e9, 1e10].map((n) => ({ id: `click${n}`, fam: 'click', name: `${fmtMine(n)} clicks`, desc: `${fmtInt(n)} clicks`, test: (g) => g.clicks >= n })),
  ...[10000, 100000, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e15, 1e18].map((n) => ({ id: `stars${n}`, fam: 'stars', name: `${fmtMine(n)} stars`, desc: `${fmtInt(n)} stars earned over every listing`, test: (g) => mineStarsLife(g) >= n })),
  ...[25, 100, 500, 1000, 5000].map((n) => ({ id: `sprints${n}`, fam: 'sprint', name: `${fmtInt(n)} sprints`, desc: `${fmtInt(n)} sprints finished`, test: (g) => g.sprintsDone >= n })),
  ...[30, 100, 365].map((n) => ({ id: `streak${n}`, fam: 'streak', name: n === 30 ? 'a month of sprints' : n === 100 ? 'a hundred clean days' : 'a year of sprints', desc: `all three sprints done ${n} days in a row`, test: (g) => g.streak >= n })),
  ...[1, 7, 30, 100].map((n) => ({ id: `perfect${n}`, fam: 'perfect', name: n === 1 ? 'a perfect day' : `${n} perfect days`, desc: `the hard sprint and all three regular ones done in a day${n > 1 ? `, ${n} times` : ''}`, test: (g) => g.perfectDays >= n })),
  ...[4, 12, 52].map((n) => ({ id: `weeks${n}`, fam: 'week', name: n === 4 ? 'a month of weeks' : n === 12 ? 'a quarter' : 'a year of weeks', desc: `${n} weekly sprints finished`, test: (g) => g.weeksDone >= n })),
  ...[[1, 'ringing the bell'], [2, 'a second listing'], [3, 'serial founder'], [5, 'a conglomerate'], [10, 'the index fund'], [25, 'the whole exchange']].map(([n, name]) => ({ id: `ipo${n}`, fam: 'ipo', name, desc: `go public ${n === 1 ? 'once' : `${n} times`}`, test: (g) => g.ipo >= n })),
  ...[10, 100, 1000, 10000, 100000].map((n) => ({ id: `shares${n}`, fam: 'shares', name: `${fmtInt(n)} shares`, desc: `hold ${fmtInt(n)} shares`, test: (g) => g.shares >= n })),
  ...[[1, 'first trade'], [10, 'ten trades'], [100, 'day trader'], [1000, 'high frequency']].map(([n, name]) => ({ id: `trades${n}`, fam: 'trade', name, desc: `${fmtInt(n)} trade${n === 1 ? '' : 's'} on the exchange`, test: (g) => g.trades >= n })),
  ...[[2, 'doubled since listing'], [10, 'a ten-bagger'], [100, 'a hundred-bagger'], [1000, 'a thousand-bagger'], [10000, 'the moon']].map(([n, name]) => ({ id: `px${n}`, fam: 'px', name, desc: `the share price at ${fmtInt(n)}× the first listing's`, test: (g) => g.pxIpo > 0 && g.px >= n * g.pxIpo })),
  ...[[1e5, 'six figures of cap'], [1e6, 'a unicorn'], [1e7, 'a decacorn'], [1e8, 'a hectocorn'], [1e9, 'a billion-star company'], [1e12, 'a trillion-star company']].map(([n, name]) => ({ id: `cap${n}`, fam: 'cap', name, desc: `a market cap of ${fmtMine(n)} stars (shares × price)`, test: (g) => mineCap(g) >= n })),
  ...[[2000, 'a metropolis'], [5000, 'a nation'], [10000, 'a planet'], [50000, 'a galaxy of agents'], [1e5, 'a hundred thousand agents'], [1e6, 'a million agents'], [1e7, 'ten million agents'], [1e8, 'a hundred million agents'], [1e9, 'a billion agents'], [1e12, 'a trillion agents']].map(([n, name]) => ({ id: `agents${n}`, fam: 'agents', name, desc: `${fmtInt(n)} agents at once`, test: (g) => mineAgents(g) >= n })),
  ...[1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987].map((n) => ({ id: `beyond${n}`, fam: 'beyond', name: n === 1 ? 'past the fork' : `${fmtInt(n)} past the fork`, desc: `hire ${n === 1 ? 'the agent after the open-source fork' : `${fmtInt(n)} agents from past the fork`}`, test: (g) => Object.keys(g.units).filter((id) => id.startsWith('x') && g.units[id] > 0).length >= n })),
  { id: 'coin', name: 'insert coin', desc: 'a game played in the arcade', test: (g) => Object.values(g.arcade).some((c) => (c.played || 0) > 0) },
  ...[[2048, '2048'], [4096, '4096'], [8192, '8192'], [16384, '16384'], [32768, '32768']].map(([n, name]) => ({ id: `tile${n}`, fam: 'tile', name, desc: `a ${fmtInt(n)} tile in 2048`, test: (g) => ((g.arcade.t2048 || {}).bestTile || 0) >= n })),
  ...[[10000, 'five figures in 2048'], [100000, 'six figures in 2048'], [1000000, 'a million in 2048']].map(([n, name]) => ({ id: `score${n}`, fam: 'score', name, desc: `a score of ${fmtInt(n)} in 2048`, test: (g) => ((g.arcade.t2048 || {}).best || 0) >= n })),
  ...[[1, 'a clear board'], [10, 'ten boards'], [50, 'fifty boards'], [250, 'mahjong master']].map(([n, name]) => ({ id: `mj${n}`, fam: 'mj', name, desc: `${n === 1 ? 'clear a mahjong board' : `clear ${fmtInt(n)} mahjong boards`}`, test: (g) => ((g.arcade.mahjong || {}).wins || 0) >= n })),
  ...[[1, 'the daily deal'], [7, 'a week of daily deals'], [30, 'a month of daily deals']].map(([n, name]) => ({ id: `mjd${n}`, fam: 'mjd', name, desc: `clear ${n === 1 ? 'the daily mahjong deal' : `${n} daily mahjong deals`}`, test: (g) => (((g.arcade.mahjong || {}).dailies || []).length || 0) >= n })),
];
const mineMilestonesShown = (g) => { const seen = new Set(); return MINE_MILESTONES.filter((m) => { if (!m.fam) return true; if (g.ach.includes(m.id)) return true; if (seen.has(m.fam)) return false; seen.add(m.fam); return true; }); };
// the wire: one line of news under the banner, picked from what fits the mine right now (state lines count three times)
const MINE_NEWS = [
  [(g) => !mineAgents(g), 'the mine is quiet. somebody should hire an intern.'],
  [(g) => g.units.intern >= 1, (g) => `${mineWho(g, 'intern', 'an intern')} fetched a token, then fetched it again to be sure.`],
  [(g) => g.units.intern >= 10, 'the interns have formed a union. first demand: more context.'],
  [(g) => g.units.intern >= 25, (g) => `${mineWho(g, 'intern', 'an intern')} was caught thinking. extended thinking, apparently.`],
  [(g) => g.units.builder >= 1, (g) => `${mineWho(g, 'builder', 'a Sonnet builder')} shipped a feature nobody asked for. it is good.`],
  [(g) => g.units.builder >= 10, 'the builders have been in plan mode since Tuesday.'],
  [(g) => g.units.architect >= 1, (g) => `${mineWho(g, 'architect', 'the Opus architect')} has been thinking for forty minutes. the diagram is beautiful.`],
  [(g) => g.units.architect >= 10, 'ten architects agreed on a name. it took all day.'],
  [(g) => g.units.pane >= 1, (g) => `${mineWho(g, 'pane', 'the second pane')} is watching the first pane.`],
  [(g) => g.units.worktree >= 1, (g) => `${mineWho(g, 'worktree', 'a worktree')} was found living on its own. it has been merged.`],
  [(g) => g.units.cron >= 1, 'the 6 AM cron ran. you were asleep. the tests passed anyway.'],
  [(g) => g.units.queue >= 1, 'the task queue reports: three done, one waiting on you. as always.'],
  [(g) => g.units.fleet >= 1, (g) => `${mineWho(g, 'fleet', 'the fleet')} has elected a captain. it is ${mineWho(g, 'intern', 'a Haiku intern')}.`],
  [(g) => g.units.daemon >= 1, (g) => `${mineWho(g, 'daemon', 'the daemon')} restarted itself and mined straight through it.`],
  [(g) => g.units.mythos >= 1, (g) => `${mineWho(g, 'mythos', 'Mythos')} cleared the backlog. the backlog is bigger now. nobody can explain it.`],
  [(g) => g.units.factory >= 1, 'the software factory shipped a release at 3 AM. the changelog is a haiku.'],
  [(g) => g.units.founder >= 1, (g) => `${mineWho(g, 'founder', 'the founder')} pushed to main. the tests ran afterwards.`],
  [(g) => mineAgents(g) >= 1000, 'a thousand agents. the standup took all day.'],
  [(g) => g.units.board >= 1, (g) => `${mineWho(g, 'board', 'the board')} met. the minutes say "tokens". nothing else.`],
  [(g) => g.units.acquirer >= 1, (g) => `${mineWho(g, 'acquirer', 'the acquirer')} found synergies. two interns are now one intern.`],
  [(g) => g.units.regulator >= 1, (g) => `${mineWho(g, 'regulator', 'the regulator')} fined the mine. the fine was paid in tokens. net positive.`],
  [(g) => g.units.agi >= 1, (g) => `${mineWho(g, 'agi', 'the AGI')} rewrote itself overnight. it is nicer now, and faster.`],
  [(g) => g.units.fork >= 1, (g) => `${mineWho(g, 'fork', 'the fork')} opened a pull request against the original. it was merged by mistake.`],
  [(g) => g.ipo >= 1, (g) => `publicly traded, ${fmtInt(g.shares)} share${g.shares === 1 ? '' : 's'} outstanding. the analysts say "hold". the interns say "click".`],
  [(g) => g.ipo >= 1, 'the ticker is KCDR. the quarterly call was all clicking.'],
  [(g) => mineLevel(g, 'vp') >= 1, (g) => `${mineLevel(g, 'vp')} VP${mineLevel(g, 'vp') === 1 ? '' : 's'} of engineering. each has a one-on-one with the mine.`],
  [(g) => g.rounds >= 1, 'a funding round closed. the valuation is in tokens. the investors are interns.'],
  [(g) => mineHas(g, 'dividend'), 'dividends were paid in stars. the shareholders clicked anyway.'],
  [(g) => g.ipo >= 1 && g.event && Date.now() - g.event.at < 1800000, (g) => `${g.event.name}: ${MINE_TICKER} ${g.event.pct > 0 ? 'up' : 'down'} ${Math.round(Math.abs(g.event.pct) * 100)}%. ${g.event.pct > 0 ? 'the interns are buying.' : 'the interns are buying the dip.'}`],
  [(g) => g.ipo >= 1 && g.pxOpen > 0 && g.px >= g.pxOpen * 1.05, (g) => `${MINE_TICKER} is up ${Math.round((g.px / g.pxOpen - 1) * 100)}% today. the analysts have upgraded it to "hold harder".`],
  [(g) => g.ipo >= 1 && g.pxOpen > 0 && g.px <= g.pxOpen * 0.95, (g) => `${MINE_TICKER} is down ${Math.round((1 - g.px / g.pxOpen) * 100)}% today. nothing has changed except the number.`],
  [(g) => g.trades >= 1, 'a retail investor bought one share and asked for the roadmap.'],
  [(g) => g.dipBuys >= 1, 'you bought the dip. the dip thanks you.'],
  [(g) => g.gains >= 1, 'profits were taken. the sell button was pressed with feeling.'],
  [(g) => g.pxIpo > 0 && g.px >= 10 * g.pxIpo, (g) => `${MINE_TICKER} is a ten-bagger. the analysts still say "hold".`],
  [(g) => mineHas(g, 'analyst'), 'the analyst has a price target. it is "more".'],
  [(g) => mineHas(g, 'broker'), 'the prime broker sent a fruit basket. it was mostly tokens.'],
  [(g) => mineHas(g, 'hype'), 'the hype machine is at full tilt. a tweet was drafted.'],
  [(g) => mineHas(g, 'ir'), 'investor relations has rebranded the commit log as "guidance".'],
  [(g) => g.bestRel > 0 && g.bestRel < 3600, (g) => `fastest release: ${fmtDurLong(g.bestRel)}. the changelog was written during the build.`],
  [(g) => g.weeksDone > 0, 'the weekly sprint is done. the retro is scheduled for next quarter.'],
  [(g) => g.sprintsDone > 0, (g) => `${fmtInt(g.sprintsDone)} sprint${g.sprintsDone === 1 ? '' : 's'} finished. the retro was skipped.`],
  [(g) => g.streak >= 3, (g) => `${g.streak} days of clean sprints. the burndown chart goes up and to the right somehow.`],
  [(g) => mineHas(g, 'procurement'), 'procurement bought something. nobody asked. it was the right call.'],
  [(g) => mineHas(g, 'auto'), 'the cron clicker has not missed a second. it is unsettling.'],
  [(g) => Object.keys(g.names).length > 0, (g) => `${mineWho(g, 'intern', 'an intern')} asked to be called something else. request noted.`],
  [(g) => g.spent > 0, (g) => `${fmtInt(g.spent)} star${g.spent === 1 ? '' : 's'} spent in the shop. the repo is down to ${fmtInt(g.stars)}. worth it.`],
  [(g) => g.ups.includes('kbd'), 'the mechanical keyboard can be heard from the next building.'],
  [(g) => g.ups.includes('dictation'), 'dictation heard "git push" and did not. good dictation.'],
  [(g) => g.ups.includes('omni'), 'the command palette has a command for opening the command palette.'],
  [(g) => g.real.commits > 0, (g) => `${fmtInt(g.real.commits)} real commit${g.real.commits === 1 ? '' : 's'} paid into the mine. the agents are impressed.`],
  [(g) => g.real.turns > 0, (g) => `${fmtFull(g.real.tokens)} tokens of this mine came from actual work. the rest is clicking.`],
  [(g) => g.stars > 0, (g) => `v${g.releases} shipped. the changelog says "improvements".`],
  [(g) => g.stars >= 10, 'ten stars on the repo. three of them are yours.'],
  [(g) => g.boost, 'everything is fast right now. nobody knows why. do not touch anything.'],
  [() => true, 'a token was found under the keyboard.'],
  [() => true, 'compaction happened. nobody remembers what.'],
  [() => true, 'rate limit lifted. the crowd goes wild.'],
  [() => true, 'CLAUDE.md is 400 lines now. twelve are followed.'],
  [() => true, 'somebody pushed to main. it was you.'],
  [() => true, 'the daemon restarted itself and did not tell anyone.'],
  [() => true, 'a handoff summary was written. it was longer than the session.'],
  [() => true, 'the intern asked what a token is. nobody could say.'],
  [() => true, 'the weekly limit is a suggestion, says a sign nobody put up.'],
  [() => true, 'tests pass. the test is assert True.'],
  [() => true, 'a surprise was seen near the agents card. it left before anyone clicked.'],
];
// the star shop: a star buys a permanent perk for the mine or a change to kcoder itself. the star goes
// for good, and its 10% with it (the mine runs on stars held; the rank follows stars ever earned)
const MINE_SHOP = [
  { id: 'head', group: 'perk', name: 'head start', desc: 'every release begins with ten interns and the mechanical keyboard', cost: 1 },
  { id: 'shift', group: 'perk', name: 'longer shift', desc: 'the away cap goes from 8 hours to 16, then 24, then 48, then a week', cost: [1, 1, 5, 10], max: 4 },
  { id: 'coach', group: 'perk', name: 'combo coach', desc: 'first the combo window stretches from 0.9 to 1.5 seconds, then the cap lifts from ×5 to ×6', cost: 1, max: 2 },
  { id: 'lucky', group: 'perk', name: 'lucky', desc: 'surprises show up twice as often and stay twice as long', cost: 2 },
  { id: 'double', group: 'perk', name: 'real work pays double', desc: 'real turns and commits pay twice into the bank', cost: 2 },
  { id: 'auto', group: 'perk', name: 'the cron clicker', desc: 'clicks the banner once a second at full combo while the tab is on screen', cost: 3 },
  { id: 'keep', group: 'perk', name: 'keep one', desc: 'pick one upgrade; it survives every release', cost: 3 },
  { id: 'daemon', group: 'perk', name: 'a ninth agent', desc: 'the daemon itself becomes hireable, priced past the fleet', cost: 5 },
  { id: 'mythos', group: 'perk', name: 'a tenth agent', desc: 'Mythos becomes hireable, priced past the daemon', cost: 10, need: 'daemon' },
  { id: 'factory', group: 'perk', name: 'an eleventh agent', desc: 'the software factory becomes hireable, priced past Mythos', cost: 25, need: 'mythos' },
  { id: 'founder', group: 'perk', name: 'a twelfth agent', desc: 'the founder becomes hireable, priced past the factory', cost: 50, need: 'factory' },
  { id: 'golden', group: 'perk', name: 'golden age', desc: 'timed boosts from surprises last twice as long', cost: 10 },
  { id: 'bulk', group: 'perk', name: 'bulk licensing', desc: 'every upgrade costs 10% less per level, down to half price', cost: [5, 10, 20, 40, 80], max: 5 },
  { id: 'volume', group: 'perk', name: 'volume pricing', desc: 'each agent costs 14% more than the last instead of 15%, then 13%, then 12%', cost: [25, 50, 100], max: 3 },
  { id: 'procurement', group: 'perk', name: 'procurement', desc: 'buys every upgrade the bank covers on its own, once a second, while the tab is on screen', cost: 25 },
  { id: 'pride', group: 'perk', name: 'the trophy case', desc: 'every milestone adds 3% to the mine instead of 2%', cost: 20 },
  { id: 'sponsors', group: 'perk', name: 'GitHub sponsors', desc: 'every star held adds 11% to the mine instead of 10%, then 12%, up to 15%', cost: [50, 100, 200, 400, 800], max: 5 },
  { id: 'board', group: 'perk', name: 'a thirteenth agent', desc: 'the board becomes hireable, priced past the founder', cost: 250, need: 'founder' },
  // repeatables: no last level; each one costs twice the one before, and never less than 2% of every star earned on this listing
  { id: 'vp', group: 'perk', name: 'a VP of engineering', desc: 'every agent mines 25% faster per VP, with no last VP', cost: (lvl, g) => mineRepeatCost(g, 5, lvl), max: Infinity },
  { id: 'ergo', group: 'perk', name: 'ergonomics', desc: 'clicks are worth 25% more per level, with no last level', cost: (lvl, g) => mineRepeatCost(g, 3, lvl), max: Infinity },
  { id: 'party', group: 'perk', name: 'the release party', desc: 'commit bonuses pay 50% more per level, with no last level', cost: (lvl, g) => mineRepeatCost(g, 10, lvl), max: Infinity },
  { id: 'onboard', group: 'perk', name: 'onboarding', desc: 'head start brings ten more interns per level', cost: (lvl, g) => mineRepeatCost(g, 5, lvl), max: Infinity, need: 'head' },
  { id: 'round', group: 'perk', name: 'a funding round', desc: 'the mine runs ×2 until the next release; each round this run costs twice the last, starting at 5% of the stars held', cost: (lvl, g) => Math.max(1, Math.ceil(g.stars * 0.05 * Math.pow(2, g.rounds))), max: Infinity },
  { id: 'bounty', group: 'perk', name: 'a bounty', desc: 'the first sprint still open today counts as done, for twice the stars it pays; the streak counts it', cost: (lvl, g) => { const goal = mineSprintToday(g).goals.find((x) => !x.done); return goal ? 2 * mineSprintPay(g, goal) : null; }, max: Infinity },
  // the exchange: what shares buy once the repo has gone public
  { id: 'acquirer', group: 'shares', cur: 'shares', name: 'a fourteenth agent', desc: 'the acquirer becomes hireable, priced past the board', cost: 5, need: 'board' },
  { id: 'regulator', group: 'shares', cur: 'shares', name: 'a fifteenth agent', desc: 'the regulator becomes hireable, priced past the acquirer', cost: 10, need: 'acquirer' },
  { id: 'agi', group: 'shares', cur: 'shares', name: 'a sixteenth agent', desc: 'the AGI becomes hireable, priced past the regulator', cost: 25, need: 'regulator' },
  { id: 'fork', group: 'shares', cur: 'shares', name: 'a seventeenth agent', desc: 'the open-source fork becomes hireable, priced past the AGI', cost: 50, need: 'agi' },
  { id: 'wire2', group: 'shares', cur: 'shares', name: 'a second wire', desc: 'two lines of news under the banner', cost: 3 },
  { id: 'dividend', group: 'shares', cur: 'shares', name: 'dividends', desc: 'a clean sprint day also pays 1% of the market cap in stars, per level', cost: [10, 20, 40, 80, 160], max: 5 },
  { id: 'float', group: 'shares', cur: 'shares', name: 'a secondary offering', desc: 'the first-day pop on a listing goes from 25% to 35%, then 10% more per level', cost: [5, 10, 20, 40, 80], max: 5 },
  { id: 'analyst', group: 'shares', cur: 'shares', name: 'an analyst', desc: 'the exchange shows the fair value and how far over or under it the price sits', cost: 2 },
  { id: 'broker', group: 'shares', cur: 'shares', name: 'a prime broker', desc: 'the spread on a trade goes from 1% to 0.5%, then 0.25%, then nothing', cost: [3, 6, 12], max: 3 },
  { id: 'index', group: 'shares', cur: 'shares', name: 'index inclusion', desc: 'the price drifts up 2% a day on its own instead of 1%, then 3%, then 4%', cost: [5, 10, 20], max: 3 },
  { id: 'ir', group: 'shares', cur: 'shares', name: 'investor relations', desc: 'every real commit lifts the price 2% instead of 1%, then 3%, then 4%', cost: [5, 10, 20], max: 3 },
  { id: 'vol', group: 'shares', cur: 'shares', name: 'volatility', desc: 'news moves the price 50% more per level, both ways: deeper dips to buy, taller pops to sell into', cost: [10, 20, 40], max: 3 },
  { id: 'hype', group: 'shares', cur: 'shares', name: 'the hype machine', desc: 'good news lands 50% harder and bad news 25% softer', cost: 25 },
  { id: 'commitx', group: 'shares', cur: 'shares', name: 'the buyback', desc: 'commit bonuses pay double per level, with no last level', cost: (lvl) => 5 * Math.pow(2, lvl), max: Infinity },
  { id: 'softer', group: 'shares', cur: 'shares', name: 'the prospectus', desc: 'the soft star curve bends later: stars count in full to 2,000 instead of 1,000, then 4,000, then 8,000', cost: [20, 40, 80], max: 3 },
  { id: 'skin-gold', group: 'kcoder', name: 'gold banner', desc: 'the KCODER banner in gold, everywhere it shows', cost: 1 },
  { id: 'skin-neon', group: 'kcoder', name: 'neon banner', desc: 'pink to cyan with a glow', cost: 1 },
  { id: 'skin-matrix', group: 'kcoder', name: 'matrix banner', desc: 'green rain, top to bottom', cost: 1 },
  { id: 'skin-amber', group: 'kcoder', name: 'retro amber banner', desc: 'the terminal your first computer had', cost: 1 },
  { id: 'skin-mono', group: 'kcoder', name: 'monochrome banner', desc: 'white to grey, no colour at all', cost: 1 },
  { id: 'skin-rainbow', group: 'kcoder', name: 'rainbow banner', desc: 'every colour, left to right', cost: 5 },
  { id: 'names', group: 'kcoder', name: 'name your agents', desc: 'click an agent\'s name on the agents card to rename it; the wire follows', cost: 1 },
  { id: 'confetti', group: 'kcoder', name: 'confetti on commit', desc: 'a short burst over the app whenever a session commits, with an off switch', cost: 1 },
  { id: 'pet', group: 'kcoder', name: 'a status bar pet', desc: 'a little creature in the status bar that works while sessions work and naps when they stop', cost: 2 },
  { id: 'pet-cat', group: 'kcoder', name: 'pet: a cat', desc: 'a different pet for the status bar', cost: 1, need: 'pet' },
  { id: 'pet-dog', group: 'kcoder', name: 'pet: a dog', desc: 'a different pet for the status bar', cost: 1, need: 'pet' },
  { id: 'pet-bear', group: 'kcoder', name: 'pet: a bear', desc: 'a different pet for the status bar', cost: 1, need: 'pet' },
  { id: 'pet-flip', group: 'kcoder', name: 'pet: the table flipper', desc: 'a different pet for the status bar; it has opinions', cost: 1, need: 'pet' },
  { id: 'pet-duck', group: 'kcoder', name: 'pet: a duck', desc: 'a rubber duck for the status bar; explain the bug to it', cost: 1, need: 'pet' },
  { id: 'pet-dragon', group: 'kcoder', name: 'pet: a dragon', desc: 'a dragon for the status bar; it breathes on the build', cost: 3, need: 'pet' },
  { id: 'verbs-pirate', group: 'kcoder', name: 'pirate verbs', desc: 'sessions swab the deck and count doubloons while they work', cost: 2 },
  { id: 'verbs-victorian', group: 'kcoder', name: 'Victorian verbs', desc: 'sessions take the air and ring for tea while they work', cost: 2 },
  { id: 'verbs-minecraft', group: 'kcoder', name: 'Minecraft verbs', desc: 'sessions punch trees and avoid creepers while they work', cost: 2 },
];
const MINE_SKINS = { gold: 'gold', neon: 'neon', matrix: 'matrix', amber: 'retro amber', mono: 'monochrome', rainbow: 'rainbow' };
const MINE_VERB_SETS = {
  pirate: ['Swabbing the deck', 'Hoisting the mainsail', 'Plundering', 'Keelhauling the bug', 'Walking the plank', 'Splicing the mainbrace', 'Counting doubloons', 'Reading the charts', 'Battening down', 'Parleying', 'Weighing anchor', 'Scuttling', 'Shivering timbers'],
  victorian: ['Perambulating', 'Taking the air', 'Consulting the almanac', 'Composing a letter', 'Dusting the ledger', 'Awaiting the post', 'Adjusting the monocle', 'Stoking the boiler', 'Ringing for tea', 'Making enquiries', 'Retiring to the study', 'Telegraphing ahead'],
  minecraft: ['Mining diamonds', 'Punching trees', 'Crafting a table', 'Smelting', 'Enchanting', 'Avoiding creepers', 'Digging straight down', 'Brewing potions', 'Taming a wolf', 'Building a dirt hut', 'Trading with villagers', 'Sleeping through the night'],
};
const MINE_PETS = {
  blob: { name: 'the blob', work: ['(•‿•)', '(•◡•)', '(•‿•)', '(•ᴗ•)'], idle: '(•_•)', sleep: '(-‿-) z' },
  cat: { name: 'a cat', work: ['(=^･ω･^=)', '(=^･ｪ･^=)'], idle: '(=^･ω･^=)', sleep: '(=^-ω-^=) z' },
  dog: { name: 'a dog', work: ['(ᵔᴥᵔ)', '(ᵔᴥᵔ)ﾉ'], idle: '(ᵔᴥᵔ)', sleep: '(-ᴥ-) z' },
  bear: { name: 'a bear', work: ['ʕ•ᴥ•ʔ', 'ʕ•ᴥ•ʔﾉ'], idle: 'ʕ•ᴥ•ʔ', sleep: 'ʕ-ᴥ-ʔ z' },
  flip: { name: 'the table flipper', work: ['(╯°□°)╯︵ ┻━┻', '(ノ°□°)ノ︵ ┻━┻'], idle: '(°□°) ┬─┬', sleep: '(-□-) ┬─┬ z' },
  duck: { name: 'a duck', work: ['( ･ө･)', '( ･ө･)ﾉ'], idle: '( ･ө･)', sleep: '( -ө-) z' },
  dragon: { name: 'a dragon', work: ['(≖ᴗ≖)~♨', '(≖ᴗ≖)~♨♨'], idle: '(≖_≖)', sleep: '(≖‿≖) z' },
};
const MINE_RANKS = [[1, 'token miner'], [3, 'foreman'], [5, 'pit boss'], [10, 'token baron'], [25, 'mining magnate'], [50, 'a constellation'], [100, 'the Milky Way'], [250, 'the Local Group'], [1000, 'the observable universe'], [5000, 'the multiverse'],
  [25000, 'the omniverse'], [100000, 'the simulation'], [500000, 'the simulation\'s simulation'], [2.5e6, 'the heat death'], [1e7, 'the reboot']];   // past the reboot the rank keeps going by powers of ten
const MINE_PUBLIC_RANKS = [[0, 'listed'], [1e4, 'small cap'], [1e5, 'mid cap'], [1e6, 'large cap'], [1e7, 'the S&P 500'], [1e8, 'the Dow'], [1e9, 'too big to fail'], [1e12, 'the whole market']];   // by market cap, in stars
const mineStarsLife = (g) => g.starsEver + g.ipoStars;   // stars earned over every listing: the rank and the star milestones never reset
const mineRank = (g) => { const n = mineStarsLife(g); let r = ''; for (const [k, name] of MINE_RANKS) if (n >= k) r = name; if (n >= 1e8) r = `the reboot ×${fmtMine(Math.pow(10, Math.floor(Math.log10(n / 1e7))))}`; return r; };
const minePublicRank = (g) => { let r = ''; if (!g.ipo) return r; const c = mineCap(g); for (const [k, name] of MINE_PUBLIC_RANKS) if (c >= k) r = name; return r; };
const mineRankLine = (g) => [minePublicRank(g), mineRank(g)].filter(Boolean).join(' · ');
const mineHas = (g, id) => (g.shop[id] || 0) > 0;
const mineLevel = (g, id) => g.shop[id] || 0;
const mineUnitsOpen = (g) => mineUnitsAll(g).filter((u) => !u.need || mineHas(g, u.need));
const mineAwayCap = (g) => [8, 16, 24, 48, 168][Math.min(4, mineLevel(g, 'shift'))] * 3600;
const mineShopCost = (it, lvl, g) => (typeof it.cost === 'function' ? it.cost(lvl, g || mine || mineLoad()) : Array.isArray(it.cost) ? it.cost[Math.min(lvl, it.cost.length - 1)] : it.cost);   // a perk with levels can price each one; a function prices from the mine (null: nothing to buy right now)
const mineRepeatCost = (g, base, lvl) => Math.max(Math.ceil(base * Math.pow(2, lvl)), Math.ceil(g.starsEver * 0.02));   // repeatables: doubling, never under 2% of the stars earned on this listing
const mineWallet = (g, it) => (it.cur === 'shares' ? g.shares : g.stars);
const mineCurName = (it, n) => `${fmtInt(n)} ${it.cur === 'shares' ? 'share' : 'star'}${n === 1 ? '' : 's'}`;
const mineRatio = (g) => 1.15 - 0.01 * Math.min(3, mineLevel(g || mine || { shop: {} }, 'volume'));   // the price curve: each agent costs this much more than the last (volume pricing flattens it)
const mineUpCost = (g, up) => Math.ceil(up.cost * (1 - 0.1 * Math.min(5, mineLevel(g, 'bulk'))));   // bulk licensing takes 10% off per level
const mineComboWindow = (g) => mineHas(g, 'coach') ? 1500 : 900;
const mineComboCap = (g) => mineLevel(g, 'coach') >= 2 ? 100 : 80;
const mineWho = (g, id, plain) => g.names[id] || plain;
const mineUnitName = (g, u) => g.names[u.id] || u.name;
let mine = null, mineTimer = null, mineSaveTimer = null, mineTicks = 0, mineNoteTimer = null, mineGold = null, mineNewsLast = '';
const mineCombo = { n: 0, at: 0 };   // fast clicks in a row (transient)
const mineSeen = [];   // live events already paid, so a reconnect replay never pays twice
function mineNormalize(g) {
  const n = { v: 5, bank: 0, total: 0, clicks: 0, units: {}, ups: [], ach: [], real: { turns: 0, tokens: 0, commits: 0, bonus: 0 }, caught: 0, bestCombo: 0, night: false, capped: false, releases: 0, stars: 0, starsEver: 0, starsBonus: 0, spent: 0, shop: {}, names: {}, cos: {}, keepUp: '', hired: 0, upsBought: 0, big: 0, sprint: null, sprintsDone: 0, sprintDays: 0, streak: 0, boost: null, clickBoost: null,
    shares: 0, ipo: 0, ipoStars: 0, ipoReleases: 0, totalIpo: 0, mined: null, rounds: 0, relAt: 0, bestRel: 0, runs: [], fastRel: 0, tiersBought: 0, frenzies: 0, bigHires: 0, week: null, weeksDone: 0, hardDone: 0, perfectDays: 0,
    px: 0, pxIpo: 0, fair: 0, fairAt: 0, shock: 0, noise: 0, pxDay: '', pxOpen: 0, pxHigh: 0, hist: [], event: null, basis: 0, trades: 0, invested: 0, cashed: 0, bought: 0, dipBuys: 0, gains: 0, arcade: {}, last: Date.now(), started: Date.now(), ...(g && typeof g === 'object' ? g : {}) };
  n.real = { turns: 0, tokens: 0, commits: 0, bonus: 0, ...(n.real || {}) }; n.units = n.units || {}; n.ups = Array.isArray(n.ups) ? n.ups : []; n.ach = Array.isArray(n.ach) ? n.ach : [];
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}); n.shop = obj(n.shop); n.names = obj(n.names); n.arcade = obj(n.arcade); n.cos = { skin: '', verbs: '', pet: '', confetti: true, ...obj(n.cos) }; n.keepUp = typeof n.keepUp === 'string' ? n.keepUp : '';
  for (const k of ['bank', 'total', 'clicks', 'last', 'started', 'caught', 'bestCombo', 'releases', 'stars', 'starsEver', 'starsBonus', 'spent', 'hired', 'upsBought', 'big', 'sprintsDone', 'sprintDays', 'streak', 'shares', 'ipo', 'ipoStars', 'ipoReleases', 'totalIpo', 'rounds', 'relAt', 'bestRel', 'fastRel', 'tiersBought', 'frenzies', 'bigHires', 'weeksDone', 'hardDone', 'perfectDays', 'px', 'pxIpo', 'fair', 'fairAt', 'shock', 'noise', 'pxOpen', 'pxHigh', 'basis', 'trades', 'invested', 'cashed', 'bought', 'dipBuys', 'gains']) n[k] = Number(n[k]) || 0;
  n.hist = Array.isArray(n.hist) ? n.hist.filter((h) => Array.isArray(h) && h.length === 2).slice(-120) : []; n.event = n.event && typeof n.event === 'object' && typeof n.event.name === 'string' ? n.event : null; n.pxDay = typeof n.pxDay === 'string' ? n.pxDay : '';
  if (n.ipo && !(n.px > 0)) {   // a listing from before the market had a price: the shares are priced from the stars that became them, with the pop
    const held = Math.max(1000, n.ipoStars - n.spent); n.px = n.fair = n.pxIpo = n.pxOpen = n.pxHigh = n.basis = held * 1.25 / Math.max(1, n.shares);
    n.fairAt = Date.now(); n.pxDay = mineDay(); n.shock = 0; n.noise = 0; n.hist = [[Date.now(), Math.round(n.px * 100) / 100]];
  }
  n.mined = Number(n.mined) || (n.mined === 0 ? 0 : Math.max(0, n.total - n.totalIpo));   // a save from before the counter: what the total says
  n.runs = Array.isArray(n.runs) ? n.runs.slice(-6) : []; if (!n.relAt) n.relAt = n.started;   // the release clock starts with the mine for a save from before it
  n.week = n.week && typeof n.week === 'object' && typeof n.week.key === 'string' && n.week.goal ? n.week : null;
  if (!n.ipo) n.starsEver = Math.max(n.starsEver, n.stars);   // a mine saved before the shop: every star it has is one it earned (once public, sold shares bring in stars that were counted already)
  n.sprint = n.sprint && typeof n.sprint === 'object' && typeof n.sprint.day === 'string' && Array.isArray(n.sprint.goals) ? n.sprint : null;
  n.ach = n.ach.map((id) => (id === 'real1k' ? 'real500' : id));   // the turns milestone came down from a thousand to five hundred
  for (const k of ['boost', 'clickBoost']) if (n[k] && !(Number(n[k].until) > 0 && Number(n[k].mult) > 1)) n[k] = null;
  return n;
}
function mineLoad() { if (mine) return mine; let g = null; try { g = JSON.parse(localStorage.getItem('kcoder.mine') || 'null'); } catch {} mine = mineNormalize(g); return mine; }
function mineAdopt(theirs) { const g = mineLoad(); const t = mineNormalize(theirs); if (t.total > g.total) { mine = t; mineSave(true); mineApplyCosmetics(); if (state.view === 'fun') { const b = $('#fun-body'); delete b.dataset.built; renderFunView(); } } }
function uiStateOut() { const out = { layout: state.layout, order: state.order, view: state.view, saved: Date.now() }; if (mine) out.mine = mine; return out; }
const mineStarsFor = (total) => Math.floor(Math.cbrt(Math.max(0, total) / 1e6));   // 1 star at a million mined all time, 10 at a billion, 100 at a trillion
const mineStarsDue = (g) => mineStarsFor(g.mined) - (g.starsEver - g.starsBonus);   // stars a release would pay now, from what was mined on this listing; sprint stars never count against it
// tokens coming in: the bank, the all-time total and the listing's own count. the total of a late mine is past 1e22, where a
// double cannot add a million, so release stars come from `mined`, which starts at zero with every listing and stays exact
const mineAdd = (g, x) => { g.bank += x; g.total += x; g.mined += x; };
const mineSoftKnee = (g) => 1000 * Math.pow(2, Math.min(3, mineLevel(g, 'softer')));   // where the star curve bends once the repo is public (the prospectus moves it out)
const mineSoftStars = (g, stars) => (!g.ipo || stars <= mineSoftKnee(g) ? stars : mineSoftKnee(g) + Math.sqrt((stars - mineSoftKnee(g)) * mineSoftKnee(g)));   // before going public every star counts in full; after, the ones past the knee count by the square root
const mineStarPct = (g) => 0.1 + 0.01 * Math.min(5, mineLevel(g, 'sponsors'));   // what a star held (or a star of market cap) adds to the mine
const mineMultWith = (g, stars) => (1 + mineStarPct(g) * (mineSoftStars(g, stars) + mineCap(g))) * (1 + (mineHas(g, 'pride') ? 0.03 : 0.02) * g.ach.length);
const mineMult = (g) => mineMultWith(g, g.stars);   // stars held, the market cap and the milestones lift everything (more per star with sponsors, more per milestone with the trophy case)
// the exchange: once the repo is public every share has a price in stars, and shares × price (the market cap) lifts the
// mine like stars held do, in full. the price drifts up on its own, jumps for good on real commits and releases, and news
// knocks it about for a while and fades (buy the dip, sell the pop); shares trade for stars either way at a spread
const MINE_TICKER = 'KCDR';
const MINE_MARKET_EVENTS = [   // [what happened, low, high, weight]: the knock to the price, as a fraction, fading over ten minutes or so
  ['an analyst upgrade', 0.06, 0.12, 3], ['an analyst downgrade', -0.12, -0.06, 3], ['an earnings beat', 0.12, 0.25, 2], ['an earnings miss', -0.2, -0.1, 2],
  ['a short report', -0.22, -0.12, 2], ['an activist investor', 0.05, 0.12, 2], ['a rate hike', -0.1, -0.05, 2], ['index rebalancing', 0.08, 0.15, 1],
  ['a letter from the regulator', -0.25, -0.15, 1], ['a data breach', -0.3, -0.2, 1], ['AI hype', 0.2, 0.4, 1], ['meme stock Monday', 0.3, 0.6, 1],
  ['a flash crash', -0.5, -0.35, 0.3], ['a short squeeze', 0.4, 0.8, 0.3],
];
const mineCap = (g) => (g.ipo ? g.shares * g.px : 0);   // the market cap, in stars
const mineSpread = (g) => [0.01, 0.005, 0.0025, 0][Math.min(3, mineLevel(g, 'broker'))];
const mineAsk = (g) => g.px * (1 + mineSpread(g)), mineBid = (g) => g.px * (1 - mineSpread(g));
const minePop = (g) => 1.25 + 0.1 * Math.min(5, mineLevel(g, 'float'));   // the first-day pop: a listing is worth this much over the stars it takes
const mineDrift = (g) => 0.01 * (1 + Math.min(3, mineLevel(g, 'index')));   // the fair value's drift per day, on its own
const fmtPx = (x) => (x >= 1000 ? fmtMine(Math.round(x)) : x >= 100 ? x.toFixed(1) : (Math.round(x * 100) / 100).toFixed(2));
const randn = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const minePxNow = (g) => Math.max(0.01, g.fair * (1 + g.shock) * (1 + g.noise));
const mineSpark = (hist) => { if (hist.length < 2) return ''; const ys = hist.map((h) => h[1]); const lo = Math.min(...ys), span = Math.max(...ys) - lo || 1; return hist.map((h, i) => `${(i / (hist.length - 1) * 200).toFixed(1)},${(38 - (h[1] - lo) / span * 36).toFixed(1)}`).join(' '); };
function mineMarketTick(g, now = Date.now()) {   // the price catches up to now: the drift, the news fading, a wobble that reverts over a couple of minutes; away time counts
  if (!g.ipo || !(g.fair > 0)) return; const dt = Math.max(0, (now - (g.fairAt || now)) / 1000); g.fairAt = now;
  if (dt > 0) { g.fair *= Math.pow(1 + mineDrift(g), dt / 86400); g.shock *= Math.exp(-dt / 600); const a = Math.exp(-dt / 120); g.noise = Math.max(-0.08, Math.min(0.08, g.noise * a + 0.02 * Math.sqrt(1 - a * a) * randn())); }
  g.px = minePxNow(g); const day = mineDay(); if (g.pxDay !== day) { g.pxDay = day; g.pxOpen = g.px; } if (g.px > g.pxHigh) g.pxHigh = g.px;
  const last = g.hist[g.hist.length - 1]; if (!last || now - last[0] >= 30000) { g.hist.push([now, Math.round(g.px * 100) / 100]); if (g.hist.length > 120) g.hist.splice(0, g.hist.length - 120); }   // a point every thirty seconds, an hour of tape
}
function mineFairBump(g, pct) { if (!g.ipo || !(g.fair > 0)) return; g.fair *= 1 + pct; g.px = minePxNow(g); if (g.px > g.pxHigh) g.pxHigh = g.px; }   // real work moves the fair value, for good
function mineMarketEvent(g, name) {   // news: a knock to the price that fades (harder with volatility; the hype machine tilts it)
  let ev = MINE_MARKET_EVENTS.find((x) => x[0] === name);
  if (!ev) { let r = Math.random() * MINE_MARKET_EVENTS.reduce((a, x) => a + x[3], 0); ev = MINE_MARKET_EVENTS.find((x) => (r -= x[3]) < 0) || MINE_MARKET_EVENTS[0]; }
  let pct = (ev[1] + Math.random() * (ev[2] - ev[1])) * (1 + 0.5 * Math.min(3, mineLevel(g, 'vol'))); if (mineHas(g, 'hype')) pct *= pct > 0 ? 1.5 : 0.75;
  g.shock = Math.max(-0.9, g.shock + pct); g.event = { name: ev[0], pct, at: Date.now() }; g.px = minePxNow(g); if (g.px > g.pxHigh) g.pxHigh = g.px;
  mineNote(`${ev[0]}: ${MINE_TICKER} ${pct > 0 ? 'up' : 'down'} ${Math.round(Math.abs(pct) * 100)}%, now ${fmtPx(g.px)}`); mineNews(g); mineSave();
}
async function mineTrade(side, qty) {   // shares for stars at the ask, stars for shares at the bid; stars from a sale were counted when first earned, so they are not earned again
  let g = mineAccrue(); if (!g.ipo || !(g.px > 0)) return;
  if (side === 'buy') {
    const ask = mineAsk(g); const n = qty === 'max' ? Math.floor(g.stars / ask) : qty; const cost = Math.ceil(n * ask); if (n < 1 || g.stars < cost) return;
    const dip = g.px <= g.fair * 0.95; g.basis = (g.basis * g.shares + cost) / (g.shares + n); g.shares += n; g.stars -= cost; g.invested += cost; g.bought += n; g.trades += 1; if (dip) g.dipBuys += 1;
    mineNote(`bought ${fmtInt(n)} share${n === 1 ? '' : 's'} at ${fmtPx(ask)} for ${fmtInt(cost)} star${cost === 1 ? '' : 's'}${dip ? ' · on the dip' : ''}`);
  } else {
    if (g.shares < 1) return;
    if (qty === 'all') { const got = Math.floor(g.shares * mineBid(g)); const ok = await confirmDialog(`Sell all ${fmtInt(g.shares)} share${g.shares === 1 ? '' : 's'}?`, `About ${fmtInt(got)} stars at the bid. The market cap goes to nothing until you buy back in, and the mine with it: from ×${fmtMine(Math.round(mineMult(g) * 100) / 100)} to ×${fmtMine(Math.round(mineMultWith({ ...g, shares: 0 }, g.stars + got) * 100) / 100)}.`); if (!ok) return; g = mineAccrue(); if (g.shares < 1) return; }
    const n = qty === 'all' ? g.shares : Math.min(qty, g.shares); const bid = mineBid(g); const got = Math.floor(n * bid); if (got < 1) return;
    const gain = got - n * g.basis; const had = g.basis > 0; g.shares -= n; g.stars += got; g.cashed += got; g.trades += 1; if (gain > 0) g.gains += gain; if (!g.shares) g.basis = 0;
    mineNote(`sold ${fmtInt(n)} share${n === 1 ? '' : 's'} at ${fmtPx(bid)} for ${fmtInt(got)} stars${had ? ` (${gain >= 0 ? 'up' : 'down'} ${fmtInt(Math.round(Math.abs(gain)))} on what they cost)` : ''}`);
  }
  mineSave(true); mineCheck(g); mineRefresh();
}
const mineAgentMult = (g) => (1 + 0.25 * mineLevel(g, 'vp')) * Math.pow(2, g.rounds);   // the agents only: VPs of engineering and this run's funding rounds
function mineBaseRate(g) { let r = 0; const mults = mineUnitMults(g); for (const u of mineUnitsAll(g)) r += (g.units[u.id] || 0) * u.rate * (mults[u.id] || 1); return r * mineMult(g) * mineAgentMult(g); }
const mineBoostOn = (b, now = Date.now()) => !!(b && b.until > now && b.mult > 1);
function mineRate(g) { return mineBaseRate(g) * (mineBoostOn(g.boost) ? g.boost.mult : 1); }
function mineClickValue(g) { let v = 1, sec = 0; for (const id of g.ups) { const up = mineUpById(g, id); if (!up) continue; if (up.click) v *= up.click; if (up.clickSec) sec += up.clickSec; } return v * mineMult(g) * (1 + 0.25 * mineLevel(g, 'ergo')) * (mineBoostOn(g.clickBoost) ? g.clickBoost.mult : 1) + mineRate(g) * sec; }
const mineComboMult = (n, g) => 1 + Math.min(Math.max(0, n - 1), g ? mineComboCap(g) : 80) * 0.05;   // ×1 on the first click, ×3 after forty fast ones, ×5 after eighty (×6 after a hundred with the combo coach)
const mineUnitCost = (u, n) => Math.ceil(u.cost * Math.pow(mineRatio(), n));
const mineUnitCostN = (u, owned, n) => { const r = mineRatio(); return Math.ceil(u.cost * Math.pow(r, owned) * (Math.pow(r, n) - 1) / (r - 1)); };   // n agents in a row from `owned`
const mineMaxAffordable = (u, owned, bank) => { const r = mineRatio(); return Math.max(0, Math.floor(Math.log(bank * (r - 1) / (u.cost * Math.pow(r, owned)) + 1) / Math.log(r))); };
const fmtDurLong = (s) => (s < 3600 ? fmtDur(s) : s < 86400 ? `${Math.round(s / 360) / 10} h` : `${Math.round(s / 8640) / 10} days`);
const mineEta = (g, cost) => { if (g.bank >= cost) return 'affordable now'; const r = mineRate(g); if (r <= 0) return 'no income yet'; const s = Math.max(1, (cost - g.bank) / r); return s > 365 * 86400 ? 'over a year at this rate' : `~${fmtDurLong(s)} at this rate`; };
let mineQty = 1;   // the buy amount picked on the agents card: 1, 10, 100 or 'max'
const mineBuyCount = (u, g) => mineQty === 'max' ? mineMaxAffordable(u, g.units[u.id] || 0, g.bank) : mineQty;
function mineAccrue() {
  const g = mineLoad(); const now = Date.now(); const cap = mineAwayCap(g); const dt = Math.min(cap, Math.max(0, (now - g.last) / 1000));
  mineMarketTick(g, now);
  if (dt > 0) {
    const base = mineBaseRate(g); let got = base * dt;
    if (mineBoostOn(g.boost, g.last)) got += base * (g.boost.mult - 1) * Math.min(dt, Math.max(0, (Math.min(g.boost.until, now) - g.last) / 1000));
    mineAdd(g, got); if (dt >= cap) g.capped = true;
    if (dt > 120 && got >= 1) mineNote(`mined ${fmtFull(got)} while you were away (${fmtDur(Math.round(dt))}${dt >= cap ? `, the ${cap / 3600}-hour cap` : ''})`);
  }
  if (g.boost && g.boost.until <= now) g.boost = null;
  if (g.clickBoost && g.clickBoost.until <= now) g.clickBoost = null;
  g.last = now; return g;
}
function mineSave(now) {
  const g = mineLoad(); try { localStorage.setItem('kcoder.mine', JSON.stringify(g)); } catch {}
  clearTimeout(mineSaveTimer); mineSaveTimer = setTimeout(() => { if (state.connected) request('ui_state', { state: uiStateOut() }).catch(() => {}); }, now ? 0 : 5000);
}
function mineNote(text) { const el = $('#mine-note'); if (!el) return; el.textContent = text; clearTimeout(mineNoteTimer); mineNoteTimer = setTimeout(() => { if (el.isConnected) el.textContent = ''; }, 6000); }
function mineCheck(g) {   // milestones: tested after anything that changes the mine; each one earned lifts the mine 2% (the sprints are checked here too)
  mineSprintCheck(g);
  const got = MINE_MILESTONES.filter((m) => !g.ach.includes(m.id) && m.test(g)); if (!got.length) return;
  for (const m of got) g.ach.push(m.id);
  const pct = mineHas(g, 'pride') ? 3 : 2; if (got.length <= 2) for (const m of got) toast(`milestone: ${m.name} (+${pct}% to the mine)`); else toast(`${got.length} milestones at once (+${got.length * pct}% to the mine)`);
  mineSave();
}
function mineOnEvent(sid, ev) {
  const key = `${sid}:${ev.t}:${ev.ts || ''}:${ev.commit || ''}`; if (mineSeen.includes(key)) return; mineSeen.push(key); if (mineSeen.length > 200) mineSeen.shift();
  const g = mineAccrue();
  const x = mineHas(g, 'double') ? 2 : 1;
  if (ev.t === 'usage') { const got = Math.max(0, Math.round(Number(ev.output) || 0)) * x; if (!got) return; mineAdd(g, got); g.real.turns += 1; g.real.tokens += got; mineFairBump(g, 0.0005); mineNote(`+${fmtFull(got)} from a real turn${x > 1 ? ', doubled' : ''}`); }
  else { const bonus = Math.round(Math.max(100, Math.round(mineRate(g) * 60)) * x * (1 + 0.5 * mineLevel(g, 'party')) * Math.pow(2, mineLevel(g, 'commitx'))); mineAdd(g, bonus); g.real.commits += 1; g.real.bonus += bonus; mineFairBump(g, 0.01 * (1 + Math.min(3, mineLevel(g, 'ir')))); mineNote(`+${fmtFull(bonus)} for commit ${ev.commit}${x > 1 ? ', doubled' : ''}`); if (mineHas(g, 'confetti') && g.cos.confetti) confettiBurst(); }
  mineSave(); mineCheck(g); if (state.view === 'fun') mineRefresh();
}
function mineBuy(kind, id) {
  const g = mineAccrue();
  if (kind === 'unit') { const u = mineUnitsAll(g).find((x) => x.id === id); if (!u) return; const owned = g.units[u.id] || 0; const n = mineBuyCount(u, g); const cost = n ? mineUnitCostN(u, owned, n) : Infinity; if (g.bank < cost) return; g.bank -= cost; g.units[u.id] = owned + n; g.hired += n; if (n >= 100) g.bigHires += 1; if (n > 1) mineNote(`hired ${fmtInt(n)} × ${u.name} for ${fmtFull(cost)} tokens`); }
  else if (kind === 'ups-all') { const [bought, spent] = mineBuyAllUps(g); if (!bought) return; mineNote(`bought ${bought} upgrade${bought === 1 ? '' : 's'} for ${fmtFull(spent)} tokens`); }
  else { const up = mineUpById(g, id); const c = up ? mineUpCost(g, up) : Infinity; if (!up || g.ups.includes(up.id) || g.bank < c) return; g.bank -= c; g.ups.push(up.id); g.upsBought += 1; if (up.unit) g.tiersBought += 1; }
  mineSave(); mineCheck(g); mineRefresh();
}
function mineBuyAllUps(g) {   // the cheapest open upgrade the bank covers, over and over: [how many, for how much]
  let bought = 0, spent = 0;
  for (;;) { const next = mineUpgradesOpen(g).map((up) => [up, mineUpCost(g, up)]).filter(([, c]) => c <= g.bank).sort((a, b) => a[1] - b[1])[0]; if (!next) break; g.bank -= next[1]; g.ups.push(next[0].id); bought += 1; spent += next[1]; if (next[0].unit) g.tiersBought += 1; }
  g.upsBought += bought; return [bought, spent];
}
function mineUpgradesOpen(g) { return mineUpgradesAll(g).filter((up) => !g.ups.includes(up.id) && (!up.need || g.ups.includes(up.need)) && (!up.unit || (g.units[up.unit] || 0) >= up.owned)); }
function mineClick(e) {
  const g = mineAccrue(); const now = Date.now();
  mineCombo.n = now - mineCombo.at < mineComboWindow(g) ? mineCombo.n + 1 : 1; mineCombo.at = now; const cm = mineComboMult(mineCombo.n, g); if (cm > g.bestCombo) g.bestCombo = cm;
  const v = mineClickValue(g) * cm; mineAdd(g, v); g.clicks += 1; if (cm >= 5) g.big += 1; const h = new Date().getHours(); if (h >= 2 && h < 5) g.night = true; mineSave();
  const head = $('.mine-head'); const r = head.getBoundingClientRect(); const pop = document.createElement('span'); pop.className = 'mine-pop'; pop.textContent = `+${fmtMine(Math.round(v * 10) / 10)}`;
  pop.style.left = `${(e.clientX || r.left + 60) - r.left + 8}px`; pop.style.top = `${(e.clientY || r.top + 40) - r.top - 10}px`; head.appendChild(pop); setTimeout(() => pop.remove(), 800);
  mineCheck(g); mineRefresh();
}
function mineSpawnSurprise(id) {   // a bubble somewhere in the part of the tab that is on screen, for twelve seconds; a click catches it
  const box = $('#fun-body'); const wrap = box && box.querySelector('.mine'); if (!wrap || mineGold) return;
  let s = MINE_SURPRISES.find((x) => x.id === id);
  if (!s) { let r = Math.random() * MINE_SURPRISES.reduce((a, x) => a + x.weight, 0); s = MINE_SURPRISES.find((x) => (r -= x.weight) < 0) || MINE_SURPRISES[0]; }
  const el = document.createElement('button'); el.className = 'mine-gold'; el.type = 'button'; el.dataset.gold = s.id; el.textContent = s.name;
  const r = box.getBoundingClientRect();   // fixed to the viewport, inside the tab's visible rectangle, so a long page never hides one below the fold
  el.style.left = `${Math.round(r.left + r.width * (0.08 + Math.random() * 0.7))}px`; el.style.top = `${Math.round(r.top + 60 + Math.random() * Math.max(0, r.height - 130))}px`;
  wrap.appendChild(el); mineGold = { s, el, timer: setTimeout(() => { if (mineGold && mineGold.el === el) { el.remove(); mineGold = null; } }, mineHas(mineLoad(), 'lucky') ? 24000 : 12000) };
}
function mineCatch() {
  if (!mineGold) return; const { s, el, timer } = mineGold; clearTimeout(timer); el.remove(); mineGold = null;
  const g = mineAccrue(); const now = Date.now(); g.caught += 1;
  if (s.kind === 'lump') { const got = Math.round(Math.max(25, Math.min(g.bank * 0.15, mineRate(g) * 900)) + 13); mineAdd(g, got); mineNote(`${s.name}: +${fmtFull(got)} tokens`); }
  else { const sec = s.sec * (mineHas(g, 'golden') ? 2 : 1); const b = { id: s.id, name: s.name, mult: s.mult, until: now + sec * 1000 }; if (s.kind === 'frenzy') { g.boost = b; g.frenzies += 1; mineNote(`${s.name}: the mine runs ×${s.mult} for ${sec} seconds`); } else { g.clickBoost = b; mineNote(`${s.name}: clicks are worth ×${s.mult} for ${sec} seconds`); } }
  mineSave(); mineCheck(g); mineRefresh();
}
function mineRunReset(g) {   // what a release and going public share: the run goes, head start and keep one come back, the clock restarts
  const keep = mineHas(g, 'keep') && g.ups.includes(g.keepUp) && mineUpById(g, g.keepUp);
  g.bank = 0; g.units = {}; g.ups = []; g.boost = null; g.clickBoost = null; g.rounds = 0;
  if (mineHas(g, 'head')) { g.units.intern = 10 + 10 * mineLevel(g, 'onboard'); g.ups.push('kbd'); }
  if (keep && !g.ups.includes(keep.id)) g.ups.push(keep.id);
  g.relAt = Date.now();
}
const mineRunSecs = (g, now = Date.now()) => Math.max(0, (now - (g.relAt || g.started)) / 1000);
function mineRunLog(g, kind, got) {   // the last six runs, and the best time
  const secs = Math.round(mineRunSecs(g)); if (kind === 'release' && (!g.bestRel || secs < g.bestRel)) g.bestRel = secs;
  g.runs = g.runs.concat([{ v: kind === 'release' ? g.releases : 0, kind, secs, got, at: Date.now() }]).slice(-6);
  const sp = g.sprint && g.sprint.goals.find((x) => x.id === 'speed' && !x.done); if (kind === 'release' && sp && secs <= sp.n) g.fastRel += 1;   // the day's speed sprint: a release inside its target
}
async function mineRelease() {
  let g = mineAccrue(); const can = mineStarsDue(g); if (can < 1) return;
  const keep = mineHas(g, 'keep') && g.ups.includes(g.keepUp) && mineUpById(g, g.keepUp);
  const ok = await confirmDialog(`Cut release v${g.releases + 1}?`, `Every agent, upgrade and banked token goes. You keep ${fmtInt(can)} new star${can === 1 ? '' : 's'} (the mine goes from ×${fmtMine(Math.round(mineMult(g) * 100) / 100)} to ×${fmtMine(Math.round(mineMultWith(g, g.stars + can) * 100) / 100)}, or spend them in the star shop), the milestones, the clicks and the real-work counters. This run took ${fmtDurLong(mineRunSecs(g))}${g.bestRel ? ` (best: ${fmtDurLong(g.bestRel)})` : ''}.${mineHas(g, 'head') ? ` Head start: ${10 + 10 * mineLevel(g, 'onboard')} interns and the keyboard come straight back.` : ''}${keep ? ` Keep one: ${keep.name} survives.` : ''}`);
  if (!ok) return; g = mineAccrue(); const got = mineStarsDue(g); if (got < 1) return; g.stars += got; g.starsEver += got; g.releases += 1; mineFairBump(g, 0.03);
  mineRunLog(g, 'release', got); mineRunReset(g);
  mineSave(true); mineCheck(g); mineNote(`v${g.releases} shipped: ${fmtInt(g.stars)} star${g.stars === 1 ? '' : 's'} on the repo`); mineRefresh();
}
// going public: the layer above releases. with a thousand stars held, every star held becomes shares with a first-day pop
// (the market cap starts 25% over the stars earned on the listing that became them, more with a secondary offering), and from
// then on shares × price lifts the mine in full while stars held past the knee count by their square root. stars, releases and
// the release star count start over on the new listing (the rank and the star milestones keep counting over every listing);
// everything from the shop stays. a later listing turns the stars held into more shares at the market's price, with the pop
// again on the stars earned on that listing (the rest, stars from selling shares, go at par, so sell-and-relist pays nothing)
const MINE_IPO_MIN = 1000;
const mineIpoValue = (g) => Math.max(0, g.stars) + Math.min(Math.max(0, g.stars), g.starsEver) * (minePop(g) - 1);   // what the stars held list for
const mineIpoShares = (g) => (g.ipo && g.px > 0 ? Math.floor(mineIpoValue(g) / g.px) : Math.floor(Math.cbrt(Math.max(0, g.stars))));
const mineIpoPx = (g, n) => (g.ipo && g.px > 0 ? g.px : mineIpoValue(g) / Math.max(1, n));   // the first listing prices the shares; later ones take the market's price
async function mineIpo() {
  let g = mineAccrue(); if (g.stars < MINE_IPO_MIN) return; const got = mineIpoShares(g); if (got < 1) return;
  const px = mineIpoPx(g, got); const after = { ...g, shares: g.shares + got, ipo: g.ipo + 1, stars: 0, px }; const pop = Math.round((minePop(g) - 1) * 100);
  const ok = await confirmDialog(g.ipo ? `List ${MINE_TICKER} again (listing ${g.ipo + 1})?` : `Take the repo public as ${MINE_TICKER}?`, `All ${fmtInt(g.stars)} stars held become ${fmtInt(got)} share${got === 1 ? '' : 's'} at ${fmtPx(px)} stars a share (${fmtInt(after.shares)} in all), with a first-day pop of ${pop}% on the ${fmtInt(Math.min(g.stars, g.starsEver))} earned on this listing: the market cap starts at ${fmtMine(Math.round(after.shares * px))} stars and lifts the mine like stars held do. ${g.ipo ? '' : `From then on the price moves (up on its own, up for good on real commits and releases, knocked about by news for a while) and the exchange trades shares for stars either way; stars held past ${fmtInt(mineSoftKnee(after))} count by their square root, the market cap in full. `}Stars, releases and the release star count start over on the new listing; the rank, the milestones, the real-work counters and everything from the shop stay. The mine goes from ×${fmtMine(Math.round(mineMult(g) * 100) / 100)} to ×${fmtMine(Math.round(mineMultWith(after, 0) * 100) / 100)}. The run resets like a release.`);
  if (!ok) return; g = mineAccrue(); if (g.stars < MINE_IPO_MIN) return; const n = mineIpoShares(g); if (n < 1) return; const p = mineIpoPx(g, n);
  mineRunLog(g, 'ipo', n); g.basis = (g.basis * g.shares + g.stars) / (g.shares + n);   // what the shares cost: the stars that became them
  if (!g.ipo) { g.px = g.fair = g.pxIpo = g.pxOpen = g.pxHigh = p; g.fairAt = Date.now(); g.pxDay = mineDay(); g.shock = 0; g.noise = 0; g.event = null; g.hist = [[Date.now(), Math.round(p * 100) / 100]]; }
  g.ipoStars += g.starsEver; g.ipoReleases += g.releases; g.ipo += 1; g.shares += n; g.stars = 0; g.starsEver = 0; g.starsBonus = 0; g.releases = 0; g.totalIpo = g.total; g.mined = 0;
  mineRunReset(g); mineSave(true); mineCheck(g); mineApplyCosmetics(); mineNews(g);
  const b = $('#fun-body'); if (b) { delete b.dataset.built; renderFunView(); }
  toast(`${MINE_TICKER} ${g.ipo > 1 ? 'listed again' : 'is public'}: ${fmtInt(n)} share${n === 1 ? '' : 's'} at ${fmtPx(p)}, ${fmtInt(g.shares)} outstanding`, 'ok'); if (mineHas(g, 'confetti') && g.cos.confetti) confettiBurst();
}
async function mineShopBuy(id) {   // a star (or a share) for a perk or a cosmetic; the star and its 10% go for good
  const g = mineAccrue(); const it = MINE_SHOP.find((x) => x.id === id); if (!it) return;
  const lvl = mineLevel(g, id); const cost = mineShopCost(it, lvl, g); if (cost == null || lvl >= (it.max || 1) || (it.need && !mineHas(g, it.need)) || mineWallet(g, it) < cost) return;
  const g2 = { ...g, shop: { ...g.shop, [id]: lvl + 1 }, stars: it.cur === 'shares' ? g.stars : g.stars - cost, shares: it.cur === 'shares' ? g.shares - cost : g.shares, rounds: g.rounds + (id === 'round' ? 1 : 0) };
  const before = mineRate(g), afterRate = mineRate(g2), after = mineMultWith(g2, g2.stars);
  const effect = before > 0 && Math.abs(afterRate - before) > 1e-9 ? `the mine ${afterRate < before ? 'drops' : 'goes'} from ${fmtMine(Math.round(before * 10) / 10)}/s to ${fmtMine(Math.round(afterRate * 10) / 10)}/s` : `the mine ${after < mineMult(g) ? 'drops' : 'goes'} from ×${fmtMine(Math.round(mineMult(g) * 100) / 100)} to ×${fmtMine(Math.round(after * 100) / 100)}`;
  const ok = await confirmDialog(`Spend ${mineCurName(it, cost)} on ${it.name}${it.max === Infinity ? ` (level ${lvl + 1})` : ''}?`, `${it.desc}. The ${it.cur === 'shares' ? 'share' : 'star'}${cost === 1 ? ' goes' : 's go'} for good: ${effect}.`);
  if (!ok) return; const h = mineAccrue(); if (mineWallet(h, it) < cost) return;
  if (it.cur === 'shares') h.shares -= cost; else { h.stars -= cost; h.spent += cost; } h.shop[id] = lvl + 1;
  if (id === 'round') h.rounds += 1;
  if (id === 'bounty') { const goal = mineSprintToday(h).goals.find((x) => !x.done); if (goal) mineSprintPayOut(h, goal, 'bought out'); }
  if (id === 'head' || id === 'onboard') { const n = 10 + 10 * mineLevel(h, 'onboard'); if ((h.units.intern || 0) < n) h.units.intern = n; if (!h.ups.includes('kbd')) h.ups.push('kbd'); }   // the perk starts now, not at the next release
  if (id.startsWith('skin-')) h.cos.skin = id.slice(5); if (id.startsWith('verbs-')) h.cos.verbs = id.slice(6);
  if (id === 'pet') h.cos.pet = 'blob'; if (id.startsWith('pet-')) h.cos.pet = id.slice(4); if (id === 'confetti') h.cos.confetti = true;
  mineSave(true); mineCheck(h); mineApplyCosmetics(); mineNote(`${it.name}${it.max === Infinity ? ` level ${lvl + 1}` : ''}: yours, for ${mineCurName(it, cost)}`); if (id === 'wire2') { const b = $('#fun-body'); if (b) { delete b.dataset.built; renderFunView(); return; } } mineRefresh();
  if (id === 'keep') mineKeepPick(); else if (id === 'names') toast('click an agent\'s name on the agents card to rename it', 'ok'); else if (id === 'confetti') confettiBurst();
}
async function mineKeepPick() {
  const g = mineLoad(); const owned = g.ups.map((id) => mineUpById(g, id)).filter(Boolean);
  if (!owned.length) { toast('keep one: pick an upgrade once you own one (under "your setup" in the shop)'); return; }
  const v = await chooseDialog('Keep one: which upgrade survives every release?', owned.map((up) => [up.id, up.name, up.unit ? up.unit : 'clicks']));
  if (!v) return; g.keepUp = v; mineSave(); mineNote(`keep one: ${(mineUpById(g, v) || {}).name} survives every release`); mineRefresh();
}
async function mineRename(id) {
  const g = mineLoad(); const u = mineUnitsAll(g).find((x) => x.id === id); if (!u || !mineHas(g, 'names')) return;
  const v = await promptDialog(`Name your ${u.name}`, 'Shown on the agents card and in the wire. Leave it empty to put the old name back.', g.names[id] || '');
  if (v == null) return; const name = v.slice(0, 24); if (name) g.names[id] = name; else delete g.names[id]; mineSave(); mineRefresh();
}
// cosmetics bought with stars reach outside the tab: the banner skin (a data attribute on <html> the CSS keys on),
// the status bar pet, the working verbs (pickVerb asks workVerbs) and confetti when a session commits
function mineApplyCosmetics() {
  const g = mineLoad(); const skin = g.cos.skin && mineHas(g, `skin-${g.cos.skin}`) ? g.cos.skin : '';
  if (skin) document.documentElement.dataset.skin = skin; else delete document.documentElement.dataset.skin;
  const pet = g.cos.pet && mineHas(g, 'pet') && (g.cos.pet === 'blob' || mineHas(g, `pet-${g.cos.pet}`)) ? g.cos.pet : '';
  const el = $('#status-pet'); if (!el) return; el.hidden = !pet;
  if (pet && !petTimer) petTimer = setInterval(petTick, 700); if (!pet && petTimer) { clearInterval(petTimer); petTimer = null; }
  if (pet) petTick();
}
let petTimer = null, petFrame = 0, petIdleSince = Date.now();
function petTick() {
  const g = mineLoad(); const p = MINE_PETS[g.cos.pet]; const el = $('#status-pet'); if (!p || !el) return;
  const working = Array.from(state.sessions.values()).filter((s) => s.status === 'working').length; const now = Date.now(); if (working) petIdleSince = now; petFrame += 1;
  const asleep = !working && now - petIdleSince > 5 * 60 * 1000; const text = working ? p.work[petFrame % p.work.length] : asleep ? p.sleep : p.idle;
  if (el.textContent !== text) el.textContent = text;
  el.title = `${p.name}: ${working ? `working alongside ${working} session${working === 1 ? '' : 's'}` : asleep ? 'napping' : 'waiting for something to do'} · the status bar pet, from the star shop`;
}
function workVerbs() { const g = mine || mineLoad(); const set = g.cos.verbs && mineHas(g, `verbs-${g.cos.verbs}`) ? MINE_VERB_SETS[g.cos.verbs] : null; return set || WORK_VERBS; }
function confettiBurst() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let box = $('#confetti'); if (!box) { box = document.createElement('div'); box.id = 'confetti'; box.className = 'confetti'; document.body.appendChild(box); }
  const colors = ['var(--accent)', 'var(--green)', 'var(--yellow)', 'var(--red)', 'var(--fg)'];
  for (let i = 0; i < 70; i++) { const s = document.createElement('i'); s.style.left = `${Math.random() * 100}%`; s.style.background = colors[i % colors.length]; s.style.animationDelay = `${Math.random() * 0.5}s`; s.style.animationDuration = `${1.4 + Math.random() * 1.2}s`; s.style.width = `${6 + Math.random() * 6}px`; box.appendChild(s); setTimeout(() => s.remove(), 3400); }
}
// sprints: three goals a day, drawn from the date so the app window and a browser tab agree, each paid in stars when
// reached. sprint stars count for the rank and the shop (starsEver, stars) but are kept in starsBonus so they never
// push the next release star further away. a day with all three done extends the streak; a missed day resets it.
const mineDailyAvg = (g, n) => n / Math.max(1, Math.min(90, (Date.now() - g.started) / 86400000));   // a counter's average per day since the mine started (over at most ninety days)
const MINE_SPRINTS = [   // the goals scale with the mine: clicks, hires, turns and commits off how much you usually do in a day, the rest off the run
  { id: 'clicks', k: 'clicks', n: (g) => Math.max(100, Math.min(5000, Math.round(Math.max(250, mineDailyAvg(g, g.clicks) * 0.6) / 10) * 10)), w: 1, text: (n) => `click ${fmtInt(n)} times` },
  { id: 'mine', k: 'mined', n: (g) => Math.max(1000, Math.round(mineBaseRate(g) * 7200)), w: 2, text: (n) => `mine ${fmtMine(n)} tokens` },
  { id: 'catch', k: 'caught', n: 2, w: 2, text: (n) => `catch ${n} surprises` },
  { id: 'hire', k: 'hired', n: (g) => Math.max(30, Math.round(mineAgents(g) * 0.25 / 10) * 10), w: 1, text: (n) => `hire ${fmtInt(n)} agents` },
  { id: 'ups', k: 'upsBought', n: (g) => Math.max(3, Math.min(20, Math.round(mineUpgradesAll(g).length / 30))), w: 2, text: (n) => `buy ${n} upgrades` },
  { id: 'turns', k: (g) => g.real.turns, n: (g) => Math.max(5, Math.min(200, Math.round(mineDailyAvg(g, g.real.turns) * 0.5))), w: 2, text: (n) => `pay in ${n} real turns` },
  { id: 'commits', k: (g) => g.real.commits, n: (g) => Math.max(2, Math.min(50, Math.round(mineDailyAvg(g, g.real.commits) * 0.5))), w: 3, text: (n) => `pay in ${n} real commits` },
  { id: 'combo', k: 'big', n: 50, w: 1, text: (n) => `${n} clicks at a ×5 combo or better` },
  { id: 'trade', k: 'trades', n: 3, w: 1, text: (n) => `make ${n} trades on the exchange`, when: (g) => g.ipo > 0 },
  { id: 'dip', k: 'dipBuys', n: 1, w: 2, text: () => 'buy shares on a dip (5% or more under fair value)', when: (g) => g.ipo > 0 },
  { id: 'release', k: 'releases', n: 1, w: 3, text: () => 'cut a release' },
  { id: 'speed', k: 'fastRel', n: (g) => (g.bestRel ? Math.max(600, Math.round(g.bestRel * 1.25 / 60) * 60) : 7200), w: 3, text: (n) => `cut a release inside ${fmtDurLong(n)} of the last`, one: true },   // n is the target in seconds; counted when a release lands inside it
  { id: 'tiers', k: 'tiersBought', n: 3, w: 2, text: (n) => `buy ${n} agent tiers` },
  { id: 'frenzy', k: 'frenzies', n: 1, w: 2, text: () => 'catch a timed boost' },
  { id: 'spend', k: 'spent', n: (g) => Math.max(1, Math.round(g.stars * 0.01)), w: 1, text: (n) => `spend ${fmtInt(n)} star${n === 1 ? '' : 's'} in the shop` },
  { id: 'rtokens', k: (g) => g.real.tokens, n: (g) => Math.max(10000, Math.round(Math.max(20000, mineDailyAvg(g, g.real.tokens) * 0.5) / 1000) * 1000), w: 2, text: (n) => `pay in ${fmtMine(n)} tokens from real turns` },
  { id: 'bighire', k: 'bigHires', n: 1, w: 1, text: () => 'hire a hundred agents in one go' },
];
const MINE_HARD = ['clicks', 'mine', 'hire', 'ups', 'turns', 'commits', 'combo', 'tiers', 'rtokens'];   // templates the hard sprint can triple
const mineCounter = (g, k) => (typeof k === 'function' ? k(g) : Number(g[k]) || 0);
const mineDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const mineWeekKey = (d = new Date()) => { const t = new Date(d); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return mineDay(t); };   // the Monday of the week
const mineSprintUnit = (g) => Math.max(1, Math.round(Math.max(Math.cbrt(Math.max(1, g.starsEver)), 0.004 * g.starsEver)));   // stars per unit of sprint weight: the cube root early, then 0.4% of the stars earned on this listing, so a clean day pays about 2% at any size
const mineSprintPay = (g, goal) => { const s = MINE_SPRINTS.find((x) => x.id === goal.id); return (s ? s.w : 1) * mineSprintUnit(g) * (goal.hard ? 3 : 1) * (goal.week ? 5 : 1); };
const mineRnd = (seedText) => { let seed = 0; for (const c of seedText) seed = (seed * 31 + c.charCodeAt(0)) >>> 0; return () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const mineGoalFrom = (g, s, scale = 1) => ({ id: s.id, n: Math.round((typeof s.n === 'function' ? s.n(g) : s.n) * (s.one ? 1 : scale)), base: mineCounter(g, s.k), done: false });
function mineSprintToday(g) {   // today's three sprints and the hard one, rolling the day over when the date has changed
  const today = mineDay();
  if (g.sprint && g.sprint.day === today) { if (!g.sprint.goals.some((x) => x.hard)) { mineAddHard(g, g.sprint, mineRnd(today + '-hard')); mineSave(); } return g.sprint; }   // a day drawn before the hard sprint existed gets one
  const prev = g.sprint; const y = new Date(); y.setDate(y.getDate() - 1);
  if (!prev || prev.day !== mineDay(y) || !prev.goals.filter((x) => !x.hard).every((x) => x.done)) g.streak = 0;   // the streak counts clean days in a row; yesterday clean keeps it
  const rnd = mineRnd(today);
  const pool = MINE_SPRINTS.filter((s) => !s.when || s.when(g)); const goals = [];   // the market goals only once the repo is public
  while (goals.length < 3 && pool.length) { const s = pool.splice(Math.floor(rnd() * pool.length), 1)[0]; goals.push(mineGoalFrom(g, s)); }
  g.sprint = { day: today, goals }; mineAddHard(g, g.sprint, rnd); mineSave(); return g.sprint;
}
function mineAddHard(g, sp, rnd) { const pool = MINE_SPRINTS.filter((s) => MINE_HARD.includes(s.id) && !sp.goals.some((x) => x.id === s.id)); const hs = pool[Math.floor(rnd() * pool.length)]; sp.goals.push({ ...mineGoalFrom(g, hs, 3), hard: true }); }   // the hard sprint: a tripled goal that pays triple
function mineWeekSprint(g) {   // one goal for the week, seven days of a daily one, paid five times over
  const key = mineWeekKey(); if (g.week && g.week.key === key) return g.week;
  const rnd = mineRnd('week-' + key); const pool = MINE_SPRINTS.filter((s) => MINE_HARD.includes(s.id)); const s = pool[Math.floor(rnd() * pool.length)];
  g.week = { key, goal: { ...mineGoalFrom(g, s, 7), week: true } }; mineSave(); return g.week;
}
function mineSprintPayOut(g, goal, how) {   // a goal done: its stars into the bank of stars (counted as bonus so the next release star stays where it was)
  const s = MINE_SPRINTS.find((x) => x.id === goal.id); goal.done = true; const stars = mineSprintPay(g, goal);
  g.stars += stars; g.starsEver += stars; g.starsBonus += stars; g.sprintsDone += 1; if (goal.hard) g.hardDone += 1; if (goal.week) g.weeksDone += 1;
  toast(`${goal.week ? 'weekly sprint' : goal.hard ? 'hard sprint' : 'sprint'} ${how || 'done'}: ${s.text(goal.n)} (+${fmtInt(stars)} star${stars === 1 ? '' : 's'})`, 'ok');
  return stars;
}
function mineAward(stars, why) {   // stars earned outside the mine (the arcade): into the bank of stars as bonus, so the next release star stays where it was; the toast says why
  const g = mineAccrue(); stars = Math.max(1, Math.round(stars)); g.stars += stars; g.starsEver += stars; g.starsBonus += stars;
  mineSave(); mineCheck(g); if (state.view === 'fun') mineRefresh(); toast(`${why}: +${fmtInt(stars)} star${stars === 1 ? '' : 's'} to the mine`, 'ok'); return stars;
}
function mineSprintCheck(g) {   // a goal reached pays its stars; all three regular ones in a day extend the streak, the hard one on top makes a perfect day
  const sp = mineSprintToday(g); let paid = 0;
  for (const goal of sp.goals) { const s = MINE_SPRINTS.find((x) => x.id === goal.id); if (!s || goal.done || (s.one ? mineCounter(g, s.k) - goal.base < 1 : mineCounter(g, s.k) - goal.base < goal.n)) continue; paid += mineSprintPayOut(g, goal); }
  const wk = mineWeekSprint(g); const ws = MINE_SPRINTS.find((x) => x.id === wk.goal.id);
  if (ws && !wk.goal.done && (ws.one ? mineCounter(g, ws.k) - wk.goal.base >= 1 : mineCounter(g, ws.k) - wk.goal.base >= wk.goal.n)) paid += mineSprintPayOut(g, wk.goal);
  const regular = sp.goals.filter((x) => !x.hard);
  if (paid && regular.every((x) => x.done) && !sp.clean) {
    sp.clean = true; g.sprintDays += 1; g.streak += 1; let extra = '';
    if (mineHas(g, 'dividend') && mineCap(g) > 0) { const d = Math.max(1, Math.round(mineCap(g) * 0.01 * mineLevel(g, 'dividend'))); g.stars += d; g.starsEver += d; g.starsBonus += d; extra = ` · dividends: +${fmtInt(d)} star${d === 1 ? '' : 's'}`; }
    mineFairBump(g, 0.02);
    toast(`a clean sprint: all three done today${g.streak > 1 ? `, ${g.streak} days in a row` : ''}${extra}`, 'ok');
  }
  if (paid && sp.goals.every((x) => x.done) && !sp.perfect) { sp.perfect = true; g.perfectDays += 1; mineFairBump(g, 0.03); toast('a perfect day: the hard sprint too', 'ok'); }
  if (paid) mineSave();
}
function mineNews(g) {
  const pool = []; for (const [test, text] of MINE_NEWS) { if (!test(g)) continue; const t = typeof text === 'function' ? text(g) : text; if (t === mineNewsLast) continue; for (let i = 0; i < (test.length ? 3 : 1); i++) pool.push(t); }
  mineNewsLast = pool[Math.floor(Math.random() * pool.length)] || ''; const el = $('#mine-news'); if (el) el.textContent = mineNewsLast;
  const el2 = $('#mine-news2'); if (el2) { const rest = pool.filter((t) => t !== mineNewsLast); el2.textContent = rest[Math.floor(Math.random() * rest.length)] || ''; }   // the second wire never repeats the first
}
// ---- the fun hub: the mine and the arcade share the fun tab, one sub-tab each. A game lives in its own file and
// registers itself with funRegister({ id, name, hint, render(pane) }); its career goes in the mine's save under
// arcade.<id> so it is mirrored to the daemon, counted by the milestones and shown on the stats page ----
const FUN_GAMES = [];
function funRegister(game) { FUN_GAMES.push(game); }
function funTab() { const t = localStorage.getItem('kcoder.funTab') || 'mine'; return t === 'mine' || FUN_GAMES.some((x) => x.id === t) ? t : 'mine'; }
function funSelect(id) { localStorage.setItem('kcoder.funTab', id); if (state.view !== 'fun') setView('fun'); else renderFunView(); }
function renderFunTabs() {
  const el = $('#fun-tabs'); if (!el) return; const tab = funTab(); const game = FUN_GAMES.find((x) => x.id === tab);
  const key = `${tab}|${FUN_GAMES.map((x) => x.id).join(',')}`;
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    el.innerHTML = `<div class="layout-picker" role="tablist">${[{ id: 'mine', name: 'the mine' }, ...FUN_GAMES].map((x) => `<button data-fun="${x.id}" class="${x.id === tab ? 'active' : ''}" role="tab">${esc(x.name)}</button>`).join('')}</div><span class="dim fun-hint">${esc(game ? game.hint || '' : 'click the banner; real turns and commits pay in too')}</span>`;
    if (!el.dataset.wired) { el.dataset.wired = '1'; el.addEventListener('click', (e) => { const b = e.target.closest('[data-fun]'); if (b) funSelect(b.dataset.fun); }); }
  }
}
function renderFunView() {
  if (state.view !== 'fun') return;
  renderFunTabs();
  const tab = funTab(); const body = $('#fun-body'); const pane = $('#fun-game');
  body.hidden = tab !== 'mine'; pane.hidden = tab === 'mine';
  if (tab !== 'mine') { const game = FUN_GAMES.find((x) => x.id === tab); if (pane.dataset.game !== tab) { pane.innerHTML = '';   /* a game's built/wired flags go with its DOM, so the next visit rebuilds */ for (const k of Object.keys(pane.dataset)) delete pane.dataset[k]; pane.dataset.game = tab; } game.render(pane); return; }
  const box = body; const g = mineAccrue();
  if (!box.dataset.built) {
    box.innerHTML = `<div class="mine">
      <div class="mine-head"><button class="mine-btn" id="mine-btn" title="click for tokens; fast clicks in a row build a combo"><pre class="banner big" aria-label="KCODER">${esc(BANNER)}</pre></button>
        <div class="mine-nums"><div class="mine-bank"><span data-m="bank">0</span> tokens</div><div class="dim"><span data-m="rate">0</span> per second · <span data-m="click">1</span> per click<span class="mine-combo" data-m="combo"></span></div><div class="mine-boost" data-m="boost"></div><div class="dim">click the banner; real turns and commits pay in too; click a surprise before it goes</div><div class="mine-note" id="mine-note"></div></div></div>
      <div class="mine-ticker"><span class="dim">the wire</span><span id="mine-news"></span>${mineHas(g, 'wire2') ? '<span class="dim w2">and</span><span id="mine-news2"></span>' : ''}</div>
      <div class="mine-grid">
        <div class="card"><h3>agents<span class="mine-qty" id="mine-qty" title="how many to hire per click">${[1, 10, 100, 'max'].map((q) => `<button data-qty="${q}" class="${q === 1 ? 'sel' : ''}">${q === 'max' ? 'max' : `×${q}`}</button>`).join('')}</span></h3><div class="mine-units" id="mine-units"></div></div>
        <div class="col"><div class="card"><h3>upgrades<button class="link" data-mine="ups-all" title="buy every upgrade on offer that the bank covers, cheapest first">buy all affordable</button></h3><div class="mine-ups" id="mine-ups"></div></div>
        <div class="card"><h3>today's sprints <span class="dim" data-m="sprintn"></span></h3><div class="mine-sprints" id="mine-sprints"></div><div class="mine-sprints mine-week" id="mine-week"></div><div class="ds mine-sprints-note">three a day and a hard one, new at midnight, and one for the week; each pays a share of the stars earned on this listing, counting for the rank and the shop but not against the next release star</div></div>
          <div class="card"><h3>releases</h3><div class="row"><span>stars held</span><b data-m="stars"></b></div><div class="row"><span>stars earned</span><b data-m="starsever"></b></div><div class="row"><span>rank</span><b data-m="rank"></b></div><div class="row"><span>releases cut</span><b data-m="releases"></b></div><div class="row"><span>the mine runs at</span><b data-m="mult"></b></div><div class="row"><span>this run</span><b data-m="run"></b></div><div class="mine-rel" data-m="rel"></div>
          <div class="mine-runs" data-m="runs"></div>
          <h3>from real work</h3><div class="row"><span>turns paid in</span><b data-m="turns"></b></div><div class="row"><span>tokens from real turns</span><b data-m="rtokens"></b></div><div class="row"><span>commits</span><b data-m="commits"></b></div><div class="row"><span>commit bonuses</span><b data-m="bonus"></b></div>
          <h3>all time</h3><div class="row"><span>tokens mined</span><b data-m="total"></b></div><div class="row"><span>clicks</span><b data-m="clicks"></b></div><div class="row"><span>best combo</span><b data-m="bestcombo"></b></div><div class="row"><span>surprises caught</span><b data-m="caught"></b></div><div class="row"><span>mining since</span><b data-m="since"></b></div>
          <div class="row"><span><button class="link" data-mine="reset">start over</button></span></div></div></div>
        <div class="col"><div class="card mine-market"><h3>the exchange <span class="dim" data-m="mkt-h"></span></h3><div id="mine-market"></div></div>
          <div class="card"><h3>milestones <span class="dim" data-m="achn"></span></h3><div class="mine-ach" id="mine-ach"></div><div class="mine-ach-info" id="mine-ach-info">click a milestone to see what it takes</div></div></div>
        <div class="card mine-shop"><h3>the star shop <span class="dim" data-m="shopn"></span></h3><div class="ds">a star buys a permanent perk for the mine or a change to kcoder itself. the star goes for good, and its 10% with it; the rank keeps counting every star you ever earned.</div>
          <div class="mine-shop-groups"><div><h3>perks for the mine</h3><div class="mine-ups" id="mine-shop-perk"></div></div>
          <div><h3>customize kcoder</h3><div class="mine-ups" id="mine-shop-kcoder"></div><h3>priced in shares <span class="dim" data-m="sharesn"></span></h3><div class="mine-ups" id="mine-shop-shares"></div></div></div>
          <div class="mine-setup" id="mine-setup"></div></div>
      </div></div>`;
    box.dataset.built = '1';
    $('#mine-btn').addEventListener('click', mineClick);
    if (!box.dataset.wired) box.addEventListener('click', async (e) => {   // once: the box outlives every rebuild, and a second listener would hire, buy and trade twice per click
      if (e.target.closest('[data-gold]')) { mineCatch(); return; }
      const a = e.target.closest('[data-ach]'); if (a) { const m = MINE_MILESTONES.find((x) => x.id === a.dataset.ach); if (!m) return; const on = mineLoad().ach.includes(m.id); box.querySelectorAll('[data-ach].sel').forEach((x) => x.classList.remove('sel')); a.classList.add('sel'); $('#mine-ach-info').innerHTML = `<b>${esc(m.name)}</b> · ${esc(m.desc)} · <span class="${on ? 'on' : 'dim'}">${on ? `earned, +${mineHas(mineLoad(), 'pride') ? 3 : 2}% to the mine` : 'not yet'}</span>`; return; }
      const q = e.target.closest('[data-qty]'); if (q) { mineQty = q.dataset.qty === 'max' ? 'max' : Number(q.dataset.qty); q.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === q)); mineRefresh(); return; }
      if (e.target.closest('[data-mine="ups-all"]')) { mineBuy('ups-all'); return; }
      const b = e.target.closest('[data-buy]'); if (b) { mineBuy('unit', b.dataset.buy); return; }
      const u = e.target.closest('[data-up]'); if (u) { mineBuy('up', u.dataset.up); return; }
      if (e.target.closest('[data-mine="release"]')) { mineRelease(); return; }
      if (e.target.closest('[data-mine="ipo"]')) { mineIpo(); return; }
      const tr = e.target.closest('[data-trade]'); if (tr) { const [side, q] = tr.dataset.trade.split(':'); mineTrade(side, q === 'max' || q === 'all' ? q : Number(q)); return; }
      const st = e.target.closest('[data-star]'); if (st) { mineShopBuy(st.dataset.star); return; }
      const cs = e.target.closest('[data-cos]'); if (cs) { const g = mineLoad(); if (cs.dataset.cos === 'confetti') g.cos.confetti = cs.dataset.val === 'on'; else g.cos[cs.dataset.cos] = cs.dataset.val; mineSave(); mineApplyCosmetics(); mineRefresh(); if (cs.dataset.cos === 'confetti' && g.cos.confetti) confettiBurst(); return; }
      if (e.target.closest('[data-mine="keep-pick"]')) { mineKeepPick(); return; }
      const rn = e.target.closest('[data-rename]'); if (rn) { mineRename(rn.dataset.rename); return; }
      if (e.target.closest('[data-mine="reset"]')) { if (await confirmDialog('Start the token mine over?', 'Every agent, upgrade, star, share, milestone and token goes; the real-work counters and everything from the star shop too.')) { mine = mineNormalize(null); mineSave(true); mineApplyCosmetics(); delete box.dataset.built; renderFunView(); } }
    });
    box.dataset.wired = '1';
    mineNews(g);
  }
  mineRefresh();
  if (!mineTimer) mineTimer = setInterval(() => {
    if (state.view !== 'fun' || document.hidden || !$('#fun-body').dataset.built || funTab() !== 'mine') { clearInterval(mineTimer); mineTimer = null; mineSave(); return; }
    const g = mineAccrue(); if (mineHas(g, 'auto')) { const v = mineClickValue(g) * (1 + mineComboCap(g) * 0.05); mineAdd(g, v); }   // the cron clicker: one click a second at full combo, only while watching
    if (mineHas(g, 'procurement')) { const [b, sp] = mineBuyAllUps(g); if (b) { mineNote(`procurement bought ${b} upgrade${b === 1 ? '' : 's'} for ${fmtFull(sp)} tokens`); mineCheck(g); } }
    if (mineTicks % 5 === 0) mineCheck(g);   // the mine goal of a sprint and the total milestones land without a click
    mineRefresh(); mineTicks += 1; if (mineTicks % 15 === 0) mineSave(); if (mineTicks % 20 === 0) mineNews(g);
    if (!mineGold && !state.dialog && Math.random() < (mineHas(g, 'lucky') ? 1 / 75 : 1 / 150)) mineSpawnSurprise();   // about one every two and a half minutes on screen (half that with lucky)
    if (g.ipo && !state.dialog && Math.random() < 1 / 480) mineMarketEvent(g);   // news on the exchange about every eight minutes on screen
  }, 1000);
}
function mineRefresh() {
  const box = $('#fun-body'); if (!box || !box.dataset.built) return;
  const g = mineLoad(); const now = Date.now(); const rate = mineRate(g); const set = (k, v) => { const el = box.querySelector(`[data-m="${k}"]`); if (el && el.textContent !== String(v)) el.textContent = v; };
  const bankText = fmtFull(g.bank); set('bank', bankText); const bankEl = box.querySelector('.mine-bank'); const bankCls = `mine-bank${bankText.length > 30 ? ' xl' : bankText.length > 18 ? ' l' : ''}`; if (bankEl.className !== bankCls) bankEl.className = bankCls;
  set('rate', fmtMine(Math.round(rate * 10) / 10)); set('click', fmtMine(Math.round(mineClickValue(g) * 10) / 10));
  set('combo', now - mineCombo.at < mineComboWindow(g) && mineCombo.n >= 5 ? ` · combo ×${mineComboMult(mineCombo.n, g).toFixed(2)}` : '');
  const boosts = [g.boost, g.clickBoost].filter((b) => mineBoostOn(b, now)).map((b) => `${b.name}: ${b.id === 'stash' ? 'clicks' : 'the mine'} ×${b.mult} for ${Math.ceil((b.until - now) / 1000)} s`); set('boost', boosts.join(' · '));
  set('turns', fmtInt(g.real.turns)); set('rtokens', fmtFull(g.real.tokens)); set('commits', fmtInt(g.real.commits)); set('bonus', fmtFull(g.real.bonus));
  set('total', fmtFull(g.total)); set('clicks', fmtInt(g.clicks)); set('bestcombo', g.bestCombo ? `×${g.bestCombo.toFixed(2)}` : '×1'); set('caught', fmtInt(g.caught)); set('since', fmtDate(new Date(g.started).toISOString().slice(0, 10)));
  set('stars', fmtInt(g.stars)); set('starsever', g.ipo ? `${fmtInt(g.starsEver)} on this listing · ${fmtInt(mineStarsLife(g))} ever` : fmtInt(g.starsEver)); set('rank', mineRankLine(g) || 'none yet (one star)'); set('releases', g.ipo ? `${fmtInt(g.releases)} on this listing · ${fmtInt(g.releases + g.ipoReleases)} ever` : fmtInt(g.releases)); set('mult', `×${fmtMine(Math.round(mineMult(g) * 100) / 100)}${g.rounds ? ` · agents ×${fmtMine(Math.pow(2, g.rounds))} this run` : ''}`);
  set('run', `${fmtDurLong(mineRunSecs(g, now))}${g.bestRel ? ` · best ${fmtDurLong(g.bestRel)}` : ''}`);
  const can = mineStarsDue(g); const rel = box.querySelector('[data-m="rel"]'); const nextStar = Math.pow(g.starsEver - g.starsBonus + 1, 3) * 1e6;
  const relKey = can > 0 ? `go:${can}:${g.stars}` : `next:${nextStar}:${mineEta(g, g.bank + nextStar - g.mined)}`;
  if (rel.dataset.key !== relKey) { rel.dataset.key = relKey; rel.innerHTML = can > 0 ? `<button data-mine="release">cut release v${g.releases + 1}: +${fmtInt(can)} star${can === 1 ? '' : 's'}</button><div class="ds">agents and bank reset; stars stay: the mine would run at ×${fmtMine(Math.round(mineMultWith(g, g.stars + can) * 100) / 100)}, or spend them in the shop</div>` : `<div class="ds">next star at ${fmtFull(nextStar)} tokens mined${g.ipo ? ' on this listing' : ' all time'} (${fmtFull(g.mined)} so far) · ${esc(mineEta(g, g.bank + nextStar - g.mined))}</div>`; }
  // the exchange: before the listing, what going public does and the button for it; after, the quote, an hour of tape, the cap, the position, the news and the trade buttons
  const mk = $('#mine-market'); const canList = g.stars >= MINE_IPO_MIN && mineIpoShares(g) >= 1; const pop = Math.round((minePop(g) - 1) * 100);
  const mkKey = `${g.ipo}|${canList ? 1 : 0}|${mineLevel(g, 'analyst')}|${mineSoftKnee(g)}|${pop}`;
  if (mk.dataset.key !== mkKey) {
    mk.dataset.key = mkKey;
    const listBtn = canList ? `<div class="mine-rel"><button data-mine="ipo"><span data-m="mkt-list"></span></button><div class="ds">${g.ipo ? `a new listing: the stars held become shares at today's price, with the ${pop}% pop on the ones earned on this listing; stars and releases start over on it` : `the stars become shares with a ${pop}% first-day pop; stars and releases start over on the listing, everything else stays`}</div></div>` : '';
    mk.innerHTML = !g.ipo ? `<div class="mine-market-cols"><div class="ds">with ${fmtInt(MINE_IPO_MIN)} stars held the repo can go public as ${MINE_TICKER}: every star held becomes shares with a ${pop}% first-day pop, so the market cap (shares × price) starts above the stars it replaced and lifts the mine the same way. from then on the price moves: up on its own, up for good on real commits and releases, knocked about by news for a while. shares trade for stars either way here, and buy the perks priced in shares.</div><div>${listBtn}</div></div>` :
      `<div class="mine-market-cols"><div><div class="mine-quote"><b>${MINE_TICKER}</b><b class="px" data-m="mkt-px"></b><span class="chg" data-m="mkt-chg"></span></div><svg class="mine-spark" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true"><polyline data-m="mkt-line" points=""/></svg>
      <div class="row"><span title="shares × price; what it is worth to the mine by itself, before stars held and milestones">market cap</span><b data-m="mkt-cap"></b></div><div class="row"><span>shares</span><b data-m="mkt-shares"></b></div><div class="row"><span>since listing</span><b data-m="mkt-since"></b></div>${mineHas(g, 'analyst') ? '<div class="row"><span>fair value</span><b data-m="mkt-fair"></b></div>' : ''}<div class="row"><span>the tape</span><b data-m="mkt-news"></b></div></div>
      <div><div class="mine-trade"><span class="dim">buy at <span data-m="mkt-ask"></span></span>${[1, 10, 100, 'max'].map((q) => `<button data-trade="buy:${q}">${q === 'max' ? 'max' : `×${q}`}</button>`).join('')}</div>
      <div class="mine-trade"><span class="dim">sell at <span data-m="mkt-bid"></span></span>${[1, 10, 100, 'all'].map((q) => `<button data-trade="sell:${q}">${q === 'all' ? 'all' : `×${q}`}</button>`).join('')}</div>${listBtn}
      <div class="ds">shares × price is the market cap; every star of it lifts the mine like a star held, in full (stars held past ${fmtInt(mineSoftKnee(g))} count by their square root). the price drifts up on its own, jumps for good on real commits and releases, and news knocks it about for ten minutes or so: buy the dips with stars, sell the pops for stars to spend in the shop. shares also buy the perks priced in shares.</div></div></div>`;
  }
  set('mkt-h', g.ipo ? `${MINE_TICKER} · listing ${g.ipo}` : 'not listed yet');
  if (canList) { const n = mineIpoShares(g); set('mkt-list', `${g.ipo ? 'list again' : `go public as ${MINE_TICKER}`}: ${fmtInt(g.stars)} stars → +${fmtInt(n)} share${n === 1 ? '' : 's'} at ${fmtPx(mineIpoPx(g, n))}`); }
  if (g.ipo) {
    const cap = mineCap(g); const chg = g.pxOpen > 0 ? g.px / g.pxOpen - 1 : 0; const pct = (x, sign = true) => `${sign ? (x >= 0 ? '+' : '-') : ''}${Math.abs(x * 100) < 10 ? Math.abs(x * 100).toFixed(1) : fmtInt(Math.round(Math.abs(x * 100)))}%`;
    set('mkt-px', fmtPx(g.px)); const chgEl = mk.querySelector('[data-m="mkt-chg"]'); const chgTxt = `${chg >= 0 ? '▲' : '▼'} ${pct(chg)} today`; if (chgEl.textContent !== chgTxt) chgEl.textContent = chgTxt; const chgCls = `chg ${chg >= 0 ? 'up' : 'down'}`; if (chgEl.className !== chgCls) chgEl.className = chgCls;
    const svg = mk.querySelector('.mine-spark'); const line = mk.querySelector('[data-m="mkt-line"]'); const pts = mineSpark(g.hist); if (line.getAttribute('points') !== pts) line.setAttribute('points', pts); const dir = `mine-spark ${g.hist.length > 1 && g.hist[g.hist.length - 1][1] < g.hist[0][1] ? 'down' : 'up'}`; if (svg.getAttribute('class') !== dir) svg.setAttribute('class', dir);
    set('mkt-cap', `${fmtMine(Math.round(cap))} stars · ×${fmtMine(Math.round((1 + mineStarPct(g) * cap) * 100) / 100)} on its own`);
    set('mkt-shares', `${fmtInt(g.shares)}${g.shares && g.basis ? ` · cost ${fmtPx(g.basis)} each · ${pct(g.px / g.basis - 1)}` : ''}`);
    set('mkt-since', `${g.pxIpo ? pct(g.px / g.pxIpo - 1) : 'n/a'}${g.pxHigh ? ` · high ${fmtPx(g.pxHigh)}` : ''}`);
    if (mineHas(g, 'analyst')) set('mkt-fair', `${fmtPx(g.fair)} · ${Math.abs(g.px / g.fair - 1) < 0.005 ? 'at fair' : g.px < g.fair ? `${pct(1 - g.px / g.fair, false)} under fair${g.px <= g.fair * 0.95 ? ': a dip' : ''}` : `${pct(g.px / g.fair - 1, false)} over fair`}`);
    const ev = g.event && now - g.event.at < 1800000 ? g.event : null; set('mkt-news', ev ? `${ev.name}: ${pct(ev.pct)}${Math.abs(g.shock) >= 0.01 ? ` · ${pct(g.shock)} still to fade` : ' · faded'}` : 'quiet trading');
    const ask = mineAsk(g), bid = mineBid(g); set('mkt-ask', `${fmtPx(ask)} stars a share`); set('mkt-bid', fmtPx(bid));
    for (const b of mk.querySelectorAll('[data-trade]')) { const [side, q] = b.dataset.trade.split(':'); const off = side === 'buy' ? g.stars < (q === 'max' ? ask : Math.ceil(Number(q) * ask)) : g.shares < (q === 'all' ? 1 : Number(q)); if (b.disabled !== off) b.disabled = off; }
  }
  const runsEl = box.querySelector('[data-m="runs"]'); const runsKey = g.runs.map((r) => r.at).join(',');
  if (runsEl.dataset.key !== runsKey) { runsEl.dataset.key = runsKey; runsEl.innerHTML = g.runs.length ? `<span class="dim">runs</span>${g.runs.slice().reverse().map((r) => `<span title="${esc(new Date(r.at).toLocaleString())}">${r.kind === 'ipo' ? 'went public' : `v${r.v}`} · ${fmtDurLong(r.secs)} · +${fmtInt(r.got)} ${r.kind === 'ipo' ? 'share' : 'star'}${r.got === 1 ? '' : 's'}</span>`).join('')}` : ''; }
  const unitsEl = $('#mine-units'); const ukey = `${mineUnitsOpen(g).map((u) => u.id).join(',')}|${JSON.stringify(g.names)}|${mineHas(g, 'names') ? 1 : 0}`;
  if (unitsEl.dataset.key !== ukey) { unitsEl.dataset.key = ukey; unitsEl.innerHTML = mineUnitsOpen(g).map((u) => `<div class="mine-unit" data-unit="${u.id}"><div class="nm">${mineHas(g, 'names') ? `<span class="rn" data-rename="${u.id}" title="rename">${esc(mineUnitName(g, u))}</span>` : esc(u.name)}<b data-m="n"></b><span data-m="urate"></span></div><div class="ds">${esc(u.desc)}</div><div class="nx" data-m="next"></div><div class="fl" data-m="floor"></div><button data-buy="${u.id}" title="${fmtMine(u.rate)} tokens per second each"><span data-m="cost"></span></button></div>`).join(''); }
  const mults = mineUnitMults(g); const allUps = mineUpgradesAll(g);
  for (const u of mineUnitsOpen(g)) {
    const row = box.querySelector(`[data-unit="${u.id}"]`); const n = g.units[u.id] || 0; const cost = mineUnitCost(u, n);
    const m = mults[u.id] || 1;
    row.querySelector('[data-m="n"]').textContent = n ? `× ${n}` : ''; row.classList.toggle('owned', n > 0);   // once hired, the blurb makes way for the next-tier line row.querySelector('[data-m="urate"]').textContent = n ? `${fmtMine(Math.round(n * u.rate * m * mineMult(g) * mineAgentMult(g) * 10) / 10)}/s` : '';
    const fl = row.querySelector('[data-m="floor"]'); const floor = n ? u.glyph.repeat(Math.min(n, 60)) + (n > 60 ? ` +${fmtInt(n - 60)}` : '') : ''; if (fl.textContent !== floor) fl.textContent = floor;
    const pend = allUps.find((up) => up.unit === u.id && !g.ups.includes(up.id));   // the next tier: how many more agents it takes and how long that is at this rate
    const nx = row.querySelector('[data-m="next"]'); const nxText = !pend ? 'every tier bought' : n >= pend.owned ? `${pend.name} is on offer under upgrades` : `${fmtInt(pend.owned - n)} more to ${pend.name} (×${fmtInt(pend.mult)}) · ${mineEta(g, mineUnitCostN(u, n, pend.owned - n))}`; if (nx.textContent !== nxText) nx.textContent = nxText;
    const k = mineBuyCount(u, g); const costK = k ? mineUnitCostN(u, n, k) : cost;
    row.querySelector('[data-m="cost"]').textContent = k > 1 ? `×${fmtInt(k)} · ${fmtMine(costK)} tokens` : `${fmtMine(costK)} tokens`; row.querySelector('button').disabled = !k || g.bank < costK;
  }
  const open = mineUpgradesOpen(g); const key = `${open.map((u) => u.id).join(',')}|${mineLevel(g, 'bulk')}`;
  const ups = $('#mine-ups');
  if (ups.dataset.key !== key) { ups.dataset.key = key; ups.innerHTML = open.length ? open.map((up) => `<div class="mine-up" data-uprow="${up.id}"><div><b>${esc(up.name)}</b><div class="ds">${esc(up.desc)}<span data-m="eta"></span></div></div><button data-up="${up.id}">${fmtMine(mineUpCost(g, up))} tokens</button></div>`).join('') : `<div class="dim">${g.ups.length >= mineUpgradesAll(g).length ? 'every upgrade bought' : 'more appear as you buy agents'}</div>`; }
  for (const up of open) { const c = mineUpCost(g, up); const b = ups.querySelector(`[data-up="${up.id}"]`); if (b) b.disabled = g.bank < c; const eta = ups.querySelector(`[data-uprow="${up.id}"] [data-m="eta"]`); const t = g.bank < c ? mineEta(g, c) : ''; if (eta && eta.textContent !== t) eta.textContent = t; }
  const all = box.querySelector('[data-mine="ups-all"]'); const canAll = open.some((up) => mineUpCost(g, up) <= g.bank); if (all.disabled === canAll) all.disabled = !canAll;
  // today's sprints (three and the hard one) and the week's: progress toward each goal, the stars it pays, done ones lit
  const sp = mineSprintToday(g); const wk = mineWeekSprint(g);
  const rowOf = (goal) => { const s = MINE_SPRINTS.find((x) => x.id === goal.id); const have = s.one ? (goal.done ? 1 : 0) : Math.min(goal.n, Math.max(0, mineCounter(g, s.k) - goal.base)); return [s, goal, have]; };
  const rows = sp.goals.map(rowOf); const wrow = rowOf(wk.goal);
  const rowHtml = ([s, goal, have]) => { const stars = mineSprintPay(g, goal); const tag = goal.week ? 'this week' : goal.hard ? 'hard' : ''; return `<div class="mine-sprint${goal.done ? ' on' : ''}${goal.hard ? ' hard' : ''}${goal.week ? ' week' : ''}"><div><b>${tag ? `<span class="tag">${tag}</span>` : ''}${esc(s.text(goal.n))}</b><div class="ds">${goal.done ? 'done' : s.one ? 'not yet' : `${fmtMine(have)} of ${fmtMine(goal.n)}`} · ${fmtInt(stars)} star${stars === 1 ? '' : 's'}</div></div>${goal.done ? '<span class="owned">done</span>' : `<div class="bar" title="${esc(s.one ? 'not yet' : `${fmtMine(have)} of ${fmtMine(goal.n)}`)}"><i style="width:${s.one ? 0 : Math.round(100 * have / goal.n)}%"></i></div>`}</div>`; };
  const spKey = `${sp.day}|${rows.map(([, goal, have]) => `${goal.id}:${goal.n}:${have}:${goal.done ? 1 : 0}`).join(',')}|${mineSprintUnit(g)}`; const spEl = $('#mine-sprints');
  if (spEl.dataset.key !== spKey) { spEl.dataset.key = spKey; spEl.innerHTML = rows.map(rowHtml).join(''); }
  const wkKey = `${wk.key}|${wrow[1].id}:${wrow[1].n}:${wrow[2]}:${wrow[1].done ? 1 : 0}|${mineSprintUnit(g)}`; const wkEl = $('#mine-week');
  if (wkEl.dataset.key !== wkKey) { wkEl.dataset.key = wkKey; wkEl.innerHTML = rowHtml(wrow); }
  set('sprintn', `${sp.goals.filter((x) => x.done).length} of ${sp.goals.length} today${g.streak ? ` · ${g.streak} clean day${g.streak === 1 ? '' : 's'} in a row` : ''}`);
  const ach = $('#mine-ach'); const shown = mineMilestonesShown(g); const akey = `${g.ach.join(',')}|${shown.length}`;
  if (ach.dataset.key !== akey) { ach.dataset.key = akey; ach.innerHTML = shown.map((m) => `<span class="${g.ach.includes(m.id) ? 'on' : ''}" data-ach="${m.id}" title="${esc(m.desc)}">${esc(m.name)}</span>`).join(''); set('achn', `${g.ach.length} of ${MINE_MILESTONES.length} · +${g.ach.length * (mineHas(g, 'pride') ? 3 : 2)}%`); }
  // the star shop: rows per group (an item needing another shows once that one is owned), then the pickers for what is owned
  const sprintOpen = sp.goals.find((x) => !x.done); const shopKey = `${g.stars}|${g.shares}|${g.ipo}|${g.rounds}|${g.starsEver}|${sprintOpen ? sprintOpen.id : ''}|${JSON.stringify(g.shop)}|${g.keepUp}|${JSON.stringify(g.cos)}|${g.ups.includes(g.keepUp)}`; const shopEl = $('#mine-shop-perk');
  if (shopEl.dataset.key !== shopKey) {
    shopEl.dataset.key = shopKey;
    const row = (it) => { const lvl = mineLevel(g, it.id), max = it.max || 1, cost = mineShopCost(it, lvl, g); return `<div class="mine-up one" title="${esc(it.desc)}"><div><b>${esc(it.name)}</b>${max === Infinity ? (lvl ? ` <span class="dim">level ${fmtInt(lvl)}</span>` : '') : max > 1 ? ` <span class="dim">${lvl} of ${max}</span>` : ''}<span class="ds">${esc(it.desc)}</span></div><button data-star="${it.id}" ${cost == null || mineWallet(g, it) < cost ? 'disabled' : ''}>${cost == null ? 'nothing open today' : mineCurName(it, cost)}</button></div>`; };   // one line a row; the full blurb is the tooltip and the confirm
    const open = (it) => !it.need || mineHas(g, it.need); const done = (it) => mineLevel(g, it.id) >= (it.max || 1);
    const group = (name) => { const items = MINE_SHOP.filter((it) => it.group === name && open(it)); const owned = items.filter(done); return (owned.length ? `<div class="mine-owned"><span class="dim">owned</span>${owned.map((it) => esc(it.name)).join(' · ')}</div>` : '') + items.filter((it) => !done(it)).map(row).join(''); };   // what is owned folds into one line so the rows left are the ones still to buy
    shopEl.innerHTML = group('perk');
    $('#mine-shop-kcoder').innerHTML = group('kcoder');
    $('#mine-shop-shares').innerHTML = g.ipo ? group('shares') : `<div class="dim">opens when the repo goes public: shares buy four more agents, an analyst, a prime broker, dividends, a second wire and more</div>`;
    set('sharesn', g.ipo ? `${fmtInt(g.shares)} share${g.shares === 1 ? '' : 's'} to spend` : '');
    set('shopn', `${fmtInt(g.stars)} star${g.stars === 1 ? '' : 's'} to spend · ${fmtInt(g.spent)} spent`);
    const pick = (k, cur, opts) => `<span class="mine-qty">${opts.map(([v, label]) => `<button data-cos="${k}" data-val="${esc(v)}" class="${cur === v ? 'sel' : ''}">${esc(label)}</button>`).join('')}</span>`;
    const lines = [];
    const skins = Object.entries(MINE_SKINS).filter(([id]) => mineHas(g, `skin-${id}`)); if (skins.length) lines.push(`<div class="row"><span>banner</span>${pick('skin', mineHas(g, `skin-${g.cos.skin}`) ? g.cos.skin : '', [['', 'kcoder blue'], ...skins])}</div>`);
    const vsets = Object.keys(MINE_VERB_SETS).filter((id) => mineHas(g, `verbs-${id}`)); if (vsets.length) lines.push(`<div class="row"><span>working verbs</span>${pick('verbs', mineHas(g, `verbs-${g.cos.verbs}`) ? g.cos.verbs : '', [['', 'the usual'], ...vsets.map((id) => [id, id])])}</div>`);
    if (mineHas(g, 'pet')) lines.push(`<div class="row"><span>status bar pet</span>${pick('pet', g.cos.pet === 'blob' || mineHas(g, `pet-${g.cos.pet}`) ? g.cos.pet : '', [['', 'off'], ...Object.entries(MINE_PETS).filter(([id]) => id === 'blob' || mineHas(g, `pet-${id}`)).map(([id, p]) => [id, p.name])])}</div>`);
    if (mineHas(g, 'confetti')) lines.push(`<div class="row"><span>confetti on commit</span>${pick('confetti', g.cos.confetti ? 'on' : 'off', [['on', 'on'], ['off', 'off']])}</div>`);
    if (mineHas(g, 'keep')) { const up = mineUpById(g, g.keepUp); lines.push(`<div class="row"><span>keep one</span><b>${up ? esc(up.name) + (g.ups.includes(up.id) ? '' : ' <span class="dim">(not owned right now)</span>') : '<span class="dim">not picked yet</span>'} <button class="link" data-mine="keep-pick">${up ? 'change' : 'pick'}</button></b></div>`); }
    if (mineHas(g, 'names')) lines.push(`<div class="row"><span>names</span><b class="dim">click an agent's name on the agents card to rename it</b></div>`);
    $('#mine-setup').innerHTML = lines.length ? `<h3>your setup</h3>${lines.join('')}` : '';
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.view === 'fun') renderFunView(); });

mineApplyCosmetics(); renderHeader(); renderViews();
connect();

