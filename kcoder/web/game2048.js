// 2048 on the fun tab: join the tiles, reach 2048, keep going. The game lives in this file; the hub in app.js shows
// it under the fun tab (funRegister) and the career (games, best score, best tile, wins, moves, stars) lives in the
// token mine's save under arcade.t2048, so it is mirrored to the daemon, counted by the milestones and shown on the
// stats page. Big tiles pay stars into the mine through mineAward: the first 1024 in a game pays half a sprint unit,
// a 2048 one, a 4096 two and so on, and a new best tile pays the same again. The board itself is saved in
// localStorage (kcoder.2048) so a game survives a reload.
(() => {
const KEY = 'kcoder.2048', N = 4, UNDOS = 3, SPEED = 90;
let G = null, seq = 1, animating = false, pane = null;
const fresh = () => ({ v: 1, tiles: [], score: 0, won: false, over: false, undo: [], undos: UNDOS, moves: 0, paid: [], started: Date.now() });
const tile = (r, c, v) => ({ id: seq++, r, c, v });
function normalize(s) {
  const g = { ...fresh(), ...(s && typeof s === 'object' ? s : {}) };
  g.tiles = Array.isArray(g.tiles) ? g.tiles.filter((t) => t && Number.isInteger(t.r) && Number.isInteger(t.c) && t.r >= 0 && t.r < N && t.c >= 0 && t.c < N && Number.isInteger(t.v) && t.v >= 2).map((t) => tile(t.r, t.c, t.v)) : [];
  g.undo = Array.isArray(g.undo) ? g.undo.filter((u) => u && Array.isArray(u.tiles)).slice(-UNDOS) : [];
  g.paid = Array.isArray(g.paid) ? g.paid : []; g.undos = Number.isInteger(g.undos) ? Math.max(0, Math.min(UNDOS, g.undos)) : UNDOS;
  for (const k of ['score', 'moves']) g[k] = Math.max(0, Number(g[k]) || 0);
  return g;
}
function load() {
  if (G) return G; let s = null; try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  G = normalize(s); if (!G.tiles.length) { spawn(G); spawn(G); save(); } return G;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify({ ...G, tiles: G.tiles.map(({ r, c, v }) => ({ r, c, v })) })); } catch {} }
