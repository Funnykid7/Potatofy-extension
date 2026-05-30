# Chrome Web Store Listing Copy

Reference document — paste each section into the Chrome Web Store Developer Dashboard
at https://chrome.google.com/webstore/devconsole when creating/updating the listing.

---

## Short Description (132 chars max — auto-filled from manifest, can override)

```
Reclaims RAM and bandwidth on Raspberry Pi and low-spec hardware. Blocks trackers, suspends idle tabs, freezes timers, kills bloat.
```

---

## Long Description

Potatofy is a browser optimizer built for Raspberry Pi and any hardware that struggles with the modern web. It strips out the heaviest parts of each page — trackers, third-party scripts, prefetch noise, background timers, and autoplay media — so Chromium can run without constantly thrashing memory or burning CPU on tabs you aren't even looking at.

**Measured on a Raspberry Pi 5 (8 GB, Chromium 148):** −784 MB peak memory (−17%) across the GPU process, renderer, and browser compared to the same browsing session without the extension.

---

### Standard features (safe defaults, all on)

- **Block trackers, ads & web fonts** — network-layer blocking via Chrome's declarative rules, no per-request CPU cost
- **Suspend idle tabs** — discards tabs after a configurable idle window (1–30 min); skips pinned, audible, and active tabs
- **Freeze background timers** — stubs setTimeout and requestAnimationFrame on hidden tabs so background scripts stop burning CPU
- **Lazy-load images** — adds loading=lazy, decoding=async, and fetchpriority=low to images and iframes
- **Kill CSS animations** — collapses animation and transition durations site-wide
- **Kill autoplay media** — strips the autoplay attribute from video and audio elements
- **Strip prefetch hints** — removes preload, prefetch, preconnect, and dns-prefetch link tags
- **Pause background video** — pauses playing video and drops preload when a tab is hidden

---

### Maximum savings (aggressive defaults, all on — whitelist sites that break)

- **Block 3rd-party scripts** — drops every script not served from the page's own domain; eliminates most trackers, chat widgets, and analytics
- **Block 3rd-party images** — foreground potato mode, extends image blocking to all visible tabs
- **Site-specific killers** — CSS rules that hide non-content DOM bloat on YouTube, Reddit, Twitter/X, Facebook, Instagram, LinkedIn, Amazon, NYTimes, CNN, and GitHub
- **Defer video loading** — forces preload=none on all videos; loads only when played
- **Memory pressure auto-discard** — monitors free RAM every 30 seconds; discards idle tabs when memory dips below a configurable threshold

---

### Per-site controls

- **Kill JS here / Kill images here** — permanently block scripts or images on the current domain via contentSettings
- **Boost this tab** — temporary tab-scoped aggressive block; clears on navigation
- **Whitelist** — one click disables everything for the current site

---

### Settings sync

Feature toggles can optionally sync to your Google account via chrome.storage.sync (opt-in, off by default). Site lists stay local unless you explicitly enable a second opt-in. Turning sync off immediately purges the remote copy.

---

**Works on:** Chromium, Chrome, Brave, Edge, Arc — any Chromium 88+ browser.

**Privacy:** No analytics, no telemetry, no remote code. All blocking rules ship bundled in the extension. Full privacy policy: https://funnykid7.github.io/Potatofy-extension/privacy

**Source:** https://github.com/Funnykid7/Potatofy-extension (GPLv3)

---

## Category

`Productivity` (primary) or `Accessibility` — both are defensible; Productivity is more accurate.

---

## Privacy Practices (dashboard fields)

- **Does the extension collect or use any user data?** — No
- **Privacy policy URL:** `https://funnykid7.github.io/Potatofy-extension/privacy`

---

## Permissions Justification

Paste this into the "Justify your permission usage" field in the dashboard.

---

### `tabs`
Reads tab URL, active state, audible state, and pinned state to determine which tabs are eligible for idle suspension. The extension never reads page content via tabs; it only queries metadata Chrome already exposes. Required for the auto-suspend idle tabs and memory-pressure auto-discard features.

