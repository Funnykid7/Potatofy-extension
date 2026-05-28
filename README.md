# Potatofy

A Chromium MV3 extension that aggressively trims memory, GPU, and network overhead so a Raspberry Pi (or any low-spec box) can browse the modern web without melting.

**Marketing site:** [funnykid7.github.io/Potatofy-extension](https://funnykid7.github.io/Potatofy-extension/) · **License:** GPLv3

---

## Why it exists

Measured on a Raspberry Pi 5 (4 cores, 8 GB RAM, Chromium 148, identical browsing session):

| Process | Without Potatofy | With Potatofy | Δ |
|---|---:|---:|---:|
| GPU process | 1,860 MB | 1,181 MB | **−678 MB** |
| Main renderer | 1,178 MB | 997 MB | −181 MB |
| Browser | 608 MB | 532 MB | −76 MB |
| **Total peak** | **4,518 MB** | **3,734 MB** | **−784 MB (−17%)** |

That gain comes from blocking trackers and ads before they load, suspending tabs you aren't using, and freezing background JavaScript on tabs you can't see.

---

## Install (unpacked)

```
1. git clone https://github.com/Funnykid7/Potatofy-extension.git
2. Open chrome://extensions
3. Toggle "Developer mode" (top-right)
4. Click "Load unpacked" and select the cloned folder
```

No build step. No `node_modules`. The repo is the extension. Works on Chromium, Brave, Edge, and Arc.

---

## Features

All toggles default to **on** after install. Flip any off in the popup, or whitelist a site to skip everything for that hostname.

| Setting | What it does |
|---|---|
| Block trackers & ads | Network-layer block of ~250 tracker, ad, and font CDN domains. |
| Auto-suspend idle tabs | Discards tabs after the chosen idle window (1-30 min). Skips pinned, audible, and active tabs. |
| Memory-pressure auto-discard | If system free RAM drops below threshold (default 500 MB), force-discards idle tabs immediately. |
| Throttle background JS | Stubs `setTimeout`, `setInterval`, and `requestAnimationFrame` on hidden tabs. |
| Pause background videos | Pauses `<video>` and drops `preload` when a tab becomes hidden. |
| Image lite mode | Adds `loading="lazy"` and `decoding="async"`; strips `srcset` so the smallest source is used. |
| Kill CSS animations | Site-wide style override collapsing animation and transition durations. |
| Kill autoplay media | Strips `autoplay` from `<video>` and `<audio>` so nothing starts on load. |
| Strip prefetch hints | Removes `preload`, `prefetch`, `preconnect`, `dns-prefetch`. |
| Whitelist | Per-hostname opt-out with one click in the popup. |

> Heads-up: a small number of sites that rely on background timers may need to be whitelisted to behave correctly.

The popup also has a **"Discard idle tabs now"** button for when RAM is tight right now.

---

## Stats

The popup shows estimated RAM, bandwidth, and CPU saved. These are heuristic estimates per event (tuned in `STATS_WEIGHTS` in `service-worker.js`), not kernel-level measurements. They are meant to show direction, not lab precision.

Settings sync via `chrome.storage.sync`; counters live in `chrome.storage.local`. Session counters reset on browser startup; lifetime counters persist until you reset them.

---

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read tab URL/state for idle-discard and popup hostname display. |
| `storage` | Persist settings (sync) and stats (local). |
| `alarms` | Periodic alarms for idle-tab check, memory pressure, and badge refresh. |
| `declarativeNetRequest` | Static block rules and dynamic whitelist allow-rules. |
| `declarativeNetRequestFeedback` | Counts blocked requests for the popup stats. |
| `system.memory` | Read free RAM for the memory-pressure auto-discard path. |
| `windows` | Iterate windows when discarding idle tabs. |
| `host_permissions: <all_urls>` | Required for MAIN-world content scripts and per-site whitelist rules. |

---

## Dev

Edit any file, then click reload on Potatofy's card at `chrome://extensions`. Service-worker logs live behind the "Service worker" link on the same card; popup logs behind right-click → Inspect popup.

Built-in diagnostics: open the popup and click **Run Diagnostics**. The popup runs a ~35-test suite covering formatters, settings round-trip, stats math, and whitelist storage. The full report renders in the popup itself.

---

## License

GPLv3. See [LICENSE](LICENSE).
