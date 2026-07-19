(function () {
  // SEC-01: this script runs in the ISOLATED world (see manifest content_scripts).
  // It has chrome.runtime and owns all messaging, DOM features, observers, and
  // calibration. The page-timer throttle — the one feature that must override
  // window.setTimeout in the page's MAIN world — lives in main-throttle.js and is
  // driven from here via postThrottleState() over window.postMessage.
  //
  // These bindings are the ISOLATED world's own globals; the page cannot reach or
  // override them, so they stay native for our internal use regardless of the page.
  const _setTimeout = window.setTimeout.bind(window);
  const _setInterval = window.setInterval.bind(window);

  // 1.1.1: only the top frame reports stats. Content scripts run per-frame
  // (`all_frames: true`), so a page with N same-origin iframes would otherwise
  // multiply every counter by N. The feature effects (throttle, killers,
  // observers) still run in every frame — only the bookkeeping is deduped.
  const IS_TOP_FRAME = (window === window.top);

  // 1.1.2 hardening cap. Matches MAX_INCREMENT in service-worker.js so a
  // single batched stat never inflates a counter beyond plausible per-flush
  // values, even if the local report buffer accumulates on a long-lived tab.
  const MAX_INCREMENT = 100_000;

  // 1.1.3 — randomise the DOM attribute names and JS-property markers we
  // leave on the page so the literal `data-potatofy` (which was a 1-line
  // fingerprint) becomes a per-page-load suffix that's invisible to a
  // simple querySelector probe.
  const POTATO_SUFFIX     = Math.random().toString(36).slice(2, 9);
  const POTATO_ATTR       = 'data-ptfy-' + POTATO_SUFFIX;
  // H-7 — single shared dataset key holding the original <video> preload value.
  const POTATO_ORIG_PRELOAD = 'ptfyOpl' + POTATO_SUFFIX;
  const POTATO_PAUSED_KEY = '__ptfy_paused_' + POTATO_SUFFIX;

  // 1.1.3 (F2) / SEC-1 — supply-chain defence. Even after the querySelector
  // syntax filter, a malicious site-killers.json could include a syntactically
  // valid selector that targets the entire document. Drop the exact-match
  // offenders here and the broad-pattern offenders via BROAD_SELECTOR_RE below
  // so a compromised rules file can't blank the page or hide security UI.
  const BLOCKED_SELECTORS = new Set(['*', 'body', 'html', 'head', ':root']);

  // SEC-1 — reject selectors that match an unreasonably large fraction of the
  // page. Three complementary checks applied inside applySiteKillers:
  //
  // 1. BLOCKED_SELECTORS — exact-match blocklist for the most obvious forms.
  //
  // 2. BROAD_SELECTOR_RE — anchored-start check: rejects selectors that OPEN
  //    with a bare `[attr]` presence form, `*` + qualifier, or a universal
  //    pseudo. Catches: `[class] .foo`, `* > div`, `:nth-child(2)`.
  //
  // 3. Three additional checks in the filter itself (see applySiteKillers):
  //    a. Comma rejection — each array entry must be a single, not compound,
  //       selector. `"div.ad, body"` would otherwise smuggle `body` past the
  //       per-entry checks.
  //    b. Bare attribute-PRESENCE anywhere — `/\[[^\]=~|^$*]*\]/` matches any
  //       `[attr]` block that contains no operator character (`=`,`~`,`|`,`^`,
  //       `$`,`*`). Catches `span[class]`, `a[href]`, `div[id]` which bypass
  //       BROAD_SELECTOR_RE because they start with a tag name.
  //    c. Universal-in-combinator — `div > *`, `body > div` are too broad;
  //       rejected by checking for `*` after any combinator, and for `body`/
  //       `html` as a leading combinator target.
  //
  // All 43 existing site-killers.json selectors (valued attribute selectors,
  // custom element names, class/id selectors) pass these filters unchanged.
  const BROAD_SELECTOR_RE = /^(\[[^\]=~|^$*]*\]|\*\s*[\[:>+~ ]|:(?:root|nth-child|nth-of-type|not|is|where)\b)/i;
  // Bare attribute-presence ANYWHERE in the selector (tag-prefixed or not):
  // matches [attr] with no operator; `[^\]=~|^$*]*` = no `]`, `=`, or operator prefix chars.
  const BARE_ATTR_RE = /\[[^\]=~|^$*]*\]/;
  // Universal selector used as an UNQUALIFIED combinator target (e.g.
  // `div > *`, `ul *`) — rejects only when `*` stands alone (followed by a
  // combinator, comma, whitespace, or end of string). A `*` immediately
  // qualified by `.`,`#`,`:`, or `[` (e.g. `div > *[data-ad]`) narrows the
  // match and is left to the other checks (BARE_ATTR_RE etc.) to validate.
  const UNIVERSAL_COMBINATOR_RE = /(?:^|[>+~\s])\s*\*(?:[\s>+~,]|$)/;
  // Selectors where body/html/head/:root is the SOLE TARGET being qualified
  // (e.g. `body`, `body.ad-banner`, `html:not(...)`) — these select
  // essentially the entire page. A selector that uses one of these tokens as
  // a DESCENDANT ROOT instead (followed by whitespace or a combinator, e.g.
  // `body .ad-container`) targets a specific descendant, not the page
  // itself, and is left alone.
  const BLOCKED_LEADING_RE = /^(?:body|html|head|:root)(?:$|[.#:\[])/i;

  const settings = {
    jsThrottleEnabled: false,
    imageLazyEnabled: false,
    imageLowQualityEnabled: false,
    animationKillEnabled: false,
    autoplayKillEnabled: false,
    prefetchStripEnabled: false,
    videoPauseEnabled: false,
    videoPreloadNoneEnabled: false,
    siteKillersEnabled: false,
    siteKillers: []
  };
  let visibilityListenerAttached = false;

  // ---------- Stats bridge (debounced) ----------
  // 1.1.2: stats go directly to the service worker via chrome.runtime. The
  // old window.dispatchEvent('__potatofy_stat') path was observable by page
  // scripts and is removed. Now that this script is in the ISOLATED world,
  // chrome.runtime lives in a world the page's JS cannot reach.

  const statBuffer = Object.create(null);
  let statFlushTimer = null;

  // M-3 — stats are reported PER TOP-LEVEL PAGE, not per element across every
  // frame. Sub-frame counts are intentionally dropped: features still run in
  // all frames (manifest all_frames:true), but counting from each frame would
  // multiply totals on pages with many same-origin iframes. The displayed
  // counters therefore reflect work on the main document and undercount work
  // done inside iframes — a deliberate trade to avoid inflated numbers.
  function reportStat(key, n) {
    if (!n) return;
    if (!IS_TOP_FRAME) return; // dedupe across same-origin iframes
    statBuffer[key] = (statBuffer[key] || 0) + n;
    if (statFlushTimer) return;
    statFlushTimer = _setTimeout(() => {
      const patch = {};
      for (const k of Object.keys(statBuffer)) {
        const v = statBuffer[k];
        if (Number.isFinite(v) && v > 0) patch[k] = Math.min(Math.floor(v), MAX_INCREMENT);
      }
      if (Object.keys(patch).length === 0) { statFlushTimer = null; return; }
      // Only subtract the sent amounts once the send actually lands — zeroing
      // unconditionally beforehand dropped the whole batch for good whenever
      // the SW was unreachable, instead of letting it ride to the next flush.
      // The guard stays held (statFlushTimer non-null) until the send settles
      // so a slow send can't overlap with a second flush reading stale counts.
      chrome.runtime.sendMessage({ type: 'STATS_INCREMENT', patch }).then(() => {
        for (const k of Object.keys(patch)) statBuffer[k] -= patch[k];
      }).catch(() => {}).finally(() => { statFlushTimer = null; });
    }, 1000);
  }

  // The 1s debounce above loses whatever is buffered if the page navigates
  // away or the tab closes before it fires — flush synchronously on pagehide
  // so short-lived pages don't undercount savings.
  window.addEventListener('pagehide', () => {
    if (!IS_TOP_FRAME) return;
    if (statFlushTimer) { clearTimeout(statFlushTimer); statFlushTimer = null; }
    const patch = {};
    for (const k of Object.keys(statBuffer)) {
      const v = statBuffer[k];
      statBuffer[k] = 0;
      if (Number.isFinite(v) && v > 0) patch[k] = Math.min(Math.floor(v), MAX_INCREMENT);
    }
    if (Object.keys(patch).length === 0) return;
    chrome.runtime.sendMessage({ type: 'STATS_INCREMENT', patch }).catch(() => {});
  });

  // ---------- Feature gates ----------
  // anyFeatureEnabled() covers ALL content-layer features. Used by applyAll()
  // to decide whether to tear everything down. Includes one-shot features
  // (animationKill, siteKillers) and visibility-driven features (throttle).
  // New feature toggles MUST be added here so the tear-down path stays
  // accurate when the user disables every toggle.

  function anyFeatureEnabled() {
    return (
      settings.jsThrottleEnabled ||
      settings.imageLazyEnabled ||
      settings.imageLowQualityEnabled ||
      settings.animationKillEnabled ||
      settings.autoplayKillEnabled ||
      settings.prefetchStripEnabled ||
      settings.videoPauseEnabled ||
      settings.videoPreloadNoneEnabled ||
      (settings.siteKillersEnabled && settings.siteKillers.length > 0)
    );
  }

  function isHidden() {
    return document.visibilityState === 'hidden';
  }

  // ---------- Throttle bridge (SEC-01) ----------
  // The real window.setTimeout / requestAnimationFrame override lives in
  // main-throttle.js, which runs in the page's MAIN world (a content script can
  // only override the page's own timers from that world). This ISOLATED script
  // cannot reach the page's timers, so it just relays the jsThrottleEnabled flag.
  // The MAIN snippet reads document.visibilityState itself and owns the
  // queue/drain logic, so there is no throttle state to manage here.
  const THROTTLE_MSG_TAG = '__ptfy_thr';
  function postThrottleState() {
    try {
      // location.origin is the literal string "null" in sandboxed iframes
      // (sandbox without allow-same-origin) and a unique opaque value on
      // file:// pages — postMessage with either as the target origin fails
      // silently, so the MAIN-world throttle snippet never gets the enable
      // signal. The payload carries no sensitive data, so '*' is safe here.
      let origin = location.origin;
      if (!origin || origin === 'null' || origin.indexOf('file://') === 0) origin = '*';
      window.postMessage({ __ptfy: THROTTLE_MSG_TAG, jsThrottleEnabled: settings.jsThrottleEnabled }, origin);
    } catch (e) {}
  }

  function handleVisibilityChange() {
    // Throttle is owned by main-throttle.js (it has its own visibilitychange
    // listener); nothing to do for it here.
    if (settings.videoPauseEnabled) {
      if (isHidden()) pauseAllVideos(document);
      else restoreVideoPlayability(document);
    }
    if (!isHidden() && anyContentFeatureEnabled()) startObserver();
  }

  function ensureVisibilityListener() {
    if (visibilityListenerAttached) return;
    visibilityListenerAttached = true;
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  // ---------- Video handling (R7) ----------
  // H-7 — the videoPause and videoPreloadNone features both want to force
  // preload="none" on the same elements. They used to keep separate copies of
  // the original preload value under different dataset keys with independent
  // restore paths, so when both were enabled one path could clobber the other.
  // They now share ONE saved value (POTATO_ORIG_PRELOAD) and one restore helper.
  // Two WeakSets record which feature currently wants suppression; the original
  // preload is only restored once NEITHER feature wants it suppressed anymore.

  const pausePreloadedVideos = new WeakSet();  // videoPause is suppressing preload
  const preloadNonedVideos   = new WeakSet();  // videoPreloadNone is suppressing preload

  function stashOriginalPreload(el) {
    if (el.dataset[POTATO_ORIG_PRELOAD] === undefined) {
      el.dataset[POTATO_ORIG_PRELOAD] = el.preload || '';
    }
    el.preload = 'none';
  }

  function maybeRestorePreload(el) {
    // Don't restore while either feature still wants preload suppressed.
    if (pausePreloadedVideos.has(el) || preloadNonedVideos.has(el)) return;
    try {
      if (el.dataset[POTATO_ORIG_PRELOAD] !== undefined) {
        el.preload = el.dataset[POTATO_ORIG_PRELOAD];
        delete el.dataset[POTATO_ORIG_PRELOAD];
      }
    } catch (e) {}
  }

  function pauseVideoNode(el) {
    if (!el || el.tagName !== 'VIDEO') return false;
    try {
      // Bug 6 — never pause a video the user has put into Picture-in-Picture;
      // they switched tabs specifically to keep watching it out-of-tab.
      if (document.pictureInPictureElement === el || el.webkitPresentationMode === 'picture-in-picture') {
        return false;
      }
      // REMAINING-1 — use the WeakSet as the idempotency guard, not POTATO_PAUSED_KEY.
      // When the video isn't currently playing (wasPlaying=false), the old code skipped
      // setting POTATO_PAUSED_KEY, so a second call to pauseVideoNode on the same element
      // would pass the guard, call stashOriginalPreload again, and re-add to the WeakSet
      // (harmless but inconsistent). Using the WeakSet directly is both correct and
      // consistent: once we've stashed the preload, the element is "handled".
      if (pausePreloadedVideos.has(el)) return false;
      const wasPlaying = !el.paused && !el.ended;
      stashOriginalPreload(el);
      pausePreloadedVideos.add(el);
      if (wasPlaying) {
        el.pause();
        el[POTATO_PAUSED_KEY] = true;
        return true;
      }
    } catch (e) {}
    return false;
  }

  function pauseAllVideos(root) {
    if (!root) return false;
    let count = 0;
    const nodes = deepQueryAll(root, 'video');
    for (const n of nodes) if (pauseVideoNode(n)) count++;
    if (count) reportStat('videosPaused', count);
    return count > 0;
  }

  function restoreVideoPlayability(root) {
    if (!root) return;
    const nodes = deepQueryAll(root, 'video');
    for (const n of nodes) {
      try {
        pausePreloadedVideos.delete(n);
        maybeRestorePreload(n);     // honors a still-active videoPreloadNone
        // QA-12 — actually resume playback for videos WE paused on tab-hide.
        // The old code only cleared the flag, so a video paused when the tab was
        // backgrounded stayed paused forever after the user returned.
        if (n[POTATO_PAUSED_KEY]) {
          n[POTATO_PAUSED_KEY] = false;
          const p = n.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (e) {}
    }
  }

  // R7: preload="none" on all videos always; restore on first play.
  function applyVideoPreloadNone(el) {
    if (!el || el.tagName !== 'VIDEO') return false;
    if (preloadNonedVideos.has(el)) return false;
    try {
      stashOriginalPreload(el);
      preloadNonedVideos.add(el);
      const onPlay = () => {
        preloadNonedVideos.delete(el);
        maybeRestorePreload(el);    // honors a still-active videoPause
        // { once: true } already removes this listener after first fire;
        // the manual removeEventListener below is redundant (NIT-4 removed).
      };
      el.addEventListener('play', onPlay, { once: true });
      return true;
    } catch (e) {
      return false;
    }
  }

  function applyVideoPreloadNoneAll(root) {
    if (!root) return false;
    let count = 0;
    const nodes = deepQueryAll(root, 'video');
    for (const n of nodes) if (applyVideoPreloadNone(n)) count++;
    // 1.1.2: dedicated counter so the popup can attribute savings to the
    // correct toggle. Previously folded into videosPaused which misled users
    // about which feature was contributing.
    if (count) reportStat('videosPreloadNoned', count);
    return count > 0;
  }

  // Restore preload for videos suppressed by videoPreloadNoneEnabled. Needed
  // as its own per-toggle path (mirroring restoreVideoPlayability for
  // videoPauseEnabled) — without it, toggling this feature off mid-session
  // while another feature stays enabled left preload="none" stuck until the
  // page was reloaded or the video happened to play (firing the one-shot
  // onPlay listener from applyVideoPreloadNone).
  function restoreVideoPreloadNone(root) {
    if (!root) return;
    const nodes = deepQueryAll(root, 'video');
    for (const n of nodes) {
      if (!preloadNonedVideos.has(n)) continue;
      preloadNonedVideos.delete(n);
      maybeRestorePreload(n); // honors a still-active videoPause
    }
  }

  // ---------- Animation killer ----------

  let killStyleEl = null;
  let pageHadAnimations = false;

  // PERF-07 — detect animations via the Web Animations API only. The old
  // fallback walked every stylesheet's cssRules looking for @keyframes, which
  // blocked the main thread on CSS-heavy sites — and it existed purely to decide
  // whether to count a single animationsKilled stat. document.getAnimations() is
  // the cheap standard signal (Chrome 120+); the stylesheet scan is dropped.
  // Trade-off: animations that haven't started at sample time may be undercounted
  // — acceptable, since the kill style is injected regardless and the RAM weight
  // for animations is now ~token (CSS animations don't allocate JS heap).
  function pageHasAnimations() {
    try {
      if (typeof document.getAnimations === 'function' && document.getAnimations().length > 0) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  function applyAnimationKill() {
    if (killStyleEl) return false;
    const css = `
      *,
      *::before,
      *::after {
        animation-duration: 0.001ms !important;
        animation-delay: 0ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
        transition-delay: 0ms !important;
        scroll-behavior: auto !important;
      }
      html { scroll-behavior: auto !important; }
    `;
    const insert = () => {
      if (killStyleEl) return;
      // The feature may have been toggled off again before DOMContentLoaded
      // fired for this deferred injection — re-check the live flag so a
      // rapid toggle-off/on right at page load doesn't still result in a
      // permanent injection.
      if (!settings.animationKillEnabled) return;
      // M-6 — sample whether the page actually had animations BEFORE injecting
      // the kill style. The kill style only zeroes durations; it doesn't remove
      // @keyframes rules, so pageHasAnimations() would return true on virtually
      // every page if checked afterwards — over-counting animationsKilled.
      const hadAnimationsAtInsert = pageHasAnimations();
      killStyleEl = document.createElement('style');
      killStyleEl.setAttribute(POTATO_ATTR, 'anim-kill');
      killStyleEl.textContent = css;
      (document.head || document.documentElement).appendChild(killStyleEl);
      _setTimeout(() => {
        if (pageHadAnimations) return;
        // Re-sample after settle to catch animations defined late, but the
        // initial pre-injection sample is authoritative for "did we kill any".
        if (hadAnimationsAtInsert || pageHasAnimations()) {
          pageHadAnimations = true;
          reportStat('animationsKilled', 1);
        }
      }, 1500);
    };
    if (document.head || document.documentElement) insert();
    else document.addEventListener('DOMContentLoaded', insert, { once: true });
    return true;
  }

  function removeAnimationKill() {
    if (killStyleEl && killStyleEl.parentNode) {
      killStyleEl.parentNode.removeChild(killStyleEl);
    }
    killStyleEl = null;
  }

  // ---------- Site-killers (R5) ----------

  let siteKillerStyleEl = null;

  function applySiteKillers() {
    if (!settings.siteKillersEnabled || settings.siteKillers.length === 0) return false;
    // 1.1.2 (B6): validate each selector in isolation so one bad pattern can't
    // poison the entire stylesheet. querySelector throws on syntax errors but
    // is fast and uses the real CSS engine.
    // 1.1.3 (F2): also reject overly-broad selectors that would blank the
    // entire page if a supply-chain attack modified site-killers.json. These
    // are syntactically valid CSS, so querySelector accepts them — we drop
    // them explicitly here.
    const selectors = settings.siteKillers.filter(s => {
      if (typeof s !== 'string' || !s.length) return false;
      const t = s.trim();
      if (BLOCKED_SELECTORS.has(t.toLowerCase())) return false;
      if (BROAD_SELECTOR_RE.test(t)) return false;
      // Strip quoted string literals before the anywhere/comma checks below —
      // otherwise content INSIDE an attribute value's quotes (e.g. the
      // literal "[Ad]" in `div[aria-label="[Ad]"]`, or "300,250" in
      // `div[data-sizes="300,250"]`) gets misread as a bare-attribute
      // presence selector or a compound-selector comma.
      const stripped = t.replace(/"[^"]*"|'[^']*'/g, '');
      // SEC-1 (a): comma = compound selector; each entry must be a single rule
      // so `"div.ad, body"` can't smuggle a blocked token past per-entry
      // checks. A comma nested inside parentheses (e.g. `:is(.a, .b)`) is a
      // single functional pseudo-class argument list, not a top-level
      // selector separator, so only a comma OUTSIDE any parens counts.
      let parenDepth = 0, hasTopLevelComma = false;
      for (const ch of stripped) {
        if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
        else if (ch === ',' && parenDepth === 0) { hasTopLevelComma = true; break; }
      }
      if (hasTopLevelComma) return false;
      // SEC-1 (b): bare [attr] presence anywhere (catches tag-prefixed forms).
      if (BARE_ATTR_RE.test(stripped)) return false;
      // SEC-1 (c): universal selector as an unqualified combinator target
      // (`div > *`, `ul *`) — a qualified one (`div > *[data-ad]`) is safe.
      if (UNIVERSAL_COMBINATOR_RE.test(stripped)) return false;
      // SEC-1 (d): body/html/head/:root as the sole target (`body`,
      // `body.ad-banner`) — used as a descendant root (`body .ad-container`)
      // is left alone.
      if (BLOCKED_LEADING_RE.test(stripped)) return false;
      // PERF-08 — validate selector SYNTAX without traversing the DOM.
      // CSS.supports('selector(...)') uses the CSS parser only (no querySelector
      // walk), so a long site-killers list doesn't trigger N full-document scans
      // at startup. Fall back to querySelector if CSS.supports is unavailable.
      try {
        if (window.CSS && typeof CSS.supports === 'function') {
          return CSS.supports('selector(' + s + ')');
        }
        document.querySelector(s);
        return true;
      } catch (e) { return false; }
    });
    if (selectors.length === 0) return false;
    const css = selectors.join(',\n') + ' { display: none !important; }';

    // Already injected with the exact same rules — nothing to do.
    if (siteKillerStyleEl && siteKillerStyleEl.textContent === css) return false;

    if (siteKillerStyleEl) {
      // Rules changed mid-session (e.g. an updated site-killers list arrived
      // via a settings update) — update the existing element instead of
      // silently ignoring the change until the feature is toggled off/on.
      siteKillerStyleEl.textContent = css;
      return true;
    }

    const insert = () => {
      if (siteKillerStyleEl) return;
      // The feature may have been toggled off again before DOMContentLoaded
      // fired for this deferred injection — re-check the live flag so a
      // rapid toggle-off/on right at page load doesn't still result in a
      // permanent injection.
      if (!settings.siteKillersEnabled || settings.siteKillers.length === 0) return;
      siteKillerStyleEl = document.createElement('style');
      siteKillerStyleEl.setAttribute(POTATO_ATTR, 'site-killer');
      siteKillerStyleEl.textContent = css;
      (document.head || document.documentElement).appendChild(siteKillerStyleEl);
      reportStat('siteKillerHits', 1);
    };
    if (document.head || document.documentElement) insert();
    else document.addEventListener('DOMContentLoaded', insert, { once: true });
    return true;
  }

  function removeSiteKillers() {
    if (siteKillerStyleEl && siteKillerStyleEl.parentNode) {
      siteKillerStyleEl.parentNode.removeChild(siteKillerStyleEl);
    }
    siteKillerStyleEl = null;
  }

  // ---------- Shadow DOM traversal ----------
  // Plain querySelectorAll never crosses shadow boundaries, so elements
  // inside a custom element's shadow root (video players, ad widgets built
  // as web components) were invisible to every content-layer feature. This
  // walks the light DOM and recurses into any shadowRoot it finds.
  // Scope: covers the initial full-document pass and newly-added subtrees
  // seen by the MutationObserver. Content added LATER inside an
  // already-processed shadow root (after its host was already walked) isn't
  // separately re-observed — a narrower, lower-risk trade than wiring up a
  // dedicated MutationObserver per shadow root.
  function deepQueryAll(root, selector, out) {
    out = out || [];
    if (!root || !root.children) return out;
    // Iterative (explicit stack) instead of recursive: recursion depth here
    // tracked DOM nesting depth 1:1 with no cap, so a pathologically deep
    // tree (tens of thousands of nested elements) could exhaust the JS call
    // stack. The stack array lives on the heap and has no such limit.
    const stack = [{ children: root.children, i: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.i >= frame.children.length) { stack.pop(); continue; }
      const el = frame.children[frame.i++];
      if (typeof el.matches === 'function' && el.matches(selector)) out.push(el);
      if (el.children && el.children.length) stack.push({ children: el.children, i: 0 });
      if (el.shadowRoot) stack.push({ children: el.shadowRoot.children, i: 0 });
    }
    return out;
  }

  // ---------- Image lite (B1: restore srcset on toggle-off) ----------

  // Bug 3 — split the single shared "processed" marker into one per feature.
  // A shared marker meant an element touched only by imageLazyEnabled could
  // never be reprocessed by applyImageLazyAll once imageLowQualityEnabled was
  // later also enabled (it was already "processed", so it got skipped before
  // lazifyImage ever ran the srcset-stripping branch for it).
  const processedImagesLazy = new WeakSet();     // imageLazyEnabled attrs applied
  const processedImagesQuality = new WeakSet();  // imageLowQualityEnabled srcset stripped
  // Stores { srcset, sizes } captured before stripping so we can restore the
  // original quality if the user disables imageLowQualityEnabled mid-session.
  const imageOriginalSrcset = new WeakMap();
  // Tracks <img> elements where we synthesized a fallback `src` (see below)
  // so restoreImageQuality() can remove it again rather than leaving it stuck.
  const injectedFallbackSrc = new WeakSet();
  // Bug 28 — tracks which loading/decoding/fetchpriority attributes Potatofy
  // itself added (as opposed to ones already present on the element) so
  // restoreImageLazyAttrs() can remove exactly those again on toggle-off.
  const injectedLazyAttrs = new WeakMap();

  // Picks the smallest candidate URL out of a srcset string, used as a `src`
  // fallback for <img> elements that rely solely on srcset (valid, common
  // responsive-image markup) — without this, stripping srcset left them with
  // no source at all and rendered as a broken image.
  function smallestSrcsetCandidate(srcset) {
    if (!srcset) return '';
    const candidates = srcset.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
      const parts = entry.split(/\s+/);
      const descriptor = parts[1] || '';
      return { url: parts[0], num: parseFloat(descriptor) || 0, isWidth: descriptor.endsWith('w') };
    });
    if (candidates.length === 0) return '';
    const widthCandidates = candidates.filter(c => c.isWidth && c.num > 0);
    if (widthCandidates.length > 0) {
      widthCandidates.sort((a, b) => a.num - b.num);
      return widthCandidates[0].url;
    }
    return candidates[0].url; // density (x) descriptors don't map to size — just take the first
  }

  function lazifyImage(el) {
    if (!el) return false;
    const tag = el.tagName;
    // <picture><source> elements carry their own srcset for responsive
    // images/art-direction but have no `loading`/`decoding` concept of
    // their own — only IMG/IFRAME get the lazyload attributes below.
    if (tag !== 'IMG' && tag !== 'IFRAME' && tag !== 'SOURCE') return false;
    try {
      let changed = false;
      if (settings.imageLazyEnabled) {
        const added = injectedLazyAttrs.get(el) || [];
        if ((tag === 'IMG' || tag === 'IFRAME') && !el.hasAttribute('loading')) { el.setAttribute('loading', 'lazy'); added.push('loading'); changed = true; }
        if (tag === 'IMG' && !el.hasAttribute('decoding')) { el.setAttribute('decoding', 'async'); added.push('decoding'); changed = true; }
        if (tag === 'IMG' && !el.hasAttribute('fetchpriority')) { el.setAttribute('fetchpriority', 'low'); added.push('fetchpriority'); changed = true; }
        if (added.length) injectedLazyAttrs.set(el, added);
        processedImagesLazy.add(el);
      }
      if (settings.imageLowQualityEnabled && (tag === 'IMG' || tag === 'SOURCE') && el.hasAttribute('srcset')) {
        if (!imageOriginalSrcset.has(el)) {
          imageOriginalSrcset.set(el, {
            srcset: el.getAttribute('srcset'),
            sizes: el.getAttribute('sizes') || ''
          });
        }
        if (tag === 'IMG' && !el.hasAttribute('src')) {
          const fallback = smallestSrcsetCandidate(el.getAttribute('srcset'));
          if (fallback) {
            el.setAttribute('src', fallback);
            injectedFallbackSrc.add(el);
          }
        }
        el.removeAttribute('srcset');
        el.removeAttribute('sizes');
        changed = true;
        processedImagesQuality.add(el);
      }
      return changed;
    } catch (e) { return false; }
  }

  function applyImageLazyAll(root) {
    if (!root) return false;
    let count = 0;
    const nodes = deepQueryAll(root, 'img, iframe, source');
    for (const n of nodes) {
      // Bug 3 — only skip a node once it's been processed under BOTH of the
      // currently-enabled features; a node marked done for one feature must
      // still fall through to lazifyImage when the other feature is newly on.
      const lazyDone = !settings.imageLazyEnabled || processedImagesLazy.has(n);
      const qualityDone = !settings.imageLowQualityEnabled || processedImagesQuality.has(n);
      if (lazyDone && qualityDone) continue;
      if (lazifyImage(n)) count++;
    }
    if (count) reportStat('imagesLazied', count);
    return count > 0;
  }

  function restoreImageQuality() {
    const nodes = deepQueryAll(document, 'img, source');
    for (const n of nodes) {
      const orig = imageOriginalSrcset.get(n);
      if (orig) {
        try {
          if (orig.srcset) n.setAttribute('srcset', orig.srcset);
          if (orig.sizes) n.setAttribute('sizes', orig.sizes);
          if (n.tagName === 'IMG' && injectedFallbackSrc.has(n)) {
            n.removeAttribute('src');
            injectedFallbackSrc.delete(n);
          }
        } catch (e) {}
        imageOriginalSrcset.delete(n);
      }
      // Clear the quality-specific marker so a later re-enable of
      // imageLowQualityEnabled reprocesses this element instead of being
      // skipped by applyImageLazyAll's per-feature "already done" check.
      processedImagesQuality.delete(n);
    }
  }

  function restoreImageLazyAttrs() {
    // Bug 28 — loading/decoding/fetchpriority set by lazifyImage() were never
    // removed on toggle-off. Only remove attributes Potatofy itself injected
    // (tracked in injectedLazyAttrs); attributes the page already had are
    // left untouched.
    const nodes = deepQueryAll(document, 'img, iframe');
    for (const n of nodes) {
      const added = injectedLazyAttrs.get(n);
      if (added) {
        try {
          for (const attr of added) n.removeAttribute(attr);
        } catch (e) {}
        injectedLazyAttrs.delete(n);
      }
      processedImagesLazy.delete(n);
    }
  }

  // ---------- Prefetch / preconnect stripping ----------

  const processedLinks = new WeakSet();
  const PREFETCH_RELS = new Set(['preload', 'prefetch', 'preconnect', 'dns-prefetch', 'modulepreload', 'prerender']);

  function stripPrefetchLink(el) {
    if (!el || processedLinks.has(el) || el.tagName !== 'LINK') return false;
    // rel is a space-separated token list (e.g. "preload prefetch"); matching
    // the whole trimmed string against PREFETCH_RELS missed any link with
    // more than one token.
    const relTokens = (el.getAttribute('rel') || '').toLowerCase().trim().split(/\s+/);
    const isPrefetchy = relTokens.some(t => PREFETCH_RELS.has(t));
    if (isPrefetchy) {
      if (!el.parentNode) return false; // detached — leave unprocessed so a
                                         // later re-attach still gets stripped
      try {
        el.parentNode.removeChild(el);
        // L-1 — only mark processed after a successful removal, so a throwing
        // removeChild doesn't permanently skip an element still in the DOM.
        processedLinks.add(el);
        return true;
      } catch (e) { return false; }
    }
    // Non-prefetch link: mark processed so we don't re-inspect it every pass.
    processedLinks.add(el);
    return false;
  }

  function applyPrefetchStripAll(root) {
    if (!root) return;
    let count = 0;
    const nodes = deepQueryAll(root, 'link[rel]');
    for (const n of nodes) if (stripPrefetchLink(n)) count++;
    if (count) reportStat('prefetchStripped', count);
  }

  // ---------- Autoplay killer ----------

  const processedMedia = new WeakSet();

  function killAutoplay(el) {
    if (!el || processedMedia.has(el)) return false;
    const tag = el.tagName;
    if (tag !== 'VIDEO' && tag !== 'AUDIO') return false;
    processedMedia.add(el);
    try {
      let changed = false;
      if (el.hasAttribute('autoplay')) { el.removeAttribute('autoplay'); changed = true; }
      if (tag === 'AUDIO' && el.getAttribute('preload') !== 'none') {
        el.setAttribute('preload', 'none'); changed = true;
      }
      return changed;
    } catch (e) { return false; }
  }

  function killAutoplayAll(root) {
    if (!root) return false;
    let count = 0;
    const nodes = deepQueryAll(root, 'video, audio');
    for (const n of nodes) if (killAutoplay(n)) count++;
    if (count) reportStat('autoplayKilled', count);
    return count > 0;
  }

  // ---------- Mutation observer (P1: narrowed, idle-deferred, auto-disconnect) ----------

  let observer = null;
  let observerIdleCount = 0;
  // L-6 — raised from 20 (~10s). An always-visible, low-mutation tab (a static
  // article that later lazy-inserts images/videos) would otherwise disconnect
  // the observer permanently after ~10s and miss every late-inserted element,
  // since startObserver only re-fires on a visibility change or settings update.
  // A higher ceiling keeps the observer alive long enough to catch deferred
  // content while still releasing it on genuinely static pages.
  const OBSERVER_DISCONNECT_AFTER = 600; // ~5 min of idle ticks

  // H-3 — `snap` is a snapshot of the relevant feature flags captured at
  // MutationObserver-callback time and passed straight into processMutations
  // (BUG-49/30 — no longer deferred via requestIdleCallback; see startObserver).
  // Using a frozen snapshot rather than reading live `settings` keeps each
  // batch internally consistent even though it's processed synchronously.
  function processMutations(mutations, snap) {
    let relevant = false;
    for (const m of mutations) {
      if (m.type === 'attributes') {
        // SPAs frequently recycle DOM nodes by mutating an EXISTING element's
        // src/srcset/rel/autoplay in place rather than inserting a new node —
        // childList-only observation misses these entirely.
        const target = m.target;
        if (!target || target.nodeType !== 1) continue;
        relevant = true;
        const tag = target.tagName;
        const attr = m.attributeName;
        if ((snap.imageLazyEnabled || snap.imageLowQualityEnabled) &&
            (attr === 'src' || attr === 'srcset') &&
            (tag === 'IMG' || tag === 'IFRAME' || tag === 'SOURCE')) {
          if (lazifyImage(target)) reportStat('imagesLazied', 1);
        } else if (snap.prefetchStripEnabled && attr === 'rel' && tag === 'LINK') {
          // A rel change can turn a previously-inspected link into a
          // prefetch one (or vice versa) — clear the processed flag so it's
          // re-evaluated instead of being skipped forever.
          processedLinks.delete(target);
          if (stripPrefetchLink(target)) reportStat('prefetchStripped', 1);
        } else if (snap.autoplayKillEnabled && attr === 'autoplay' && (tag === 'VIDEO' || tag === 'AUDIO')) {
          processedMedia.delete(target);
          if (killAutoplay(target)) reportStat('autoplayKilled', 1);
        }
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        relevant = true;
        const tag = node.tagName;

        // PERF-06 — only descend into added subtrees that actually have element
        // children (or a shadow root, which won't show up in .children). A leaf
        // node (<span>, a text wrapper) has neither, so a deep query would scan
        // for nothing; the guard skips that cost on highly dynamic pages (React
        // re-renders, infinite scroll).
        const hasKids = (node.children && node.children.length > 0) || !!node.shadowRoot;

        if (snap.imageLazyEnabled || snap.imageLowQualityEnabled) {
          if (tag === 'IMG' || tag === 'IFRAME' || tag === 'SOURCE') {
            if (lazifyImage(node)) reportStat('imagesLazied', 1);
          } else if (hasKids) {
            applyImageLazyAll(node);
          }
        }
        if (snap.prefetchStripEnabled) {
          if (tag === 'LINK') {
            if (stripPrefetchLink(node)) reportStat('prefetchStripped', 1);
          } else if (hasKids) {
            applyPrefetchStripAll(node);
          }
        }
        // QA-13 — read live isHidden() here, NOT the snapshotted snap.hidden.
        // The observer callback can still be delivered slightly after a
        // visibility flip; the stale snapshot would otherwise pause
        // freshly-inserted videos on a now-foreground tab.
        if (snap.videoPauseEnabled && isHidden()) {
          if (tag === 'VIDEO') {
            if (pauseVideoNode(node)) reportStat('videosPaused', 1);
          } else if (hasKids) {
            pauseAllVideos(node);
          }
        }
        if (snap.videoPreloadNoneEnabled) {
          if (tag === 'VIDEO') {
            if (applyVideoPreloadNone(node)) reportStat('videosPreloadNoned', 1);
          } else if (hasKids) applyVideoPreloadNoneAll(node);
        }
        if (snap.autoplayKillEnabled) {
          if (tag === 'VIDEO' || tag === 'AUDIO') {
            if (killAutoplay(node)) reportStat('autoplayKilled', 1);
          } else if (hasKids) {
            killAutoplayAll(node);
          }
        }
      }
    }
    if (relevant) observerIdleCount = 0;
    else observerIdleCount++;
    if (observerIdleCount >= OBSERVER_DISCONNECT_AFTER) {
      stopObserver();
    }
  }

  function startObserver() {
    // BUG-10 — reset before the early return so a startObserver() call while
    // an observer is already attached (repeated applyAll() from a settings
    // update, or a visibilitychange firing while already observing) still
    // refreshes the idle counter instead of leaving it to accumulate toward
    // OBSERVER_DISCONNECT_AFTER from its prior value.
    observerIdleCount = 0;
    if (observer) return;
    const target = document.body || document.documentElement;
    if (!target) return;
    observer = new MutationObserver((mutations) => {
      // BUG-49/30 — process synchronously right here instead of deferring via
      // requestIdleCallback (up to 500ms). The deferral widened the window
      // during which a newly-inserted element (prefetch link, autoplay video,
      // eager img fetch) could dispatch its network request before mitigation
      // ran, and it let a stale `snap` re-apply a since-disabled feature if
      // settings changed (and applyAll() cleanup ran) during the deferred wait.
      // Visibility is intentionally NOT snapshotted — processMutations reads
      // isHidden() live so a callback delivered after the tab is shown again
      // can't act on stale state (QA-13).
      const snap = {
        imageLazyEnabled:        settings.imageLazyEnabled,
        imageLowQualityEnabled:  settings.imageLowQualityEnabled,
        prefetchStripEnabled:    settings.prefetchStripEnabled,
        videoPauseEnabled:       settings.videoPauseEnabled,
        videoPreloadNoneEnabled: settings.videoPreloadNoneEnabled,
        autoplayKillEnabled:     settings.autoplayKillEnabled
      };
      processMutations(mutations, snap);
    });
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'rel', 'autoplay']
    });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // anyContentFeatureEnabled() covers only features that need a MutationObserver
  // to keep applying to new DOM nodes. Excludes throttle (visibility-driven, no
  // DOM scan), animationKill (one-shot stylesheet), and siteKillers (one-shot
  // stylesheet). Asymmetric with anyFeatureEnabled() by design; a new feature
  // that mutates per-element MUST be added here too or it won't apply to DOM
  // nodes added after page load.

  function anyContentFeatureEnabled() {
    return (
      settings.imageLazyEnabled ||
      settings.imageLowQualityEnabled ||
      settings.prefetchStripEnabled ||
      settings.videoPauseEnabled ||
      settings.videoPreloadNoneEnabled ||
      settings.autoplayKillEnabled
    );
  }

  // ---------- Apply / sync feature flags ----------

  function applyAll() {
    // Keep main-throttle.js (MAIN world) in sync with the current setting on
    // every settings change, including the teardown path below.
    postThrottleState();

    if (!anyFeatureEnabled()) {
      restoreImageQuality();
      restoreImageLazyAttrs();
      restoreVideoPlayability(document);
      removeAnimationKill();
      removeSiteKillers();
      stopObserver();
      return;
    }
    ensureVisibilityListener();

    if (settings.animationKillEnabled) applyAnimationKill();
    else removeAnimationKill();
    if (settings.siteKillersEnabled && settings.siteKillers.length > 0) applySiteKillers();
    else removeSiteKillers();

    // L-3 — only walk the document when an image-modifying feature is actually
    // on. restoreImageQuality is a cheap no-op when the WeakMap is empty, so we
    // avoid the apply-then-immediately-restore churn that ran every applyAll.
    if (settings.imageLazyEnabled || settings.imageLowQualityEnabled) applyImageLazyAll(document);
    if (!settings.imageLowQualityEnabled) restoreImageQuality();
    if (!settings.imageLazyEnabled) restoreImageLazyAttrs();
    if (settings.prefetchStripEnabled) applyPrefetchStripAll(document);
    if (settings.autoplayKillEnabled) killAutoplayAll(document);

    // Per-toggle restore paths (mirroring the imageLowQualityEnabled pattern
    // above) — previously restoreVideoPlayability/restoreVideoPreloadNone were
    // only called in the full-teardown branch, so disabling just ONE of these
    // two toggles while another feature stayed on left affected videos
    // permanently paused / stuck at preload="none" for the rest of the session.
    if (settings.videoPauseEnabled) {
      if (isHidden()) pauseAllVideos(document);
    } else {
      restoreVideoPlayability(document);
    }
    if (settings.videoPreloadNoneEnabled) applyVideoPreloadNoneAll(document);
    else restoreVideoPreloadNone(document);

    if (anyContentFeatureEnabled()) startObserver(); else stopObserver();
  }

  function ingestDetail(detail) {
    if (!detail) return;
    // QUALITY-05 — derive the boolean flags from the `settings` object's own keys,
    // so adding a content toggle only means adding it to the `settings` initializer
    // (and the gate helpers). siteKillers is the lone non-boolean field.
    for (const k of Object.keys(settings)) {
      if (k === 'siteKillers') continue;
      settings[k] = !!detail[k];
    }
    settings.siteKillers = Array.isArray(detail.siteKillers) ? detail.siteKillers : [];
  }

  // ---------- chrome.runtime channel (1.1.2 — replaces CustomEvent bus) ----------

  // Bug 31 — true while init()'s GET_CONTENT_SETTINGS request is still in
  // flight. If a live POTATOFY_SETTINGS_UPDATE arrives and is applied before
  // that request resolves, it clears this flag so init()'s later-resolving
  // (and now-stale) reply is discarded instead of overwriting the fresher
  // live settings.
  let pendingInitRequest = true;

  async function init() {
    try {
      const reply = await chrome.runtime.sendMessage({
        type: 'GET_CONTENT_SETTINGS',
        host: location.hostname
      });
      if (reply && reply.ok && reply.detail && pendingInitRequest) {
        ingestDetail(reply.detail);
        applyAll();
      }
    } catch (e) {
      // SW unreachable (e.g. install/uninstall race). Page runs with defaults.
    } finally {
      pendingInitRequest = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'POTATOFY_SETTINGS_UPDATE') return;
    if (!msg.detail) return;
    pendingInitRequest = false;
    ingestDetail(msg.detail);
    applyAll();
  });

  // ========== Phase 2: Bandwidth Calibration ==========
  // Collect real resource sizes for bandwidth calibration

  const resourceStats = {
    trackers: [],
    fonts: [],
    scripts: [],
    images: []
  };

  // Hostname-anchored (not substring) tracker domain match — a bare
  // `facebook\.com` substring check against the full URL false-positived on
  // hosts like "cdn.notfacebook.com". `(^|\.)host$` requires an exact host or
  // a proper subdomain of it.
  const TRACKER_HOST_RE = /(^|\.)(google-analytics\.com|googletagmanager\.com|facebook\.com|segment\.com|mixpanel\.com|amplitude\.com|hotjar\.com|intercom\.io|drift\.com)$/i;
  const FONT_HOST_RE = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/i;
  const FONT_EXT_RE = /\.(woff2?|ttf|otf)$/i;
  const SCRIPT_EXT_RE = /\.js$/i;
  const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp|svg|ico)$/i;

  function initResourceObserver() {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const url = entry.name;
          // Bug 72 — the old `if (entry.transferSize === 0) continue;` guard
          // ran BEFORE this decodedBodySize fallback could ever be reached,
          // so any 0-transferSize entry (e.g. a disk-cache hit, which still
          // reports a real decodedBodySize) was dropped even though a valid
          // size was available right here.
          const size = entry.transferSize || entry.decodedBodySize || 0;
          if (size === 0) continue; // no size available at all — skip

          let hostname = '', pathname = '';
          try {
            const u = new URL(url);
            hostname = u.hostname;
            pathname = u.pathname; // excludes query string / hash, unlike matching the raw url
          } catch (e) { continue; }

          if (TRACKER_HOST_RE.test(hostname)) {
            if (resourceStats.trackers.length < 500) resourceStats.trackers.push(size);
          } else if (FONT_EXT_RE.test(pathname) || FONT_HOST_RE.test(hostname)) {
            if (resourceStats.fonts.length < 500) resourceStats.fonts.push(size);
          } else if (SCRIPT_EXT_RE.test(pathname)) {
            if (resourceStats.scripts.length < 500) resourceStats.scripts.push(size);
          } else if (IMAGE_EXT_RE.test(pathname)) {
            if (resourceStats.images.length < 500) resourceStats.images.push(size);
          }
        }
      });

      observer.observe({ type: 'resource', buffered: true });
    } catch (e) {
      // PerformanceObserver not available or failed
    }
  }

  function sendCalibrationData() {
    if (!IS_TOP_FRAME) return; // dedupe across same-origin iframes
    if (!Object.values(resourceStats).some(arr => arr.length > 0)) return;

    const calibration = {
      trackers: median(resourceStats.trackers),
      fonts: median(resourceStats.fonts),
      scripts: median(resourceStats.scripts),
      images: median(resourceStats.images),
    };

    // Snapshot which arrays had data so only those get cleared, and only once
    // the send actually lands — clearing unconditionally beforehand dropped
    // the whole batch for good whenever the SW was unreachable (e.g. mid-
    // suspend), instead of letting it ride to the next 30s interval.
    const hadData = {
      trackers: resourceStats.trackers.length > 0,
      fonts: resourceStats.fonts.length > 0,
      scripts: resourceStats.scripts.length > 0,
      images: resourceStats.images.length > 0
    };

    chrome.runtime.sendMessage({
      type: 'CALIBRATE_BANDWIDTH',
      data: calibration
    }).then(() => {
      if (hadData.trackers) resourceStats.trackers = [];
      if (hadData.fonts)    resourceStats.fonts = [];
      if (hadData.scripts)  resourceStats.scripts = [];
      if (hadData.images)   resourceStats.images = [];
    }).catch(() => {}); // leave buffers intact so the next interval retries
  }

  // Median helper (local copy for IIFE context; lib version used by service-worker.js)
  function median(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Phase 2/3 calibration is top-frame-only (sendCalibrationData returns early
  // in sub-frames). Guarding the setInterval and observer here avoids creating
  // a dormant 30-second timer in every iframe on pages like YouTube.
  if (IS_TOP_FRAME) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initResourceObserver);
    } else {
      initResourceObserver();
    }

    _setInterval(sendCalibrationData, 30000); // Send every 30 seconds
  }

  // PERF-01 — the former Phase 3 heap-measurement path (performance.memory
  // deltas) was removed. performance.memory is deprecated, Chrome-only, and
  // bucketed for privacy, and the Math.max(0, before - after) delta misattributed
  // unrelated GC drops to features, inflating the RAM-saved figure. Savings now
  // use the real tab-discard measurement plus conservative heuristic weights only.

  // N-1 — guard the call site so a synchronous throw (e.g. chrome.runtime
  // unavailable mid-load) can't surface as an unhandled rejection.
  init().catch(() => {});
})();
