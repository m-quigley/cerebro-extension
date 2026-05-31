# Cerebro Chrome Extension

Receives push notifications from [cerebro.zeroknowledge.fr](https://www.zeroknowledge.fr) via Web Push, even when the cerebro tab is closed.

## How it works

```
cerebro rule_match → cerebro-dispatcher → browser push service (FCM) → this extension's service worker → showNotification()
```

The extension does **not** roll its own login. It piggybacks on the
NextAuth session cookie set when you sign in at
`https://www.zeroknowledge.fr/connect` — `chrome.cookies` reads it
(covers `httpOnly`) and the extension uses it as a `Authorization: Bearer`
when calling cerebro's subscribe endpoint.

## Install (developer / unpacked)

1. Clone this repo.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** → pick this directory.
5. Sign in at `https://www.zeroknowledge.fr/connect` (wallet SIWE).
6. Click the extension's icon → **Subscribe to notifications**.

The first push delivery verifies the destination server-side; if it
gets a `404` or `410` from the push service (subscription gone), the
destination row is auto-revoked and the popup will show "not
subscribed" next time you open it.

## File layout

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest — permissions, action popup, background worker. |
| `background.js` | Service worker: cookie → JWT, subscribe / unsubscribe, `push` + `notificationclick` handlers. |
| `popup.html` / `popup.css` / `popup.js` | Toolbar popup UI — status + Subscribe / Unsubscribe button. |
| `icons/` | 16 / 48 / 128 px PNG icons. |

## What's on the cerebro side

- `GET /api/web-push/vapid-public-key` — public, returns the VAPID application server key (URL-safe base64 of the 65-byte P-256 uncompressed point).
- `POST /api/destinations/browser-push/subscribe` — auth-gated; takes a `PushSubscription`, encrypts `{endpoint, keys}` into `destinations.secret_encrypted`, inserts a `browser_push` destination row keyed by `sha256(endpoint)`. Idempotent — re-subscribing updates in place.

## What's on the swarm side

`platform_cerebro-dispatcher` has a `BrowserPushAdapter` that reads
`browser_push` destination rows, decrypts the subscription, signs a
VAPID JWT (using `WEB_PUSH_VAPID_PRIVATE_KEY`), and POSTs the payload
to the browser push service.

## Permissions

- `notifications` — to call `self.registration.showNotification`.
- `storage` — local key/value cache of the destination id + subscribe timestamp.
- `cookies` — read the cerebro session cookie (covers `httpOnly`).
- `host_permissions: https://www.zeroknowledge.fr/*` — required for `chrome.cookies` and same-origin `fetch`.

No external hosts; no analytics; no remote code.

## Roadmap

- [x] Cyber-panel styling on the popup; icons in the cerebro brand cyan (v0.2.0).
- [ ] Chrome Web Store listing so install is one click instead of unpacked.
- [ ] Settings UI on `cerebro/settings/destinations` to list registered devices and rename / revoke individual ones.
- [ ] Options page for click-behaviour (open tab vs focus existing) and per-tile filter.
