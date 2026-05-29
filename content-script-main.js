(function () {
  // Saved originals — must be captured before any page script can override them.
  const _setTimeout = window.setTimeout.bind(window);
  const _clearTimeout = window.clearTimeout.bind(window);
  const _setInterval = window.setInterval.bind(window);
  const _requestAnimationFrame = (window.requestAnimationFrame || function () { return 0; }).bind(window);
  const _cancelAnimationFrame = (window.cancelAnimationFrame || function () {}).bind(window);
  const _requestIdleCallback = (window.requestIdleCallback || function (cb) { return _setTimeout(cb, 1); }).bind(window);

  // 1.1.1: only the top frame reports stats. Content scripts run per-frame
  // (`all_frames: true`), so a page with N same-origin iframes would otherwise
  // multiply every counter by N. The feature effects (throttle, killers,
  // observers) still run in every frame — only the bookkeeping is deduped.
  const IS_TOP_FRAME = (window === window.top);

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

  // ---------- Stats bridge (debounced, isolated-world picks this up) ----------

  const statBuffer = Object.create(null);
  let statFlushTimer = null;

  function reportStat(key, n) {
    if (!n) return;
    if (!IS_TOP_FRAME) return; // dedupe across same-origin iframes
    statBuffer[key] = (statBuffer[key] || 0) + n;
    if (statFlushTimer) return;
    statFlushTimer = _setTimeout(() => {
      statFlushTimer = null;
      const detail = { ...statBuffer };
      for (const k of Object.keys(statBuffer)) statBuffer[k] = 0;
      try {
        window.dispatchEvent(new CustomEvent('__potatofy_stat', { detail }));
      } catch (e) {}
    }, 1000);
  }

  // ---------- R1: feature gate (returns true if MAIN-world script has work to do) ----------

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

  // ---------- B7: rAF override with real IDs + drain on visible ----------
  // Returns a positive ID so cancelAnimationFrame and `if (id)` checks work.
  // Stores pending callbacks for drain when the tab becomes visible.

  let rafCounter = 1;
  const pendingRaf = new Map();

  function shadowedSetTimeout(fn, delay, ...args) {
    if (isHidden() && settings.jsThrottleEnabled) return 0;
    return _setTimeout(fn, delay, ...args);
  }
  function shadowedSetInterval(fn, delay, ...args) {
    if (isHidden() && settings.jsThrottleEnabled) return 0;
    return _setInterval(fn, delay, ...args);
  }
  function shadowedRequestAnimationFrame(cb) {
    if (isHidden() && settings.jsThrottleEnabled) {
      const id = rafCounter++;
      pendingRaf.set(id, cb);
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
    window.setInterval = shadowedSetInterval;
    window.requestAnimationFrame = shadowedRequestAnimationFrame;
    window.cancelAnimationFrame = shadowedCancelAnimationFrame;
  }

  function restoreOriginals() {
    if (!throttleActive) return;
    throttleActive = false;
    window.setTimeout = _setTimeout;
    window.setInterval = _setInterval;
    window.requestAnimationFrame = _requestAnimationFrame;
    window.cancelAnimationFrame = _cancelAnimationFrame;
    drainPendingRaf();
  }

  function handleVisibilityChange() {
    if (settings.jsThrottleEnabled) {
      if (isHidden()) applyThrottle(); else restoreOriginals();
    }
    if (settings.videoPauseEnabled) {
      if (isHidden()) pauseAllVideos(document);
      else restoreVideoPlayability(document);
    }
  }

  function ensureVisibilityListener() {
    if (visibilityListenerAttached) return;
    visibilityListenerAttached = true;
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  // ---------- Video handling (R7) ----------

  function pauseVideoNode(el) {
    if (!el || el.tagName !== 'VIDEO') return false;
    try {
      if (el.__potatofy_paused_by_us) return false;
      const wasPlaying = !el.paused && !el.ended;
      if (el.dataset.potatofyPreload === undefined) {
        el.dataset.potatofyPreload = el.preload || '';
      }
      el.preload = 'none';
      if (wasPlaying) {
        el.pause();
        el.__potatofy_paused_by_us = true;
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
        if (n.dataset.potatofyPreload !== undefined) {
          n.preload = n.dataset.potatofyPreload;
          delete n.dataset.potatofyPreload;
        }
        n.__potatofy_paused_by_us = false;
      } catch (e) {}
    }
  }

  // R7: preload="none" on all videos always; restore on first play.
  const preloadNonedVideos = new WeakSet();
  function applyVideoPreloadNone(el) {
    if (!el || el.tagName !== 'VIDEO') return false;
    if (preloadNonedVideos.has(el)) return false;
    try {
      if (el.dataset.potatofyOrigPreload === undefined) {
        el.dataset.potatofyOrigPreload = el.preload || '';
      }
      el.preload = 'none';
      preloadNonedVideos.add(el);
      const onPlay = () => {
        try {
          if (el.dataset.potatofyOrigPreload !== undefined) {
            el.preload = el.dataset.potatofyOrigPreload;
            delete el.dataset.potatofyOrigPreload;
          }
        } catch (e) {}
        el.removeEventListener('play', onPlay);
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
    // Counted into videosPaused — same RAM weight class.
    if (count) reportStat('videosPaused', count);
  }

  // ---------- Animation killer ----------
  // 1.1.1: the counter now fires AT MOST ONCE per page (per top-frame visit).
  // The weight in lib/stats-weights.js (4 MB) represents the average page-wide
  // GPU/compositor savings, not per-animation. Previously this reported
  // hundreds per heavy page × 3 MB each = absurd RAM totals.

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
      killStyleEl = document.createElement('style');
      killStyleEl.setAttribute('data-potatofy', 'anim-kill');
      killStyleEl.textContent = css;
      (document.head || document.documentElement).appendChild(killStyleEl);
      // Defer the check so getAnimations() sees animations registered after
      // initial parse. We only need to know IF the page had any — the per-page
      // weight in stats-weights.js covers the magnitude.
      _setTimeout(() => {
        if (pageHadAnimations) return;
        if (pageHasAnimations()) {
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
    const selectors = settings.siteKillers.filter(s => typeof s === 'string' && s.length > 0);
    if (selectors.length === 0) return;
    const css = selectors.join(',\n') + ' { display: none !important; }';
    const insert = () => {
      if (siteKillerStyleEl) return;
      siteKillerStyleEl = document.createElement('style');
      siteKillerStyleEl.setAttribute('data-potatofy', 'site-killer');
      siteKillerStyleEl.textContent = css;
      (document.head || document.documentElement).appendChild(siteKillerStyleEl);
      // 1.1.1: report 1 per host visit, NOT selectors.length. Previously a
      // YouTube page with 10 selectors per iframe × 5 iframes = 50 hits × 20 MB.
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

  // ---------- Image lite (B6: split low-quality from lazy) ----------

  const processedImages = new WeakSet();

  function lazifyImage(el) {
    if (!el || processedImages.has(el)) return false;
    if (el.tagName !== 'IMG' && el.tagName !== 'IFRAME') return false;
    try {
      let changed = false;
      if (settings.imageLazyEnabled) {
        if (!el.hasAttribute('loading')) { el.setAttribute('loading', 'lazy'); changed = true; }
        if (el.tagName === 'IMG' && !el.hasAttribute('decoding')) { el.setAttribute('decoding', 'async'); changed = true; }
        if (el.tagName === 'IMG' && !el.hasAttribute('fetchpriority')) { el.setAttribute('fetchpriority', 'low'); changed = true; }
      }
      if (settings.imageLowQualityEnabled && el.tagName === 'IMG' && el.hasAttribute('srcset')) {
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
    for (const n of nodes) if (lazifyImage(n)) count++;
    if (count) reportStat('imagesLazied', count);
  }

  // ---------- Prefetch / preconnect stripping ----------

  const processedLinks = new WeakSet();
  const PREFETCH_RELS = new Set(['preload', 'prefetch', 'preconnect', 'dns-prefetch', 'modulepreload', 'prerender']);

  function stripPrefetchLink(el) {
    if (!el || processedLinks.has(el) || el.tagName !== 'LINK') return false;
    processedLinks.add(el);
    const rel = (el.getAttribute('rel') || '').toLowerCase().trim();
    if (PREFETCH_RELS.has(rel)) {
      try {
        el.parentNode && el.parentNode.removeChild(el);
        return true;
      } catch (e) { return false; }
    }
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
  const OBSERVER_DISCONNECT_AFTER = 20; // 20 consecutive idle ticks (~10s)

  function processMutations(mutations) {
    let relevant = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        relevant = true;
        const tag = node.tagName;

        if (settings.imageLazyEnabled || settings.imageLowQualityEnabled) {
          if (tag === 'IMG' || tag === 'IFRAME') {
            if (lazifyImage(node)) reportStat('imagesLazied', 1);
          } else if (node.querySelectorAll) {
            applyImageLazyAll(node);
          }
        }
        if (settings.prefetchStripEnabled) {
          if (tag === 'LINK') {
            if (stripPrefetchLink(node)) reportStat('prefetchStripped', 1);
          } else if (node.querySelectorAll) {
            applyPrefetchStripAll(node);
          }
        }
        if (settings.videoPauseEnabled && isHidden()) {
          if (tag === 'VIDEO') {
            if (pauseVideoNode(node)) reportStat('videosPaused', 1);
          } else if (node.querySelectorAll) {
            pauseAllVideos(node);
          }
        }
        if (settings.videoPreloadNoneEnabled) {
          if (tag === 'VIDEO') applyVideoPreloadNone(node);
          else if (node.querySelectorAll) applyVideoPreloadNoneAll(node);
        }
        if (settings.autoplayKillEnabled) {
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
      _requestIdleCallback(() => processMutations(mutations), { timeout: 500 });
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

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
      // R1: nothing to do — tear down everything and bail.
      restoreOriginals();
      removeAnimationKill();
      removeSiteKillers();
      stopObserver();
      return;
    }
    ensureVisibilityListener();

    if (settings.animationKillEnabled) applyAnimationKill(); else removeAnimationKill();
    if (settings.siteKillersEnabled && settings.siteKillers.length > 0) applySiteKillers();
    else removeSiteKillers();

    if (settings.imageLazyEnabled || settings.imageLowQualityEnabled) applyImageLazyAll(document);
    if (settings.prefetchStripEnabled) applyPrefetchStripAll(document);
    if (settings.autoplayKillEnabled) killAutoplayAll(document);
    if (settings.videoPreloadNoneEnabled) applyVideoPreloadNoneAll(document);
    if (settings.videoPauseEnabled && isHidden()) pauseAllVideos(document);

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

  window.addEventListener('__potatofy_init', (e) => {
    ingestDetail(e.detail);
    applyAll();
  });

  window.addEventListener('__potatofy_settings_update', (e) => {
    ingestDetail(e.detail);
    applyAll();
  });
})();
