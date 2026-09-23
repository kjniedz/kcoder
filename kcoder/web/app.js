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
  order: [],               // wall pane order
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
  try { state.providers = (await request('providers')).providers; } catch {}
  try { state.config = (await request('config')).config; } catch {}
  applyUrlParams();
  for (const sid of state.sessions.keys()) loadEvents(sid, 80);
  if (state.sid && !state.events.has(state.sid)) await loadEvents(state.sid, -1);
  renderAll();
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
  renderHeader(); renderWall(); renderTitlebars();
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
  if (state.sid === sid) {
    if (state.view === 'chat') renderChatLog();
    if (state.view === 'terminal') renderTermLog();
  }
}

function renderAll() { renderHeader(); renderViews(); renderWall(); renderSidebar(); renderTitlebars(); renderChatLog(); renderTermLog(); }

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
  const list = opts.tail ? store.list.slice(-opts.tail) : store.list;
  const calls = new Map();
  const approvals = new Map();
  const out = [];
  let userTurn = -1;
  // count user turns before the tail for correct edit indices
  if (opts.tail) for (const e of store.list.slice(0, -opts.tail)) if (e.t === 'user') userTurn++;
  for (const e of store.list) if (e.t === 'approval_result') approvals.set(e.id, e.approved);
  const results = new Map();
  for (const e of store.list) if (e.t === 'tool_result') results.set(e.id, e);
  for (const e of list) {
    switch (e.t) {
      case 'user': {
        userTurn++;
        const imgs = (e.images || []).map((i) => `<span>🖼 ${esc(i)}</span>`).join('');
        out.push(`<div class="msg msg-user" data-turn="${userTurn}"><span class="who">you&gt;</span><div class="bubble">${esc(e.text)}${imgs ? `<div class="images">${imgs}</div>` : ''}</div>` +
          (opts.compact ? '' : `<div class="actions"><button data-act="edit" title="Edit and resend">✎</button><button data-act="fork" title="Fork from here">⑂</button><button data-act="copy" title="Copy">⧉</button></div>`) + `</div>`);
        break;
      }
      case 'assistant_end':
        if (e.text) out.push(`<div class="msg msg-assistant"><div class="who">kcoder&gt;</div><div class="md">${renderMarkdown(e.text)}</div></div>`);
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
        out.push(`<details class="tool"${(res && res.is_error) || live ? ' open' : ''}><summary><span class="gear">⚙</span><span class="desc">${esc(e.description)}</span>${status}</summary><div class="body">${toolBodyHtml(e, res)}${live ? `<div class="label">live output</div><pre>${esc(stripAnsi(live))}</pre>` : ''}</div></details>`);
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
  if (store.streaming || store.live) out.push(`<div class="msg msg-assistant streaming"><div class="who">kcoder&gt;</div><div class="md">${store.live ? renderMarkdown(store.live) : ''}</div></div>`);
  const sess = state.sessions.get(sid);
  if (sess && sess.status === 'working' && !store.live && !store.streaming) out.push(`<div class="note"><span class="t-spinner">◐</span> working…</div>`);
  return out.join('');
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
  const cap = st.daily_cap_usd || 0;
  $('#stats').innerHTML = [
    `<div class="stat"><b>${st.sessions || 0}</b><span>active</span></div>`,
    `<div class="stat${st.waiting ? ' warn' : ''}"><b>${st.waiting || 0}</b><span>waiting on you</span></div>`,
    `<div class="stat"><b>${fmtTokens(tokens)}</b><span>tokens today</span></div>`,
    `<div class="stat${st.cap_reached ? ' bad' : ''}" title="${cap ? 'daily cap ' + fmtUsd(cap) : 'no daily cap (⌘K → set cap)'}"><b>${fmtUsd(today.cost || 0)}${cap ? ' <small style="color:var(--fg-mute)">/ ' + fmtUsd(cap) + '</small>' : ''}</b><span>spend today${st.cap_reached ? ' · paused' : ''}</span></div>`,
  ].join('');
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
  if (v !== 'wall') { if (!state.sid) state.sid = state.order[0] || null; if (state.sid) loadEvents(state.sid, -1); }
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
  pane.className = 'pane st-' + st + (pane.classList.contains('focused') ? ' focused' : '') + (state.sid === s.id ? ' active' : '');
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
      (s.project && s.project.git ? `<button data-act="git">git status</button>` : '') +
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
    body.innerHTML = `<div class="chat-log">${buildChatHtml(store, sid, { tail: focused ? 0 : 30, compact: !focused })}</div>`;
  }
  body.scrollTop = body.scrollHeight;
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
      case 'merge': if (await confirmDialog(`Merge branch ${s.worktree.branch} into ${s.project.name}?`, 'Uncommitted changes in the worktree are committed first.')) { const r = await request('merge', { sid }); toast(r.message || 'merged', r.ok === false ? 'err' : 'ok'); } break;
      case 'pr': { const r = await request('pr', { sid }); if (r.url) { toast('PR opened: ' + r.url, 'ok'); window.open(r.url, '_blank'); } else toast(r.message || 'PR created', 'ok'); break; }
      case 'discard': if (await confirmDialog(`Discard all work in ${s.worktree.branch}?`, 'The worktree and branch are deleted. This cannot be undone.')) { await request('discard', { sid }); toast('discarded', 'warn'); } break;
      case 'open-chat': state.sid = sid; localStorage.setItem('kcoder.sid', sid); setView('chat'); break;
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
      case 'copy': { const msg = el.closest('.msg-user'); navigator.clipboard.writeText($('.bubble', msg).textContent); toast('copied'); break; }
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
  const st = c.archived ? 'archived' : c.status;
  return `<div class="chat-item${c.archived ? ' archived' : ''}${c.id === state.sid ? ' current' : ''}" data-sid="${c.id}" title="${esc(c.name)} · ${esc(c.model || '')}"><span class="dot ${st}"></span><span class="title">${c.pinned ? '<span class="pin">📌 </span>' : ''}${esc(c.title || c.name)}</span><span class="age">${age(c.last_activity)}</span></div>`;
}

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
  state.sid = sid; localStorage.setItem('kcoder.sid', sid);
  state.events.delete(sid);
  await loadEvents(sid, -1);      // resumes archived chats too
  renderSidebar(); renderTitlebars(); renderChatLog(); renderTermLog(); renderWall();
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
  for (const id of ['#chat-title', '#term-titlebar']) {
    const el = $(id); el.innerHTML = html;
    if (s) { $('select[data-act="trust"]', el).value = s.trust || 'read'; fillModelSelect($('select[data-act="model"]', el), s); }
  }
}
for (const id of ['#chat-title', '#term-titlebar']) {
  $(id).addEventListener('click', (e) => { const b = e.target.closest('button[data-act]'); if (!b || !state.sid) return; if (b.dataset.act === 'menu') chatMenu(state.sid); else handleAction(b, state.sid); });
  $(id).addEventListener('change', (e) => { const s = e.target.closest('select[data-act]'); if (s && state.sid) handleAction(s, state.sid); });
}

