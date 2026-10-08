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
  ['/model', 'switch model'], ['/trust', 'auto | write | read | none'], ['/auto', 'toggle auto-approve'],
  ['/title', 'set the chat title'], ['/name', 'rename the session'], ['/queue', 'add a follow-up task'],
  ['/fork', 'fork this chat'], ['/compact', 'summarise history to free context'], ['/export', 'download as markdown'],
  ['/archive', 'archive this chat'], ['/shell', 'toggle the shell pane'], ['/wall', 'wall view'],
  ['/chat', 'chat view'], ['/terminal', 'terminal view'],
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
  view: localStorage.getItem('kcoder.view') || 'wall',
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
  statsDays: Number(localStorage.getItem('kcoder.statsDays') || 30),
  statsMetric: null,
  statsSort: { key: 'date', dir: -1 },
};

if (!state.winName) { state.winName = 'w' + Math.random().toString(36).slice(2, 7); sessionStorage.setItem('kcoder.win', state.winName); }
state.pins = JSON.parse(localStorage.getItem('kcoder.pins.' + state.winName) || '[]');
function savePins() { localStorage.setItem('kcoder.pins.' + state.winName, JSON.stringify(state.pins)); }

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
    state.connected = false; setConn('off');
    for (const [, p] of state.pending) p.reject(new Error('disconnected'));
    state.pending.clear();
    if (e.code === 4401) { localStorage.removeItem('kcoder.token'); tokenGate('That token was rejected.'); return; }
    setTimeout(connect, 1500);
  };
  ws.onerror = () => {};
}

function setConn(s) { const el = $('#conn'); el.className = 'conn ' + (s === 'on' ? 'on' : s === 'wait' ? 'wait' : ''); el.title = s === 'on' ? 'connected to kcoderd' : s === 'wait' ? 'connecting…' : 'disconnected - retrying'; }

function request(type, fields = {}) {
  return new Promise((resolve, reject) => {
    if (!state.ws || state.ws.readyState !== 1) return reject(new Error('not connected'));
    const id = state.reqId++;
    state.pending.set(id, { resolve, reject });
    state.ws.send(JSON.stringify({ type, id, ...fields }));
  });
}
function send(type, fields = {}) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify({ type, ...fields })); }

async function onFrame(msg) {
  if (msg.type === 'reply') {
    if (msg.id === 0) {
      if (!msg.ok) { localStorage.removeItem('kcoder.token'); tokenGate('Unauthorized.'); return; }
      state.connected = true; setConn('on');
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
}

async function onConnected() {
  await request('attach', { sid: '*' });
  await refreshProviders();
  try { state.config = (await request('config')).config; } catch {}
  applyUrlParams();
  for (const sid of state.sessions.keys()) loadEvents(sid, 80);
  for (const sid of state.layout.panes) if (sid) loadEvents(sid, -1);
  if (state.sid && !state.events.has(state.sid)) await loadEvents(state.sid, -1);
  syncSid();
  renderAll();
  if (!state._setupShown && (((state.providers || []).length && !state.providers.some((p) => p.configured)) || (state.github && !state.github.connected))) { state._setupShown = true; setupDialog(); }
  const open = new URLSearchParams(location.search).get('open');
  if (open && !state._openedOnce) { state._openedOnce = true; ({ new: openNewSession, inbox: openInbox, palette: openPalette, help: helpDialog }[open] || (() => {}))(); }
}

function applyUrlParams() {
  // ?view=wall|chat|terminal  ?sid=<id or name>  ?focus=1  ?pin=<id,id>  ?open=new|inbox|palette|help
  const q = new URLSearchParams(location.search);
  if (state._urlApplied) return; state._urlApplied = true;
  if (q.get('view')) { state.view = q.get('view'); localStorage.setItem('kcoder.view', state.view); }
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
}

function statusChanged(s, prev) {
  if (s.status === 'waiting') notify(`${s.name} is waiting on you`, s.pending_approval ? 'tool approval needed' : 'needs input', s.id, 'wait');
  else if (s.status === 'idle' && prev === 'working') notify(`${s.name} finished`, s.title || '', s.id, 'done');
  else if (s.status === 'error' && prev !== 'error') notify(`${s.name} hit an error`, '', s.id, 'err');
}

function onEvent(sid, ev) {
  let store = state.events.get(sid);
  if (!store) { store = { list: [], live: '', streaming: false, loaded: false, partial: true }; state.events.set(sid, store); }
  if (ev.t === 'text') { store.live += ev.delta; store.streaming = true; queueRender(sid); return; }
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
  });
}

function renderSession(sid) {
  const pane = $(`.pane[data-sid="${sid}"]`);
  if (pane) renderPaneBody(pane, sid);
  if (state.view === 'chat') for (const cp of $$(`.cpane[data-sid="${sid}"]`)) renderCpaneLog(cp);
  if (state.sid === sid && state.view === 'terminal') renderTermLog();
}

function renderAll() { renderHeader(); renderViews(); renderWall(); renderSidebar(); renderTitlebars(); renderSplit(); renderTermLog(); if (state.view === 'stats') renderStatsView(); }

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
          (opts.compact ? '' : `<div class="actions"><button data-act="edit" title="Edit and resend">✎</button><button data-act="fork" title="Fork from here">⑂</button><button data-act="copy" title="Copy message">⧉</button></div>`) + `</div>`);
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
        if (live) out.push(`<div class="approval" data-rid="${esc(e.id)}"><span>Allow</span><code>${esc(e.description)}</code><button class="primary" data-act="approve">yes <kbd>y</kbd></button><button class="danger" data-act="decline">no <kbd>n</kbd></button></div>`);
        break;
      }
      case 'usage':
        if (!opts.compact) out.push(`<div class="note usage">✓ ${e.elapsed != null ? e.elapsed.toFixed ? e.elapsed.toFixed(1) + 's · ' : e.elapsed + 's · ' : ''}${fmtInt(e.input)} in → ${fmtInt(e.output)} out tokens${e.plan ? ' · on your plan' : e.cost ? ' · ' + fmtUsd(e.cost) : ''}</div>`);
        break;
      case 'error': out.push(`<div class="note err">${esc(e.text)}</div>`); break;
      case 'notice': out.push(`<div class="note warn">${esc(e.text)}</div>`); break;
      case 'retry': out.push(`<div class="note warn">↻ ${esc(e.reason)} - retrying in ${e.delay}s (${e.attempt}/${e.max})</div>`); break;
      case 'info': out.push(`<div class="note">${esc(e.text)}</div>`); break;
      case 'system': out.push(`<div class="note">${esc(e.text)}${e.kind === 'interrupted' ? ' <button data-act="resume">resume</button>' : ''}</div>`); break;
      case 'compaction': out.push(`<div class="note marker">✂ context compacted here (${e.messages_before} messages → summary)</div>`); break;
      case 'compaction_start': out.push(`<div class="note">✂ compacting context (${fmtInt(e.tokens)} tokens)…</div>`); break;
      case 'queue': out.push(`<div class="note">▶ queued task started (${e.remaining} left): ${esc(e.started)}</div>`); break;
      case 'git': out.push(`<div class="note">${esc(e.text || '')}</div>`); break;
    }
  }
  if (!opts.noTail) out.push(trailerHtml(store, sid));
  return out.join('');
}
function trailerHtml(store, sid) {
  if (store.streaming || store.live) return `<div class="msg msg-assistant streaming"><div class="who">kcoder&gt;</div><div class="md">${store.live ? renderMarkdown(store.live) : ''}</div></div>`;
  const sess = state.sessions.get(sid);
  if (sess && sess.status === 'working') return `<div class="note working"><span class="t-spinner">◐</span> working…</div>`;
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
      case 'tool_result': if (e.is_error) out.push(`<span class="t-dim">  ✗ ${esc(stripAnsi(e.content || '').split('\n')[0])}</span>\n`); break;
      case 'error': case 'notice': out.push(`<span class="t-err">${esc(e.text)}</span>\n`); break;
      case 'retry': out.push(`<span class="t-warn">↻ ${esc(e.reason)} - retrying in ${e.delay}s (${e.attempt}/${e.max})</span>\n`); break;
      case 'info': case 'system': case 'git': out.push(`<span class="t-dim">${esc(e.text || '')}</span>\n`); break;
      case 'compaction': out.push(`<span class="t-dim">✂ compacted ${e.messages_before} messages into a summary</span>\n`); break;
      case 'compaction_start': out.push(`<span class="t-dim">✂ context at ${fmtInt(e.tokens)} tokens - compacting…</span>\n`); break;
      case 'queue': out.push(`<span class="t-dim">▶ next queued task (${e.remaining} left): ${esc(e.started)}</span>\n`); break;
      case 'turn_end': out.push('\n'); break;
    }
  }
  if (store.streaming || store.live) out.push(`<span class="t-k">kcoder&gt;</span>\n${esc(store.live)}<span class="cursor">▍</span>\n`);
  else if (sess && sess.status === 'working') out.push(`<span class="t-spinner">⠋</span> <span class="t-dim">working…</span>\n`);
  return out.join('');
}

