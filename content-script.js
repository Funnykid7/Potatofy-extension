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
  const _requestIdleCallback = (window.requestIdleCallback || function (cb) { return _setTimeout(cb, 1); }).bind(window);
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
      statFlushTimer = null;
      const patch = {};
      for (const k of Object.keys(statBuffer)) {
        const v = statBuffer[k];
        statBuffer[k] = 0;
        if (Number.isFinite(v) && v > 0) patch[k] = Math.min(Math.floor(v), MAX_INCREMENT);
      }
      if (Object.keys(patch).length === 0) return;
      chrome.runtime.sendMessage({ type: 'STATS_INCREMENT', patch }).catch(() => {});
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
      window.postMessage({ __ptfy: THROTTLE_MSG_TAG, jsThrottleEnabled: settings.jsThrottleEnabled }, location.origin);
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
    if (!root || !root.querySelectorAll) return false;
    let count = 0;
    const nodes = root.querySelectorAll('video');
    for (const n of nodes) if (pauseVideoNode(n)) count++;
    if (count) reportStat('videosPaused', count);
    return count > 0;
  }

  function restoreVideoPlayability(root) {
    if (!root || !root.querySelectorAll) return;
    const nodes = root.querySelectorAll('video');
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
    if (!root || !root.querySelectorAll) return false;
    let count = 0;
    const nodes = root.querySelectorAll('video');
    for (const n of nodes) if (applyVideoPreloadNone(n)) count++;
    // 1.1.2: dedicated counter so the popup can attribute savings to the
    // correct toggle. Previously folded into videosPaused which misled users
    // about which feature was contributing.
    if (count) reportStat('videosPreloadNoned', count);
    return count > 0;
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
    if (siteKillerStyleEl || !settings.siteKillersEnabled || settings.siteKillers.length === 0) return false;
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
    return true;
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
    if (!root || !root.querySelectorAll) return false;
    let count = 0;
    const nodes = root.querySelectorAll('img, iframe');
    for (const n of nodes) {
      if (processedImages.has(n)) continue;
      if (lazifyImage(n)) count++;
    }
    if (count) reportStat('imagesLazied', count);
    return count > 0;
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
    if (!root || !root.querySelectorAll) return false;
    let count = 0;
    const nodes = root.querySelectorAll('video, audio');
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

        // PERF-06 — only descend into added subtrees that actually have element
        // children. A leaf node (<span>, a text wrapper) has children.length === 0,
        // so querySelectorAll would scan for nothing; the guard skips that cost on
        // highly dynamic pages (React re-renders, infinite scroll).
        const hasKids = node.children && node.children.length > 0 && node.querySelectorAll;

        if (snap.imageLazyEnabled || snap.imageLowQualityEnabled) {
          if (tag === 'IMG' || tag === 'IFRAME') {
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
        // This callback runs in a deferred requestIdleCallback tick that can fire
        // AFTER the tab became visible again; the stale snapshot would otherwise
        // pause freshly-inserted videos on a now-foreground tab.
        if (snap.videoPauseEnabled && isHidden()) {
          if (tag === 'VIDEO') {
            if (pauseVideoNode(node)) reportStat('videosPaused', 1);
          } else if (hasKids) {
            pauseAllVideos(node);
          }
        }
        if (snap.videoPreloadNoneEnabled) {
          if (tag === 'VIDEO') applyVideoPreloadNone(node);
          else if (hasKids) applyVideoPreloadNoneAll(node);
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
    if (observer) return;
    const target = document.body || document.documentElement;
    if (!target) return;
    observerIdleCount = 0;
    observer = new MutationObserver((mutations) => {
      // Snapshot feature flags now, before the deferred tick (H-3). Visibility is
      // intentionally NOT snapshotted — processMutations reads isHidden() live so a
      // tick that fires after the tab is shown again can't act on stale state (QA-13).
      const snap = {
        imageLazyEnabled:        settings.imageLazyEnabled,
        imageLowQualityEnabled:  settings.imageLowQualityEnabled,
        prefetchStripEnabled:    settings.prefetchStripEnabled,
        videoPauseEnabled:       settings.videoPauseEnabled,
        videoPreloadNoneEnabled: settings.videoPreloadNoneEnabled,
        autoplayKillEnabled:     settings.autoplayKillEnabled
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
    // Keep main-throttle.js (MAIN world) in sync with the current setting on
    // every settings change, including the teardown path below.
    postThrottleState();

    if (!anyFeatureEnabled()) {
      restoreImageQuality();
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
    if (settings.prefetchStripEnabled) applyPrefetchStripAll(document);
    if (settings.autoplayKillEnabled) killAutoplayAll(document);
    if (settings.videoPreloadNoneEnabled) applyVideoPreloadNoneAll(document);
    if (settings.videoPauseEnabled && isHidden()) pauseAllVideos(document);

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
            if (resourceStats.trackers.length < 500) resourceStats.trackers.push(size);
          } else if (/\.woff2?|\.ttf|\.otf|fonts\.googleapis|fonts\.gstatic/.test(url)) {
            if (resourceStats.fonts.length < 500) resourceStats.fonts.push(size);
          } else if (/\.js$/.test(url)) {
            if (resourceStats.scripts.length < 500) resourceStats.scripts.push(size);
          } else if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i.test(url)) {
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

    chrome.runtime.sendMessage({
      type: 'CALIBRATE_BANDWIDTH',
      data: calibration
    }).catch(() => {}); // Silent fail

    // Reset for next batch — only clear arrays that contributed to this send
    if (resourceStats.trackers.length > 0) resourceStats.trackers = [];
    if (resourceStats.fonts.length > 0)    resourceStats.fonts = [];
    if (resourceStats.scripts.length > 0)  resourceStats.scripts = [];
    if (resourceStats.images.length > 0)   resourceStats.images = [];
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
