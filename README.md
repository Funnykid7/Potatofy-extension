# Potatofy

A Chromium MV3 extension that aggressively trims memory, GPU, and network overhead so a Raspberry Pi (or any low-spec box) can browse the modern web without melting.

Measured on a real Pi 5 (4 cores, 8 GB RAM, Chromium 148, identical browsing session):

| Process | Without Potatofy | With Potatofy | Δ |
|---|---:|---:|---:|
| GPU process | 1,860 MB | 1,181 MB | **−678 MB** |
| Main renderer | 1,178 MB | 997 MB | −181 MB |
| Browser | 608 MB | 532 MB | −76 MB |
| **Total peak** | **4,518 MB** | **3,734 MB** | **−784 MB (−17%)** |

Source traces are not committed; the methodology is `chrome://tracing` memory-infra dump compared via `traceEvents.args.dumps.allocators[*].attrs.size`.

---

## Install (unpacked)

```
1. git clone <this repo>
2. Open chrome://extensions
3. Toggle "Developer mode" (top-right)
4. Click "Load unpacked" and select the cloned directory
```

No build step. No `node_modules`. The repo is the extension.

---

## Architecture

```
            ┌─────────────────────────────────────────────┐
            │                  popup/                     │
            │  popup.html → popup.css → popup.js          │
            │  • toggles      • stats card    • whitelist │
            └────────────┬────────────────────────────────┘
                         │ chrome.runtime.sendMessage
                         │   UPDATE_SETTINGS / GET_STATS /
                         │   RESET_STATS
                         ▼
            ┌─────────────────────────────────────────────┐
            │            service-worker.js                │
            │  • DEFAULT_SETTINGS    • STATS_WEIGHTS      │
            │  • idle-tab discard alarm (1 min)           │
            │  • dynamic DNR whitelist rules              │
            │  • onRuleMatchedDebug → stats buffer        │
            │  • chrome.action badge (debounced 10 s)     │
            └────────────┬────────────────────────────────┘
                         │ chrome.storage.sync.onChanged
                         ▼
            ┌─────────────────────────────────────────────┐
            │     content-script.js (ISOLATED world)      │
            │  • reads settings, resolves whitelist       │
            │  • dispatches CustomEvents to MAIN world    │
            │  • forwards stat increments back to SW      │
            └────────────┬────────────────────────────────┘
                         │ CustomEvent: __potatofy_init,
                         │ __potatofy_settings_update,
                         │ __potatofy_stat
                         ▼
            ┌─────────────────────────────────────────────┐
            │   content-script-main.js (MAIN world)       │
            │  • setTimeout/setInterval/rAF stubs (hidden)│
            │  • applyAnimationKill() — global <style>    │
            │  • applyImageLiteAll() — lazy + drop srcset │
            │  • applyPrefetchStripAll() — drop hint links│
            │  • MutationObserver for SPAs                │
            └─────────────────────────────────────────────┘
                         │
                         ▼
            ┌─────────────────────────────────────────────┐
            │  rules/static-rules.json (declarativeNet)   │
            │  • 196 rules @ priority 1                   │
            │  • dynamic whitelist rules @ priority 100   │
            └─────────────────────────────────────────────┘
```

### File map

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest. Two content scripts (ISOLATED + MAIN), `declarativeNetRequest` + `declarativeNetRequestFeedback`. |
| `service-worker.js` | Background controller. Settings, alarms, DNR feedback, stats buffer, badge. |
| `content-script.js` | ISOLATED-world bridge. Reads settings, dispatches events, forwards stat increments. |
| `content-script-main.js` | MAIN-world hooks. JS throttle, animation killer, image lite, prefetch stripping. |
| `popup/popup.html` | Popup markup. Stats card + 6 toggles + whitelist UI. |
| `popup/popup.css` | Popup styling. Dark palette: `#1a1a1a` bg, `#4caf50` accent, mono numbers. |
| `popup/popup.js` | Popup logic. Polls `GET_STATS` every 2 s while open. |
| `rules/static-rules.json` | DNR rules — trackers, ad SSPs, fonts, ad-media. IDs 1–251. |
| `icons/` | 16/48/128 PNG icons. |

---

## Features

| Setting key | What it does |
|---|---|
| `blockingEnabled` | Network-layer block of ~196 tracker/ad/font domains via `declarativeNetRequest`. |
| `tabSuspendEnabled` | Discards idle tabs via `chrome.tabs.discard()`. Skips pinned/audible/active/`chrome://`. Threshold is configurable. |
| `idleThresholdMinutes` | How long a tab can sit idle before being discarded. Picker in popup (1/3/5/10/15/30 min). Default 5. |
| `memoryPressureEnabled` | When system free RAM drops below `memoryPressureThresholdMB` (default 500), force-discards idle tabs immediately. Only affects tabs idle ≥ 30 s. |
| `videoPauseEnabled` | Pauses any `<video>` on a tab when it goes hidden and sets `preload="none"`, freeing decoder memory. User must press play to resume. |
| `jsThrottleEnabled` | Stubs `setTimeout`, `setInterval`, `requestAnimationFrame`, `eval`, `Function` on hidden tabs. |
| `imageLiteEnabled` | Adds `loading="lazy"` and `decoding="async"` to `<img>`/`<iframe>`; strips `srcset`/`sizes` to force smallest source. |
| `animationKillEnabled` | Injects a global `<style>` that collapses `animation-duration`, `transition-duration`, `scroll-behavior`. |
| `prefetchStripEnabled` | Removes `<link rel="preload\|prefetch\|preconnect\|dns-prefetch\|modulepreload\|prerender">` at load and via `MutationObserver`. |
| `whitelist` | Per-hostname opt-out. Dynamic DNR allow-rules at priority 100 override the priority-1 blocks; content-script features are skipped for whitelisted hostnames. |

