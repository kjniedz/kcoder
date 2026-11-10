# kcoder phone relay

A small Cloudflare Worker that puts kcoder on a phone with nothing to
install there. Each Mac's daemon keeps one outbound websocket (the tunnel)
to the relay; a phone opens `https://<relay>/m/<install>/`, which is that
Mac's own kcoder web app served through the tunnel, in the phone layout,
with a live connection the relay pairs with a fresh connection to the
daemon. Every frame between the phone and the Mac is sealed with AES-GCM
under a key that rides in the QR code's URL fragment and never reaches the
relay; the relay keeps only the key's hash (the relay token a phone shows
to be let through), so it carries bytes it cannot read. Push notifications
(Web Push) go through it too.

kcoder's default relay is the one Kyle hosts (`DEFAULT_RELAY` in
`kcoder/phone.py`). To run your own:

## Deploy (once)

```
cd relay
node -e "$(cat vapid.js)"          # prints VAPID_PUBLIC + VAPID_PRIVATE
# put VAPID_PUBLIC under [vars] in wrangler.toml, then:
wrangler secret put VAPID_PRIVATE  # paste the private key
wrangler deploy
```

If wrangler is signed in to another Cloudflare account (or none), deploy
with an account API token instead of `wrangler login`: export
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for the account that
should own the Worker and run the same commands. Kyle's relay lives on the
kyleniedz99 account at `https://kcoder-relay.kyleniedz99.workers.dev`, the
default the phone dialog prefills.

Then in kcoder on the Mac: ⌘K → **phone** → turn on with the Worker URL
(`https://kcoder-relay.<you>.workers.dev`) → **pair a phone** → scan the QR
code with the phone's camera → Share → Add to Home Screen. On the phone,
Settings › Phone allows notifications (iPhone delivers Web Push only to a
page on the Home Screen).

## What the relay stores

Per install (one Durable Object each): a random install token (the
daemon's credential), the relay token (a hash of the pairing key), the
version of the web app the Mac serves (its files are cached at the edge
under it), and the push subscriptions of the phones that allowed
notifications (an id, a name, the subscription). Nothing of the sessions:
the frames are sealed before they reach it, and files of the web app are
public code. "New key" on the Mac replaces the relay token and drops every
subscription; "turn off" deletes the install.

## Endpoints

- `POST /v1/installs` → a new install (id + token), from the daemon.
- `GET /v1/installs/:id/tunnel` (Bearer, websocket) → the daemon's tunnel.
  Frames: `{op:"open"|"msg"|"close", ch}` for the phones' channels and
  `{op:"http", id, path}` for the web app's files, answered in base64
  chunks.
- `POST /v1/installs/:id/key` (Bearer) `{rt, version}`, `GET status`,
  `GET devices`, `DELETE devices/:id`, `POST push` `{title, body, url, tag}`,
  `DELETE /v1/installs/:id`.
- `POST /v1/installs/:id/devices` (header `X-Relay-Token`) from a phone:
  `{id, name, subscription}`.
- `GET /m/:id/` and `/m/:id/<file>`: the Mac's web app through the tunnel
  (a 503 page when the Mac is offline); `GET /m/:id/ws?rt=<relay token>`:
  the phone's live connection.
- `GET /vapid`: the push public key.

## Local test

```
cd relay && wrangler dev --local --port 8787
```

and point kcoder at `http://127.0.0.1:8787` (allowed for testing only); the
phone page is then `http://127.0.0.1:8787/m/<install>/#token=…&key=…`, the
URL the pair dialog puts in the QR code.
