// kcoder approval relay. See README.md. One Durable Object per kcoder install
// holds its devices, pairing codes, open requests and the daemon's event stream.
import { b64u, sendPush } from "./push.js";
import { ICON_32, ICON_180, ICON_192, ICON_512 } from "./icons.js";
const png = (b64) => new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
const err = (msg, status) => json({ error: msg }, status);
const rnd = (n) => b64u.enc(crypto.getRandomValues(new Uint8Array(n)));
const code = () => { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (const b of crypto.getRandomValues(new Uint8Array(8))) s += a[b % a.length]; return s.slice(0, 4) + "-" + s.slice(4); };
const html = (body, title = "kcoder") => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0C0E12"><title>${title}</title><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="kcoder"><style>
body{margin:0;background:#0C0E12;color:#D9E2EC;font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:640px;margin:0 auto;padding:18px}h1{color:#7FC5FF;font-size:18px;margin:0 0 12px}
.card{background:#151D25;border:1px solid #2E4559;border-radius:10px;padding:14px;margin:12px 0}code,pre{background:#0C0E12;border:1px solid #2E4559;border-radius:6px;padding:8px;display:block;white-space:pre-wrap;word-break:break-word;font-size:13px;max-height:40vh;overflow:auto}
button{font:inherit;padding:14px 18px;border-radius:10px;border:1px solid #2E4559;background:#151D25;color:#D9E2EC;width:100%;margin:6px 0;font-size:17px}button.ok{background:#1f6f45;border-color:#2f9f65}button.no{background:#7a2b2b;border-color:#a33}input{font:inherit;width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #2E4559;background:#0C0E12;color:#D9E2EC}
.dim{color:#8597AB;font-size:13px}.ok-t{color:#7ee787}.err{color:#ff7b72}.small{font-size:12px}
</style></head><body><main>${body}</main></body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } });

const SW = `self.addEventListener('push', (e) => { const d = e.data ? e.data.json() : {}; e.waitUntil(self.registration.showNotification(d.title || 'kcoder', { body: d.body || '', tag: d.request_id || 'kcoder', data: d, requireInteraction: true, actions: [] })); });
self.addEventListener('notificationclick', (e) => { e.notification.close(); const u = (e.notification.data && e.notification.data.url) || '/app'; e.waitUntil(clients.openWindow(u)); });
self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));`;

const PAGE_JS = `
const dev = JSON.parse(localStorage.getItem('kcoder.device') || 'null');
async function api(method, path, body) { const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(dev ? { 'X-Device-Token': dev.token } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }
async function subscribePush(vapid) { if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'push not supported in this browser'; const reg = await navigator.serviceWorker.register('/sw.js'); const perm = await Notification.requestPermission(); if (perm !== 'granted') return 'notifications not allowed'; const k = vapid.replace(/-/g, '+').replace(/_/g, '/'); const raw = Uint8Array.from(atob(k + '='.repeat((4 - k.length % 4) % 4)), c => c.charCodeAt(0)); const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw }); await api('POST', '/v1/installs/' + dev.install + '/devices/' + dev.id + '/subscription', { subscription: sub.toJSON() }); return 'ok'; }
`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const seg = p.split("/").filter(Boolean);
    if (p === "/sw.js") return new Response(SW, { headers: { "Content-Type": "application/javascript", "Cache-Control": "no-store" } });
    if (p === "/manifest.webmanifest") return json({ name: "kcoder approvals", short_name: "kcoder", start_url: "/app", display: "standalone", background_color: "#0C0E12", theme_color: "#0C0E12", icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }] }, 200, { "Content-Type": "application/manifest+json" });
    if (p === "/icon-192.png") return png(ICON_192);
    if (p === "/icon-512.png") return png(ICON_512);
    if (p === "/apple-touch-icon.png") return png(ICON_180);
    if (p === "/favicon-32.png" || p === "/favicon.ico") return png(ICON_32);
    if (p === "/" || p === "/health") return json({ ok: true, service: "kcoder-relay" });
    if (p === "/vapid") return json({ public: env.VAPID_PUBLIC || null });
    if (req.method === "POST" && p === "/v1/installs") {
      const id = rnd(12).replace(/[-_]/g, "x").slice(0, 16), token = rnd(32);
      const stub = env.INSTALLS.get(env.INSTALLS.idFromName(id));
      await stub.fetch("https://do/_init", { method: "POST", body: JSON.stringify({ id, token, name: (await req.json().catch(() => ({}))).name || "" }) });
      return json({ install_id: id, install_token: token });
    }
    // daemon + device API on one install
    if (seg[0] === "v1" && seg[1] === "installs" && seg[2]) {
      const stub = env.INSTALLS.get(env.INSTALLS.idFromName(seg[2]));
      return stub.fetch(req);
    }
    if (seg[0] === "pair" && seg[1] && seg[2]) return html(pairPage(seg[1], seg[2], env.VAPID_PUBLIC || ""), "pair with kcoder");
    if (seg[0] === "r" && seg[1] && seg[2]) return html(requestPage(seg[1], seg[2]), "kcoder approval");
    if (p === "/app") return html(appPage(), "kcoder approvals");
    return err("not found", 404);
  },
};