function career() {   // the lifetime numbers, kept in the mine's save
  const m = mineLoad(); if (!m.arcade || typeof m.arcade !== 'object') m.arcade = {};
  const c = m.arcade.t2048 = { played: 0, best: 0, bestTile: 0, wins: 0, moves: 0, stars: 0, ...(m.arcade.t2048 || {}) }; return c;
}
function empties(g) { const used = new Set(g.tiles.map((t) => t.r * N + t.c)); const out = []; for (let i = 0; i < N * N; i++) if (!used.has(i)) out.push(i); return out; }
function spawn(g) { const e = empties(g); if (!e.length) return null; const i = e[Math.floor(Math.random() * e.length)]; const t = tile(Math.floor(i / N), i % N, Math.random() < 0.9 ? 2 : 4); t.fresh = true; g.tiles.push(t); return t; }
function stuck(g) {   // no empty cell and no two equal neighbours: game over
  if (g.tiles.length < N * N) return false; const at = {}; for (const t of g.tiles) at[t.r * N + t.c] = t.v;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { const v = at[r * N + c]; if ((c + 1 < N && at[r * N + c + 1] === v) || (r + 1 < N && at[(r + 1) * N + c] === v)) return false; }
  return true;
}
const VEC = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
function slide(g, dir) {   // every tile slides as far as it can; equal neighbours merge once per move. Returns what to animate and the board after
  const [dr, dc] = VEC[dir]; const order = g.tiles.slice().sort((a, b) => (dr ? (b.r - a.r) * dr : (b.c - a.c) * dc));
  const next = Array.from({ length: N }, () => Array(N).fill(null)); let moved = false, gained = 0; const merges = [];
  for (const t of order) {
    let r = t.r, c = t.c, into = null;
    for (;;) { const rr = r + dr, cc = c + dc; if (rr < 0 || rr >= N || cc < 0 || cc >= N) break; const o = next[rr][cc]; if (!o) { r = rr; c = cc; continue; } if (o.v === t.v && !o.merged) { o.merged = true; o.v *= 2; o.from.push(t.id); gained += o.v; merges.push(o.v); r = rr; c = cc; into = o; } break; }
    if (r !== t.r || c !== t.c) moved = true; t.to = [r, c]; if (!into) next[r][c] = { id: t.id, v: t.v, merged: false, from: [t.id] };
  }
  if (!moved) return null;
  const after = []; for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { const o = next[r][c]; if (!o) continue; const t = tile(r, c, o.v); if (o.merged) t.pop = true; else t.id = o.id; after.push(t); }
  return { after, gained, merges };
}
function move(dir) {
  const g = load(); if (animating || g.over) return; const res = slide(g, dir); if (!res) return;
  g.undo.push({ tiles: g.tiles.map(({ r, c, v }) => ({ r, c, v })), score: g.score }); g.undo = g.undo.slice(-UNDOS);
  animating = true; for (const t of g.tiles) place(t.id, t.to[0], t.to[1]);   // phase one: every tile slides, the ones that merge slide into their partner
  setTimeout(() => {   // phase two: merged tiles pop, a new one appears, the score moves
    const c = career(); if (g.moves === 0) c.played += 1;
    g.tiles = res.after; g.moves += 1; c.moves += 1; g.score += res.gained; spawn(g);
    if (g.score > c.best) c.best = g.score;
    let won = false; const top = Math.max(...g.tiles.map((t) => t.v));
    for (const v of res.merges) {
      if (v >= 1024 && !g.paid.includes(v)) { g.paid.push(v); const unit = mineSprintUnit(mineLoad()); const n = mineAward(unit * v / 2048, `${fmtInt(v)} in 2048`); c.stars += n; }
      if (v > c.bestTile) { c.bestTile = v; if (v >= 1024) { const n = mineAward(mineSprintUnit(mineLoad()) * v / 2048, `a new best tile in 2048, ${fmtInt(v)}`); c.stars += n; } }
      if (v === 2048 && !g.won) { g.won = true; c.wins += 1; won = true; }
    }
    if (top > c.bestTile) c.bestTile = top;
    if (stuck(g)) g.over = true;
    save(); mineSave(); mineCheck(mineLoad()); animating = false; render(res.gained); if (won) overlay('2048!', 'keep going');
  }, SPEED + 10);
}
function undo() { const g = load(); if (animating || !g.undo.length || !g.undos) return; const u = g.undo.pop(); g.tiles = u.tiles.map((t) => tile(t.r, t.c, t.v)); g.score = u.score; g.over = false; g.undos -= 1; save(); render(); }
function newGame() { G = fresh(); spawn(G); spawn(G); save(); render(); }
function place(id, r, c) { const el = pane && pane.querySelector(`[data-tile="${id}"]`); if (el) { el.style.setProperty('--r', r); el.style.setProperty('--c', c); } }
function tileHtml(t) { const cls = ['tile', t.v >= 4096 ? 'big' : '', t.pop ? 'pop' : '', t.fresh ? 'new' : '', t.v >= 10000 ? 'd5' : t.v >= 1000 ? 'd4' : t.v >= 100 ? 'd3' : ''].filter(Boolean).join(' '); return `<div class="${cls}" data-tile="${t.id}" data-v="${t.v}" style="--r:${t.r};--c:${t.c}"><span>${fmtInt(t.v)}</span></div>`; }
function overlay(title, button, sub) { const el = pane && pane.querySelector('[data-z="over"]'); if (!el) return; el.hidden = false; el.innerHTML = `<div class="t">${esc(title)}</div>${sub ? `<div class="dim">${esc(sub)}</div>` : ''}<div class="b"><button data-z="go">${esc(button)}</button>${load().undo.length && load().undos ? `<button data-z="undo">undo (${load().undos} left)</button>` : ''}</div>`; }
function render(gained) {
  if (!pane) return; const g = load(); const c = career();
  const set = (k, v) => { const el = pane.querySelector(`[data-z="${k}"]`); if (el && el.textContent !== String(v)) el.textContent = v; };
  pane.querySelector('[data-z="tiles"]').innerHTML = g.tiles.map(tileHtml).join(''); for (const t of g.tiles) { t.pop = false; t.fresh = false; }
  set('score', fmtInt(g.score)); set('best', fmtInt(Math.max(c.best, g.score))); set('tile', fmtInt(Math.max(c.bestTile, ...g.tiles.map((t) => t.v))));
  if (gained) { const p = pane.querySelector('[data-z="plus"]'); p.textContent = `+${fmtInt(gained)}`; p.classList.remove('go'); void p.offsetWidth; p.classList.add('go'); }
  const u = pane.querySelector('[data-z="undo"]'); u.disabled = !g.undo.length || !g.undos; u.textContent = `undo${g.undos < UNDOS ? ` (${g.undos} left)` : ''}`;
  set('stats', `${fmtInt(c.played)} game${c.played === 1 ? '' : 's'} · ${fmtInt(c.wins)} win${c.wins === 1 ? '' : 's'} · ${fmtInt(c.moves)} move${c.moves === 1 ? '' : 's'} · ${fmtInt(c.stars)} star${c.stars === 1 ? '' : 's'} to the mine`);
  const ov = pane.querySelector('[data-z="over"]'); if (g.over) overlay('game over', 'try again', `${fmtInt(g.score)} points · ${fmtInt(g.moves)} moves`); else ov.hidden = true;
}
function build(el) {
  pane = el; const unit = mineSprintUnit(mineLoad());
  el.innerHTML = `<div class="g2048">
    <div class="g2048-head"><div><div class="g2048-title">2048</div><div class="dim">join the tiles, reach 2048, keep going</div></div>
      <div class="g2048-scores"><div class="sc"><span>score</span><b data-z="score">0</b><i class="plus" data-z="plus"></i></div><div class="sc"><span>best</span><b data-z="best">0</b></div><div class="sc"><span>best tile</span><b data-z="tile">0</b></div></div></div>
    <div class="g2048-board" data-z="board"><div class="cells">${'<i></i>'.repeat(N * N)}</div><div class="tiles" data-z="tiles"></div><div class="g2048-over" data-z="over" hidden></div></div>
    <div class="g2048-foot"><button data-z="new">new game</button><button data-z="undo">undo</button><span class="dim">arrows, WASD or HJKL · U undo · N new game · or swipe</span></div>
    <div class="g2048-stats dim" data-z="stats"></div>
    <div class="ds">tiles slide as far as they go and two of a kind join into one of twice the value. the first 1,024 in a game pays ${fmtInt(Math.max(1, Math.round(unit / 2)))} stars into the mine, a 2,048 pays ${fmtInt(unit)}, a 4,096 pays ${fmtInt(unit * 2)} and so on (a sprint unit, scaling with the stars earned on the listing); a new best tile pays the same again; three undos a game. the mine's milestones count the best tile and the best score.</div></div>`;
  if (!el.dataset.wired2048) {
    el.dataset.wired2048 = '1';
    el.addEventListener('click', (e) => {
      if (funTab() !== '2048') return; const b = e.target.closest('[data-z]'); if (!b || b.tagName !== 'BUTTON') return;
      if (b.dataset.z === 'new' || b.dataset.z === 'go') { if (b.dataset.z === 'go' && !load().over) { pane.querySelector('[data-z="over"]').hidden = true; return; } newGame(); }
      else if (b.dataset.z === 'undo') undo();
    });
    let down = null;
    el.addEventListener('pointerdown', (e) => { if (e.target.closest('[data-z="board"]')) { down = [e.clientX, e.clientY]; } });
    el.addEventListener('pointerup', (e) => { if (!down) return; const dx = e.clientX - down[0], dy = e.clientY - down[1]; down = null; if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return; move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')); });
  }
}
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', k: 'up', j: 'down', h: 'left', l: 'right' };
document.addEventListener('keydown', (e) => {   // before the app's own shortcuts (capture), only while the game is on screen and nothing else has the keyboard
  if (state.view !== 'fun' || funTab() !== '2048' || state.dialog || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName) || (e.target && e.target.isContentEditable)) return;
  const dir = KEYS[e.key]; if (dir) { e.preventDefault(); e.stopPropagation(); if (load().won && pane) { const ov = pane.querySelector('[data-z="over"]'); if (ov && !ov.hidden && !load().over) ov.hidden = true; } move(dir); return; }
  if (e.key === 'u') { e.preventDefault(); e.stopPropagation(); undo(); } else if (e.key === 'n') { e.preventDefault(); e.stopPropagation(); newGame(); }
}, true);
funRegister({ id: '2048', name: '2048', hint: 'arrows, WASD or HJKL to move · U undo · N new game', render: (el) => { if (!el.dataset.built2048) { build(el); el.dataset.built2048 = '1'; } else pane = el; render(); } });
})();
