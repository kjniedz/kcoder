// Mahjong solitaire on the fun tab: clear the board two matching free tiles at a time. The game lives in this file;
// the hub in app.js shows it under the fun tab (funRegister) and the career (deals played, boards cleared, the best
// time per layout, daily deals and the streak, stars) lives in the token mine's save under arcade.mahjong, so it is
// mirrored to the daemon and shown on the stats page. A cleared board pays a sprint unit of stars into the mine
// through mineAward, the daily deal two, a new best time on a layout one more. Every deal is built by playing the
// empty positions forward, two free ones at a time, so it can always be cleared; the daily deal is seeded from the
// day and the layout, so it is the same all day. The board itself (the deal, the pairs taken, the clock) is saved
// in localStorage (kcoder.mahjong) so a game survives a reload.
(() => {
const KEY = 'kcoder.mahjong', TW = 36, TH = 48, OFF = 4, PAD = 10, PENALTY = 60000;
let G = null, pane = null, sel = -1, hint = null, hintTimer = 0, last = Date.now(), savedAt = 0;
// ---- layouts: positions in half-tile units [x, y, z] like the classic layout files, a tile covers 2 by 2; each holds 144 ----
const rect = (x, y, w, h, z) => { const out = []; for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) out.push([x + 2 * c, y + 2 * r, z]); return out; };
const ring = (x, y, w, h, z, [hx, hy, hw, hh]) => rect(x, y, w, h, z).filter(([px, py]) => !(px >= hx && px < hx + 2 * hw && py >= hy && py < hy + 2 * hh));
const LAYOUTS = [
  { id: 'turtle', name: 'turtle', slots: [...[12, 8, 10, 12, 12, 10, 8, 12].flatMap((n, r) => rect(14 - n, 2 * r, n, 1, 0)), [0, 7, 0], [26, 7, 0], [28, 7, 0], ...rect(8, 2, 6, 6, 1), ...rect(10, 4, 4, 4, 2), ...rect(12, 6, 2, 2, 3), [13, 7, 4]] },
  { id: 'pyramid', name: 'pyramid', slots: [...rect(0, 0, 14, 6, 0), ...rect(4, 2, 10, 4, 1), ...rect(8, 4, 6, 2, 2), ...rect(10, 4, 4, 2, 3)] },
  { id: 'fortress', name: 'fortress', slots: [...rect(0, 4, 16, 4, 0), ...ring(12, 0, 4, 10, 0, [12, 4, 4, 4]), [0, 0, 0], [30, 0, 0], [0, 18, 0], [30, 18, 0], ...rect(4, 6, 12, 2, 1), ...ring(14, 2, 2, 8, 1, [14, 6, 2, 2]), ...rect(10, 6, 6, 2, 2), ...rect(14, 6, 2, 2, 3)] },
  { id: 'bridge', name: 'bridge', slots: [...rect(0, 4, 16, 4, 0), ...rect(0, 4, 3, 4, 1), ...rect(26, 4, 3, 4, 1), ...rect(6, 4, 10, 1, 1), ...rect(6, 10, 10, 1, 1), ...rect(1, 4, 2, 4, 2), ...rect(27, 4, 2, 4, 2), ...rect(6, 4, 10, 1, 2), ...rect(2, 4, 1, 4, 3), ...rect(28, 4, 1, 4, 3), [2, 7, 4], [28, 7, 4]] },
  { id: 'arena', name: 'arena', slots: [...ring(0, 0, 16, 10, 0, [4, 4, 12, 6]), ...ring(2, 2, 14, 8, 1, [4, 4, 12, 6]), ...[2, 16].flatMap((y) => [...rect(2, y, 2, 1, 2), ...rect(10, y, 4, 1, 2), ...rect(24, y, 2, 1, 2)])] },
];
const layoutOf = (g) => LAYOUTS.find((l) => l.id === g.layout) || LAYOUTS[0];
function geom(L) {   // per slot: the slots that lie on it, under it, to its left and to its right (same layer, overlapping in y); cached on the layout
  if (L.geo) return L.geo; const S = L.slots, n = S.length, over = (a, b) => Math.abs(a[0] - b[0]) < 2 && Math.abs(a[1] - b[1]) < 2;
  const g = { above: [], below: [], left: [], right: [], w: 0, h: 0, zmax: 0 };
  for (let i = 0; i < n; i++) {
    const [x, y, z] = S[i]; g.above[i] = []; g.below[i] = []; g.left[i] = []; g.right[i] = []; g.w = Math.max(g.w, x + 2); g.h = Math.max(g.h, y + 2); g.zmax = Math.max(g.zmax, z);
    for (let j = 0; j < n; j++) { const [X, Y, Z] = S[j]; if (Z === z + 1 && over(S[i], S[j])) g.above[i].push(j); else if (Z === z - 1 && over(S[i], S[j])) g.below[i].push(j); else if (Z === z && Math.abs(Y - y) < 2) { if (X === x - 2) g.left[i].push(j); else if (X === x + 2) g.right[i].push(j); } }
  }
  return L.geo = g;
}
const isFree = (geo, p, i) => p[i] && !geo.above[i].some((j) => p[j]) && (!geo.left[i].some((j) => p[j]) || !geo.right[i].some((j) => p[j]));
// ---- the tiles: 34 kinds in fours (bamboo, characters, dots 1 to 9, four winds, three dragons) plus four flowers and four seasons, which match within the family ----
const KINDS = []; for (const s of 'bcd') for (let n = 1; n <= 9; n++) KINDS.push(s + n); for (const w of 'ESWN') KINDS.push('w' + w); for (const d of 'RGW') KINDS.push('g' + d);
for (let n = 1; n <= 4; n++) KINDS.push('f' + n); for (let n = 1; n <= 4; n++) KINDS.push('s' + n);
const match = (k) => (k[0] === 'f' || k[0] === 's' ? k[0] : k);
const fullSet = () => { const out = []; for (const k of KINDS) for (let i = 0; i < (k[0] === 'f' || k[0] === 's' ? 1 : 4); i++) out.push(k); return out; };
const shuffle = (a, rnd) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function pairUp(kinds, rnd) { const by = {}; for (const k of kinds) (by[match(k)] = by[match(k)] || []).push(k); const out = []; for (const g of Object.values(by)) { shuffle(g, rnd); for (let i = 0; i + 1 < g.length; i += 2) out.push([g[i], g[i + 1]]); } return shuffle(out, rnd); }
function build(L, slots, kinds, rnd) {   // deal the kinds onto the slots so the board can be cleared: play the empty positions forward, taking two free ones at a time and giving them a matching pair; that order is a winning line
  const geo = geom(L), n = L.slots.length;
  for (let attempt = 0; attempt < 80; attempt++) {   // the walk can corner itself (one tile left under another); then it starts over with the next random draw
    const pairs = pairUp(kinds, rnd), p = Array(n).fill(false), out = []; for (const i of slots) p[i] = true; let left = slots.length; if (pairs.length * 2 !== left) return null;
    while (left) {
      const fr = slots.filter((i) => isFree(geo, p, i)); if (fr.length < 2) break;
      const a = fr.splice(Math.floor(rnd() * fr.length), 1)[0], b = fr[Math.floor(rnd() * fr.length)]; p[a] = p[b] = false; left -= 2; out.push([a, b]);
    }
    if (!left) { const at = {}; out.forEach(([a, b], i) => { at[a] = pairs[i][0]; at[b] = pairs[i][1]; }); return { kinds: at, order: out }; }
  }
  return null;
}
const fresh = (layout, seed, daily, kinds) => ({ v: 1, layout, seed, daily, kinds, gone: [], moves: 0, time: 0, hints: 0, undos: 0, shuffles: 0, won: false, paid: false, stars: 0, seen: false, started: Date.now() });
function deal(layoutId, seed, daily) {
  const L = LAYOUTS.find((l) => l.id === layoutId) || LAYOUTS[0]; const rnd = mineRnd(seed), idx = L.slots.map((_, i) => i); const r = build(L, idx, fullSet(), rnd);
  return fresh(L.id, seed, daily || '', r ? idx.map((i) => r.kinds[i]) : shuffle(fullSet(), rnd));   // the fallback never came up in testing; it still plays, with shuffle to lean on
}
function normalize(s) {
  if (!s || typeof s !== 'object' || !LAYOUTS.some((l) => l.id === s.layout)) return null; const n = LAYOUTS.find((l) => l.id === s.layout).slots.length;
  if (!Array.isArray(s.kinds) || s.kinds.length !== n || !s.kinds.every((k) => KINDS.includes(k))) return null;
  const g = { ...fresh(s.layout, String(s.seed || ''), typeof s.daily === 'string' ? s.daily : '', s.kinds), ...s }; const seen = new Set();
  g.gone = Array.isArray(g.gone) ? g.gone.filter((p) => Array.isArray(p) && p.length === 2 && p.every((i) => Number.isInteger(i) && i >= 0 && i < n && !seen.has(i) && seen.add(i))) : [];
  for (const k of ['moves', 'time', 'hints', 'undos', 'shuffles', 'stars']) g[k] = Math.max(0, Number(g[k]) || 0);
  g.won = g.gone.length * 2 >= n; return g;
}
function load() { if (G) return G; let s = null; try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {} G = normalize(s) || deal(LAYOUTS[0].id, `mahjong:${Date.now()}`, ''); return G; }
function save() { savedAt = Date.now(); try { localStorage.setItem(KEY, JSON.stringify(G)); } catch {} }
function career() {   // the lifetime numbers, kept in the mine's save
  const m = mineLoad(); if (!m.arcade || typeof m.arcade !== 'object') m.arcade = {};
  const c = m.arcade.mahjong = { played: 0, wins: 0, bestTime: {}, stars: 0, dailies: [], streak: 0, lastDaily: '', ...(m.arcade.mahjong || {}) };
  if (!c.bestTime || typeof c.bestTime !== 'object') c.bestTime = {}; if (!Array.isArray(c.dailies)) c.dailies = []; return c;
}
const alive = (g) => { const p = g.kinds.map(() => true); for (const [a, b] of g.gone) p[a] = p[b] = false; return p; };
const freeList = (g, p) => { const geo = geom(layoutOf(g)); return g.kinds.map((_, i) => i).filter((i) => isFree(geo, p, i)); };
const groups = (g, fr) => { const by = {}; for (const i of fr) (by[match(g.kinds[i])] = by[match(g.kinds[i])] || []).push(i); return Object.values(by).filter((x) => x.length >= 2); };
const pairsFree = (g, p) => groups(g, freeList(g, p)).reduce((n, x) => n + Math.floor(x.length / 2), 0);
const fmtTime = (ms) => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return `${h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const plural = (n, w) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;
// ---- play ----
function tap(i) {
  const g = load(); if (g.won) return; const p = alive(g); if (!p[i]) return; const fr = new Set(freeList(g, p)); if (!fr.has(i)) return;   // a blocked tile does nothing
  if (sel === i) sel = -1; else if (sel >= 0 && p[sel] && fr.has(sel) && match(g.kinds[sel]) === match(g.kinds[i])) { take(g, sel, i); return; } else sel = i;
  render();
}
function take(g, a, b) {
  g.gone.push([a, b]); g.moves += 1; g.seen = false; sel = -1; hint = null;
  if (g.moves === 1) { career().played += 1; mineSave(); mineCheck(mineLoad()); }
  if (g.gone.length * 2 >= g.kinds.length) finish(g); save(); render();
}
function finish(g) {   // the board is clear: the career, the best time for the layout, the daily and its streak, and the stars (once per game)
  g.won = true; const c = career(), L = layoutOf(g), secs = Math.max(1, Math.round(g.time / 1000)), prev = c.bestTime[L.id] || 0, best = !prev || secs < prev; c.wins += 1;
  if (best) c.bestTime[L.id] = secs;
  if (!g.paid) {
    g.paid = true; const today = mineDay(); let units = 1, why = `mahjong: the ${L.name} cleared`;
    if (g.daily && g.daily === today && !c.dailies.includes(today)) {
      c.dailies.push(today); c.dailies = c.dailies.slice(-400); c.streak = c.lastDaily === mineDay(new Date(Date.now() - 864e5)) ? c.streak + 1 : 1; c.lastDaily = today;
      units = 2; why = `mahjong: the daily deal cleared${c.streak > 1 ? `, ${c.streak} days in a row` : ''}`;
    }
    if (best && prev) { units += 1; why += ', a new best time'; }
    g.stars = mineAward(mineSprintUnit(mineLoad()) * units, why); c.stars += g.stars;
  }
  mineSave(); mineCheck(mineLoad());
}
function undo() { const g = load(); if (g.won || !g.gone.length) return; g.gone.pop(); g.undos += 1; g.seen = false; sel = -1; hint = null; save(); render(); }
function showHint() {
  const g = load(); if (g.won) return; const gs = groups(g, freeList(g, alive(g))); if (!gs.length) return;
  const grp = gs[Math.floor(Math.random() * gs.length)]; hint = [grp[0], grp[1]]; g.hints += 1; save(); render();
  clearTimeout(hintTimer); hintTimer = setTimeout(() => { hint = null; render(); }, 1800);
}
function reshuffle() {   // the tiles left go back onto the slots left, in a clearable order when the builder finds one; a minute on the clock for it
  const g = load(); const p = alive(g), idx = p.map((v, i) => (v ? i : -1)).filter((i) => i >= 0); if (g.won || idx.length < 2) return;
  const rnd = mineRnd(`${g.seed}:shuffle${g.shuffles}`); const r = build(layoutOf(g), idx, idx.map((i) => g.kinds[i]), rnd);
  if (r) for (const i of idx) g.kinds[i] = r.kinds[i]; else { const ks = shuffle(idx.map((i) => g.kinds[i]), rnd); idx.forEach((i, n) => { g.kinds[i] = ks[n]; }); }
  g.shuffles += 1; g.time += PENALTY; g.seen = false; sel = -1; hint = null; save(); render();
}
async function newDeal(daily, layoutId) {
  const g = load(); const L = LAYOUTS.find((l) => l.id === (layoutId || g.layout)) || LAYOUTS[0]; const p = alive(g), left = p.filter(Boolean).length;
  if (g.moves && !g.won && pairsFree(g, p) && !(await confirmDialog(daily ? 'Start the daily deal?' : 'Start a new deal?', `the game in progress goes: ${plural(left, 'tile')} left after ${plural(g.moves, 'move')}, ${fmtTime(g.time)} on the clock.`))) { render(); return false; }
  const day = mineDay(); G = daily ? deal(L.id, `mahjong:${day}:${L.id}`, day) : deal(L.id, `mahjong:${Date.now()}`, ''); sel = -1; hint = null; save(); render(); return true;
}
// ---- drawing ----
const SMALL = { b: '竹', c: '萬', d: '●', w: '風', f: '花', s: '季' }, SEASON = ['春', '夏', '秋', '冬'], DRAGON = { R: '中', G: '發', W: '□' };
function face(k) { const s = k[0], v = k.slice(1); if (s === 'g') return [`drg ${v}`, DRAGON[v], '']; if (s === 'f') return ['flo', '✿', SMALL.f]; if (s === 's') return ['sea', SEASON[v - 1], SMALL.s]; return [s === 'b' ? 'bam' : s === 'c' ? 'chr' : s === 'd' ? 'dot' : 'wind', v, SMALL[s]]; }
function tileHtml(L, geo, i, k, cls) {
  const [x, y, z] = L.slots[i], [fc, big, small] = face(k), lift = (geo.zmax - z) * OFF;
  return `<div class="mj-tile ${fc}${cls}" data-mj-id="${i}" style="left:${PAD + x * TW / 2 + lift}px;top:${PAD + y * TH / 2 + lift}px;z-index:${z * 1000 + y * 16 + x}"><b>${big}</b>${small ? `<i>${small}</i>` : ''}</div>`;
}
function fit() {   // the board has a fixed size per layout; on a narrow pane it is scaled down as a whole
  const wrap = pane && pane.querySelector('[data-mj="wrap"]'); if (!wrap || !G) return; const geo = geom(layoutOf(G));
  const W = geo.w * TW / 2 + geo.zmax * OFF + 2 * PAD + 4, H = geo.h * TH / 2 + geo.zmax * OFF + 2 * PAD + 6, s = Math.min(1, Math.max(200, pane.clientWidth - 36) / W), b = wrap.firstElementChild;
  b.style.width = `${W}px`; b.style.height = `${H}px`; b.style.transform = s < 1 ? `scale(${s})` : ''; wrap.style.width = `${Math.round(W * s)}px`; wrap.style.height = `${Math.round(H * s)}px`;
}
function overlay(title, sub, buttons) { const el = pane.querySelector('[data-mj="over"]'); el.hidden = false; el.innerHTML = `<div class="t">${esc(title)}</div><div class="dim">${esc(sub)}</div><div class="b">${buttons.map(([k, l]) => `<button data-mj="${k}">${esc(l)}</button>`).join('')}</div>`; }
function render() {
  if (!pane) return; const g = load(), L = layoutOf(g), geo = geom(L), p = alive(g), fr = freeList(g, p), frS = new Set(fr), c = career(), today = mineDay();
  const left = p.filter(Boolean).length, pairs = groups(g, fr).reduce((n, x) => n + Math.floor(x.length / 2), 0), best = c.bestTime[L.id] || 0;
  const q = (k) => pane.querySelector(`[data-mj="${k}"]`), set = (k, v) => { const el = q(k); if (el && el.textContent !== String(v)) el.textContent = v; };
  q('board').innerHTML = g.kinds.map((k, i) => (p[i] ? tileHtml(L, geo, i, k, `${frS.has(i) ? ' free' : ''}${sel === i ? ' sel' : ''}${hint && hint.includes(i) ? ' hint' : ''}`) : '')).join('');
  set('time', fmtTime(g.time)); set('left', fmtInt(left)); set('pairs', fmtInt(pairs));
  q('layout').value = L.id; q('undo').disabled = g.won || !g.gone.length; q('hint').disabled = g.won || !pairs; q('shuffle').disabled = g.won || left < 2;
  const d = q('daily'); d.classList.toggle('active', g.daily === today); d.textContent = c.dailies.includes(today) ? 'daily deal ✓' : 'daily deal';
  set('note', `${g.daily === today ? "today's daily deal" : g.daily ? `the daily deal of ${g.daily}` : 'a random deal'} on the ${L.name} · ${plural(g.hints, 'hint')} · ${plural(g.undos, 'undo')}${g.shuffles ? ` · ${plural(g.shuffles, 'shuffle')}` : ''}`);
  set('stats', `${plural(c.played, 'deal')} · ${fmtInt(c.wins)} cleared · best on the ${L.name} ${best ? fmtTime(best * 1000) : '-'} · ${plural(c.dailies.length, 'daily deal')}${c.streak > 1 ? `, ${c.streak} days in a row` : ''} · ${plural(c.stars, 'star')} to the mine`);
  const ov = q('over');
  if (g.won) overlay('cleared!', `${fmtTime(Math.max(1000, Math.round(g.time / 1000) * 1000))} · best on the ${L.name} ${fmtTime(best * 1000)} · ${g.hints || g.undos || g.shuffles ? `with ${plural(g.hints, 'hint')}, ${plural(g.undos, 'undo')}${g.shuffles ? ` and ${plural(g.shuffles, 'shuffle')}` : ''}` : 'no hints, no undos'} · ${g.stars ? `+${plural(g.stars, 'star')} to the mine` : 'paid already'}`, [['new', 'new deal'], ['daily', c.dailies.includes(today) ? 'the daily again' : 'the daily deal']]);
  else if (left && !pairs && !g.seen) overlay('no moves left', `${plural(left, 'tile')} left, none free match`, [['shuffle', 'shuffle (+60 s)'], ['undo', 'undo'], ['new', 'new deal'], ['look', 'look at the board']]);
  else ov.hidden = true;
  fit();
}
function buildPane(el) {
  pane = el; const unit = mineSprintUnit(mineLoad());
  el.innerHTML = `<div class="mj">
    <div class="mj-head"><div><div class="mj-title">mahjong</div><div class="dim">clear the board, two matching free tiles at a time</div></div>
      <div class="mj-scores"><div class="sc"><span>time</span><b data-mj="time">00:00</b></div><div class="sc"><span>tiles left</span><b data-mj="left">144</b></div><div class="sc"><span>pairs free</span><b data-mj="pairs">0</b></div></div></div>
    <div class="mj-bar"><select data-mj="layout" title="the layout; picking one starts a new deal on it">${LAYOUTS.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select><button data-mj="daily" title="today's deal on this layout, the same all day, pays double">daily deal</button><button data-mj="new">new deal</button><button data-mj="undo">undo</button><button data-mj="hint">hint</button><button data-mj="shuffle" title="the tiles left go back on the board, +60 s">shuffle</button><span class="dim mj-note" data-mj="note"></span></div>
    <div class="mj-wrap" data-mj="wrap"><div class="mj-board" data-mj="board"></div><div class="mj-over" data-mj="over" hidden></div></div>
    <div class="mj-stats dim" data-mj="stats"></div>
    <div class="ds">a tile is free when nothing lies on it and its left or its right side is open: free tiles are bright, the rest sit back. any season matches any season, any flower any flower. every deal can be cleared; the daily deal is the same all day. a cleared board pays ${fmtInt(unit)} stars into the mine (a sprint unit, scaling with the stars earned on the listing), the daily deal ${fmtInt(unit * 2)}, a new best time on a layout ${fmtInt(unit)} more; a shuffle costs 60 seconds; undos are free and noted. H hint, U undo, S shuffle, N new deal.</div></div>`;
  if (!el.dataset.wiredMahjong) {   // once: the pane outlives every rebuild
    el.dataset.wiredMahjong = '1';
    el.addEventListener('click', (e) => { if (funTab() !== 'mahjong') return; const t = e.target.closest('[data-mj-id]'); if (t) { tap(Number(t.dataset.mjId)); return; } const b = e.target.closest('button[data-mj]'); if (b) act(b.dataset.mj); });
    el.addEventListener('change', (e) => { const s = e.target.closest('select[data-mj="layout"]'); if (s && funTab() === 'mahjong') { s.blur(); newDeal(false, s.value); } });
  }
}
function act(k) { if (k === 'new') newDeal(false); else if (k === 'daily') newDeal(true); else if (k === 'undo') undo(); else if (k === 'hint') showHint(); else if (k === 'shuffle') reshuffle(); else if (k === 'look') { load().seen = true; render(); } }
document.addEventListener('keydown', (e) => {   // before the app's own shortcuts (capture), only while the game is on screen and nothing else has the keyboard
  if (state.view !== 'fun' || funTab() !== 'mahjong' || state.dialog || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target || {}).tagName) || (e.target && e.target.isContentEditable)) return;
  const k = { u: undo, h: showHint, n: () => newDeal(false), s: reshuffle }[e.key.toLowerCase()]; if (!k) return; e.preventDefault(); e.stopPropagation(); k();
}, true);
setInterval(() => {   // the clock runs while the game is on screen with tiles left; a hidden tab or another view stops it (a throttled tick comes back with a long gap, which is dropped)
  const now = Date.now(), dt = now - last; last = now;
  if (!G || G.won || !pane || document.hidden || state.view !== 'fun' || funTab() !== 'mahjong' || dt > 5000) return;
  G.time += dt; const el = pane.querySelector('[data-mj="time"]'); if (el) el.textContent = fmtTime(G.time); if (now - savedAt > 10000) save();
}, 1000);
window.addEventListener('resize', () => { if (state.view === 'fun' && funTab() === 'mahjong') fit(); });
window.addEventListener('pagehide', () => { if (G) save(); });
funRegister({ id: 'mahjong', name: 'mahjong', hint: 'click two matching free tiles · H hint · U undo · S shuffle (+60 s) · N new deal', render: (el) => { if (!el.querySelector('.mj')) buildPane(el); else pane = el; render(); } });
window.__mahjong = {   // test hooks: the game, a deal by seed, a solvability trial that replays the builder's order, and a solver that clears the board the way it was built
  game: () => load(), layouts: LAYOUTS.map((l) => ({ id: l.id, n: l.slots.length })), render,
  deal(layoutId, seed) { G = deal(layoutId, seed, ''); sel = -1; hint = null; save(); render(); return G; },
  trial(layoutId, seed) {
    const L = LAYOUTS.find((l) => l.id === layoutId), geo = geom(L), idx = L.slots.map((_, i) => i), r = build(L, idx, fullSet(), mineRnd(seed)); if (!r) return 'unbuilt';
    const kinds = idx.map((i) => r.kinds[i]), p = kinds.map(() => true);
    for (const [a, b] of r.order) { if (!isFree(geo, p, a) || !isFree(geo, p, b) || match(kinds[a]) !== match(kinds[b])) return false; p[a] = p[b] = false; }
    return !p.some(Boolean);
  },
  autoWin(steps = 72) {
    const g = load(), L = layoutOf(g), r = build(L, g.kinds.map((_, i) => i), fullSet(), mineRnd(g.seed)), same = r && g.kinds.every((k, i) => k === r.kinds[i]); let n = 0;
    while (!g.won && n++ < steps) { const p = alive(g); let pair = same ? r.order.find(([a, b]) => p[a] && p[b]) : null; if (!pair) { const gs = groups(g, freeList(g, p)); if (!gs.length) break; pair = [gs[0][0], gs[0][1]]; } take(g, pair[0], pair[1]); }
    return g.won;
  },
};
})();