// ----------------------------------------------------------------------
// header
// ----------------------------------------------------------------------
function renderHeader() {
  $('#banner').textContent = BANNER;
  const st = state.stats || {};
  const today = st.today || {};
  const tokens = (today.input || 0) + (today.output || 0);
  const wk = st.week_tokens || []; const mx = Math.max(1, ...wk);
  const spark = `<svg class="spark" viewBox="0 0 ${Math.max(1, wk.length) * 7} 18" width="${Math.max(1, wk.length) * 7}" height="18" aria-label="tokens, last 7 days">${wk.map((v, i) => { const h = Math.max(1, Math.round(v / mx * 16)); return `<rect x="${i * 7}" y="${18 - h}" width="5" height="${h}" rx="1"><title>${esc((st.week_dates || [])[i] || '')}: ${fmtInt(v)} tokens</title></rect>`; }).join('')}</svg>`;
  $('#stats').innerHTML = [
    `<button class="stat${st.cap_reached ? ' bad' : ''}" data-metric="sessions" title="open stats"><b>${st.sessions || 0}</b><span>active${st.cap_reached ? ' · paused (daily cap)' : ''}</span></button>`,
    `<button class="stat${st.waiting ? ' warn' : ''}" data-metric="sessions" title="open stats"><b>${st.waiting || 0}</b><span>waiting on you</span></button>`,
    `<button class="stat" data-metric="tokens" title="open stats"><b>${fmtTokens(tokens)}</b><span>tokens today</span></button>`,
    `<button class="stat" data-metric="commits" title="open stats"><b>${st.commits_today || 0}</b><span>commits today</span></button>`,
    `<button class="stat" data-metric="tokens" title="tokens, last 7 days"><b>${spark}</b><span>7 days</span></button>`,
  ].join('');
  $('#btn-broadcast').classList.toggle('active', !!state.broadcast);
  const n = (st.pending_approvals || []).length;
  const c = $('#inbox-count'); c.hidden = !n; c.textContent = n;
  $('#btn-sound').textContent = state.sound ? '🔔' : '🔕';
  for (const b of $$('.views button')) b.classList.toggle('active', b.dataset.view === state.view);
  const pinned = state.pins.length;
  document.title = (n ? `(${n}) ` : '') + 'kcoder' + (pinned ? ` · ${pinned} pinned` : '');
}

function setView(v) {
  state.view = v; localStorage.setItem('kcoder.view', v);
  renderViews();
  if (v === 'chat') { if (!focusedSid() && state.order[0]) { state.layout.panes[state.layout.focus] = state.order[0]; saveLayout(); } for (const sid of state.layout.panes) if (sid) loadEvents(sid, -1); syncSid(); }
  else if (v === 'terminal') { if (!state.sid) state.sid = focusedSid() || state.order[0] || null; if (state.sid) loadEvents(state.sid, -1); }
  else if (v === 'stats') statsData = null;
  renderAll();
  if (v === 'chat' || v === 'terminal') focusComposer();
}
function renderViews() {
  for (const s of $$('.view')) s.hidden = s.id !== 'view-' + state.view;
  for (const b of $$('.views button')) b.classList.toggle('active', b.dataset.view === state.view);
}