The popup also has a **"Discard idle tabs now"** button that force-discards every eligible tab on demand — useful when RAM is tight right now and you don't want to wait for the idle threshold.

All toggles default to **on** after install. Settings live in `chrome.storage.sync` so they follow your Chrome profile.

---

## Stats methodology

The popup does not measure RAM with kernel precision — it can't, from inside the extension sandbox. Instead it counts events and multiplies by tuned constants:

| Event | RAM estimate | Bandwidth estimate | CPU estimate |
|---|---:|---:|---:|
| Blocked tracker / ad request | 120 KB | 25 KB | 40 ms |
| Blocked font request | 80 KB | 60 KB | 25 ms |
| Tab discarded | 80 MB | — | — |
| Animation killer applied (per page) | 12 MB GPU | — | 15 ms/frame |
| Prefetch link stripped | 50 KB | 30 KB | — |
| Image lazified | 2 MB | — | — |
| Background video paused | 50 MB | — | — |

Constants are centralised in `STATS_WEIGHTS` near the top of `service-worker.js` — retune in one place. Counter sources:

- **Blocked requests / fonts** — `chrome.declarativeNetRequest.onRuleMatchedDebug` (requires the `declarativeNetRequestFeedback` permission, already declared). Font rules are identified by `FONT_RULE_IDS` (IDs 40–44).
- **Tab discards** — counted inside the existing `checkIdleTabs` alarm handler.
- **Animations / prefetch / images** — counted in the MAIN-world content script, debounced 1 s, forwarded via `__potatofy_stat` → `STATS_INCREMENT` to the service worker.

The service worker batches all increments through a 1 s flush window before writing to `chrome.storage.local.stats`. Storage shape:

```js
{
  session:  { blockedRequests, blockedFonts, tabsDiscarded,
              animationsKilled, prefetchStripped, imagesLazied, since },
  lifetime: { ...same..., since }
}
```

Session resets on `chrome.runtime.onStartup`; lifetime persists until the user hits **Reset** with the lifetime scope selected.

> **Heads-up:** `onRuleMatchedDebug` only fires for unpacked extensions. If you ever pack this for the Web Store the request counters will go quiet. The content-script counters (animations, prefetch, images) and discard counter keep working in packed builds.

---

## Permissions rationale

| Permission | Why |
|---|---|
| `tabs` | Read tab URL/state for idle-discard checks and popup hostname display. |
| `storage` | Persist settings (sync) and stats (local). |
| `alarms` | 1-min periodic alarms for idle-tab check and badge refresh. |
| `declarativeNetRequest` | Static block rules + dynamic whitelist allow-rules. |
| `declarativeNetRequestFeedback` | `onRuleMatchedDebug` for the request counter. |
| `scripting` | Reserved for future dynamic content-script injection (currently unused beyond manifest declaration). |
| `system.memory` | Read system free RAM for the memory-pressure auto-discard path. Polled every 30 s in the service worker. |
| `host_permissions: <all_urls>` | Required for MAIN-world content scripts and DNR `initiatorDomains` on whitelist rules. |

---

## DNR rule layout

| ID range | Purpose |
|---|---|
| 1–37 | Original analytics, ad networks, session recording (Google, Facebook, Hotjar, Sentry, etc.) |
| 40–44 | Font CDNs (Google Fonts, Typekit, FontAwesome). Special-cased for the stats counter. |
| 60–61 | Media-type blocks for video ad SDKs. |
| 100–247 | EasyList-lite expansion: ad SSPs, push-notification spam, marketing automation, heatmap/recording, social embeds, comment widgets. |
| 248–251 | Extra font CDN entries (cdnjs, MaxCDN, bootstrapcdn). |
| 10000+ | Dynamic whitelist allow-rules at priority 100 (override the priority-1 blocks). |

To add a rule, append a `{id, priority, action, condition}` object to `rules/static-rules.json` with a fresh ID inside the appropriate range. Reload the extension at `chrome://extensions`. There is no remote rule fetch — everything stays in-tree (MV3-pure).

---

## Dev workflow

1. Edit any file in this repo.
2. Open `chrome://extensions`, click the reload icon on Potatofy's card.
3. Hard-refresh the test page (`Ctrl+Shift+R`) so the new content scripts inject at `document_start`.
4. **Service worker debugging:** click "Service worker" on the extension card to open a DevTools window scoped to `service-worker.js`. Logs from `chrome.declarativeNetRequest.onRuleMatchedDebug` and the stats buffer appear here.
5. **Popup debugging:** right-click the toolbar icon → "Inspect popup". Stats refresh every 2 s while the popup is open.
6. **DNR rule debugging:** use `chrome://extensions/?id=<your-id>` → "Inspect views: service worker" and call `chrome.declarativeNetRequest.getMatchedRules({})` to dump recent matches.

### Verifying the new content-script features on a page

- `loading="lazy"` injection — DevTools Elements panel → inspect an `<img>` → confirm the attribute is present.
- Animation kill — DevTools Elements → `<head>` should contain a `<style data-potatofy="anim-kill">` element.
- Prefetch strip — DevTools Network panel → filter `Type: Other` → confirm no `preload`/`prefetch` rows. Or inspect `<head>` for missing `<link rel="preload">`.

---

## License

GPLv3. See [LICENSE](LICENSE).
