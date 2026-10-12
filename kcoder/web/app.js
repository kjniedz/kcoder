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
  ['/fork', 'fork this chat'], ['/compact', 'summarise history to free context'], ['/export', 'download as markdown'],
  ['/archive', 'archive this chat'], ['/shell', 'toggle the shell pane'], ['/grid', 'sessions: the grid'],
  ['/panes', 'sessions: 1 to 3 panes (/panes 2)'], ['/terminal', 'toggle this pane between chat and terminal view'],
];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => (n || 0).toLocaleString();
const fmtUsd = (n) => (n >= 100 ? '$' + Math.round(n).toLocaleString() : n >= 10 ? '$' + n.toFixed(1) : '$' + (n || 0).toFixed(2));
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n || 0));
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
}
function setTheme(c) { localStorage.setItem('kcoder.theme', c); applyTheme(); }
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
  uiSyncTimer = setTimeout(() => { if (state.connected) request('ui_state', { state: { layout: state.layout, order: state.order, view: state.view, saved: Date.now() } }).catch(() => {}); }, 800);
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
  if (msg.type === 'plan_usage') { state.claude = { ...(state.claude || {}), usage: msg.usage }; renderClaudeButton(); if (state.dialog === 'claude' && state._renderClaude) state._renderClaude(state.claude); return; }
  if (msg.type === 'notice') { toast(`${msg.title}: ${msg.body}`, 'warn'); notify(msg.title, msg.body, msg.sid, 'wait'); return; }
}