// ----------------------------------------------------------------------
// wall
// ----------------------------------------------------------------------
function paneStatus(s) {
  if (state.stats.cap_reached && s.status === 'idle') return 'paused';
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
  $('.model', pane).textContent = s.model || '';
  $('.window-pin', pane).classList.toggle('on', state.pins.includes(s.id));
  const pv = paneViewOf(s.id);
  $('.view-toggle', pane).textContent = pv === 'term' ? '▤' : pv === 'shell' ? '$' : '☰';
  const u = s.usage || {};
  const ctx = s.context_tokens || 0;
  const git = state.gitInfo.get(s.id);
  $('.pane-status', pane).innerHTML =
    `<span title="context used (last prompt)">ctx ${fmtTokens(ctx)}</span><span title="tokens in+out">${fmtTokens((u.input || 0) + (u.output || 0))} tok</span><span title="${s.plan ? 'covered by your Claude plan' : 'API spend'}">${s.plan ? 'plan' : fmtUsd(u.cost || 0)}</span>` +
    (s.queue && s.queue.length ? `<span title="queued tasks">▶ ${s.queue.length} queued</span>` : '') +
    (git ? `<span class="git-line" title="git">${esc(git.branch || '')}${git.dirty ? ` <span class="dirty">±${git.dirty}</span>` : ''}${git.ahead ? ` ↑${git.ahead}` : ''}</span>` : '') +
    `<span class="spacer"></span>` +
    (st === 'waiting' ? `<span class="waiting">WAITING ON YOU</span>` : st === 'paused' ? `<span>paused (cap)</span>` : '') +
    `<span>${age(s.last_activity)} ago</span>`;
  // approval bar
  const bar = $('.approval-bar', pane);
  if (s.pending_approval) {
    const store = state.events.get(s.id);
    const req = store && store.list.slice().reverse().find((e) => e.t === 'approval_request' && e.id === s.pending_approval);
    bar.hidden = false;
    bar.innerHTML = `<span>allow</span><code title="${esc(req ? req.description : '')}">${esc(req ? req.description : 'pending tool call')}</code><button class="primary" data-act="approve" data-rid="${esc(s.pending_approval)}">yes</button><button class="danger" data-act="decline" data-rid="${esc(s.pending_approval)}">no</button>`;
  } else bar.hidden = true;
  // actions (focused only)
  const acts = $('.pane-actions', pane);
  const focused = pane.classList.contains('focused');
  acts.hidden = !focused;
  if (focused) {
    acts.innerHTML =
      `<button data-act="interrupt" ${s.status === 'working' || s.status === 'waiting' ? '' : 'disabled'}>■ interrupt</button>` +
      `<button data-act="queue">+ task</button>` +
      `<select data-act="trust" title="trust level"><option value="auto">trust: auto</option><option value="write">trust: write</option><option value="read">trust: read</option><option value="none">trust: none</option></select>` +
      `<select data-act="model" title="model"></select>` +
      (s.project && s.project.git ? `<button data-act="git">git status</button><button data-act="pull" title="git pull --ff-only from the remote">⇣ pull</button>` : '') +
      (s.worktree ? `<button data-act="merge" title="merge this session's branch into the project">⇤ merge</button><button data-act="pr">open PR</button><button data-act="discard" class="danger">discard</button>` : '') +
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
  if (s.model && !models.includes(s.model)) models.unshift(s.model);
  sel.innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('') + '<option value="__other">other model…</option>';
  sel.value = s.model;
}

function paneViewOf(sid) { return state.paneView.get(sid) || 'chat'; }

function renderPaneBody(pane, sid) {
  const body = $('.pane-body', pane);
  const store = state.events.get(sid) || { list: [], live: '' };
  const pv = paneViewOf(sid);
  const focused = pane.classList.contains('focused');
  if (pv === 'shell') { body.className = 'pane-body shell-box'; ensureShell(sid, body); return; }
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
  holder._rendered = { sig: 1, sid, store, optsKey, count: store.list.length, live: store.live, streaming, status, toolSig, toolIds: Object.keys(store.toolLive || {}) };
  const jump = holder.querySelector ? holder.querySelector('.jump') : null;
  if (stick) { scroller.scrollTop = scroller.scrollHeight; if (jump) jump.hidden = true; }
  else if (jump && changed) jump.hidden = false;
}
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

function saveOrder() { localStorage.setItem('kcoder.order', JSON.stringify(state.order)); }
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
  const order = ['chat', 'term', 'shell'];
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
      case 'pr': { const r = await request('pr', { sid }); if (r.url) { toast('PR opened: ' + r.url, 'ok'); window.open(r.url, '_blank'); } else toast(r.message || 'PR created', 'ok'); break; }
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
async function exportChat(sid) {
  const r = await request('export', { sid });
  const blob = new Blob([r.markdown], { type: 'text/markdown' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (r.title || 'chat').replace(/[^\w.-]+/g, '_') + '.md'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function copyCode(btn) { const code = btn.parentElement.querySelector('code'); navigator.clipboard.writeText(code ? code.textContent : btn.parentElement.textContent); btn.textContent = 'copied'; setTimeout(() => (btn.textContent = 'copy'), 1200); }

// ----------------------------------------------------------------------
// chat view: sidebar
// ----------------------------------------------------------------------
function renderSidebar() {
  const box = $('#projects');
  if (state.searchResults) {
    box.innerHTML = `<div class="project search-results"><div class="project-head"><span class="name">search results</span><button class="add" data-clear-search="1">✕</button></div>` +
      (state.searchResults.length ? state.searchResults.map((c) => chatItemHtml(c) + (c.hits || []).map((h) => `<div class="hit"><b>${esc(h.who)}:</b> ${esc(h.snippet)}</div>`).join('')).join('') : '<div class="hit">no matches</div>') + '</div>';
    return;
  }
  const groups = new Map();
  for (const c of state.chats) { const pid = (c.project || {}).id || 'other'; if (!groups.has(pid)) groups.set(pid, { project: c.project || { name: 'other', path: '' }, chats: [] }); groups.get(pid).chats.push(c); }
  const collapsed = JSON.parse(localStorage.getItem('kcoder.collapsed') || '{}');
  box.innerHTML = Array.from(groups.entries()).map(([pid, g]) => {
    const active = g.chats.filter((c) => !c.archived);
    const archived = g.chats.filter((c) => c.archived);
    const open = !collapsed[pid];
    return `<div class="project" data-pid="${esc(pid)}"><div class="project-head" title="${esc(g.project.path)}"><span>${open ? '▾' : '▸'}</span><span class="name">${esc(g.project.name)}</span><span>${active.length}${archived.length ? '+' + archived.length : ''}</span><button class="add" data-new-in="${esc(g.project.path)}" title="new chat in ${esc(g.project.name)}">+</button></div>` +
      (open ? active.map(chatItemHtml).join('') + (archived.length ? `<details class="archived-group"><summary class="chat-item archived"><span class="title">${archived.length} archived</span></summary>${archived.map(chatItemHtml).join('')}</details>` : '') : '') + '</div>';
  }).join('') || '<div class="hit">no chats yet - press + to start one</div>';
}
function chatItemHtml(c) {
  const live = state.sessions.get(c.id);
  const st = c.archived ? 'archived' : (live ? live.status : c.status);
  const label = st === 'working' ? 'running' : st === 'waiting' ? (live && live.pending_approval ? 'needs approval' : 'needs you') : st === 'error' ? 'error' : st === 'idle' && live ? 'idle' : '';
  const inPane = state.layout.panes.indexOf(c.id);
  return `<div class="chat-item${c.archived ? ' archived' : ''}${c.id === state.sid ? ' current' : ''}${inPane >= 0 ? ' in-pane' : ''}" data-sid="${c.id}" draggable="true" title="${esc(c.name)} · ${esc(c.model || '')} · drag onto a pane"><span class="dot ${st}"></span><span class="title">${c.pinned ? '<span class="pin">📌 </span>' : ''}${esc(c.title || c.name)}</span>${label ? `<span class="badge ${st}">${label}</span>` : ''}${inPane >= 0 ? `<span class="pane-no" title="open in pane ${inPane + 1}">${inPane + 1}</span>` : ''}<span class="age">${age(c.last_activity)}</span></div>`;
}
$('#projects').addEventListener('dragstart', (e) => { const item = e.target.closest('.chat-item[data-sid]'); if (!item) return; state.dragChat = item.dataset.sid; e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', item.dataset.sid); });
$('#projects').addEventListener('dragend', () => { state.dragChat = null; for (const p of $$('.cpane')) p.classList.remove('drop'); });
$('#btn-split').addEventListener('click', () => splitAdd(null));

$('#projects').addEventListener('click', async (e) => {
  const clear = e.target.closest('[data-clear-search]'); if (clear) { state.searchResults = null; $('#search').value = ''; renderSidebar(); return; }
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
$('#btn-new-chat').addEventListener('click', () => openNewSession());

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
function renderTitlebars() {
  const s = state.sid ? (state.sessions.get(state.sid) || state.chats.find((c) => c.id === state.sid)) : null;
  const html = !s ? '<span class="meta">pick a chat on the left, or press n for a new one</span>' :
    `<span class="dot ${s.archived ? 'archived' : s.status}"></span><span class="title">${esc(s.title || s.name)}</span><span class="meta">${esc((s.project || {}).name || '')}${s.worktree ? ' @ ' + esc(s.worktree.branch) : ''} · ${esc(shortHome(s.cwd))}</span><span class="spacer"></span>` +
    `<span class="meta">ctx ${fmtTokens(s.context_tokens || 0)} · ${s.plan ? 'on your plan' : fmtUsd((s.usage || {}).cost || 0)}</span>` +
    `<select data-act="trust" title="trust"><option value="auto">auto</option><option value="write">write</option><option value="read">read</option><option value="none">none</option></select>` +
    `<select data-act="model" title="model"></select>` +
    `<button data-act="interrupt" title="Esc" ${s.status === 'working' || s.status === 'waiting' ? '' : 'disabled'}>■</button>` +
    `<button data-act="export" title="export markdown">⤓</button><button data-act="menu" title="more">⋯</button>`;
  for (const id of ['#term-titlebar']) {
    const el = $(id); el.innerHTML = html;
    if (s) { $('select[data-act="trust"]', el).value = s.trust || 'read'; fillModelSelect($('select[data-act="model"]', el), s); }
  }
}
for (const id of ['#term-titlebar']) {
  $(id).addEventListener('click', (e) => { const b = e.target.closest('button[data-act]'); if (!b || !state.sid) return; if (b.dataset.act === 'menu') chatMenu(state.sid); else handleAction(b, state.sid); });
  $(id).addEventListener('change', (e) => { const s = e.target.closest('select[data-act]'); if (s && state.sid) handleAction(s, state.sid); });
}

function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 80; }
function renderTermLog() {
  if (state.view !== 'terminal') return;
  const log = $('#term-log');
  if (!state.sid) { log.innerHTML = 'no chat selected - press n'; ensureComposer('#term-composer', null); return; }
  const store = state.events.get(state.sid) || { list: [], live: '' };
  const stick = nearBottom(log);
  log.innerHTML = buildTermHtml(store, state.sid, {});
  if (stick) log.scrollTop = log.scrollHeight;
  ensureComposer('#term-composer', state.sid, true);
}
for (const id of ['#term-log']) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (b && state.sid) { handleAction(b, state.sid); return; }
    if (e.target.dataset.copy) copyCode(e.target);
  });
}
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
      case '/model': if (arg) await request('set', { sid, model: arg }); else toast('model: ' + s.model); return true;
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
      case '/wall': setView('wall'); return true;
      case '/chat': setView('chat'); return true;
      case '/terminal': setView('terminal'); return true;
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
  const term = new Terminal({ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, theme: { background: '#000000', foreground: '#d5dde8', cursor: '#87CEFA' }, cursorBlink: true, scrollback: 5000, allowProposedApi: true });
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
    const d = openDialog(`<h2>${esc(title)}</h2><div class="list">${items.map(([k, l], i) => `<div class="item${i === 0 ? ' sel' : ''}" data-k="${esc(k)}"><span>${esc(l)}</span></div>`).join('')}</div>`, 'choose');
    d.addEventListener('click', (e) => { const it = e.target.closest('[data-k]'); if (!it) return; state._dialogReject = null; closeDialog(); resolve(it.dataset.k); });
  });
}
function infoDialog(title, html) { openDialog(`<h2>${esc(title)}<span class="spacer"></span><button data-x="close">✕</button></h2><div class="body">${html}</div>`, 'info').addEventListener('click', (e) => { if (e.target.closest('[data-x]')) closeDialog(); }); }

function helpDialog() {
  const rows = [
    ['1-9', 'jump to pane'], ['click / enter', 'focus pane'], ['drag title bar', 'reorder panes'], ['esc', 'back to grid · interrupt agent while typing'], ['w', 'cycle sessions waiting on you'],
    ['n', 'new session'], ['a', 'approval inbox'], ['y / n', 'approve / decline (inbox or focused pane)'], ['v', 'cycle pane view: chat → terminal → shell'],
    ['alt+1 / 2 / 3', 'wall · chat · terminal view'], ['⌘K', 'command palette'], ['p', 'pin focused session to this window'], ['?', 'this help'],
    ['enter', 'send'], ['shift+enter', 'newline'], ['↑', 'previous prompt'], ['/', 'slash commands'], ['@', 'reference a project file'], ['paste', 'never submits; big pastes become chips'],
    ['⌘\\', 'split: add a pane (up to 3)'], ['⌘1 / 2 / 3', 'focus pane'], ['⌘⇧W', 'close pane'], ['⌘⇧↩', 'pop out the pane / back to the grid'], ['⌃⌘F', 'full screen'],
    ['⌘F', 'find in this session'], ['⌘⇧F', 'search across sessions'], ['⌘A', 'select the whole transcript'], ['⌘C', 'copy selection as clean text'], ['alt+4', 'stats view'],
  ];
  infoDialog('keyboard', `<div class="help-grid">${rows.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('')}</div>`);
}

// approval inbox
function renderInbox() {
  const pend = [];
  for (const s of state.sessions.values()) {
    if (!s.pending_approval) continue;
    const store = state.events.get(s.id);
    const req = store && store.list.slice().reverse().find((e) => e.t === 'approval_request' && e.id === s.pending_approval);
    pend.push({ sid: s.id, name: s.name, rid: s.pending_approval, desc: req ? req.description : 'pending tool call', ts: req ? req.ts : 0 });
  }
  pend.sort((a, b) => a.ts - b.ts);
  const sel = Math.min(state.inboxSel || 0, Math.max(0, pend.length - 1)); state.inboxSel = sel;
  const html = `<h2>approval inbox <span class="help">${pend.length} pending · y approve · n decline · a approve all · ↑↓ move · esc close</span><span class="spacer"></span><button data-x="close">✕</button></h2>` +
    `<div class="list">${pend.length ? pend.map((p, i) => `<div class="item${i === sel ? ' sel' : ''}" data-i="${i}"><span class="sess">${esc(p.name)}</span><code>${esc(p.desc)}</code><span class="meta">${age(p.ts)} ago</span><button class="primary" data-ap="1" data-sid="${p.sid}" data-rid="${esc(p.rid)}">yes</button><button class="danger" data-ap="0" data-sid="${p.sid}" data-rid="${esc(p.rid)}">no</button></div>`).join('') : '<div class="empty-row">nothing waiting on you</div>'}</div>`;
  state.inboxItems = pend;
  if (state.dialog === 'inbox') { $('#overlay .dialog').innerHTML = html; }
  else openDialog(html, 'inbox');
}
function openInbox() { state.inboxSel = 0; renderInbox(); }
$('#overlay').addEventListener('click', async (e) => {
  if (state.dialog !== 'inbox') return;
  if (e.target.closest('[data-x]')) { closeDialog(); return; }
  const b = e.target.closest('[data-ap]');
  if (b) { await approve(b.dataset.sid, b.dataset.rid, b.dataset.ap === '1'); return; }
  const it = e.target.closest('.item[data-i]'); if (it) { state.inboxSel = Number(it.dataset.i); renderInbox(); }
});
async function approve(sid, rid, ok) { try { await request('approve', { sid, rid, approved: ok }); } catch (e) { toast(e.message, 'err'); } setTimeout(() => { if (state.dialog === 'inbox') renderInbox(); }, 150); }
function inboxKey(e) {
  const items = state.inboxItems || []; const cur = items[state.inboxSel || 0];
  if (e.key === 'ArrowDown' || e.key === 'j') { state.inboxSel = Math.min(items.length - 1, (state.inboxSel || 0) + 1); renderInbox(); }
  else if (e.key === 'ArrowUp' || e.key === 'k') { state.inboxSel = Math.max(0, (state.inboxSel || 0) - 1); renderInbox(); }
  else if (e.key === 'y' && cur) approve(cur.sid, cur.rid, true);
  else if (e.key === 'n' && cur) approve(cur.sid, cur.rid, false);
  else if (e.key === 'a') items.forEach((p) => approve(p.sid, p.rid, true));
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
  const d = openDialog(`<h2>new session</h2><div class="body">
    <label>repo / folder <span class="help" style="text-transform:none;letter-spacing:0">local path, owner/name, or a GitHub URL (cloned into ${esc(shortHome(cfg.projects_dir || '~/kcoder-projects'))} on first use)</span>
      <input id="ns-cwd" value="${esc(cwd)}" placeholder="/path/to/project  ·  owner/repo  ·  https://github.com/owner/repo" autocomplete="off">
      <div class="menu repo-menu" id="ns-repos" hidden></div>
    </label>
    <div class="row">
      <label>provider<select id="ns-provider">${provs.map((p) => `<option value="${p.id}"${p === def ? ' selected' : ''}${p.configured ? '' : ' disabled'}>${esc(p.label)}${p.configured ? '' : ' (not set up)'}</option>`).join('')}</select></label>
      <label>model<select id="ns-model"></select></label>
      <label>trust<select id="ns-trust"><option value="auto">auto (never ask)</option><option value="write">write (gate shell)</option><option value="read">read (gate writes + shell)</option><option value="none">none (ask for everything)</option></select></label>
    </div>
    <label>session name (optional)<input id="ns-name" placeholder="defaults to the folder name"></label>
    <label>initial task<textarea id="ns-task" placeholder="what should it do first?"></textarea></label>
    <label>follow-up tasks, one per line (optional)<textarea id="ns-queue" placeholder="run the tests&#10;open a PR"></textarea></label>
    <label class="check"><input type="checkbox" id="ns-wt" ${cfg.worktrees === false ? '' : 'checked'}> use a separate git worktree + branch (recommended when running several sessions on one repo)</label>
    <div class="help" style="text-transform:none;letter-spacing:0">Provider not set up yet? <a href="#" id="ns-setup">Connect your AI</a></div>
  </div><div class="foot"><span class="help" id="ns-status"></span><span class="spacer" style="flex:1"></span><button data-x="cancel">cancel</button><button class="primary" data-x="ok">start</button></div>`, 'new');
  const modelSel = $('#ns-model', d), provSel = $('#ns-provider', d), cwdIn = $('#ns-cwd', d), repoMenu = $('#ns-repos', d), status = $('#ns-status', d);
  $('#ns-setup', d).addEventListener('click', (e) => { e.preventDefault(); const pid = provSel.value; closeDialog(); setupDialog(pid); });
  $('#ns-trust', d).value = state.config && state.config.default_trust ? state.config.default_trust : 'auto';
  const fill = () => { const p = provs.find((x) => x.id === provSel.value) || {}; modelSel.innerHTML = (p.models || []).map((m) => `<option${m === p.default_model ? ' selected' : ''}>${esc(m)}</option>`).join('') + '<option value="__other">other…</option>'; };
  provSel.addEventListener('change', fill); fill();
  // repo picker: local git repos + GitHub repos via gh
  let repos = state.repoCache;
  const renderRepos = () => {
    if (!repos) { repoMenu.hidden = false; repoMenu.innerHTML = '<div class="item"><span class="meta">looking for repos…</span></div>'; return; }
    const q = cwdIn.value.trim().toLowerCase();
    const local = repos.local.filter((r) => !q || fuzzy((r.name + ' ' + r.path).toLowerCase(), q)).slice(0, 12);
    const gh = repos.github.filter((r) => !local.some((l) => l.path === r.path) && (!q || fuzzy(r.spec.toLowerCase(), q))).slice(0, 12);
    const pub = !(state.config && state.config.auto_publish === false);
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
  d.addEventListener('click', (e) => { const b = e.target.closest('[data-x]'); if (!b) return; b.dataset.x === 'ok' ? submit() : closeDialog(); });
  d.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
}

// command palette
function paletteItems() {
  const items = [
    ['new session', () => openNewSession(), 'n'], ['connect your AI (sign in to a provider)', () => setupDialog()], ['connect GitHub (commit identity)', () => setupDialog()], ['approval inbox', openInbox, 'a'],
    ['split: add a pane', () => { if (state.view !== 'chat') setView('chat'); splitAdd(null); }, '⌘\\'], ['pop out / restore pane', () => toggleZoom(), '⌘⇧↩'], ['full screen', toggleFullscreen, '⌃⌘F'],
    ['stats view', () => setView('stats'), 'alt+4'], ['toggle broadcast (send to all panes)', toggleBroadcast], ['cycle waiting sessions', cycleWaiting, 'w'],
    ['wall view', () => setView('wall'), 'alt+1'], ['chat view', () => setView('chat'), 'alt+2'], ['terminal view', () => setView('terminal'), 'alt+3'],
    ['toggle sound', toggleSound], ['enable browser notifications', () => Notification.requestPermission().then((p) => toast('notifications: ' + p))],
    ['set default trust for new sessions', async () => { const v = await chooseDialog('Default trust for new sessions', [['auto', 'auto - never ask'], ['write', 'write - gate shell'], ['read', 'read - gate writes + shell'], ['none', 'none - ask for everything']]); if (v) { const r = await request('config', { default_trust: v }); state.config = r.config; toast('default trust: ' + v, 'ok'); } }],
    ['toggle auto-publish of local folders to GitHub', async () => { const on = !(state.config && state.config.auto_publish !== false); const r = await request('config', { auto_publish: on }); state.config = r.config; toast('auto-publish to GitHub: ' + (on ? 'on' : 'off'), 'ok'); }],
    ['set daily spend cap', async () => { const v = await promptDialog('Daily spend cap (USD, 0 = none)', 'Sessions pause when today\'s spend reaches it.', String(state.stats.daily_cap_usd || 0)); if (v != null) await request('config', { daily_cap_usd: Number(v) || 0 }); }],
    ['unpin all sessions from this window', () => { state.pins = []; savePins(); renderHeader(); renderWall(); }],
    ['keyboard help', helpDialog, '?'],
  ];
  for (const s of state.sessions.values()) {
    items.push([`focus: ${s.name}${s.title ? ' · ' + s.title : ''}`, () => { if (state.view !== 'wall') setView('wall'); focusPane(s.id); }]);
    items.push([`chat: ${s.name}`, () => { state.sid = s.id; setView('chat'); }]);
    if (s.status === 'working' || s.status === 'waiting') items.push([`interrupt: ${s.name}`, () => request('interrupt', { sid: s.id })]);
    items.push([`archive: ${s.name}`, () => request('archive', { sid: s.id })]);
    items.push([`export: ${s.name}`, () => exportChat(s.id)]);
    items.push([`shell: ${s.name}`, () => { if (state.view !== 'wall') setView('wall'); setPaneView(s.id, 'shell'); focusPane(s.id); }]);
    if (s.project && s.project.git) items.push([`pull from remote: ${s.name}`, () => handleAction({ dataset: { act: 'pull' } }, s.id)]);
    if (s.worktree) { items.push([`merge: ${s.name}`, () => handleAction({ dataset: { act: 'merge' } }, s.id)]); items.push([`open PR: ${s.name}`, () => handleAction({ dataset: { act: 'pr' } }, s.id)]); }
  }
  for (const c of state.chats.filter((c) => c.archived).slice(0, 50)) items.push([`resume: ${c.title || c.name}`, () => openChat(c.id)]);
  return items;
}
function openPalette() {
  const all = paletteItems();
  let sel = 0, shown = all;
  const d = openDialog(`<div class="palette"><input id="pal-in" placeholder="type a command…"><div class="list" id="pal-list"></div></div>`, 'palette');
  const inp = $('#pal-in', d), list = $('#pal-list', d);
  const render = () => { list.innerHTML = shown.slice(0, 30).map(([l, , k], i) => `<div class="item${i === sel ? ' sel' : ''}" data-i="${i}"><span>${esc(l)}</span>${k ? `<span class="meta"><kbd>${esc(k)}</kbd></span>` : ''}</div>`).join('') || '<div class="empty-row">no match</div>'; const s = $('.sel', list); if (s) s.scrollIntoView({ block: 'nearest' }); };
  const filter = () => { const q = inp.value.toLowerCase().trim(); shown = q ? all.filter(([l]) => fuzzy(l.toLowerCase(), q)) : all; sel = 0; render(); };
  const run = (i) => { const it = shown[i]; closeDialog(); if (it) it[1](); };
  inp.addEventListener('input', filter);
  inp.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { sel = Math.min(shown.length - 1, sel + 1); render(); e.preventDefault(); } else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); render(); e.preventDefault(); } else if (e.key === 'Enter') { run(sel); } else if (e.key === 'Escape') closeDialog(); });
  list.addEventListener('click', (e) => { const it = e.target.closest('[data-i]'); if (it) run(Number(it.dataset.i)); });
  render();
}
function fuzzy(text, q) { let i = 0; for (const ch of q) { i = text.indexOf(ch, i); if (i < 0) return false; i++; } return true; }

