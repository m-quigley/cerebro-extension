/* Cerebro extension background service worker.
 *
 * Responsibilities:
 *   1. Read the user's NextAuth session cookie from cerebro
 *      (chrome.cookies API — covers httpOnly) and use it as the
 *      Bearer token when talking to cerebro APIs.
 *   2. Subscribe / unsubscribe to Web Push via the worker's own
 *      pushManager registration.
 *   3. Handle `push` events → showNotification.
 *   4. Handle `notificationclick` → focus / open the right tab.
 *
 * Auth model: we don't roll our own login. The user signs in on
 * cerebro.zeroknowledge.fr normally; we piggyback on the same
 * session cookie. When the cookie expires (7-day TTL on the JWT),
 * the user re-signs and the extension just works again.
 */

const CEREBRO_ORIGIN = "https://www.zeroknowledge.fr";

/* NextAuth v5 ships its session cookie under one of two names: the
 * `__Secure-`-prefixed one on HTTPS (production), the plain name on
 * plain HTTP (rare for cerebro, but we cover it for local-dev
 * proxying via host_permissions). */
const SESSION_COOKIE_NAMES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
];

async function getSessionJWT() {
  for (const name of SESSION_COOKIE_NAMES) {
    const c = await chrome.cookies.get({ url: CEREBRO_ORIGIN, name });
    if (c?.value) return c.value;
  }
  return null;
}

async function fetchVAPIDPublicKey() {
  const res = await fetch(`${CEREBRO_ORIGIN}/api/web-push/vapid-public-key`);
  if (!res.ok) throw new Error(`vapid-public-key ${res.status}`);
  const data = await res.json();
  if (!data?.publicKey) throw new Error("vapid-public-key payload missing");
  return data.publicKey;
}

/* URL-safe base64 → Uint8Array. pushManager.subscribe() wants the
 * raw 65-byte uncompressed P-256 point as a Uint8Array — Cerebro's
 * /api/web-push/vapid-public-key gives us the URL-safe base64 form
 * (no padding). */
function urlBase64ToUint8Array(b64) {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getStatus() {
  const jwt = await getSessionJWT();
  const sub = await self.registration.pushManager.getSubscription();
  return { signedIn: !!jwt, subscribed: !!sub };
}

async function doSubscribe() {
  const jwt = await getSessionJWT();
  if (!jwt) {
    throw new Error("not_signed_in");
  }

  /* If we already have a local subscription, re-register it server-
   * side rather than creating a duplicate — the cerebro subscribe
   * endpoint is idempotent on sha256(endpoint), so a re-POST just
   * updates the row in place. */
  let sub = await self.registration.pushManager.getSubscription();
  if (!sub) {
    const vapidPublic = await fetchVAPIDPublicKey();
    sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublic),
    });
  }

  const json = sub.toJSON();
  const res = await fetch(
    `${CEREBRO_ORIGIN}/api/destinations/browser-push/subscribe`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: json.keys,
        expirationTime: json.expirationTime ?? null,
        userAgent: navigator.userAgent,
        label: "Cerebro Extension",
      }),
    },
  );

  if (!res.ok) {
    /* Roll back the browser-side subscription so we don't end up in
     * the "client subscribed, server doesn't know" split state. */
    try {
      await sub.unsubscribe();
    } catch {
      /* best-effort */
    }
    const body = await res.text().catch(() => "");
    throw new Error(`subscribe ${res.status}: ${body || res.statusText}`);
  }

  const data = await res.json();
  await chrome.storage.local.set({
    destinationId: data?.destination?.id ?? null,
    subscribedAt: Date.now(),
  });
  return data.destination;
}

async function doUnsubscribe() {
  const sub = await self.registration.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  await chrome.storage.local.remove(["destinationId", "subscribedAt"]);
}

/* Popup messaging. The popup is short-lived, so it sends a single
 * action and we reply once; no streaming. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.action) {
        case "status":
          sendResponse({ ok: true, ...(await getStatus()) });
          break;
        case "subscribe":
          sendResponse({ ok: true, destination: await doSubscribe() });
          break;
        case "unsubscribe":
          await doUnsubscribe();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: "unknown_action" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message ?? String(e) });
    }
  })();
  return true; // keep the message channel open for the async reply
});

/* Push delivery from the browser push service. The cerebro
 * dispatcher's BrowserPushAdapter sends:
 *   { title, body, url?, id? }
 * — minimal stable shape. We render via the standard
 * showNotification + carry url/id on the notification data so
 * notificationclick can route.
 *
 * Verbose console logging on every code path until the end-to-end
 * delivery is verified — every line is prefixed `[push]` so it's
 * easy to filter and easy to strip once stable. */
self.addEventListener("push", (event) => {
  console.log("[push] event received", event);
  let data = {};
  try {
    const rawText = event.data?.text();
    console.log("[push] raw data text:", rawText);
    data = event.data?.json() ?? {};
    console.log("[push] parsed data:", data);
  } catch (e) {
    console.warn("[push] data parse failed, falling back to text:", e);
    data = { title: "Cerebro", body: event.data?.text() ?? "" };
  }
  const title = data.title || "Cerebro";
  const options = {
    body: data.body || "",
    icon: "icons/icon-128.png",
    badge: "icons/icon-48.png",
    data: { url: data.url || "", id: data.id || "" },
    /* Tag dedupes back-to-back notifications for the same signal
     * (cerebro's notification.id is unique per rule_match, so
     * tagging on it means a re-delivery overwrites rather than
     * stacking). Empty id → unique-per-event default. */
    tag: data.id || undefined,
    renotify: !!data.id,
  };
  console.log("[push] calling showNotification", { title, options });
  event.waitUntil(
    self.registration
      .showNotification(title, options)
      .then(() => console.log("[push] showNotification resolved"))
      .catch((e) => console.error("[push] showNotification rejected:", e)),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || `${CEREBRO_ORIGIN}/`;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = wins.find((w) => w.url.startsWith(CEREBRO_ORIGIN));
      if (existing) {
        await existing.focus();
        try {
          await existing.navigate(url);
        } catch {
          /* navigate() can throw cross-origin in odd edge cases —
           * we already focused, the user is on cerebro, fine. */
        }
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

/* Best-effort prune: if pushsubscriptionchange fires (Chrome's
 * signal that the underlying subscription rotated keys / expired),
 * re-register so the cerebro destination row reflects the new
 * endpoint. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        await doSubscribe();
      } catch {
        /* If the user isn't signed in anymore, swallow — the next
         * popup interaction will surface the state. */
      }
    })(),
  );
});
