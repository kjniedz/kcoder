# kcoder approval relay

A tiny Cloudflare Worker that lets you approve a kcoder session's tool
calls from your phone without opening any port on your Mac. The daemon
keeps one outbound connection to the relay; phones pair once with a QR
code and get a Web Push notification for every request.

## Deploy (once)

```
cd relay
node -e "$(cat vapid.js)"          # prints VAPID_PUBLIC + VAPID_PRIVATE
# put VAPID_PUBLIC under [vars] in wrangler.toml, then:
wrangler secret put VAPID_PRIVATE  # paste the private key
wrangler deploy
```

Then in kcoder: ⌘K → **phone approvals** → enable with the Worker URL
(`https://kcoder-relay.<you>.workers.dev`) → **pair a phone** → scan the QR
code on the phone, give the device a name, allow notifications. On iPhone
add the page to the Home Screen first (Safari → Share → Add to Home
Screen), because iOS only delivers Web Push to installed web apps.

## What the relay stores

Per install: a random install token (the daemon's credential), paired
devices (name, token, push subscription) and open approval requests
(title, command, diff summary) until they expire or are decided. Decisions
flow back to the daemon over its event stream. Revoking a device deletes
its token and subscription immediately.

## Local test

```
cd relay && wrangler dev --local --port 8787
```

and point kcoder at `http://127.0.0.1:8787` (allowed for testing only).