// first-run setup: connect an AI provider (API key, or Claude Code for a Claude plan)
async function refreshProviders() { try { const r = await request('providers'); state.providers = r.providers; state.github = r.github || state.github; } catch {} return state.providers || []; }
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
      panel.innerHTML = `<div class="status"><span>Claude Code: ${p.installed ? '<b class="ok">installed</b>' : '<b class="warn">not installed</b>'}</span><span>Account: ${p.logged_in ? `<b class="ok">signed in${p.email ? ' as ' + esc(p.email) : ''}</b>` : '<b class="warn">not signed in</b>'}</span></div>
        <div class="help plain">Uses your Claude subscription from claude.ai. No API key and no per-token billing.${p.installed ? '' : ' Installing opens a Terminal window; follow the steps there, then come back and click Check again.'}</div>
        <div class="row">${!p.installed ? '<button class="primary" data-su="install">Install Claude Code and sign in</button>' : !p.logged_in ? '<button class="primary" data-su="login">Sign in to Claude</button>' : '<button class="primary" data-su="use-claude">Use my Claude plan</button>'}<button data-su="check">Check again</button></div>`;
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
document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName) || (e.target && e.target.isContentEditable);
  const mod = e.metaKey || e.ctrlKey;
  const key = (e.key || '').toLowerCase();
  if (state.dialog === 'inbox') { inboxKey(e); return; }
  if (state.dialog && e.key === 'Escape') { closeDialog(); return; }
  if (mod && key === 'k') { e.preventDefault(); state.dialog ? closeDialog() : openPalette(); return; }
  if (e.altKey && ['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); setView(['wall', 'chat', 'terminal', 'stats'][Number(e.key) - 1]); return; }
  if (e.metaKey && e.ctrlKey && key === 'f') { e.preventDefault(); toggleFullscreen(); return; }
  if (mod && !state.dialog) {
    if (!e.shiftKey && !e.altKey && ['1', '2', '3'].includes(e.key) && state.view === 'chat') { e.preventDefault(); splitFocus(Number(e.key) - 1); return; }
    if (e.key === '\\') { e.preventDefault(); if (state.view !== 'chat') setView('chat'); splitAdd(null); return; }
    if (e.shiftKey && key === 'w') { e.preventDefault(); if (state.view === 'chat') splitClose(state.layout.focus); return; }
    if (e.shiftKey && e.key === 'Enter') { e.preventDefault(); if (state.view !== 'chat') setView('chat'); toggleZoom(); return; }
    if (e.shiftKey && key === 'f') { e.preventDefault(); if (state.view !== 'chat') setView('chat'); const si = $('#search'); si.focus(); si.select(); return; }
    if (!e.shiftKey && key === 'f' && state.view === 'chat') { e.preventDefault(); const p = $$('#split .cpane')[state.layout.focus]; if (p) openFind(p); return; }
    if (key === 'a' && !inField) { const log = focusedLog(); if (log) { e.preventDefault(); const r = document.createRange(); r.selectNodeContents(log); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); return; } }
  }
  if (e.key === 'Escape' && state.view === 'chat' && !state.dialog) { const p = $$('#split .cpane')[state.layout.focus]; if (p && p._find && !inField) { closeFind(p); return; } }
  if (inField || state.dialog) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const focusedSess = state.view === 'chat' ? state.sessions.get(focusedSid()) : (state.focus && state.sessions.get(state.focus));
  switch (e.key) {
    case 'Escape': if (state.focus) { focusPane(null); } break;
    case 'n': openNewSession(); break;
    case 'a': case 'i': openInbox(); break;
    case 'w': cycleWaiting(); break;
    case 'v': if (state.focus) cyclePaneView(state.focus); else if (state.sid && state.view !== 'wall') setView(state.view === 'chat' ? 'terminal' : 'chat'); break;
    case 'p': if (state.focus) togglePin(state.focus); break;
    case '?': helpDialog(); break;
    case 'y': if (focusedSess && focusedSess.pending_approval) approve(focusedSess.id, focusedSess.pending_approval, true); break;
    case 'N': if (focusedSess && focusedSess.pending_approval) approve(focusedSess.id, focusedSess.pending_approval, false); break;
    case 'Enter': if (state.view === 'wall' && !state.focus && state.sid) focusPane(state.sid); break;
    case '/': if (state.view !== 'wall' || state.focus) { e.preventDefault(); focusComposer(); const ta = document.activeElement; if (ta && ta.tagName === 'TEXTAREA') { ta.value = '/'; ta.dispatchEvent(new Event('input')); } } break;
    default:
      if (/^[1-9]$/.test(e.key)) { const list = visibleSessions(); const s = list[Number(e.key) - 1]; if (s) { if (state.view !== 'wall') setView('wall'); focusPane(s.id); } }
  }
});