function pairPage(install, code, vapid) {
  return `<h1>pair this phone with kcoder</h1><div class="card"><p>Code <b>${code}</b>. Give this device a name, then allow notifications.</p><input id="name" placeholder="my phone" autocomplete="off"><button class="ok" id="go">pair</button><p id="msg" class="dim"></p></div>
<script>${PAGE_JS}
document.getElementById('go').onclick = async () => { const m = document.getElementById('msg'); try { const r = await api('POST', '/v1/installs/${install}/pair/${code}', { name: document.getElementById('name').value || 'phone' }); localStorage.setItem('kcoder.device', JSON.stringify({ id: r.device_id, token: r.device_token, install: '${install}' })); m.textContent = 'paired as ' + r.name + '. Setting up notifications…'; location.reload(); } catch (e) { m.textContent = e.message; m.className = 'err'; } };
if (dev && dev.install === '${install}') { document.querySelector('.card').innerHTML = '<p class="ok-t">this phone is paired.</p><p id="msg" class="dim">enabling notifications…</p><button id="app">open approvals</button>'; document.getElementById('app').onclick = () => location.href = '/app'; subscribePush('${vapid}').then((s) => { document.getElementById('msg').textContent = s === 'ok' ? 'notifications on. On iPhone, add this page to the Home Screen to receive them.' : s; }); }
</script>`;
}

function requestPage(install, rid) {
  return `<h1>kcoder wants to run</h1><div class="card" id="box"><p class="dim">loading…</p></div>
<script>${PAGE_JS}
const box = document.getElementById('box');
async function load() { if (!dev) { box.innerHTML = '<p class="err">this phone is not paired. Scan the QR code in kcoder first.</p>'; return; } try { const r = await api('GET', '/v1/installs/${install}/requests/${rid}'); render(r); } catch (e) { box.innerHTML = '<p class="err">' + e.message + '</p>'; } }
function render(r) { const left = Math.max(0, Math.round((r.expires_at * 1000 - Date.now()) / 1000)); box.innerHTML = '<p><b>' + esc(r.session) + '</b> · ' + esc(r.title) + '</p><code>' + esc(r.command || '') + '</code>' + (r.diff ? '<p class="dim small">changes so far</p><pre>' + esc(r.diff) + '</pre>' : '') + (r.status !== 'pending' ? '<p class="dim">already ' + esc(r.status) + '</p>' : left <= 0 ? '<p class="err">expired</p>' : '<button class="ok" id="ok">approve</button><button class="no" id="no">deny</button><p class="dim">expires in ' + left + 's</p>'); const ok = document.getElementById('ok'), no = document.getElementById('no'); if (ok) ok.onclick = () => decide(true); if (no) no.onclick = () => decide(false); }
async function decide(approved) { try { const r = await api('POST', '/v1/installs/${install}/requests/${rid}/decision', { approved }); box.innerHTML = '<p class="ok-t">' + (approved ? 'approved' : 'denied') + ' · sent to your Mac</p>'; } catch (e) { box.innerHTML = '<p class="err">' + e.message + '</p>'; } }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
load();
</script>`;
}