async function onConnected() {
  await request('attach', { sid: '*' });
  await refreshProviders();
  try { state.config = (await request('config')).config; } catch {}
  if (!state._updOffered) { state._updOffered = true; request('update', { action: 'check' }).then((r) => { if (r.update && r.update.available && !r.update.failed) updateNow(); }).catch(() => {}); }
  if (!localStorage.getItem('kcoder.layout') && !localStorage.getItem('kcoder.order')) {
    // a fresh browser profile: pick up the layout the daemon kept for us
    try { const r = await request('ui_state'); if (r.state) { if (r.state.layout) { state.layout = r.state.layout; localStorage.setItem('kcoder.layout', JSON.stringify(state.layout)); } if (Array.isArray(r.state.order)) { state.order = r.state.order; localStorage.setItem('kcoder.order', JSON.stringify(state.order)); } } } catch {}
  }
  applyUrlParams();
  setTimeout(maybeMorningBrief, 1500);
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
  if (ev.t === 'tool_output') { store.toolLive = store.toolLive || {}; store.toolLive[ev.id] = ((store.toolLive[ev.id] || '') + ev.delta).slice(-12000); queueRender(sid); return; }
  if (ev.t === 'tool_result' && store.toolLive) delete store.toolLive[ev.id];
  if (ev.t === 'assistant_start') { store.live = ''; store.streaming = true; }
  if (ev.t === 'assistant_end') { store.live = ''; store.streaming = false; }
  if (ev.t === 'history_reset') { loadEventsFresh(sid); return; }
  if (ev.t === 'git') { state.gitInfo.set(sid, ev); }
  if (ev.t === 'turn_end') { const s = state.sessions.get(sid); if (s && s.project && s.project.git) gitStatus(sid, false).catch(() => {}); }
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

function renderAll() { renderHeader(); renderViews(); renderWall(); renderSidebar(); renderTitlebars(); renderSplit(); renderTermLog(); if (state.view === 'stats') renderStatsView(); tickStatusLines(); }

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
        const imgs = (e.images || []).map((i) => `<span>🖼 ${esc(i)}</span>`).join('');
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
        if (!opts.compact) out.push(`<div class="note usage">✓ ${e.elapsed != null ? e.elapsed.toFixed ? e.elapsed.toFixed(1) + 's · ' : e.elapsed + 's · ' : ''}${fmtInt(e.input)} in → ${fmtInt(e.output)} out tokens${e.plan ? ' · on your plan' : e.cost ? ' · ' + fmtUsd(e.cost) : ''}</div>`);
        break;
      case 'error': out.push(`<div class="note err">${esc(e.text)}${e.fix === 'claude-login' ? ' <button class="primary" data-fix="claude">Reconnect Claude</button>' : e.fix === 'plan-limit' ? ' <button data-fix="claude">Claude plan</button>' : ` <button data-err="${esc(sid)}" title="what happened, send again, copy a report">details</button>`}</div>`); break;
      case 'notice': out.push(`<div class="note warn">${esc(e.text)}</div>`); break;
      case 'retry': out.push(`<div class="note warn">↻ ${esc(e.reason)} - retrying in ${e.delay}s (${e.attempt}/${e.max})</div>`); break;
      case 'info': out.push(`<div class="note">${esc(e.text)}</div>`); break;
      case 'system': out.push(`<div class="note">${esc(e.text)}${e.kind === 'interrupted' ? ' <button data-act="resume">resume</button>' : ''}</div>`); break;
      case 'compaction': out.push(`<div class="note marker">✂ context compacted here (${e.messages_before} messages → summary)</div>`); break;
      case 'compaction_start': out.push(`<div class="note">✂ compacting context (${fmtInt(e.tokens)} tokens)…</div>`); break;
      case 'handoff_start': out.push(`<div class="note">⇢ context at ${fmtInt(e.tokens)} tokens - writing the handoff summary for a fresh session…</div>`); break;
      case 'handoff': out.push(`<div class="note marker">⇢ ${esc(e.text || '')} <button data-open="${esc(e.to)}">open ${esc(e.name)}</button></div>`); break;
      case 'queue': out.push(`<div class="note">▶ queued task started (${e.remaining} left): ${esc(e.started)}</div>`); break;
      case 'git': out.push(`<div class="note">${esc(e.text || '')}</div>`); break;
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
  const pool = elapsedMs >= LONG_HAUL_AFTER_MS ? LONG_HAUL_VERBS : WORK_VERBS;
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
  if (sess && sess.status === 'paused') return `<div class="note paused"><b>paused</b> - kcoderd restarted during this turn; nothing was re-run. <button class="primary" data-act="resume">resume</button> <button data-act="dismiss">dismiss</button></div>`;
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
  const wk = st.week_tokens || []; const mx = Math.max(1, ...wk);
  const spark = `<svg viewBox="0 0 ${Math.max(1, wk.length) * 6} 12" width="${Math.max(1, wk.length) * 6}" height="12" aria-label="tokens, last 7 days">${wk.map((v, i) => { const h = Math.max(1, Math.round(v / mx * 11)); return `<rect x="${i * 6}" y="${12 - h}" width="4" height="${h}" rx="1"><title>${esc((st.week_dates || [])[i] || '')}: ${fmtInt(v)} tokens</title></rect>`; }).join('')}</svg>`;
  const items = [
    `<button class="status-item${st.cap_reached ? ' bad' : ''}" data-go="sessions" title="live sessions · open the sessions grid"><b>${st.sessions || 0}</b> active${st.cap_reached ? ' · paused (daily cap)' : ''}</button>`,
    `<button class="status-item" data-go="stats:tokens" title="tokens today · open stats"><b>${fmtTokens(tokens)}</b> tokens today</button>`,
    `<button class="status-item" data-go="stats:commits" title="commits today · open stats"><b>${st.commits_today || 0}</b> commit${st.commits_today === 1 ? '' : 's'} today</button>`,
    `<button class="status-item spark" data-go="stats:tokens" title="tokens, last 7 days · open stats">${spark}</button>`,
  ];
  const up = st.update || {};
  if (st.restarting) items.push(`<span class="status-item warn">restarting kcoderd…</span>`);
  else if (up.available) items.push(`<button class="status-item warn" data-upd="1" title="${esc((up.commits || []).join('\n'))}">${up.behind} new commit${up.behind === 1 ? '' : 's'}${up.failed ? ' · failed, rolled back' : ' · click to update'}</button>`);
  $('#status-items').innerHTML = items.join('<span class="sep">·</span>');
  const v = state.version || {};
  const vb = $('#btn-version'); vb.textContent = 'kcoder ' + (v.running || ''); vb.title = `kcoder ${v.running || ''}${v.installed && v.installed !== v.running ? ` (${v.installed} on disk, restart to use it)` : ''}${v.dev ? ' · git checkout' : ''} · settings`;
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
    (st === 'waiting' ? `<span class="waiting">WAITING ON YOU</span>` : st === 'paused' ? `<span class="waiting">PAUSED</span><button data-act="resume" class="primary">resume</button><button data-act="dismiss">dismiss</button>` : st === 'capped' ? `<span>paused (cap)</span>` : st === 'error' ? `<span class="waiting errlabel">ERROR</span><button data-err="${esc(s.id)}" title="what happened, send again, copy a report">details</button>` : '') +
    `<span>${age(s.last_activity)} ago</span>`;
  // approval bar
  const bar = $('.approval-bar', pane);
  if (s.pending_approval) {
    const store = state.events.get(s.id);
    const req = store && store.list.slice().reverse().find((e) => e.t === 'approval_request' && e.id === s.pending_approval);
    bar.hidden = false;
    bar.innerHTML = `<span>allow</span><code title="${esc(req ? req.description : '')}">${esc(req ? req.description : 'pending tool call')}</code><button class="primary" data-act="approve" data-rid="${esc(s.pending_approval)}">yes</button><button class="danger" data-act="decline" data-rid="${esc(s.pending_approval)}">no</button><span class="keys" title="keyboard: y approves, shift+N declines, then the next waiting item comes up; w jumps to the next one">y · ⇧N · w</span>`;
  } else if (s.status === 'paused') {
    bar.hidden = false;
    bar.innerHTML = `<span>paused</span><code title="${esc(s.resume_text || '')}">${esc(s.resume_text ? 'interrupted by a restart: ' + s.resume_text : 'the last turn was interrupted by a restart')}</code><button class="primary" data-act="resume">resume</button><button data-act="dismiss">dismiss</button>`;
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
      `<button data-act="open-chat">open in chat</button><button data-act="export">export</button><button data-act="archive">archive</button>` +
      (s.resume_text ? `<button data-act="resume" class="primary">resume interrupted turn</button>` : '');
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
      for (const el of $$(':scope > .msg.streaming, :scope > .note.working', log)) el.remove();
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
        if (!live) { const w = $(':scope > .note.working', log); if (w) w.remove(); log.insertAdjacentHTML('beforeend', trailerHtml(store, sid)); }
        else if (r.live !== store.live) $('.md', live).innerHTML = renderMarkdown(store.live);
      } else {
        if (live) live.remove();
        const w = $(':scope > .note.working', log); const want = trailerHtml(store, sid);
        if (w && !want) w.remove(); else if (!w && want) log.insertAdjacentHTML('beforeend', want);
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
        if (k >= 0) { const w = $(':scope > .msg.streaming, :scope > .note.working', log); const html = buildChatHtml(store, sid, { from: k, to: k + 1, noTail: true }); if (w) w.insertAdjacentHTML('beforebegin', html); else log.insertAdjacentHTML('beforeend', html); }
      }
    }
  }
  if (!incremental || changed) groupTools(log);
  holder._rendered = { sig: 1, sid, store, optsKey, count: store.list.length, live: store.live, streaming, status, toolSig, toolIds: Object.keys(store.toolLive || {}) };
  const jump = holder.querySelector ? holder.querySelector('.jump') : null;
  if (stick) { scroller.scrollTop = scroller.scrollHeight; if (jump) jump.hidden = true; }
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
  if (v !== 'shell') closeShell(sid);
  state.paneView.set(sid, v);
  const pane = $(`.pane[data-sid="${sid}"]`);
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
      case 'pr': { toast('opening a draft PR… (commit, review check, push, description)'); const r = await request('pr', { sid }); if (r.url) { toast((r.pr && r.pr.draft ? 'draft PR opened: ' : 'PR opened: ') + r.url, 'ok'); window.open(r.url, '_blank'); } else toast(r.message || 'PR created', 'ok'); break; }
      case 'discard': if (await confirmDialog(`Discard all work in ${s.worktree.branch}?`, 'The worktree and branch are deleted. This cannot be undone.')) { await request('discard', { sid }); toast('discarded', 'warn'); } break;
      case 'open-chat': assignPane(state.layout.focus, sid); setView('chat'); break;
      case 'export': await exportChat(sid); break;
      case 'archive': await request('archive', { sid }); if (state.focus === sid) focusPane(null); break;
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
  const blob = new Blob([format === 'html' ? r.html : r.markdown], { type: format === 'html' ? 'text/html' : 'text/markdown' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (r.title || 'chat').replace(/[^\w.-]+/g, '_') + (format === 'html' ? '.html' : '.md'); a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('exported ' + a.download, 'ok');
}
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
    return `<div class="project" data-pid="${esc(pid)}"><div class="project-head" title="${esc(g.project.path)}"><span>${open ? '▾' : '▸'}</span><span class="name">${esc(g.project.name)}</span><span>${active.length}${archived.length ? '+' + archived.length : ''}</span><button class="add" data-new-in="${esc(g.project.path)}" title="new chat in ${esc(g.project.name)}">+</button></div>` +
      (open ? active.map(chatItemHtml).join('') + (archived.length && show ? `<details class="archived-group"><summary class="chat-item archived"><span class="title">${archived.length} archived</span></summary>${archived.map(chatItemHtml).join('')}</details>` : '') : '') + '</div>';
  }).join('') || `<div class="hit">${hiddenChats ? 'no live chats' : 'no chats yet'} - press + to start one</div>`;
  const b = $('#btn-archived');
  b.hidden = !show && !hiddenChats;
  b.textContent = show ? 'hide archived' : `show ${hiddenChats} archived`; b.title = show ? 'Hide archived chats and projects with no live session' : `${hiddenChats} archived chat${hiddenChats === 1 ? '' : 's'}${hiddenProjects ? ` in ${hiddenProjects} project${hiddenProjects === 1 ? '' : 's'} with nothing live` : ''} are hidden`;
}
function showArchived() { return localStorage.getItem('kcoder.showArchived') === 'on'; }
$('#btn-archived').addEventListener('click', () => { localStorage.setItem('kcoder.showArchived', showArchived() ? 'off' : 'on'); renderSidebar(); });
function chatItemHtml(c) {
  const live = state.sessions.get(c.id);
  const st = c.archived ? 'archived' : (live ? live.status : c.status);
  const label = st === 'working' ? 'running' : st === 'waiting' ? (live && live.pending_approval ? 'needs approval' : 'needs you') : st === 'error' ? 'error' : st === 'idle' && live ? 'idle' : '';
  const inPane = state.layout.panes.indexOf(c.id);
  return `<div class="chat-item${c.archived ? ' archived' : ''}${c.id === state.sid ? ' current' : ''}${inPane >= 0 ? ' in-pane' : ''}" data-sid="${c.id}" draggable="true" title="${esc(c.name)} · ${esc(c.model || '')} · drag onto a pane"><span class="dot ${st}"></span><span class="title">${c.pinned ? '<span class="pin">📌 </span>' : ''}${esc(c.title || c.name)}</span>${st === 'working' ? `<span class="badge working">${statusLineHtml(c.id, true)}</span>` : st === 'error' ? `<button class="badge error" data-err="${c.id}" title="what happened, send again, copy a report">error · details</button>` : label ? `<span class="badge ${st}">${label}</span>` : ''}${inPane >= 0 ? `<span class="pane-no" title="open in pane ${inPane + 1}">${inPane + 1}</span>` : ''}<span class="age">${age(c.last_activity)}</span></div>`;
}
$('#projects').addEventListener('dragstart', (e) => { const item = e.target.closest('.chat-item[data-sid]'); if (!item) return; state.dragChat = item.dataset.sid; e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', item.dataset.sid); });
$('#projects').addEventListener('dragend', () => { state.dragChat = null; for (const p of $$('.cpane')) p.classList.remove('drop'); });

$('#projects').addEventListener('click', async (e) => {
  const clear = e.target.closest('[data-clear-search]'); if (clear) { state.searchResults = null; $('#search').value = ''; renderSidebar(); return; }
  const jmp = e.target.closest('[data-jump]'); if (jmp) { const [sid, turn] = jmp.dataset.jump.split(':'); jumpTo(sid, Number(turn)); return; }
  if (e.target.closest('[data-search-all]')) { searchDialog($('#search').value.trim()); return; }
  const add = e.target.closest('[data-new-in]'); if (add) { openNewSession({ cwd: add.dataset.newIn }); e.stopPropagation(); return; }
  const head = e.target.closest('.project-head'); if (head) { const pid = head.parentElement.dataset.pid; const c = JSON.parse(localStorage.getItem('kcoder.collapsed') || '{}'); c[pid] = !c[pid]; localStorage.setItem('kcoder.collapsed', JSON.stringify(c)); renderSidebar(); return; }
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
    else if (choice === 'archive') await request('archive', { sid });
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

function addImage(comp, file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { comp.images.push({ name: file.name || 'image.png', data_url: reader.result }); renderAtts(comp); };
  reader.readAsDataURL(file);
}
function renderAtts(comp) {
  comp.atts.hidden = comp.images.length === 0;
  comp.atts.innerHTML = comp.images.map((im, i) => `<span class="attachment"><img src="${im.data_url}" alt="${esc(im.name)}" title="${esc(im.name)}"><span class="x" data-i="${i}">✕</span></span>`).join('');
  for (const x of $$('.x', comp.atts)) x.onclick = () => { comp.images.splice(Number(x.dataset.i), 1); renderAtts(comp); };
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
  try {
    for (const t of targets) {
      const ts = state.sessions.get(t);
      const busy = ts && (ts.status === 'working' || ts.status === 'waiting');
      const r = await request('send', { sid: t, text, images: comp.images, queue_if_busy: busy });
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
    items.push([`archive: ${s.name}`, () => request('archive', { sid: s.id })]);
    items.push([`export: ${s.name}`, () => exportChat(s.id)]);
    items.push([`shell: ${s.name}`, () => { if (state.view !== 'wall') setView('wall'); setPaneView(s.id, 'shell'); focusPane(s.id); }]);
    if (s.project && s.project.git) items.push([`pull from remote: ${s.name}`, () => handleAction({ dataset: { act: 'pull' } }, s.id)]);
    if (s.worktree) { items.push([`changes: ${s.name}${s.needs_review ? ' (needs review)' : ''}`, () => changesDialog(s.id)]); items.push([`merge: ${s.name}`, () => handleAction({ dataset: { act: 'merge' } }, s.id)]); items.push([`open PR: ${s.name}`, () => handleAction({ dataset: { act: 'pr' } }, s.id)]); }
    items.push([`instructions: ${s.name}`, () => instructionsDialog(s.id)]);
  }
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
  const use = (c.usage || []).filter((u) => !u.stale && (u.limit === 'five_hour' || u.limit === 'seven_day'));
  b.textContent = !c.on_plan ? 'connect Claude' : lim.length ? `plan limit${lim.some((l) => l.scope === 'all') ? '' : ' · ' + lim.map((l) => l.scope).join(', ')}` : use.length ? 'plan ' + use.map((u) => `${PLAN_SHORT[u.limit]} ${planPct(u)}`).join(' · ') : 'plan ✓';
  if (!lim.length && use.some((u) => u.utilization >= 0.8)) b.className = 'warn';
  b.title = !c.on_plan ? (c.problem || 'not connected') : lim.length ? lim.map(claudeLimitText).join('\n') : `On your Claude plan${c.email ? ' as ' + c.email : ''}. kcoder never uses credits or an API key.` + ((c.usage || []).length ? '\n' + c.usage.map(planUsageText).join('\n') + '\nFrom Claude Code\'s rate-limit reports; updated on every turn. Click for the per-session share.' : '');
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
    <div class="tagline">${esc(TAGLINES[Math.floor(Math.random() * TAGLINES.length)])}</div>
    <div class="credits">developed by Kyle Niedzwiecki<br>© 2026 Kyer's Reserve LLC<br><span class="ver">kcoder ${esc(v.running || '')}</span></div>
    <div class="row"><button data-x="settings">Settings</button><button data-x="keys">Keyboard shortcuts</button><button class="primary" data-x="close">Close</button></div></div>`, 'about');
  d.classList.add('about');
  d.addEventListener('click', (e) => { const b = e.target.closest('[data-x]'); if (!b) return; closeDialog(); if (b.dataset.x === 'settings') settingsDialog(); else if (b.dataset.x === 'keys') helpDialog(); });
}

async function settingsDialog() {
  try { state.config = (await request('config')).config; } catch {}
  const cfg = state.config || {}; const v = state.version || {};
  const chk = (id, on, label, help) => `<label class="setting"><span>${label}${help ? ` <span class="help">${help}</span>` : ''}</span><input type="checkbox" data-set="${id}"${on ? ' checked' : ''}></label>`;
  const sel = (id, val, label, opts) => `<label class="setting"><span>${label}</span><select data-set="${id}">${opts.map(([k, l]) => `<option value="${k}"${k === val ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
  const d = openDialog(`<h2>settings<span class="spacer"></span><button data-x="close">✕</button></h2><div class="body">
    ${sel('theme', themeChoice(), 'Theme', [['dark', 'dark'], ['light', 'light'], ['system', 'follow the system']])}
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
    <label class="setting"><span>Daily spend cap (USD, 0 = none) <span class="help">sessions on paid API keys pause when today's spend reaches it</span></span><input type="number" min="0" step="1" data-set="daily_cap_usd" value="${Number((state.stats || {}).daily_cap_usd || 0)}"></label>
    <div class="label-h">accounts</div>
    <div class="links"><button data-x="claude">Claude plan</button><button data-x="setup">AI providers + GitHub</button><button data-x="remote">Phone approvals</button><button data-x="notif">Browser notifications</button></div>
    <div class="label-h">kcoder</div>
    <div class="links"><button data-x="update">Check for new commits</button><button data-x="restart">Restart kcoderd</button><button data-x="keys">Keyboard shortcuts</button><button data-x="about">About</button><button class="danger" data-x="uninstall">Uninstall…</button></div>
  </div><div class="foot"><span class="help">kcoder ${esc(v.running || '')} · © 2026 Kyer's Reserve LLC · developed by Kyle Niedzwiecki</span><button class="primary" data-x="close">Done</button></div>`, 'settings');
  d.classList.add('settings');
  d.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-set]'); if (!el) return;
    const k = el.dataset.set;
    try {
      if (k === 'theme') { setTheme(el.value); toast('theme: ' + el.value, 'ok'); return; }
      if (k === 'font') { const custom = el.value === '__custom'; $('#font-custom', d).hidden = !custom; if (custom) { $('[data-set="font_custom"]', d).focus(); return; } setFont(el.value, null); toast('font: ' + (el.value || 'system monospace'), 'ok'); return; }
      if (k === 'font_custom') { setFont(el.value.trim(), null); toast('font: ' + (el.value.trim() || 'system monospace'), 'ok'); return; }
      if (k === 'font_size') { setFont(null, Number(el.value)); toast('text size: ' + el.value + ' px', 'ok'); return; }
      if (k === 'sound') { if (state.sound !== el.checked) toggleSound(); return; }
      const fields = k === 'routing_enabled' ? { routing_enabled: el.checked } : k === 'auto_publish' ? { auto_publish: el.checked } : k === 'connector_approvals' ? { connector_approvals: el.checked } : k === 'handoff' ? { handoff: el.checked } : k === 'ci_autofix' ? { ci_autofix: el.checked } : k === 'daily_cap_usd' ? { daily_cap_usd: Number(el.value) || 0 } : { [k]: el.value };
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
  return h;
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
let tasksData = null, tasksTimer = null, schedulesData = null;
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
      <label>task<textarea name="text" placeholder="what should it do? It runs in its own worktree as soon as a slot is free, and lands in review when done. Paste a GitHub issue URL and the issue becomes the task (repo optional); the PR closes it." required></textarea></label>
      <div class="row"><span class="help">finished tasks wait in review; nothing is pushed on its own</span><span class="spacer" style="flex:1"></span><button class="primary" type="submit">add to queue</button></div>
    </form>
    <h3>running</h3><div class="task-list">${by('running').map((x) => row(x, false)).join('') || '<div class="empty-row">nothing running</div>'}</div>
    <h3>queued</h3><div class="task-list" id="tq-queued">${by('queued').map((x) => row(x, true)).join('') || '<div class="empty-row">queue is empty</div>'}</div>
    <h3>finished</h3><div class="task-list">${t.tasks.filter((x) => !['running', 'queued'].includes(x.status)).reverse().map((x) => row(x, false)).join('') || '<div class="empty-row">none yet</div>'}</div>
    ${schedulesHtml(schedulesData || [])}`;
  const sform = $('#sc-form', body);
  sform.addEventListener('submit', async (e) => { e.preventDefault(); const fd = new FormData(sform); try { await request('schedules', { action: 'add', name: fd.get('name'), repo: fd.get('repo'), text: fd.get('text'), every: fd.get('every'), at: fd.get('at'), weekday: Number(fd.get('weekday')), pr: fd.get('pr') === 'on' }); toast('schedule added', 'ok'); schedulesData = null; renderTasksView(true); } catch (err) { toast(err.message, 'err'); } });
  $('#sc-list', body).addEventListener('click', async (e) => { const b = e.target.closest('[data-s]'); if (!b) return; const id = b.closest('.task').dataset.sid; try { if (b.dataset.s === 'remove' && !(await confirmDialog('Remove this schedule?', ''))) return; await request('schedules', { action: b.dataset.s, id }); if (b.dataset.s === 'run') toast('queued a run', 'ok'); schedulesData = null; renderTasksView(true); } catch (err) { toast(err.message, 'err'); } });
  const form = $('#tq-form', body);
  form.querySelector('[name=provider]').addEventListener('change', (e) => { const p = provs.find((x) => x.id === e.target.value) || {}; form.querySelector('[name=model]').innerHTML = '<option value="">provider default</option>' + (p.models || []).map((m) => `<option>${esc(m)}</option>`).join(''); });
  form.querySelector('[name=trust]').value = (state.config && state.config.default_trust) || 'auto';
  form.addEventListener('submit', async (e) => { e.preventDefault(); const fd = new FormData(form); try { await request('tasks', { action: 'add', text: fd.get('text'), repo: fd.get('repo'), provider: fd.get('provider'), model: fd.get('model') || null, trust: fd.get('trust') }); toast('task queued', 'ok'); renderTasksView(true); } catch (err) { toast(err.message, 'err'); } });
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
function toast(text, kind = '') {
  const el = document.createElement('div'); el.className = 'toast ' + kind; el.textContent = text;
  const blocked = /GitHub is (not )?connected|Connect GitHub/i.test(text) && /block/i.test(text);
  if (blocked) { el.classList.add('warn'); const b = document.createElement('button'); b.textContent = 'Connect GitHub'; b.className = 'primary'; b.style.marginLeft = '8px'; b.onclick = (e) => { e.stopPropagation(); el.remove(); setupDialog(); }; el.appendChild(b); }
  $('#toasts').appendChild(el); el.onclick = () => el.remove(); setTimeout(() => el.remove(), blocked ? 12000 : 5000);
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
    if (pane.dataset.sid !== (sid || '')) { pane.dataset.sid = sid || ''; $('.composer-slot', pane).innerHTML = ''; $('.chat-log', pane).innerHTML = ''; pane._rendered = null; if (pane._find) closeFind(pane, true); }
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
function renderCpaneLog(pane) {
  const sid = pane.dataset.sid; const log = $('.chat-log', pane);
  const term = cpaneViewOf(sid) === 'term';
  log.classList.toggle('term-log', !!sid && term);
  if (!sid) { log.innerHTML = '<div class="empty"><p>No session in this pane.</p><p><button class="primary" data-pane="pick">Pick a session</button> or drag one from the sidebar.</p></div>'; pane._rendered = null; $('.jump', pane).hidden = true; return; }
  const store = state.events.get(sid) || { list: [], live: '', streaming: false };
  if (term) { const stick = nearBottom(log); log.innerHTML = buildTermHtml(store, sid, {}); if (stick) log.scrollTop = log.scrollHeight; pane._rendered = null; $('.jump', pane).hidden = true; return; }
  renderLogInto(pane, log, sid, store, {}, log);
  if (pane._find && pane._find.q) runFind(pane, false);
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
    const pb = e.target.closest('[data-pane]');
    if (pb) { const a = pb.dataset.pane; if (a === 'zoom') toggleZoom(idx()); else if (a === 'close') splitClose(idx()); else if (a === 'menu') paneMenu(pane); else if (a === 'find') openFind(pane); else if (a === 'view') toggleCpaneView(pane); return; }
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
  log.addEventListener('scroll', () => { if (nearBottom(log)) $('.jump', pane).hidden = true; });
  $('.jump', pane).addEventListener('click', () => { log.scrollTop = log.scrollHeight; $('.jump', pane).hidden = true; });
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
const fmtCompact = (v) => { v = Math.round(v || 0); const a = Math.abs(v); return a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 10000 ? (v / 1e3).toFixed(1) + 'k' : fmtInt(v); };
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
const verbCountsThisMonth = () => { try { return (JSON.parse(localStorage.getItem('kcoder.verbCounts') || '{}')[new Date().toISOString().slice(0, 7)] || {}); } catch { return {}; } };

async function renderStatsView(force) {
  if (state.view !== 'stats') return;
  const box = $('#stats-body');
  if (force || !statsData || statsData.days !== state.statsDays || (statsData.date || null) !== (state.statsDate || null)) {
    if (!statsData) box.innerHTML = '<div class="empty"><p>loading stats…</p></div>';
    try { statsData = await request('stats_full', { days: state.statsDays, date: state.statsDate || null }); } catch (e) { box.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; return; }
    if (state.view !== 'stats') return;
  }
  const d = statsData; const S = d.summary; const m = state.statsMetric;
  // the period every number on the page is for: a day, today, the last N days, or all time
  const P = d.date ? fmtDate(d.date) : d.days === 1 ? 'today' : d.days === 0 ? 'all time' : `${d.days} days`;
  const PW = S.window || S.today, isDay = !!d.date || d.days === 1;
  const metricCard = (key, title, pick, fmt, foot) => `<div class="card${m === key ? ' hl' : ''}"><h3>${title} <span class="dim">· ${P}</span></h3><div class="big">${fmt(pick(PW))}</div>${isDay ? '' : `<div class="row"><span>per day (${P})</span><b>${fmt(pick(S.window_avg || PW))}</b></div>`}${d.days === 1 ? '' : `<div class="row"><span>today</span><b>${fmt(pick(S.today))}</b></div>`}<div class="row"><span>7-day avg</span><b>${fmt(pick(S.avg7))}</b></div><div class="row"><span>30-day avg</span><b>${fmt(pick(S.avg30))}</b></div>${d.days === 0 ? '' : `<div class="row"><span>all time${S.first_date ? ' (since ' + fmtDate(S.first_date) + ')' : ''}</span><b>${fmt(pick(S.all))}</b></div>`}${foot || ''}</div>`;
  const linesFmt = (r) => `<span class="ok">+${fmtCompact(r.insertions)}</span> <span class="warn">-${fmtCompact(r.deletions)}</span> <span class="dim">net ${fmtSigned(r.net)}</span>`;
  const summary = [
    metricCard('tokens', 'tokens', (r) => r.total, fmtTokens),
    metricCard('lines', 'lines of code', (r) => r, linesFmt, `<div class="row"><span>files changed (${P}) · all time</span><b>${fmtInt(PW.files)} · ${fmtInt(S.all.files)}</b></div>`).replace('<div class="card', '<div class="card wide'),
    metricCard('commits', 'commits', (r) => r.commits, fmtNum),
    metricCard('sessions', 'sessions', (r) => r.sessions, fmtNum),
    metricCard('active', 'active agent time', (r) => r.active_seconds, fmtDur),
    metricCard('api', 'API equivalent <span class="dim">(estimate)</span>', (r) => r.api_equivalent, fmtUsd, `<div class="row"><span class="dim">what this usage would cost at API rates; plan usage is not billed</span></div>`),
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
  const cacheCard = `<div class="card"><h3>input tokens · ${P}</h3><div class="stack"><i class="fresh" style="width:${c.fresh / ci * 100}%" title="fresh input"></i><i class="cread" style="width:${c.cache_read / ci * 100}%" title="cache reads"></i><i class="cwrite" style="width:${c.cache_write / ci * 100}%" title="cache writes"></i></div>
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
  const vc = Object.entries(verbCountsThisMonth()).sort((a, b) => b[1] - a[1]);
  const fun = `<div class="card"><h3>just for fun</h3>${rec('most-shown verb this month', vc.length ? `${esc(vc[0][0])} <span class="dim">· ${fmtInt(vc[0][1])} times${vc[1] ? ' · then ' + esc(vc[1][0]) : ''}</span>` : null)}<div class="row"><span class="dim">counted in this browser while sessions work</span></div></div>`;
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
  box.innerHTML = `
    <div class="stats-head"><h2>stats</h2>
      <div class="seg" id="stats-range">${[[1, 'today'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [0, 'all time']].map(([n, l]) => `<button data-days="${n}" class="${!state.statsDate && state.statsDays === n ? 'active' : ''}">${l}</button>`).join('')}</div>
      <label class="help day-pick" title="Show one day: pick it here, or click a day in the daily table or the calendar">or a day <input type="date" id="stats-day" max="${d.today}" value="${esc(state.statsDate || '')}"></label>
      ${state.statsDate ? `<span class="chip day-chip">${fmtDate(state.statsDate)} <button data-clear-day="1" title="back to a period">✕</button></span>` : ''}
      <span class="help">today is ${fmtDate(d.today)} · days roll over at local midnight</span>
      <span class="spacer"></span>
      <button id="stats-csv" title="daily table as CSV">⤓ export CSV</button><button id="stats-refresh" title="refresh">↻</button>
    </div>
    <div class="summary six">${summary}</div>
    ${(d.window || {}).n === 1 ? '' : `<div class="two"><div class="card${m === 'tokens' ? ' hl' : ''}"><h3>daily tokens · ${P}</h3>${tokChart}</div><div class="card${m === 'lines' ? ' hl' : ''}"><h3>daily lines of code · ${P}</h3>${linesChart}</div></div>`}
    <div class="card"><h3>daily</h3><div id="stats-daily"></div></div>
    <div class="card"><h3>by model · ${P} <span class="dim">(aliases and full ids merged)</span></h3>${byModel}</div>
    <div class="two"><div class="card"><h3>by provider · ${P}</h3>${byProvider}</div>${cacheCard}</div>
    <div class="card"><h3>by repo / project · ${P}</h3>${byProject}</div>
    <div class="card${m === 'sessions' ? ' hl' : ''}"><h3>top sessions by tokens · ${P}</h3>${top}</div>
    ${calendar}
    ${hours}
    <div class="summary four">${parallel}${waiting}${health}${records}</div>
    <div class="two"><div class="card"><h3>tool usage · ${P}</h3>${toolsT}</div>${fun}</div>
    <div class="card${m === 'commits' ? ' hl' : ''}"><h3>commits from kcoder sessions · ${P} · ${fmtInt(ct.total)} total · <span class="ok">${fmtInt(ct.pushed)} pushed</span> · <span class="${ct.unpushed ? 'warn' : ''}">${fmtInt(ct.unpushed)} local only</span></h3>${commitsT}</div>`;
  renderDailyTable();
  $('#stats-range').addEventListener('click', (e) => { const b = e.target.closest('[data-days]'); if (!b) return; state.statsDays = Number(b.dataset.days); state.statsDate = null; localStorage.setItem('kcoder.statsDays', state.statsDays); renderStatsView(true); });
  $('#stats-day').addEventListener('change', (e) => { state.statsDate = e.target.value || null; renderStatsView(true); });
  $('#stats-csv').addEventListener('click', exportStatsCsv);
  $('#stats-refresh').addEventListener('click', () => renderStatsView(true));
  box.onclick = (e) => {
    const th = e.target.closest('th[data-sort]'); const tb = th && th.closest('[data-table]');
    if (th && tb) { const id = tb.dataset.table, k = th.dataset.sort; const cur = state.statsSorts[id]; state.statsSorts[id] = { key: k, dir: cur && cur.key === k ? -cur.dir : -1 }; localStorage.setItem('kcoder.statsSorts', JSON.stringify(state.statsSorts)); renderStatsView(false); return; }
    const cb = e.target.closest('[data-cal]'); if (cb) { state.statsCal = cb.dataset.cal; localStorage.setItem('kcoder.statsCal', state.statsCal); renderStatsView(false); return; }
    if (e.target.closest('[data-clear-day]')) { state.statsDate = null; renderStatsView(true); return; }
    const dd = e.target.closest('[data-day]'); if (dd && !e.target.closest('th')) { state.statsDate = dd.dataset.day; renderStatsView(true); return; }
    const os = e.target.closest('[data-open-session]'); if (os) { e.preventDefault(); assignPane(state.layout.focus, os.dataset.openSession); setView('chat'); return; }
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-open]'); if (tr) { assignPane(state.layout.focus, tr.dataset.open); setView('chat'); return; }
    const cr = e.target.closest('tr[data-sha]'); if (cr) cr.classList.toggle('open');
  };
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
function exportStatsCsv() {
  if (!statsData) return;
  const cols = ['date', 'input', 'fresh', 'cache_read', 'cache_write', 'output', 'total', 'calls', 'sessions', 'commits', 'insertions', 'deletions', 'net', 'files', 'active_seconds', 'cost', 'api_equivalent', 'pushed', 'unpushed'];
  const w = statsData.window || {}; const days = statsData.daily.filter((r) => (!w.start || r.date >= w.start) && (!w.end || r.date <= w.end));
  const csv = [cols.join(',')].concat(days.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((r) => cols.map((c) => r[c] ?? '').join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `kcoder-stats-${statsData.today}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

renderHeader(); renderViews();
connect();