// header buttons
for (const b of $$('.views button')) b.addEventListener('click', () => setView(b.dataset.view));
$('#btn-inbox').addEventListener('click', openInbox);
$('#btn-new').addEventListener('click', () => openNewSession());
$('#btn-palette').addEventListener('click', openPalette);
$('#btn-sound').addEventListener('click', toggleSound);
$('#btn-broadcast').addEventListener('click', toggleBroadcast);
$('#stats').addEventListener('click', (e) => { const b = e.target.closest('[data-metric]'); if (b) openStats(b.dataset.metric); });
if (window.addEventListener) window.addEventListener('pywebviewready', () => document.body.classList.add('native'));
$('#view-wall').addEventListener('click', (e) => { const b = e.target.closest('[data-action="new"]'); if (b) openNewSession(); });
$('#tagline').textContent = ['ten agents, one keyboard.', 'ship it before the coffee cools.', 'parallel by default.', 'less typing, more shipping.', 'every session earns its keep.', 'small commits, big days.'][Math.floor(Math.random() * 6)];
document.addEventListener('click', () => { if ('Notification' in window && Notification.permission === 'default' && !localStorage.getItem('kcoder.askedNotif')) { localStorage.setItem('kcoder.askedNotif', '1'); Notification.requestPermission(); } }, { once: true });
setInterval(() => { renderHeader(); if (state.view === 'wall') for (const p of $$('.pane')) { const s = state.sessions.get(p.dataset.sid); if (s) renderPaneChrome(p, s, state.order.indexOf(s.id) + 1); } }, 15000);
window.addEventListener('resize', () => { for (const sid of state.shells.keys()) fitShell(sid); });