function appPage() {
  return `<h1>kcoder approvals</h1><div class="card" id="box"><p class="dim">loading…</p></div>
<script>${PAGE_JS}
const box = document.getElementById('box');
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
async function load() { if (!dev) { box.innerHTML = '<p class="err">this phone is not paired. Scan the QR code in kcoder (⌘K → phone approvals).</p>'; return; } try { const r = await api('GET', '/v1/installs/' + dev.install + '/requests'); box.innerHTML = r.requests.length ? r.requests.map((q) => '<p><a style="color:#7FC5FF" href="/r/' + dev.install + '/' + q.id + '"><b>' + esc(q.session) + '</b> · ' + esc(q.title) + '</a><br><span class="dim small">' + esc(q.command || '').slice(0, 120) + '</span></p>').join('') : '<p class="dim">nothing waiting for you.</p>'; } catch (e) { box.innerHTML = '<p class="err">' + e.message + '</p>'; } }
load(); setInterval(load, 5000);
</script>`;
}

export class Install {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.streams = new Set(); }

  async fetch(req) {
    const url = new URL(req.url);
    const seg = url.pathname.split("/").filter(Boolean);
    const meta = await this.ctx.storage.get("meta");
    if (url.pathname === "/_init" && req.method === "POST") {
      const d = await req.json();
      await this.ctx.storage.put("meta", { id: d.id, token: d.token, name: d.name, created: Date.now() });
      return json({ ok: true });
    }
    if (!meta) return err("unknown install", 404);
    const rest = seg.slice(3);     // after v1/installs/:id
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const isDaemon = bearer && bearer === meta.token;
    const devToken = req.headers.get("X-Device-Token") || "";
    const device = devToken ? await this.deviceByToken(devToken) : null;

    // ---- phone: pairing (no auth)
    if (rest[0] === "pair" && rest[1] && req.method === "POST") {
      const key = `pairing:${rest[1]}`;
      const pr = await this.ctx.storage.get(key);
      if (!pr || pr.expires < Date.now()) return err("pairing code expired or unknown", 410);
      await this.ctx.storage.delete(key);
      const body = await req.json().catch(() => ({}));
      const dev = { id: rnd(9).replace(/[-_]/g, "x"), token: rnd(32), name: String(body.name || "phone").slice(0, 60), created: Date.now(), subscription: null };
      await this.ctx.storage.put(`device:${dev.id}`, dev);
      return json({ device_id: dev.id, device_token: dev.token, name: dev.name, install_id: meta.id });
    }
    // ---- phone: subscription, requests, decisions
    if (rest[0] === "devices" && rest[1] && rest[2] === "subscription" && req.method === "POST") {
      if (!device || device.id !== rest[1]) return err("unknown device", 401);
      const b = await req.json().catch(() => ({}));
      device.subscription = b.subscription || null; device.last_seen = Date.now();
      await this.ctx.storage.put(`device:${device.id}`, device);
      return json({ ok: true });
    }
    if (rest[0] === "requests" && !isDaemon) {
      if (!device) return err("unknown device", 401);
      if (!rest[1] && req.method === "GET") {
        const all = await this.ctx.storage.list({ prefix: "request:" });
        const now = Date.now() / 1000;
        return json({ requests: [...all.values()].filter((r) => r.status === "pending" && r.expires_at > now).map(this.publicRequest) });
      }
      const r = await this.ctx.storage.get(`request:${rest[1]}`);
      if (!r) return err("no such request", 404);
      if (req.method === "GET") return json(this.publicRequest(r));
      if (rest[2] === "decision" && req.method === "POST") {
        if (r.status !== "pending") return err(`already ${r.status}`, 409);
        if (r.expires_at < Date.now() / 1000) { r.status = "expired"; await this.ctx.storage.put(`request:${r.id}`, r); return err("this request has expired", 410); }
        const b = await req.json().catch(() => ({}));
        r.status = b.approved ? "approved" : "denied"; r.decided_by = device.name; r.decided_at = Date.now() / 1000;
        await this.ctx.storage.put(`request:${r.id}`, r);
        this.broadcast({ type: "decision", request_id: r.id, approved: !!b.approved, device: { id: device.id, name: device.name } });
        return json({ ok: true, status: r.status });
      }
      return err("not found", 404);
    }
    // ---- daemon
    if (!isDaemon) return err("unauthorized", 401);
    if (rest.length === 0 && req.method === "DELETE") { await this.ctx.storage.deleteAll(); for (const s of this.streams) { try { s.close(); } catch {} } return json({ ok: true }); }
    if (rest[0] === "pairings" && req.method === "POST") {
      const c = code();
      await this.ctx.storage.put(`pairing:${c}`, { expires: Date.now() + 5 * 60 * 1000 });
      return json({ code: c, expires: Date.now() / 1000 + 300, path: `/pair/${meta.id}/${c}` });
    }
    if (rest[0] === "devices" && req.method === "GET") {
      const all = await this.ctx.storage.list({ prefix: "device:" });
      return json({ devices: [...all.values()].map((d) => ({ id: d.id, name: d.name, created: d.created / 1000, push: !!d.subscription, last_seen: (d.last_seen || 0) / 1000 })) });
    }
    if (rest[0] === "devices" && rest[1] && req.method === "DELETE") { await this.ctx.storage.delete(`device:${rest[1]}`); return json({ ok: true }); }
    if (rest[0] === "requests" && req.method === "POST") {
      const b = await req.json().catch(() => null);
      if (!b || !b.id) return err("bad request", 400);
      const r = { id: String(b.id), session: String(b.session || ""), title: String(b.title || "approve?").slice(0, 200), command: String(b.command || "").slice(0, 4000),
                  diff: String(b.diff || "").slice(0, 6000), expires_at: Number(b.expires_at) || Date.now() / 1000 + 600, status: "pending", created: Date.now() / 1000 };
      await this.ctx.storage.put(`request:${r.id}`, r);
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
      const pushed = await this.push({ title: `kcoder: ${r.session}`, body: (r.command || r.title).slice(0, 140), request_id: r.id, url: `/r/${meta.id}/${r.id}` });
      return json({ ok: true, pushed });
    }
    if (rest[0] === "requests" && rest[1] && rest[2] === "resolve" && req.method === "POST") {
      const r = await this.ctx.storage.get(`request:${rest[1]}`);
      if (r && r.status === "pending") { r.status = (await req.json().catch(() => ({}))).outcome || "resolved"; await this.ctx.storage.put(`request:${r.id}`, r); }
      return json({ ok: true });
    }
    if (rest[0] === "events" && req.method === "GET") {
      const { readable, writable } = new TransformStream();
      const w = writable.getWriter();
      this.streams.add(w);
      w.write(new TextEncoder().encode(`: connected\n\n`));
      const ping = setInterval(() => { w.write(new TextEncoder().encode(`: ping\n\n`)).catch(() => { clearInterval(ping); this.streams.delete(w); }); }, 25000);
      return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
    }
    return err("not found", 404);
  }

  publicRequest(r) { return { id: r.id, session: r.session, title: r.title, command: r.command, diff: r.diff, expires_at: r.expires_at, status: r.status }; }

  async deviceByToken(token) {
    const all = await this.ctx.storage.list({ prefix: "device:" });
    for (const d of all.values()) if (d.token === token) return d;
    return null;
  }

  broadcast(ev) {
    const data = new TextEncoder().encode(`data: ${JSON.stringify(ev)}\n\n`);
    for (const w of [...this.streams]) w.write(data).catch(() => this.streams.delete(w));
  }

  async push(payload) {
    if (!this.env.VAPID_PRIVATE || !this.env.VAPID_PUBLIC) return 0;
    const all = await this.ctx.storage.list({ prefix: "device:" });
    let n = 0;
    for (const d of all.values()) {
      if (!d.subscription) continue;
      try {
        const st = await sendPush(d.subscription, payload, this.env);
        if (st === 404 || st === 410) { d.subscription = null; await this.ctx.storage.put(`device:${d.id}`, d); } else if (st < 300) n++;
      } catch (e) { /* one bad device must not block the rest */ }
    }
    return n;
  }

  async alarm() {   // drop requests that expired more than an hour ago
    const all = await this.ctx.storage.list({ prefix: "request:" });
    const now = Date.now() / 1000;
    for (const [k, r] of all) if (r.expires_at < now - 3600) await this.ctx.storage.delete(k);
  }
}