function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 80; }
function renderChatLog() {
  if (state.view !== 'chat') return;
  const log = $('#chat-log');
  if (!state.sid) { log.innerHTML = '<div class="empty"><p>No chat selected.</p></div>'; ensureComposer('#chat-composer', null); return; }
  const store = state.events.get(state.sid) || { list: [], live: '' };
  const stick = nearBottom(log);
  log.innerHTML = buildChatHtml(store, state.sid, {});
  if (stick) log.scrollTop = log.scrollHeight;
  ensureComposer('#chat-composer', state.sid, false);
}
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
for (const id of ['#chat-log', '#term-log']) {
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
  const view = $('#view-' + state.view);
  const ta = view && view.querySelector('.composer textarea:not([hidden])');
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
  form._comp = comp;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.4) + 'px'; };
  ta.addEventListener('input', () => { grow(); updateMenu(comp); });
  ta.addEventListener('keydown', (e) => onComposerKey(e, comp));
  ta.addEventListener('paste', (e) => onPaste(e, comp));
  ta.addEventListener('drop', (e) => { const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); files.forEach((f) => addImage(comp, f)); } });
  ta.addEventListener('dragover', (e) => e.preventDefault());
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
    const n = comp.pastes.size + 1;
    comp.pastes.set(n, { text, lines, expanded: false });
    insertAtCursor(comp.ta, `[Pasted #${n} · ${lines} lines]`);
    renderChips(comp);
  }
}
function insertAtCursor(ta, s) { const a = ta.selectionStart, b = ta.selectionEnd; ta.value = ta.value.slice(0, a) + s + ta.value.slice(b); ta.selectionStart = ta.selectionEnd = a + s.length; ta.dispatchEvent(new Event('input')); }
function renderChips(comp) {
  comp.chips.hidden = comp.pastes.size === 0;
  comp.chips.innerHTML = Array.from(comp.pastes.entries()).map(([n, p]) => `<span class="chip${p.expanded ? ' expanded' : ''}" data-n="${n}" title="click to expand into the message">[Pasted #${n} · ${p.lines} lines]<span class="x" title="remove">✕</span></span>`).join('');
}
function expandChip(comp, n) {
  const p = comp.pastes.get(n); if (!p) return;
  const tag = `[Pasted #${n} · ${p.lines} lines]`;
  if (comp.ta.value.includes(tag)) { comp.ta.value = comp.ta.value.replace(tag, p.text); p.expanded = true; comp.pastes.delete(n); comp.ta.dispatchEvent(new Event('input')); renderChips(comp); }
}
function removeChip(comp, n) { const p = comp.pastes.get(n); if (!p) return; comp.ta.value = comp.ta.value.replace(`[Pasted #${n} · ${p.lines} lines]`, ''); comp.pastes.delete(n); comp.ta.dispatchEvent(new Event('input')); renderChips(comp); }
function expandAll(comp, text) { for (const [n, p] of comp.pastes) text = text.split(`[Pasted #${n} · ${p.lines} lines]`).join(p.text); return text; }

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
  try {
    const busy = s && (s.status === 'working' || s.status === 'waiting');
    const r = await request('send', { sid, text, images: comp.images, queue_if_busy: busy });
    historyFor(sid).push(text);
    if (r.queued) toast(`queued as follow-up #${r.position}`, 'ok');
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
    ['1-9', 'jump to pane'], ['click / enter', 'focus pane'], ['esc', 'back to grid · interrupt agent while typing'], ['w', 'cycle sessions waiting on you'],
    ['n', 'new session'], ['a', 'approval inbox'], ['y / n', 'approve / decline (inbox or focused pane)'], ['v', 'cycle pane view: chat → terminal → shell'],
    ['alt+1 / 2 / 3', 'wall · chat · terminal view'], ['⌘K', 'command palette'], ['p', 'pin focused session to this window'], ['?', 'this help'],
    ['enter', 'send'], ['shift+enter', 'newline'], ['↑', 'previous prompt'], ['/', 'slash commands'], ['@', 'reference a project file'], ['paste', 'never submits; big pastes become chips'],
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
  </div><div class="foot"><span class="help" id="ns-status"></span><span class="spacer" style="flex:1"></span><button data-x="cancel">cancel</button><button class="primary" data-x="ok">start</button></div>`, 'new');
  const modelSel = $('#ns-model', d), provSel = $('#ns-provider', d), cwdIn = $('#ns-cwd', d), repoMenu = $('#ns-repos', d), status = $('#ns-status', d);
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
    const items = local.map((r) => ({ v: r.path, label: r.name, meta: shortHome(r.path) })).concat(gh.map((r) => ({ v: r.path || r.spec, label: r.spec, meta: r.path ? 'github · cloned' : 'github · clone' })));
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
    try { const r = await request('create', fields); closeDialog(); state.repoCache = null; state.sid = r.session.id; localStorage.setItem('kcoder.sid', r.session.id); loadEvents(r.session.id, -1); if (state.view === 'wall') focusPane(r.session.id); toast('started ' + r.session.name + ' in ' + shortHome(r.session.cwd), 'ok'); }
    catch (e) { toast(e.message, 'err'); status.textContent = e.message; $('[data-x="ok"]', d).disabled = false; }
  };
  d.addEventListener('click', (e) => { const b = e.target.closest('[data-x]'); if (!b) return; b.dataset.x === 'ok' ? submit() : closeDialog(); });
  d.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
}

// command palette
function paletteItems() {
  const items = [
    ['new session', () => openNewSession(), 'n'], ['approval inbox', openInbox, 'a'], ['cycle waiting sessions', cycleWaiting, 'w'],
    ['wall view', () => setView('wall'), 'alt+1'], ['chat view', () => setView('chat'), 'alt+2'], ['terminal view', () => setView('terminal'), 'alt+3'],
    ['toggle sound', toggleSound], ['enable browser notifications', () => Notification.requestPermission().then((p) => toast('notifications: ' + p))],
    ['set default trust for new sessions', async () => { const v = await chooseDialog('Default trust for new sessions', [['auto', 'auto - never ask'], ['write', 'write - gate shell'], ['read', 'read - gate writes + shell'], ['none', 'none - ask for everything']]); if (v) { const r = await request('config', { default_trust: v }); state.config = r.config; toast('default trust: ' + v, 'ok'); } }],
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
  $('#toasts').appendChild(el); el.onclick = () => el.remove(); setTimeout(() => el.remove(), 5000);
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
  if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
    try { const n = new Notification(title, { body, tag: sid, silent: true }); n.onclick = () => { window.focus(); if (state.view !== 'wall') setView('wall'); focusPane(sid); n.close(); }; } catch {}
  }
  renderHeader();
}
function toggleSound() { state.sound = !state.sound; localStorage.setItem('kcoder.sound', state.sound ? 'on' : 'off'); renderHeader(); toast(state.sound ? 'sound on' : 'sound off'); }

// ----------------------------------------------------------------------
// keyboard
// ----------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName) || (e.target && e.target.isContentEditable);
  if (state.dialog === 'inbox') { inboxKey(e); return; }
  if (state.dialog && e.key === 'Escape') { closeDialog(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); state.dialog ? closeDialog() : openPalette(); return; }
  if (e.altKey && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); setView(['wall', 'chat', 'terminal'][Number(e.key) - 1]); return; }
  if (inField || state.dialog) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const focusedSess = state.focus && state.sessions.get(state.focus);
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
$('#view-wall').addEventListener('click', (e) => { const b = e.target.closest('[data-action="new"]'); if (b) openNewSession(); });
$('#tagline').textContent = ['ten agents, one keyboard.', 'ship it before the coffee cools.', 'parallel by default.', 'less typing, more shipping.', 'every session earns its keep.', 'small commits, big days.'][Math.floor(Math.random() * 6)];
document.addEventListener('click', () => { if ('Notification' in window && Notification.permission === 'default' && !localStorage.getItem('kcoder.askedNotif')) { localStorage.setItem('kcoder.askedNotif', '1'); Notification.requestPermission(); } }, { once: true });
setInterval(() => { renderHeader(); if (state.view === 'wall') for (const p of $$('.pane')) { const s = state.sessions.get(p.dataset.sid); if (s) renderPaneChrome(p, s, state.order.indexOf(s.id) + 1); } }, 15000);
window.addEventListener('resize', () => { for (const sid of state.shells.keys()) fitShell(sid); });

renderHeader(); renderViews();
connect();