// ----------------------------------------------------------------------
// split view: 1 to 3 session panes side by side, each fully independent
// ----------------------------------------------------------------------
function saveLayout() { localStorage.setItem('kcoder.layout', JSON.stringify(state.layout)); }
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
  $('.meta', bar).textContent = s ? `${(s.project || {}).name || shortHome(s.cwd)}${s.worktree ? ' @ ' + s.worktree.branch : ''}` : '';
  $('.ctx', bar).textContent = s ? `ctx ${fmtTokens(s.context_tokens || 0)} · ${s.plan ? 'plan' : fmtUsd((s.usage || {}).cost || 0)}` : '';
  for (const el of $$('select[data-act], button[data-act]', bar)) el.disabled = !s;
  if (s) {
    const ts = $('select[data-act="trust"]', bar); if (ts.value !== (s.trust || 'read')) ts.value = s.trust || 'read';
    const ms = $('select[data-act="model"]', bar); if (ms.dataset.for !== sid + ':' + s.model + ':' + s.provider) { fillModelSelect(ms, s); ms.dataset.for = sid + ':' + s.model + ':' + s.provider; }
    $('button[data-act="interrupt"]', bar).disabled = !(s.status === 'working' || s.status === 'waiting');
  }
  $('[data-pane="zoom"]', bar).textContent = state.layout.zoom != null ? '⤡' : '⤢';
  $('[data-pane="zoom"]', bar).hidden = state.layout.panes.length <= 1 && state.layout.zoom == null;
  $('[data-pane="close"]', bar).hidden = state.layout.panes.length <= 1;
}

