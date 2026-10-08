// Web Push (RFC 8030 + 8291 + 8292) with WebCrypto only: VAPID auth and aes128gcm payload encryption.
export const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); },
};
const te = new TextEncoder();
const cat = (...parts) => { const n = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function hkdf(ikm, salt, info, bits) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}

// RFC 8291: encrypt `plaintext` for a subscription (p256dh, auth); `opts` fixes the sender key + salt for tests
export async function encryptPush(plaintext, p256dh, auth, opts = {}) {
  const uaPub = b64u.dec(p256dh), authSecret = b64u.dec(auth);
  const salt = opts.salt ? b64u.dec(opts.salt) : crypto.getRandomValues(new Uint8Array(16));
  let asPriv, asPubRaw;
  if (opts.asPrivateJwk) {
    asPriv = await crypto.subtle.importKey("jwk", opts.asPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const pubJwk = { ...opts.asPrivateJwk }; delete pubJwk.d; pubJwk.key_ops = [];
    const pub = await crypto.subtle.importKey("jwk", pubJwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
    asPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pub));
  } else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPriv = kp.privateKey; asPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPriv, 256));
  const ikm = await hkdf(shared, authSecret, cat(te.encode("WebPush: info\0"), uaPub, asPubRaw), 256);
  const cek = await hkdf(ikm, salt, te.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, te.encode("Content-Encoding: nonce\0"), 96);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = cat(plaintext, new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, padded));
  const rs = new Uint8Array([0, 0, 16, 0]);           // 4096
  return cat(salt, rs, new Uint8Array([asPubRaw.length]), asPubRaw, ct);
}

// RFC 8292: a short-lived JWT signed with the VAPID key for one push service origin
export async function vapidAuth(audience, subject, privateJwk, publicB64u) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64u.enc(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.enc(te.encode(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${hdr}.${body}`)));
  return `vapid t=${hdr}.${body}.${b64u.enc(sig)}, k=${publicB64u}`;
}

export function vapidPrivateJwk(privateB64u, publicB64u) {
  const pub = b64u.dec(publicB64u);
  return { kty: "EC", crv: "P-256", d: privateB64u, x: b64u.enc(pub.slice(1, 33)), y: b64u.enc(pub.slice(33, 65)) };
}

// returns the push service's HTTP status (201 = queued; 404/410 = subscription gone)
export async function sendPush(subscription, payload, env, ttl = 600) {
  const { endpoint, keys } = subscription;
  const body = await encryptPush(te.encode(JSON.stringify(payload)), keys.p256dh, keys.auth);
  const aud = new URL(endpoint).origin;
  const auth = await vapidAuth(aud, env.VAPID_SUBJECT || "mailto:kcoder@example.com", vapidPrivateJwk(env.VAPID_PRIVATE, env.VAPID_PUBLIC), env.VAPID_PUBLIC);
  const r = await fetch(endpoint, { method: "POST", headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(ttl), Urgency: "high", Authorization: auth }, body });
  return r.status;
}
