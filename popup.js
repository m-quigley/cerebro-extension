/* Cerebro extension popup. Stateless thin client — every render
 * calls the background service worker for the canonical state. */

const CEREBRO_ORIGIN = "https://www.zeroknowledge.fr";
const $ = (id) => document.getElementById(id);

function send(action) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action }, (resp) => resolve(resp));
  });
}

function setStatus(text, kind) {
  const el = $("status");
  const badge = $("statusBadge");
  el.textContent = text;
  el.classList.toggle("error", kind === "error");

  /* Three badge states — `live` (cyan glow), `off` (muted), `err`
   * (magenta). Mirrors the website's per-panel status dot. */
  badge.classList.remove("off", "err");
  if (kind === "error") {
    badge.classList.add("err");
    badge.textContent = "Error";
  } else if (kind === "live") {
    badge.textContent = "Live";
  } else if (kind === "ready") {
    badge.textContent = "Ready";
  } else {
    badge.classList.add("off");
    badge.textContent = kind === "loading" ? "…" : "Idle";
  }
}

async function refresh() {
  const r = await send("status");
  if (!r?.ok) {
    setStatus("Could not reach the background worker.", "error");
    return;
  }
  $("signin").hidden = r.signedIn;
  $("subscribe").hidden = !r.signedIn || r.subscribed;
  $("unsubscribe").hidden = !r.subscribed;
  if (!r.signedIn) {
    setStatus("Sign in to Cerebro to enable push notifications.");
  } else if (r.subscribed) {
    setStatus("Receiving push notifications.", "live");
  } else {
    setStatus("Signed in — click Subscribe to start receiving pushes.", "ready");
  }
}

function busy(buttonId, label) {
  const btn = $(buttonId);
  if (btn) {
    btn.disabled = true;
    btn.dataset.original = btn.textContent;
    btn.textContent = label;
  }
}
function unbusy(buttonId) {
  const btn = $(buttonId);
  if (btn && btn.dataset.original) {
    btn.disabled = false;
    btn.textContent = btn.dataset.original;
    delete btn.dataset.original;
  }
}

$("signin").addEventListener("click", () => {
  chrome.tabs.create({ url: `${CEREBRO_ORIGIN}/connect` });
});

$("subscribe").addEventListener("click", async () => {
  busy("subscribe", "Subscribing…");
  setStatus("Subscribing…", "loading");
  const r = await send("subscribe");
  unbusy("subscribe");
  if (!r?.ok) {
    setStatus(`Error: ${r?.error ?? "unknown"}`, "error");
    return;
  }
  refresh();
});

$("unsubscribe").addEventListener("click", async () => {
  busy("unsubscribe", "Unsubscribing…");
  setStatus("Unsubscribing…", "loading");
  await send("unsubscribe");
  unbusy("unsubscribe");
  refresh();
});

setStatus("Loading…", "loading");
refresh();