function renderCpaneLog(pane) {
  const sid = pane.dataset.sid; const log = $('.chat-log', pane);
  if (!sid) { log.innerHTML = '<div class="empty"><p>No session in this pane.</p><p><button class="primary" data-pane="pick">Pick a session</button> or drag one from the sidebar.</p></div>'; pane._rendered = null; $('.jump', pane).hidden = true; return; }
  const store = state.events.get(sid) || { list: [], live: '', streaming: false };
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
    if (pb) { const a = pb.dataset.pane; if (a === 'zoom') toggleZoom(idx()); else if (a === 'close') splitClose(idx()); else if (a === 'menu') paneMenu(pane); else if (a === 'find') openFind(pane); return; }
    if (e.target.closest('.picker')) { pickSession(idx()); return; }
    const b = e.target.closest('button[data-act]'); if (b && sid) handleAction(b, sid);
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
  const items = [['pick', 'Switch session…'], ['find', 'Find in session  ⌘F'], ['zoom', state.layout.zoom != null ? 'Back to the grid  ⌘⇧↩' : 'Pop out this pane  ⌘⇧↩'], ['split', 'Add a pane  ⌘\\'], ['close', 'Close this pane  ⌘⇧W'], ['fullscreen', 'Full screen  ⌃⌘F']];
  if (s) {
    items.push(['model', `Model: ${s.model}`], ['trust', `Trust: ${s.trust}`]);
    if (s.status === 'working' || s.status === 'waiting') items.push(['interrupt', 'Interrupt  esc']);
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
      case 'model': { const prov = (state.providers || []).find((p) => p.id === s.provider); const m = await chooseDialog('Model', (prov ? prov.models : [s.model]).map((x) => [x, x]).concat([['__other', 'other model…']])); if (!m) return; let name = m; if (m === '__other') { name = await promptDialog('Model name', ''); if (!name) return; } await request('set', { sid, model: name }); break; }
      case 'trust': { const t = await chooseDialog('Trust', [['auto', 'auto - never ask'], ['write', 'write - gate shell'], ['read', 'read - gate writes + shell'], ['none', 'none - ask for everything']]); if (t) await request('set', { sid, trust: t }); break; }
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
async function renderStatsView(force) {
  if (state.view !== 'stats') return;
  const box = $('#stats-body');
  if (force || !statsData || statsData.days !== state.statsDays) {
    if (!statsData) box.innerHTML = '<div class="empty"><p>loading stats…</p></div>';
    try { statsData = await request('stats_full', { days: state.statsDays }); } catch (e) { box.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; return; }
    if (state.view !== 'stats') return;
  }
  const d = statsData; const S = d.summary; const m = state.statsMetric;
  const metricCard = (key, title, pick, fmt) => `<div class="card${m === key ? ' hl' : ''}"><h3>${title}</h3><div class="big">${fmt(pick(S.today))}</div><div class="row"><span>7-day avg</span><b>${fmt(pick(S.avg7))}</b></div><div class="row"><span>30-day avg</span><b>${fmt(pick(S.avg30))}</b></div><div class="row"><span>all time${S.first_date ? ' (since ' + fmtDate(S.first_date) + ')' : ''}</span><b>${fmt(pick(S.all))}</b></div></div>`;
  const summary = [
    metricCard('tokens', 'tokens', (r) => r.total, fmtTokens),
    metricCard('commits', 'commits', (r) => r.commits, (v) => (Number.isInteger(v) ? fmtInt(v) : v.toFixed(1))),
    metricCard('sessions', 'sessions', (r) => r.sessions, (v) => (Number.isInteger(v) ? fmtInt(v) : v.toFixed(1))),
    metricCard('active', 'active agent time', (r) => r.active_seconds, fmtDur),
  ].join('');
  // chart
  const ser = d.series; const mx = Math.max(1, ...ser.map((r) => r.total)); const W = 900, H = 150, pad = 4; const bw = Math.max(2, (W - pad * 2) / Math.max(1, ser.length) - 2);
  const bars = ser.map((r, i) => { const x = pad + i * ((W - pad * 2) / ser.length); const hi = Math.round(r.input / mx * (H - 20)); const ho = Math.round(r.output / mx * (H - 20)); return `<g><title>${r.date}: ${fmtInt(r.total)} tokens (${fmtInt(r.input)} in, ${fmtInt(r.output)} out)${r.commits ? ' · ' + r.commits + ' commits' : ''}</title><rect class="in" x="${x}" y="${H - 16 - hi}" width="${bw}" height="${hi}"></rect><rect class="out" x="${x}" y="${H - 16 - hi - ho}" width="${bw}" height="${ho}"></rect>${(ser.length <= 31 || i % 7 === 0) && (i === 0 || i === ser.length - 1 || i % Math.ceil(ser.length / 10) === 0) ? `<text x="${x}" y="${H - 4}">${fmtDate(r.date)}</text>` : ''}</g>`; }).join('');
  const chart = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg><div class="legend"><span><i class="in"></i> tokens in</span><span><i class="out"></i> tokens out</span><span class="dim">peak ${fmtTokens(mx)} / day</span></div>`;
  // breakdowns
  const bd = (title, rows, keyLabel, extra) => `<div class="card"><h3>${title}</h3><div class="grid-wrap"><table class="grid"><thead><tr><th class="l">${keyLabel}</th>${extra ? extra.map((e) => `<th>${e[0]}</th>`).join('') : ''}<th>tokens</th><th>in</th><th>out</th><th>calls</th><th>sessions</th><th>cost</th></tr></thead><tbody>${rows.length ? rows.map((r) => `<tr><td class="l">${esc(r.key)}</td>${extra ? extra.map((e) => `<td>${e[1](r)}</td>`).join('') : ''}<td>${fmtTokens(r.total)}</td><td>${fmtTokens(r.input)}</td><td>${fmtTokens(r.output)}</td><td>${fmtInt(r.calls)}</td><td>${fmtInt(r.sessions)}</td><td>${r.plan ? '<span class="dim">plan</span>' : fmtUsd(r.cost) + (r.cost ? ' est.' : '')}</td></tr>`).join('') : '<tr><td class="l" colspan="9">nothing in this range</td></tr>'}</tbody></table></div></div>`;
  const top = `<div class="card${m === 'sessions' ? ' hl' : ''}"><h3>top sessions by tokens (${d.days} days)</h3><div class="grid-wrap"><table class="grid"><thead><tr><th class="l">session</th><th class="l">project</th><th class="l">model</th><th>tokens</th><th>turns</th><th>active</th><th>cost</th></tr></thead><tbody>${d.top_sessions.length ? d.top_sessions.map((r) => `<tr class="click" data-open="${esc(r.key)}" title="open in the focused pane"><td class="l">${esc(r.name || r.key)}${r.title && r.title !== r.name ? ' <span class="dim">· ' + esc(r.title) + '</span>' : ''}${r.archived ? ' <span class="badge archived">archived</span>' : ''}</td><td class="l">${esc(r.project || '')}</td><td class="l">${esc(r.model || '')}</td><td><b>${fmtTokens(r.total)}</b></td><td>${fmtInt(r.turns)}</td><td>${fmtDur(r.active_seconds)}</td><td>${r.plan ? '<span class="dim">plan</span>' : fmtUsd(r.cost)}</td></tr>`).join('') : '<tr><td class="l" colspan="7">no usage in this range</td></tr>'}</tbody></table></div></div>`;
  const ct = d.commit_totals;
  const commits = `<div class="card${m === 'commits' ? ' hl' : ''}"><h3>commits from kcoder sessions (${d.days} days) · ${fmtInt(ct.total)} total · <span class="ok">${fmtInt(ct.pushed)} pushed</span> · <span class="${ct.unpushed ? 'warn' : ''}">${fmtInt(ct.unpushed)} local only</span></h3><div class="grid-wrap tall"><table class="grid"><thead><tr><th class="l">when</th><th class="l">commit</th><th class="l">subject</th><th class="l">repo</th><th class="l">session</th><th>+</th><th>-</th><th class="l">state</th></tr></thead><tbody>${d.commits.length ? d.commits.map((c) => `<tr><td class="l" title="${new Date(c.ts * 1000).toLocaleString()}">${fmtDate(c.date)} ${new Date(c.ts * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</td><td class="l">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener" title="open on GitHub">${c.sha.slice(0, 7)} ↗</a>` : `<code>${c.sha.slice(0, 7)}</code>`}</td><td class="l wrap">${esc(c.subject)}</td><td class="l">${esc(c.project || '')}${c.branch ? ' <span class="dim">@ ' + esc(c.branch) + '</span>' : ''}</td><td class="l">${esc(c.session || c.sid || '')}</td><td class="ok">+${fmtInt(c.insertions)}</td><td class="warn">-${fmtInt(c.deletions)}</td><td class="l"><span class="badge ${c.pushed ? 'pushed' : 'local'}">${c.pushed ? 'pushed' : 'local only'}</span></td></tr>`).join('') : '<tr><td class="l" colspan="8">no commits from sessions in this range</td></tr>'}</tbody></table></div></div>`;
  box.innerHTML = `
    <div class="stats-head"><h2>stats</h2>
      <div class="seg" id="stats-range">${[7, 30, 90].map((n) => `<button data-days="${n}" class="${state.statsDays === n ? 'active' : ''}">${n} days</button>`).join('')}</div>
      <span class="help">today is ${fmtDate(d.today)} · days roll over at local midnight</span>
      <span class="spacer"></span>
      <button id="stats-csv" title="daily table as CSV">⤓ export CSV</button><button id="stats-refresh" title="refresh">↻</button>
    </div>
    <div class="summary">${summary}</div>
    <div class="card${m === 'tokens' ? ' hl' : ''}"><h3>daily tokens · last ${d.days} days</h3>${chart}</div>
    <div class="card"><h3>daily</h3><div class="grid-wrap tall" id="stats-daily"></div></div>
    <div class="two">${bd('by model', d.by_model, 'model')}${bd('by provider', d.by_provider, 'provider', [['billing', (r) => r.billing || (r.plan ? 'subscription' : 'api key')]])}</div>
    <div class="two">${bd('by repo / project', d.by_project, 'project')}${top}</div>
    ${commits}`;
  renderDailyTable();
  $('#stats-range').addEventListener('click', (e) => { const b = e.target.closest('[data-days]'); if (!b) return; state.statsDays = Number(b.dataset.days); localStorage.setItem('kcoder.statsDays', state.statsDays); renderStatsView(true); });
  $('#stats-csv').addEventListener('click', exportStatsCsv);
  $('#stats-refresh').addEventListener('click', () => renderStatsView(true));
  box.onclick = (e) => { const tr = e.target.closest('tr[data-open]'); if (tr) { assignPane(state.layout.focus, tr.dataset.open); setView('chat'); } };
}
const DAILY_COLS = [['date', 'day', (r) => fmtDate(r.date), 'l'], ['input', 'tokens in', (r) => fmtTokens(r.input)], ['output', 'tokens out', (r) => fmtTokens(r.output)], ['total', 'total tokens', (r) => fmtTokens(r.total)], ['sessions', 'sessions', (r) => fmtInt(r.sessions)], ['commits', 'commits', (r) => fmtInt(r.commits)], ['lines', 'lines changed', (r) => (r.lines ? `+${fmtInt(r.insertions)} / -${fmtInt(r.deletions)}` : '0')], ['active_seconds', 'active time', (r) => fmtDur(r.active_seconds)], ['cost', 'cost', (r) => (r.cost ? fmtUsd(r.cost) : r.api_equivalent ? '<span class="dim">plan</span>' : '-')]];
function renderDailyTable() {
  const el = $('#stats-daily'); if (!el || !statsData) return;
  const rows = statsData.daily.slice();
  const { key, dir } = state.statsSort;
  rows.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * dir);
  const tot = {}; for (const r of statsData.daily) for (const k of Object.keys(r)) if (typeof r[k] === 'number') tot[k] = (tot[k] || 0) + r[k];
  tot.date = `total · ${statsData.daily.length} day${statsData.daily.length === 1 ? '' : 's'}`;
  const metricCol = { tokens: 'total', commits: 'commits', sessions: 'sessions', active: 'active_seconds' }[state.statsMetric];
  el.innerHTML = `<table class="grid"><thead><tr>${DAILY_COLS.map(([k, label, , cls]) => `<th class="${cls || ''}${key === k ? ' on' : ''}${metricCol === k ? ' hl' : ''}" data-sort="${k}">${label}${key === k ? (dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((r) => `<tr${r.date === statsData.today ? ' class="today"' : ''}>${DAILY_COLS.map(([k, , f, cls]) => `<td class="${cls || ''}${metricCol === k ? ' hl' : ''}">${f(r)}</td>`).join('')}</tr>`).join('') : '<tr><td class="l" colspan="9">no history yet</td></tr>'}${rows.length ? `<tr class="total">${DAILY_COLS.map(([k, , f, cls]) => `<td class="${cls || ''}">${k === 'date' ? esc(tot.date) : f(tot)}</td>`).join('')}</tr>` : ''}</tbody></table>`;
  el.onclick = (e) => { const th = e.target.closest('th[data-sort]'); if (!th) return; const k = th.dataset.sort; state.statsSort = { key: k, dir: state.statsSort.key === k ? -state.statsSort.dir : -1 }; renderDailyTable(); };
}
function exportStatsCsv() {
  if (!statsData) return;
  const cols = ['date', 'input', 'output', 'total', 'cache_read', 'calls', 'sessions', 'commits', 'insertions', 'deletions', 'lines', 'active_seconds', 'cost', 'api_equivalent', 'pushed', 'unpushed'];
  const csv = [cols.join(',')].concat(statsData.daily.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((r) => cols.map((c) => r[c] ?? '').join(','))).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `kcoder-stats-${statsData.today}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

renderHeader(); renderViews();
connect();