### `storage`
Writes settings (feature toggles, thresholds) to chrome.storage.local. Optionally writes feature toggles to chrome.storage.sync when the user enables Settings Sync in the popup. Writes aggregate stats counters (blocked-request counts, tabs-discarded counts) to chrome.storage.local and chrome.storage.session. No browsing history, URLs, or page content is stored.

### `alarms`
Creates four recurring alarms: idle-tab check (1 min), memory-pressure check (30 s), stats flush (15 s), and blocked-request polling (1 min). Alarms are the only way a Manifest V3 service worker can reliably execute periodic background work.

### `contentSettings`
Used exclusively to implement the "Kill JS here" and "Kill images here" per-site blocking buttons in the popup. When the user clicks one of these buttons, the extension calls chrome.contentSettings.javascript.set or chrome.contentSettings.images.set for the current domain only. No other content setting category is read or written.

### `declarativeNetRequest`
Required to apply the bundled static blocking rule sets (tracker/ad block, font CDN block) and to install dynamic rules for the user's whitelist (allow rules) and 3rd-party script/image blocking (block rules). All rules are evaluated by the browser engine; the extension never intercepts or reads request content.

### `declarativeNetRequestFeedback`
Used to call chrome.declarativeNetRequest.getMatchedRules() once per minute to count how many blocking rules fired, so the popup can display an accurate "Requests blocked" counter. The API returns only rule IDs and match timestamps — no request URLs, no page content, no origin information is returned to the extension. In developer (unpacked) mode, also subscribes to onRuleMatchedDebug for real-time counts during development; this listener does not run in production (packaged) builds.

### `system.memory`
Reads chrome.system.memory.getInfo() every 30 seconds to check available RAM. If free memory drops below the user's configured threshold (default 500 MB), the extension discards eligible idle tabs. The memory reading is not stored or logged beyond the immediate comparison.

### `windows`
Calls chrome.windows.getAll() when performing idle-tab suspension to iterate all open browser windows and identify the active tab in each window, which is excluded from discarding. No window content or position data is used.

### `host_permissions: <all_urls>`
Required for two reasons:
1. Declarative blocking rules must be allowed to apply to requests from any initiator domain; Chrome requires broad host permissions to install rules with unrestricted initiator matching.
2. The MAIN-world content script (see below) must run on every page to intercept background timer functions.

---

## MAIN World Content Script Justification

The content script runs in `"world": "MAIN"` (the page's own JavaScript context) rather than the default isolated world.

**Why this is necessary:** The "Freeze background JS" feature works by overriding `window.setTimeout` and `window.requestAnimationFrame` with wrapper functions that suppress timer callbacks when `document.visibilityState === 'hidden'`. These are native globals that live on the page's own window object. An isolated-world content script runs in a separate JavaScript context and cannot write to `window.setTimeout` — the page's own scripts would not see the override. MAIN world access is the only way to implement this feature without a separate injected script element.

**Scope of access:** The content script only writes to two window properties (`window.setTimeout` and `window.requestAnimationFrame`) and restores them when the tab becomes visible. It does not read page content, does not access the DOM for data extraction, does not communicate with page scripts via postMessage or shared globals, and does not send any page data to the service worker. The only data the content script sends to the service worker is aggregate event counts (e.g. "3 images were lazified on this page"), never content or URLs.

---

## Screenshots — what to capture (1280×800 or 640×400 PNG)

Suggested 3–5 screenshots to prepare before submission:

1. **Popup — stats after a browsing session** — shows all 6 stat rows with real numbers (RAM saved, bandwidth, time, requests, 3rd-party scripts, tabs discarded). Best after 20–30 min on YouTube or Reddit.
2. **Popup — Standard section expanded** — shows all 8 Standard toggles on.
3. **Popup — Maximum savings section expanded** — shows the Maximum savings section.
4. **Before/after memory bar chart** — the marketing site's chart at https://funnykid7.github.io/Potatofy-extension/ or a fresh chrome://memory-internals comparison.
5. **Site killer in action** — YouTube with sidebar/comments hidden.

Capture with: right-click the extension icon → Inspect popup, then use DevTools Device toolbar to set 400×600 or similar, screenshot the popup in context.
