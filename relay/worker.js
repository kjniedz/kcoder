// kcoder phone relay. See README.md. One Durable Object per kcoder install holds the daemon's
// tunnel (one outbound websocket from the Mac), the phones' websockets, the push subscriptions and
// the version of the web app the Mac serves. The relay carries sealed bytes: every app frame between
// a phone and its Mac is encrypted with a key the relay never sees (it rides in the QR code's URL
// fragment); the relay only sees which install they belong to.
import { b64u, sendPush } from "./push.js";
import { ICON_32, ICON_180, ICON_192, ICON_512 } from "./icons.js";
const png = (b64) => new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } });

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
const err = (msg, status) => json({ error: msg }, status);
const rnd = (n) => b64u.enc(crypto.getRandomValues(new Uint8Array(n)));
const HTTP_TIMEOUT = 25000;
const PAGE_HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0C0E12"><title>kcoder</title><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><style>
body{margin:0;background:#0C0E12;color:#D9E2EC;font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;display:flex;min-height:100vh;align-items:center;justify-content:center}main{max-width:420px;padding:24px;text-align:center}h1{color:#7FC5FF;font-size:18px;margin:0 0 12px}.dim{color:#8597AB;font-size:13px}button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #2E4559;background:#151D25;color:#D9E2EC;margin-top:14px}
</style></head><body><main>`;
const page = (body, status = 200) => new Response(PAGE_HEAD + body + "</main></body></html>", { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } });
const offline = (name) => page(`<h1>${name ? esc(name) : "your Mac"} is offline</h1><p class="dim">kcoderd keeps the connection to this relay while it runs. Start kcoder on the Mac (or wake it up) and this page reconnects on its own.</p><button onclick="location.reload()">try again</button><script>setTimeout(() => location.reload(), 8000)</script>`, 503);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const seg = p.split("/").filter(Boolean);
    if (p === "/apple-touch-icon.png") return png(ICON_180);
    if (p === "/icon-192.png") return png(ICON_192);
    if (p === "/icon-512.png") return png(ICON_512);
    if (p === "/favicon-32.png" || p === "/favicon.ico") return png(ICON_32);
    if (p === "/" || p === "/health") return json({ ok: true, service: "kcoder-relay" });
    if (p === "/vapid") return json({ public: env.VAPID_PUBLIC || null });
    if (req.method === "POST" && p === "/v1/installs") {
      const id = rnd(12).replace(/[-_]/g, "x").slice(0, 16), token = rnd(32);
      const stub = env.INSTALLS.get(env.INSTALLS.idFromName(id));
      await stub.fetch("https://do/_init", { method: "POST", body: JSON.stringify({ id, token, name: (await req.json().catch(() => ({}))).name || "" }) });
      return json({ install_id: id, install_token: token });
    }
    // the daemon's API and the phones' API on one install
    if (seg[0] === "v1" && seg[1] === "installs" && seg[2]) return env.INSTALLS.get(env.INSTALLS.idFromName(seg[2])).fetch(req);
    // the app itself, through the Mac: /m/<install>/ is kcoder's own web app served over the tunnel
    if (seg[0] === "m" && seg[1]) {
      if (seg.length === 2 && !p.endsWith("/")) return Response.redirect(url.origin + p + "/" + url.search + url.hash, 302);
      return env.INSTALLS.get(env.INSTALLS.idFromName(seg[1])).fetch(req);
    }
    return err("not found", 404);
  },
};

export class Install {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.pending = new Map(); this.parts = new Map(); }

  daemon() { const l = this.ctx.getWebSockets("daemon"); return l.length ? l[l.length - 1] : null; }
  phones() { return this.ctx.getWebSockets("phone"); }
  phoneByCh(ch) { for (const ws of this.phones()) { const a = ws.deserializeAttachment(); if (a && a.ch === ch) return ws; } return null; }
  toDaemon(obj) { const d = this.daemon(); if (!d) return false; try { d.send(JSON.stringify(obj)); return true; } catch { return false; } }

  async fetch(req) {
    const url = new URL(req.url);
    const seg = url.pathname.split("/").filter(Boolean);
    const meta = await this.ctx.storage.get("meta");
    if (url.pathname === "/_init" && req.method === "POST") {
      const d = await req.json();
      await this.ctx.storage.put("meta", { id: d.id, token: d.token, name: d.name, created: Date.now() });
      return json({ ok: true });
    }
    if (!meta) return seg[0] === "m" ? page("<h1>unknown install</h1><p class=dim>this link belongs to no Mac on this relay. Pair again from kcoder's phone dialog.</p>", 404) : err("unknown install", 404);
    const rt = await this.ctx.storage.get("rt");

    // ---- the app, for phones: /m/<id>/ws is the live connection, anything else a file from the Mac
    if (seg[0] === "m") {
      const rest = "/" + seg.slice(2).join("/");
      if (rest === "/ws") {
        if (req.headers.get("Upgrade") !== "websocket") return err("websocket only", 400);
        if (!rt || url.searchParams.get("rt") !== rt) return err("this phone is not paired with this Mac (scan the QR code again)", 401);
        const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
        const ch = rnd(6);
        this.ctx.acceptWebSocket(server, ["phone"]);
        server.serializeAttachment({ ch, since: Date.now() });
        if (!this.toDaemon({ op: "open", ch })) { server.close(4404, "your Mac is offline"); }
        return new Response(null, { status: 101, webSocket: client });
      }
      if (req.method !== "GET") return err("not found", 404);
      if (!this.daemon()) return offline(meta.name);
      const path = rest + (url.search || "");
      const version = (await this.ctx.storage.get("version")) || "0";
      const cacheable = !rest.startsWith("/uploads/") && rest !== "/" && !rest.endsWith(".html") && !rest.endsWith("sw.js");
      const cacheKey = new Request(`${url.origin}/_cache/${meta.id}/${version}${rest}`);
      let cache = null;
      try { cache = caches.default; } catch { cache = null; }
      if (cacheable && cache) { const hit = await cache.match(cacheKey); if (hit) return hit; }
      const r = await this.tunnelHttp(path);
      if (!r) return offline(meta.name);
      const headers = { "Content-Type": r.ctype || "application/octet-stream", "Cache-Control": cacheable ? "public, max-age=3600" : "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };
      if (rest === "/" || rest.endsWith(".html")) headers["Content-Security-Policy"] = "frame-ancestors 'none'";
      const resp = new Response(r.body, { status: r.status || 200, headers });
      if (cacheable && cache && r.status === 200) { try { await cache.put(cacheKey, resp.clone()); } catch {} }
      return resp;
    }

    const rest = seg.slice(3);     // after v1/installs/:id
    const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const isDaemon = bearer && bearer === meta.token;
    const phoneOk = rt && req.headers.get("X-Relay-Token") === rt;

    // ---- phones: push subscriptions (a phone proves itself with the relay token derived from the pairing key)
    if (rest[0] === "devices" && req.method === "POST" && !isDaemon) {
      if (!phoneOk) return err("this phone is not paired with this Mac", 401);
      const b = await req.json().catch(() => ({}));
      const id = String(b.id || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || rnd(9).replace(/[-_]/g, "x");
      const old = (await this.ctx.storage.get(`device:${id}`)) || { id, created: Date.now() };
      const dev = { ...old, name: String(b.name || old.name || "phone").slice(0, 60), subscription: b.subscription || old.subscription || null, last_seen: Date.now() };
      await this.ctx.storage.put(`device:${id}`, dev);
      return json({ ok: true, id, push: !!dev.subscription, vapid: this.env.VAPID_PUBLIC || null });
    }
    // ---- the daemon
    if (!isDaemon) return err("unauthorized", 401);
    if (rest[0] === "tunnel") {
      if (req.headers.get("Upgrade") !== "websocket") return err("websocket only", 400);
      for (const old of this.ctx.getWebSockets("daemon")) { try { old.close(4409, "replaced by a newer connection"); } catch {} }
      const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ["daemon"]);
      server.serializeAttachment({ daemon: true, since: Date.now() });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (rest.length === 0 && req.method === "DELETE") { await this.ctx.storage.deleteAll(); for (const ws of [...this.phones(), ...this.ctx.getWebSockets("daemon")]) { try { ws.close(4410, "this Mac left the relay"); } catch {} } return json({ ok: true }); }
    if (rest[0] === "key" && req.method === "POST") {   // a new pairing key: its relay token replaces the old one, so every phone paired before has to scan again
      const b = await req.json().catch(() => ({}));
      if (!b.rt || String(b.rt).length < 20) return err("bad relay token", 400);
      await this.ctx.storage.put("rt", String(b.rt));
      if (b.version) await this.ctx.storage.put("version", String(b.version));
      for (const ws of this.phones()) { try { ws.close(4401, "the pairing key changed: scan the QR code again"); } catch {} }
      const all = await this.ctx.storage.list({ prefix: "device:" });
      for (const k of all.keys()) await this.ctx.storage.delete(k);
      return json({ ok: true });
    }
    if (rest[0] === "devices" && req.method === "GET") {
      const all = await this.ctx.storage.list({ prefix: "device:" });
      return json({ devices: [...all.values()].map((d) => ({ id: d.id, name: d.name, created: d.created / 1000, push: !!d.subscription, last_seen: (d.last_seen || 0) / 1000 })) });
    }
    if (rest[0] === "devices" && rest[1] && req.method === "DELETE") { await this.ctx.storage.delete(`device:${rest[1]}`); return json({ ok: true }); }
    if (rest[0] === "status" && req.method === "GET") {
      const all = await this.ctx.storage.list({ prefix: "device:" });
      return json({ tunnel: !!this.daemon(), phones: this.phones().length, devices: [...all.values()].map((d) => ({ id: d.id, name: d.name, created: d.created / 1000, push: !!d.subscription, last_seen: (d.last_seen || 0) / 1000 })), paired: !!rt, version: (await this.ctx.storage.get("version")) || null });
    }
    if (rest[0] === "push" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const pushed = await this.push({ title: String(b.title || "kcoder").slice(0, 120), body: String(b.body || "").slice(0, 240), tag: String(b.tag || "kcoder").slice(0, 60), url: `/m/${meta.id}/${String(b.url || "").replace(/^\/+/, "")}` });
      return json({ ok: true, pushed });
    }
    return err("not found", 404);
  }

  // ---- a file from the Mac: ask over the tunnel, assemble the chunks, time out if the Mac goes quiet
  tunnelHttp(path) {
    return new Promise((resolve) => {
      const id = rnd(8);
      const timer = setTimeout(() => { this.pending.delete(id); this.parts.delete(id); resolve(null); }, HTTP_TIMEOUT);
      this.pending.set(id, { resolve, timer });
      if (!this.toDaemon({ op: "http", id, path })) { clearTimeout(timer); this.pending.delete(id); resolve(null); }
    });
  }

  async webSocketMessage(ws, msg) {
    const a = ws.deserializeAttachment() || {};
    if (a.daemon) {
      let m; try { m = JSON.parse(typeof msg === "string" ? msg : new TextDecoder().decode(msg)); } catch { return; }
      if (m.op === "hello") { if (m.version) await this.ctx.storage.put("version", String(m.version)); for (const p of this.phones()) { const pa = p.deserializeAttachment(); if (pa && pa.ch) this.toDaemon({ op: "open", ch: pa.ch }); } return; }   // phones that waited through a reconnect get their channels back
      if (m.op === "msg") { const p = this.phoneByCh(m.ch); if (p) { try { p.send(m.data); } catch {} } else this.toDaemon({ op: "close", ch: m.ch }); return; }
      if (m.op === "close") { const p = this.phoneByCh(m.ch); if (p) { try { p.close(m.code || 1000, m.reason || ""); } catch {} } return; }
      if (m.op === "http") {
        const pend = this.pending.get(m.id); if (!pend) return;
        const parts = this.parts.get(m.id) || []; parts.push(m.body || ""); this.parts.set(m.id, parts);
        if (m.more) return;
        clearTimeout(pend.timer); this.pending.delete(m.id); this.parts.delete(m.id);
        pend.resolve({ status: m.status, ctype: m.ctype, body: b64u.dec(parts.join("")) });
        return;
      }
      if (m.op === "ping") { try { ws.send(JSON.stringify({ op: "pong" })); } catch {} }
      return;
    }
    if (a.ch) {   // a phone's sealed frame goes to the Mac as is
      if (!this.toDaemon({ op: "msg", ch: a.ch, data: typeof msg === "string" ? msg : b64u.enc(msg) })) { try { ws.close(4404, "your Mac is offline"); } catch {} }
    }
  }

  async webSocketClose(ws, code, reason) {
    const a = ws.deserializeAttachment() || {};
    if (a.daemon) { for (const p of this.phones()) { try { p.close(4404, "your Mac went offline"); } catch {} } for (const [, pend] of this.pending) { clearTimeout(pend.timer); pend.resolve(null); } this.pending.clear(); this.parts.clear(); }
    else if (a.ch) this.toDaemon({ op: "close", ch: a.ch });
  }
  async webSocketError(ws, e) { return this.webSocketClose(ws, 1011, String(e)); }

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
}
