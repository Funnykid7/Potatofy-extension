# Potatofy

A Chromium MV3 extension that aggressively trims memory, GPU, and network overhead so a Raspberry Pi (or any low-spec box) can browse the modern web without melting.

**Website:** [funnykid7.github.io/Potatofy-extension](https://funnykid7.github.io/Potatofy-extension/) · **License:** GPLv3

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

## Install (Web store version)

```
1. Install Potatofy from chrome web store.
2. Enjoy boost in performance.
3. Note: web store version may be behind on features and bug fixes, to use latest version look below to install unoacked section.
```

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

All toggles default to **on** after install. Flip any off in the popup, or whitelist a site with one click to suspend everything for that hostname.

Features are split into two sections in the popup:

**Standard** — conservative defaults that don't break sites:

| Setting | What it does |
|---|---|
| Block trackers & ads | Network-layer block of ~250 tracker, ad, and font CDN domains. |
| Auto-suspend idle tabs | Discards tabs after a configurable idle window (1–30 min). Skips pinned, audible, and active tabs. |
| Memory-pressure auto-discard | If free RAM drops below a threshold (default 500 MB), force-discards idle tabs immediately. |
| Freeze background JS | Stubs `setTimeout` and `requestAnimationFrame` on hidden tabs. `setInterval` is intentionally left running so repeating polling loops (webmail refresh, chat heartbeats, etc.) keep working. |
| Pause background videos | Pauses `<video>` and drops `preload` when a tab becomes hidden. Restores on tab focus. |
| Lazy-load images | Adds `loading="lazy"`, `decoding="async"`, and `fetchpriority="low"` to images and iframes. |
| Kill CSS animations | Site-wide style override collapsing animation and transition durations to near-zero. |
| Kill autoplay media | Strips `autoplay` from `<video>` and `<audio>` so nothing starts on load. |
| Strip prefetch hints | Removes `preload`, `prefetch`, `preconnect`, `dns-prefetch`, and `modulepreload` link tags. |
| Whitelist | Per-hostname opt-out. Open the popup → Whitelist This Site. All features immediately suspended for that domain. |

**Maximum savings** — aggressive, may break some sites (all on by default; whitelist to fix):

| Setting | What it does |
|---|---|
| Block 3rd-party scripts | Drops every script not served from the page's own domain at the network layer. Eliminates most trackers, chat widgets, and A/B frameworks. Will break sites that depend on CDN-hosted scripts for core functionality — whitelist those. |
| Block 3rd-party images | Foreground potato mode: blocks third-party images on all visible tabs. |
| Site-specific killers | CSS rules that hide DOM bloat per domain: YouTube comments/sidebar, Reddit trending, Twitter trending column, Facebook right rail, Amazon sponsored rows, LinkedIn ads, GitHub promoted content, and more. |
| Defer video loading | Forces `preload="none"` on all visible videos; restores on first play. |
| Low-quality images | Strips `srcset` and `sizes` so the browser uses the smallest available source. Opt-in, off by default. |
| Per-site JS / image kill | "Kill JS here" and "Kill images here" buttons in the popup block all scripts or images permanently for the current domain via `contentSettings`. |
| Boost this tab | Temporary tab-scoped aggressive block (scripts + images + media) on the current tab only. Clears on navigation. |

> **Heads-up:** The Maximum savings features are on by default and significantly reduce resource usage, but some sites that rely on 3rd-party scripts for core functionality (certain payment flows, login buttons, embedded players) will need to be whitelisted.

The popup also has a **"Discard idle tabs now"** button for when RAM is tight right now.

---

## Stats

The popup shows estimated RAM, bandwidth, and CPU saved. These are heuristic estimates per event (tuned in `STATS_WEIGHTS` in `lib/stats-weights.js`), not kernel-level measurements. They are meant to show direction and relative impact, not lab precision.

Settings sync via `chrome.storage.sync` (opt-in, off by default); counters live in `chrome.storage.local`. Session counters reset on browser startup; lifetime counters persist until you reset them.

---

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read tab URL and activity state for idle-tab suspension and popup hostname display. No tab content is accessed. |
| `storage` | Persist settings (`local`) and stats (`local`). Optionally mirror feature toggles to `sync` if the user opts in. |
| `alarms` | Periodic checks for idle-tab suspension (1 min), memory pressure (30 s), stats flush (15 s), and DNR polling (1 min). |
| `contentSettings` | Per-site JavaScript and image blocking for the "Kill JS here" / "Kill images here" popup buttons. No other content setting is touched. |
| `declarativeNetRequest` | Static block rules (trackers, ads, font CDNs) and dynamic whitelist allow-rules. All rules ship in the extension — no remote fetch. |
| `declarativeNetRequestFeedback` | Polls `getMatchedRules()` once per minute to count blocked requests for popup statistics. Only rule IDs and timestamps are read — no request URLs or page content. |
| `system.memory` | Reads free RAM every 30 s for the memory-pressure auto-discard path. Not stored or transmitted. |
| `windows` | Iterates open windows when discarding idle tabs to correctly skip the active tab in each window. |
| `host_permissions: <all_urls>` | Required for (1) declarative blocking rules that must apply to all domains, and (2) the MAIN-world content script that overrides `window.setTimeout` / `window.requestAnimationFrame` to freeze background timers. |

### Why MAIN world?

The content script runs in `"world": "MAIN"` because it must override `window.setTimeout` and `window.requestAnimationFrame`. These are native browser globals on the page's own JavaScript context — an isolated-world content script cannot write to them. The script does not read page content, does not extract data, and does not communicate with page scripts. It only wraps two timer functions to suppress callbacks when `document.visibilityState === 'hidden'`, then restores the originals when the tab becomes visible again.

---

## Dev

Edit any file, then click **Reload** on Potatofy's card at `chrome://extensions`. Service-worker logs are behind the "Service worker" link on the same card; popup logs behind right-click → Inspect popup.

Built-in diagnostics: open the popup and click **Run Diagnostics** (visible in dev/unpacked builds only). The suite runs tests covering formatters, settings round-trip, stats math, boost behaviour, and whitelist storage. The full report renders in the popup itself.

---

## License

GPLv3. See [LICENSE](LICENSE).
