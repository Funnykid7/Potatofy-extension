(function () {
  // Saved originals — must be captured before any page script can override them.
  const _setTimeout = window.setTimeout.bind(window);
  const _requestAnimationFrame = (window.requestAnimationFrame || function () { return 0; }).bind(window);
  const _cancelAnimationFrame = (window.cancelAnimationFrame || function () {}).bind(window);
  const _requestIdleCallback = (window.requestIdleCallback || function (cb) { return _setTimeout(cb, 1); }).bind(window);

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
  // Universal selector used as a combinator target (e.g. `div > *`, `ul *`):
  const UNIVERSAL_COMBINATOR_RE = /(?:^|[>+~\s])\s*\*(?:[^=\w\-]|$)/;
  // Selectors whose LEADING token is a document-root element — targets like
  // `body > div` or `html .foo` select essentially the entire page structure:
  const BLOCKED_LEADING_RE = /^(?:body|html|head|:root)\b/i;

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
  let throttleActive = false;
  let visibilityListenerAttached = false;

  // ---------- Stats bridge (debounced) ----------
  // 1.1.2: stats go directly to the service worker via chrome.runtime. The
  // old window.dispatchEvent('__potatofy_stat') path was observable by page
  // scripts and is removed. chrome.runtime in MAIN-world content scripts is
  // closure-scoped and not reachable from page-script JS.

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
      statFlushTimer = null;
      const patch = {};
      for (const k of Object.keys(statBuffer)) {
        const v = statBuffer[k];
        statBuffer[k] = 0;
        if (Number.isFinite(v) && v > 0) patch[k] = Math.min(Math.floor(v), MAX_INCREMENT);
      }
      if (Object.keys(patch).length === 0) return;
      try {
        chrome.runtime.sendMessage({ type: 'STATS_INCREMENT', patch });
      } catch (e) {}
    }, 1000);
  }

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

  // ---------- Throttle (B7 + A7 hardening) ----------
  // Only one-shot work is suppressed on hidden tabs: setTimeout and rAF.
  // C-1 — setInterval is intentionally NOT shadowed. Suppressing a repeating
  // timer permanently dropped it (there was no replay path), which silently
  // broke background polling loops (webmail refresh, chat heartbeats, SPA
  // pollers started while the tab was hidden). Chrome already throttles
  // background interval timers to ~1/minute on its own, so the marginal extra
  // savings weren't worth the correctness loss.
  //
  // C-2 — suppressed rAF IDs are NEGATIVE descending integers. Real
  // requestAnimationFrame IDs are positive longs starting at 1, so a negative
  // ID can never collide with a real one; shadowedCancelAnimationFrame can
  // therefore safely forward unknown IDs to the native cancel.
  //
  // 1.1.3 — suppressed setTimeout IDs still come from a randomised high base
  // so the old fixed 0x7FFF0000 sentinel (a trivial extension fingerprint /
  // visibility oracle) is gone. The base lives in the upper 30 bits, well
  // above any realistic real timer ID, but unpredictable per page load.
  const SENTINEL_BASE = ((Math.random() * 0x3FFFFFFF) | 0) + 0x40000000;
  let rafCounter = 0;               // decremented → negative, native-disjoint
  let suppressedTimerCounter = SENTINEL_BASE;
  const pendingRaf = new Map();
  // N-4 — cap so a tight rAF loop on a long-hidden tab can't grow the Map
  // without bound (and can't cause a giant drain burst on un-hide).
  const MAX_PENDING_RAF = 240;

  function shadowedSetTimeout(fn, delay, ...args) {
    if (isHidden() && settings.jsThrottleEnabled) return ++suppressedTimerCounter;
    return _setTimeout(fn, delay, ...args);
  }
  function shadowedRequestAnimationFrame(cb) {
    if (isHidden() && settings.jsThrottleEnabled) {
      const id = --rafCounter;
      pendingRaf.set(id, cb);
      if (pendingRaf.size > MAX_PENDING_RAF) {
        // Drop the oldest queued callback (Map preserves insertion order).
        const oldest = pendingRaf.keys().next().value;
        pendingRaf.delete(oldest);
      }
      return id;
    }
    return _requestAnimationFrame(cb);
  }
  function shadowedCancelAnimationFrame(id) {
    if (pendingRaf.delete(id)) return;
    _cancelAnimationFrame(id);
  }

  function drainPendingRaf() {
    if (pendingRaf.size === 0) return;
    const snapshot = Array.from(pendingRaf.entries());
    pendingRaf.clear();
    for (const [, cb] of snapshot) {
      try { _requestAnimationFrame(cb); } catch (e) {}
    }
  }

  function applyThrottle() {
    if (throttleActive) return;
    throttleActive = true;
    window.setTimeout = shadowedSetTimeout;
    window.requestAnimationFrame = shadowedRequestAnimationFrame;
    window.cancelAnimationFrame = shadowedCancelAnimationFrame;
  }

  function restoreOriginals() {
    if (!throttleActive) return;
    throttleActive = false;
    window.setTimeout = _setTimeout;
    window.requestAnimationFrame = _requestAnimationFrame;
    window.cancelAnimationFrame = _cancelAnimationFrame;
    // H-1 — only replay queued rAF callbacks when the tab is actually visible.
    // Draining into a still-hidden tab schedules them onto the native rAF,
    // which Chrome has suspended, so they'd be lost. Leave them queued; the
    // visibilitychange handler drains them on the real transition to visible.
    if (!isHidden()) drainPendingRaf();
  }

  function handleVisibilityChange() {
    if (settings.jsThrottleEnabled) {
      if (isHidden()) applyThrottle(); else restoreOriginals();
    }
    // H-1 — always replay any rAF callbacks that were queued while hidden once
    // the tab is visible again, even if throttle was disabled in the meantime
    // (in which case restoreOriginals already ran and left them queued).
    if (!isHidden()) drainPendingRaf();
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
    if (!root || !root.querySelectorAll) return;
    let count = 0;
    const nodes = root.querySelectorAll('video');
    for (const n of nodes) if (pauseVideoNode(n)) count++;
    if (count) reportStat('videosPaused', count);
  }

  function restoreVideoPlayability(root) {
    if (!root || !root.querySelectorAll) return;
    const nodes = root.querySelectorAll('video');
    for (const n of nodes) {
      try {
        pausePreloadedVideos.delete(n);
        maybeRestorePreload(n);     // honors a still-active videoPreloadNone
        n[POTATO_PAUSED_KEY] = false;
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
    if (!root || !root.querySelectorAll) return;
    let count = 0;
    const nodes = root.querySelectorAll('video');
    for (const n of nodes) if (applyVideoPreloadNone(n)) count++;
    // 1.1.2: dedicated counter so the popup can attribute savings to the
    // correct toggle. Previously folded into videosPaused which misled users
    // about which feature was contributing.
    if (count) reportStat('videosPreloadNoned', count);
  }

  // ---------- Animation killer ----------

  let killStyleEl = null;
  let pageHadAnimations = false;

  function pageHasAnimations() {
    try {
      if (typeof document.getAnimations === 'function' && document.getAnimations().length > 0) {
        return true;
      }
    } catch (e) {}
    try {
      const sheets = document.styleSheets;
      for (const sheet of sheets) {
        let rules;
        try { rules = sheet.cssRules; } catch (e) { continue; } // cross-origin
        if (!rules) continue;
        for (const rule of rules) {
          if (rule.type === CSSRule.KEYFRAMES_RULE) return true;
        }
      }
    } catch (e) {}
    return false;
  }

  function applyAnimationKill() {
    if (killStyleEl) return;
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
    if (siteKillerStyleEl || !settings.siteKillersEnabled || settings.siteKillers.length === 0) return;
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
      // SEC-1 (a): comma = compound selector; each entry must be a single rule
      // so `"div.ad, body"` can't smuggle a blocked token past per-entry checks.
      if (t.includes(',')) return false;
      // SEC-1 (b): bare [attr] presence anywhere (catches tag-prefixed forms).
      if (BARE_ATTR_RE.test(t)) return false;
      // SEC-1 (c): universal selector as a combinator target (`div > *`, `ul *`).
      if (UNIVERSAL_COMBINATOR_RE.test(t)) return false;
      // SEC-1 (d): leading document-root token (`body > div`, `html .foo`).
      if (BLOCKED_LEADING_RE.test(t)) return false;
      try { document.querySelector(s); return true; } catch (e) { return false; }
    });
    if (selectors.length === 0) return;
    const css = selectors.join(',\n') + ' { display: none !important; }';
    const insert = () => {
      if (siteKillerStyleEl) return;
      siteKillerStyleEl = document.createElement('style');
      siteKillerStyleEl.setAttribute(POTATO_ATTR, 'site-killer');
      siteKillerStyleEl.textContent = css;
      (document.head || document.documentElement).appendChild(siteKillerStyleEl);
      reportStat('siteKillerHits', 1);
    };
    if (document.head || document.documentElement) insert();
    else document.addEventListener('DOMContentLoaded', insert, { once: true });
  }

  function removeSiteKillers() {
    if (siteKillerStyleEl && siteKillerStyleEl.parentNode) {
      siteKillerStyleEl.parentNode.removeChild(siteKillerStyleEl);
    }
    siteKillerStyleEl = null;
  }

  // ---------- Image lite (B1: restore srcset on toggle-off) ----------

  const processedImages = new WeakSet();
  // Stores { srcset, sizes } captured before stripping so we can restore the
  // original quality if the user disables imageLowQualityEnabled mid-session.
  const imageOriginalSrcset = new WeakMap();

  function lazifyImage(el) {
    if (!el) return false;
    if (el.tagName !== 'IMG' && el.tagName !== 'IFRAME') return false;
    try {
      let changed = false;
      if (settings.imageLazyEnabled) {
        if (!el.hasAttribute('loading')) { el.setAttribute('loading', 'lazy'); changed = true; }
        if (el.tagName === 'IMG' && !el.hasAttribute('decoding')) { el.setAttribute('decoding', 'async'); changed = true; }
        if (el.tagName === 'IMG' && !el.hasAttribute('fetchpriority')) { el.setAttribute('fetchpriority', 'low'); changed = true; }
      }
      if (settings.imageLowQualityEnabled && el.tagName === 'IMG' && el.hasAttribute('srcset')) {
        if (!imageOriginalSrcset.has(el)) {
          imageOriginalSrcset.set(el, {
            srcset: el.getAttribute('srcset'),
            sizes: el.getAttribute('sizes') || ''
          });
        }
        el.removeAttribute('srcset');
        el.removeAttribute('sizes');
        changed = true;
      }
      processedImages.add(el);
      return changed;
    } catch (e) { return false; }
  }

  function applyImageLazyAll(root) {
    if (!root || !root.querySelectorAll) return;
    let count = 0;
    const nodes = root.querySelectorAll('img, iframe');
    for (const n of nodes) {
      if (processedImages.has(n)) continue;
      if (lazifyImage(n)) count++;
    }
    if (count) reportStat('imagesLazied', count);
  }

  function restoreImageQuality() {
    if (!document.querySelectorAll) return;
    const nodes = document.querySelectorAll('img');
    for (const n of nodes) {
      const orig = imageOriginalSrcset.get(n);
      if (!orig) continue;
      try {
        if (orig.srcset) n.setAttribute('srcset', orig.srcset);
        if (orig.sizes) n.setAttribute('sizes', orig.sizes);
      } catch (e) {}
      imageOriginalSrcset.delete(n);
    }
  }

  // ---------- Prefetch / preconnect stripping ----------

  const processedLinks = new WeakSet();
  const PREFETCH_RELS = new Set(['preload', 'prefetch', 'preconnect', 'dns-prefetch', 'modulepreload', 'prerender']);

  function stripPrefetchLink(el) {
    if (!el || processedLinks.has(el) || el.tagName !== 'LINK') return false;
    const rel = (el.getAttribute('rel') || '').toLowerCase().trim();
    if (PREFETCH_RELS.has(rel)) {
      try {
        el.parentNode && el.parentNode.removeChild(el);
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
    if (!root || !root.querySelectorAll) return;
    let count = 0;
    const nodes = root.querySelectorAll('link[rel]');
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
    if (!root || !root.querySelectorAll) return;
    let count = 0;
    const nodes = root.querySelectorAll('video, audio');
    for (const n of nodes) if (killAutoplay(n)) count++;
    if (count) reportStat('autoplayKilled', count);
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
  // MutationObserver-callback time. The actual node processing runs later in a
  // requestIdleCallback tick; reading the live `settings` object there would
  // let a POTATOFY_SETTINGS_UPDATE arriving in between flip behavior mid-batch
  // (e.g. lazify nodes after the feature was just disabled). Using the frozen
  // snapshot keeps each batch consistent with the settings at observation time.
  function processMutations(mutations, snap) {
    let relevant = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        relevant = true;
        const tag = node.tagName;

        if (snap.imageLazyEnabled || snap.imageLowQualityEnabled) {
          if (tag === 'IMG' || tag === 'IFRAME') {
            if (lazifyImage(node)) reportStat('imagesLazied', 1);
          } else if (node.querySelectorAll) {
            applyImageLazyAll(node);
          }
        }
        if (snap.prefetchStripEnabled) {
          if (tag === 'LINK') {
            if (stripPrefetchLink(node)) reportStat('prefetchStripped', 1);
          } else if (node.querySelectorAll) {
            applyPrefetchStripAll(node);
          }
        }
        if (snap.videoPauseEnabled && snap.hidden) {
          if (tag === 'VIDEO') {
            if (pauseVideoNode(node)) reportStat('videosPaused', 1);
          } else if (node.querySelectorAll) {
            pauseAllVideos(node);
          }
        }
        if (snap.videoPreloadNoneEnabled) {
          if (tag === 'VIDEO') applyVideoPreloadNone(node);
          else if (node.querySelectorAll) applyVideoPreloadNoneAll(node);
        }
        if (snap.autoplayKillEnabled) {
          if (tag === 'VIDEO' || tag === 'AUDIO') {
            if (killAutoplay(node)) reportStat('autoplayKilled', 1);
          } else if (node.querySelectorAll) {
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
    if (observer) return;
    const target = document.body || document.documentElement;
    if (!target) return;
    observerIdleCount = 0;
    observer = new MutationObserver((mutations) => {
      // Snapshot feature flags + visibility now, before the deferred tick.
      const snap = {
        imageLazyEnabled:        settings.imageLazyEnabled,
        imageLowQualityEnabled:  settings.imageLowQualityEnabled,
        prefetchStripEnabled:    settings.prefetchStripEnabled,
        videoPauseEnabled:       settings.videoPauseEnabled,
        videoPreloadNoneEnabled: settings.videoPreloadNoneEnabled,
        autoplayKillEnabled:     settings.autoplayKillEnabled,
        hidden:                  isHidden()
      };
      _requestIdleCallback(() => processMutations(mutations, snap), { timeout: 500 });
    });
    observer.observe(target, { childList: true, subtree: true });
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
    if (!anyFeatureEnabled()) {
      restoreOriginals();
      removeAnimationKill();
      removeSiteKillers();
      stopObserver();
      return;
    }
    ensureVisibilityListener();

    if (settings.animationKillEnabled) {
      applyAnimationKill();
      measureHeapDelta('animationsKilled');
    } else removeAnimationKill();
    if (settings.siteKillersEnabled && settings.siteKillers.length > 0) {
      applySiteKillers();
      measureHeapDelta('siteKillerHits');
    } else removeSiteKillers();

    // L-3 — only walk the document when an image-modifying feature is actually
    // on. restoreImageQuality is a cheap no-op when the WeakMap is empty, so we
    // avoid the apply-then-immediately-restore churn that ran every applyAll.
    if (settings.imageLazyEnabled || settings.imageLowQualityEnabled) {
      applyImageLazyAll(document);
      measureHeapDelta('imagesLazied');
    }
    if (!settings.imageLowQualityEnabled) restoreImageQuality();
    if (settings.prefetchStripEnabled) applyPrefetchStripAll(document);
    if (settings.autoplayKillEnabled) {
      killAutoplayAll(document);
      measureHeapDelta('autoplayKilled');
    }
    if (settings.videoPreloadNoneEnabled) {
      applyVideoPreloadNoneAll(document);
      measureHeapDelta('videosPreloadNoned');
    }
    if (settings.videoPauseEnabled && isHidden()) {
      pauseAllVideos(document);
      measureHeapDelta('videosPaused');
    }

    if (anyContentFeatureEnabled()) startObserver(); else stopObserver();

    if (settings.jsThrottleEnabled) {
      if (isHidden()) applyThrottle();
    } else {
      restoreOriginals();
    }
  }

  function ingestDetail(detail) {
    if (!detail) return;
    settings.jsThrottleEnabled       = !!detail.jsThrottleEnabled;
    settings.imageLazyEnabled        = !!detail.imageLazyEnabled;
    settings.imageLowQualityEnabled  = !!detail.imageLowQualityEnabled;
    settings.animationKillEnabled    = !!detail.animationKillEnabled;
    settings.autoplayKillEnabled     = !!detail.autoplayKillEnabled;
    settings.prefetchStripEnabled    = !!detail.prefetchStripEnabled;
    settings.videoPauseEnabled       = !!detail.videoPauseEnabled;
    settings.videoPreloadNoneEnabled = !!detail.videoPreloadNoneEnabled;
    settings.siteKillersEnabled      = !!detail.siteKillersEnabled;
    settings.siteKillers             = Array.isArray(detail.siteKillers) ? detail.siteKillers : [];
  }

  // ---------- chrome.runtime channel (1.1.2 — replaces CustomEvent bus) ----------

  async function init() {
    try {
      const reply = await chrome.runtime.sendMessage({
        type: 'GET_CONTENT_SETTINGS',
        host: location.hostname
      });
      if (reply && reply.ok && reply.detail) {
        ingestDetail(reply.detail);
        applyAll();
      }
    } catch (e) {
      // SW unreachable (e.g. install/uninstall race). Page runs with defaults.
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'POTATOFY_SETTINGS_UPDATE') return;
    if (!msg.detail) return;
    ingestDetail(msg.detail);
    applyAll();
  });

  // ========== Phase 2: Bandwidth Calibration ==========
  // Collect real resource sizes for bandwidth calibration

  const resourceStats = {
    trackers: [],
    ads: [],
    fonts: [],
    scripts: [],
    images: []
  };

  function initResourceObserver() {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.transferSize === 0) continue; // Cached, skip
          const url = entry.name;
          const size = entry.transferSize || entry.decodedBodySize || 0;
          if (size === 0) continue;

          if (/google-analytics|facebook\.com|segment\.com|mixpanel|amplitude|hotjar|intercom|drift/.test(url)) {
            resourceStats.trackers.push(size);
          } else if (/ads\.google|adswyzz|doubleclick|criteo|casalemedia|adform|appnexus|openx|rubiconproject|sonobi/.test(url)) {
            resourceStats.ads.push(size);
          } else if (/\.woff2?|\.ttf|\.otf|fonts\.googleapis|fonts\.gstatic/.test(url)) {
            resourceStats.fonts.push(size);
          } else if (/\.js$/.test(url)) {
            resourceStats.scripts.push(size);
          } else if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(url)) {
            resourceStats.images.push(size);
          }
        }
      });

      observer.observe({ entryTypes: ['resource'] });
    } catch (e) {
      // PerformanceObserver not available or failed
    }
  }

  function sendCalibrationData() {
    if (!Object.values(resourceStats).some(arr => arr.length > 0)) return;

    const calibration = {
      trackers: median(resourceStats.trackers),
      ads: median(resourceStats.ads),
      fonts: median(resourceStats.fonts),
      scripts: median(resourceStats.scripts),
      images: median(resourceStats.images),
      timestamp: Date.now(),
      counts: {
        trackers: resourceStats.trackers.length,
        ads: resourceStats.ads.length,
        fonts: resourceStats.fonts.length,
        scripts: resourceStats.scripts.length,
        images: resourceStats.images.length
      }
    };

    chrome.runtime.sendMessage({
      type: 'CALIBRATE_BANDWIDTH',
      data: calibration
    }).catch(() => {}); // Silent fail

    // Reset for next batch
    resourceStats.trackers = [];
    resourceStats.ads = [];
    resourceStats.fonts = [];
    resourceStats.scripts = [];
    resourceStats.images = [];
  }

  function median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initResourceObserver);
  } else {
    initResourceObserver();
  }

  setInterval(sendCalibrationData, 30000); // Send every 30 seconds

  // ========== Phase 3: Heap Memory Measurement ==========
  // Measure actual JS heap freed by content features (non-blocking, async)

  function measureHeapDelta(featureName) {
    if (!performance.memory) return; // Chrome only, non-standard API

    // Schedule measurement asynchronously to avoid blocking user interaction.
    // Note: GC timing is unpredictable; 200ms provides reasonable confidence but
    // measurements represent conservative lower bounds, not exact freed memory.
    setTimeout(() => {
      try {
        const heapBefore = performance.memory.usedJSHeapSize;

        // Wait for GC to complete (200ms accommodates most typical heap sizes)
        setTimeout(() => {
          try {
            const heapAfter = performance.memory.usedJSHeapSize;
            const freed = Math.max(0, heapBefore - heapAfter);

            if (freed > 0) {
              chrome.runtime.sendMessage({
                type: 'HEAP_MEASUREMENT',
                feature: featureName,
                freed: freed
              }).catch(() => {});
            }
          } catch (e) {
            // Silent fail
          }
        }, 200);
      } catch (e) {
        // Silent fail - measurement not available
      }
    }, 10);
  }

  // N-1 — guard the call site so a synchronous throw (e.g. chrome.runtime
  // unavailable mid-load) can't surface as an unhandled rejection.
  init().catch(() => {});
})();
