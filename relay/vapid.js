// generate a VAPID key pair: node -e "$(cat vapid.js)"
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]).then(async (k) => {
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", k.privateKey);
  console.log("VAPID_PUBLIC=" + b64u(pub));
  console.log("VAPID_PRIVATE=" + jwk.d);
});
