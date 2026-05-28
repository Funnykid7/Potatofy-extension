(function () {
  const _setTimeout = window.setTimeout.bind(window);
  const _setInterval = window.setInterval.bind(window);
  const _requestAnimationFrame = (window.requestAnimationFrame || function () { return 0; }).bind(window);

  const settings = {
    jsThrottleEnabled: false,
    imageLiteEnabled: false,
    animationKillEnabled: false,
    autoplayKillEnabled: false,
    prefetchStripEnabled: false,
    videoPauseEnabled: false
  };
  let throttleActive = false;

  // ---------- Stats bridge (debounced, isolated-world picks this up) ----------

  const statBuffer = { animationsKilled: 0, prefetchStripped: 0, imagesLazied: 0, videosPaused: 0, autoplayKilled: 0 };
  let statFlushTimer = null;

  function reportStat(key, n) {
    if (!n) return;
    statBuffer[key] += n;
    if (statFlushTimer) return;
    statFlushTimer = _setTimeout(() => {
      statFlushTimer = null;
      const detail = { ...statBuffer };
      statBuffer.animationsKilled = 0;
      statBuffer.prefetchStripped = 0;
      statBuffer.imagesLazied = 0;
      statBuffer.videosPaused = 0;
      statBuffer.autoplayKilled = 0;
      try {
        window.dispatchEvent(new CustomEvent('__potatofy_stat', { detail }));
      } catch (e) {
        // ignore
      }
    }, 1000);
  }

  // ---------- Background-tab JS throttle (unchanged behaviour) ----------

  function isHidden() {
    return document.visibilityState === 'hidden';
  }

  function applyThrottle() {
    if (throttleActive) return;
    throttleActive = true;

    window.setTimeout = function (fn, delay, ...args) {
      if (isHidden()) return 0;
      return _setTimeout(fn, delay, ...args);
    };
    window.setInterval = function (fn, delay, ...args) {
      if (isHidden()) return 0;
      return _setInterval(fn, delay, ...args);
    };
    window.requestAnimationFrame = function (cb) {
      if (isHidden()) return 0;
      return _requestAnimationFrame(cb);
    };
  }

  function restoreOriginals() {
    if (!throttleActive) return;
    throttleActive = false;
    window.setTimeout = _setTimeout;
    window.setInterval = _setInterval;
    window.requestAnimationFrame = _requestAnimationFrame;
  }

  function handleVisibilityChange() {
    if (settings.jsThrottleEnabled) {
      if (isHidden()) applyThrottle(); else restoreOriginals();
    }
    if (settings.videoPauseEnabled && isHidden()) {
      pauseAllVideos(document);
    } else if (!isHidden()) {
      restoreVideoPreload(document);
    }
  }

  // ---------- Video pause (background tabs) ----------

  function pauseVideoNode(el) {
    if (!el || el.tagName !== 'VIDEO') return false;
    try {
      if (el.__potatofy_paused_by_us) return false;
      const wasPlaying = !el.paused && !el.ended;
      // Save original preload so we can restore on visible.
      if (el.dataset.potatofyPreload === undefined) {
        el.dataset.potatofyPreload = el.preload || '';
      }
      el.preload = 'none';
      if (wasPlaying) {
        el.pause();
        el.__potatofy_paused_by_us = true;
        return true;
      }
    } catch (e) {
      // Cross-origin iframe contents or detached nodes can throw; ignore.
    }
    return false;
  }

  function pauseAllVideos(root) {
    if (!root || !root.querySelectorAll) return;
    let count = 0;
    const nodes = root.querySelectorAll('video');
    for (const n of nodes) if (pauseVideoNode(n)) count++;
    if (count) reportStat('videosPaused', count);
  }

  function restoreVideoPreload(root) {
    if (!root || !root.querySelectorAll) return;
    const nodes = root.querySelectorAll('video');
    for (const n of nodes) {
      try {
        if (n.dataset.potatofyPreload !== undefined) {
          n.preload = n.dataset.potatofyPreload;
          delete n.dataset.potatofyPreload;
        }
        n.__potatofy_paused_by_us = false;
      } catch (e) {
        // ignore
      }
    }
  }

  // ---------- Animation killer ----------

  let killStyleEl = null;

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
      html {
        scroll-behavior: auto !important;
      }
    `;
    const insert = () => {
      if (killStyleEl) return;
      killStyleEl = document.createElement('style');
      killStyleEl.setAttribute('data-potatofy', 'anim-kill');
      killStyleEl.textContent = css;
      (document.head || document.documentElement).appendChild(killStyleEl);
      reportStat('animationsKilled', 1);
    };
    if (document.head || document.documentElement) {
      insert();
    } else {
      document.addEventListener('DOMContentLoaded', insert, { once: true });
    }
  }

  function removeAnimationKill() {
    if (killStyleEl && killStyleEl.parentNode) {
      killStyleEl.parentNode.removeChild(killStyleEl);
    }
    killStyleEl = null;
  }

  // ---------- Image lite ----------

  function lazifyImage(el) {
    if (!el || el.__potatofy_lazied) return false;
    if (el.tagName === 'IMG' || el.tagName === 'IFRAME') {
      try {
        if (!el.hasAttribute('loading')) el.setAttribute('loading', 'lazy');
        if (el.tagName === 'IMG' && !el.hasAttribute('decoding')) el.setAttribute('decoding', 'async');
        if (el.tagName === 'IMG' && !el.hasAttribute('fetchpriority')) el.setAttribute('fetchpriority', 'low');
        if (el.tagName === 'IMG' && el.hasAttribute('srcset')) {
          el.removeAttribute('srcset');
          el.removeAttribute('sizes');
        }
        el.__potatofy_lazied = true;
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  function applyImageLiteAll(root) {
    if (!root || !root.querySelectorAll) return;
    let count = 0;
    const nodes = root.querySelectorAll('img, iframe');
    for (const n of nodes) if (lazifyImage(n)) count++;
    if (count) reportStat('imagesLazied', count);
  }

  // ---------- Prefetch / preconnect stripping ----------

  const PREFETCH_RELS = new Set(['preload', 'prefetch', 'preconnect', 'dns-prefetch', 'modulepreload', 'prerender']);

  function stripPrefetchLink(el) {
    if (!el || el.tagName !== 'LINK') return false;
    const rel = (el.getAttribute('rel') || '').toLowerCase().trim();
    if (PREFETCH_RELS.has(rel)) {
      try {
        el.parentNode && el.parentNode.removeChild(el);
        return true;
      } catch (e) {
        return false;
      }
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

  function killAutoplay(el) {
    if (!el || el.__potatofy_autoplay_killed) return false;
    const tag = el.tagName;
    if (tag !== 'VIDEO' && tag !== 'AUDIO') return false;
    try {
      let changed = false;
      if (el.hasAttribute('autoplay')) {
        el.removeAttribute('autoplay');
        changed = true;
      }
      // For audio, also force preload=none so the browser skips prefetching.
      if (tag === 'AUDIO' && el.getAttribute('preload') !== 'none') {
        el.setAttribute('preload', 'none');
        changed = true;
      }
      el.__potatofy_autoplay_killed = true;
      return changed;
    } catch (e) {
      return false;
    }
  }

  function killAutoplayAll(root) {
    if (!root || !root.querySelectorAll) return;
    let count = 0;
    const nodes = root.querySelectorAll('video, audio');
    for (const n of nodes) if (killAutoplay(n)) count++;
    if (count) reportStat('autoplayKilled', count);
  }

  // ---------- Mutation observer (handles SPAs and lazy-inserted markup) ----------

  let observer = null;

  function startObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (settings.imageLiteEnabled) {
            if (node.tagName === 'IMG' || node.tagName === 'IFRAME') {
              if (lazifyImage(node)) reportStat('imagesLazied', 1);
            } else if (node.querySelectorAll) {
              applyImageLiteAll(node);
            }
          }
          if (settings.prefetchStripEnabled) {
            if (node.tagName === 'LINK') {
              if (stripPrefetchLink(node)) reportStat('prefetchStripped', 1);
            } else if (node.querySelectorAll) {
              applyPrefetchStripAll(node);
            }
          }
          if (settings.videoPauseEnabled && isHidden()) {
            if (node.tagName === 'VIDEO') {
              if (pauseVideoNode(node)) reportStat('videosPaused', 1);
            } else if (node.querySelectorAll) {
              pauseAllVideos(node);
            }
          }
          if (settings.autoplayKillEnabled) {
            if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') {
              if (killAutoplay(node)) reportStat('autoplayKilled', 1);
            } else if (node.querySelectorAll) {
              killAutoplayAll(node);
            }
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function anyContentFeatureEnabled() {
    return settings.imageLiteEnabled || settings.prefetchStripEnabled ||
           settings.videoPauseEnabled || settings.autoplayKillEnabled;
  }

  // ---------- Apply / sync feature flags ----------

  function applyAll() {
    if (settings.animationKillEnabled) applyAnimationKill(); else removeAnimationKill();
    if (settings.imageLiteEnabled) applyImageLiteAll(document);
    if (settings.prefetchStripEnabled) applyPrefetchStripAll(document);
    if (settings.autoplayKillEnabled) killAutoplayAll(document);
    if (settings.videoPauseEnabled && isHidden()) pauseAllVideos(document);
    if (anyContentFeatureEnabled()) startObserver(); else stopObserver();
    if (settings.jsThrottleEnabled) {
      if (isHidden()) applyThrottle();
    } else {
      restoreOriginals();
    }
  }

  function ingestDetail(detail) {
    settings.jsThrottleEnabled    = !!(detail && detail.jsThrottleEnabled);
    settings.imageLiteEnabled     = !!(detail && detail.imageLiteEnabled);
    settings.animationKillEnabled = !!(detail && detail.animationKillEnabled);
    settings.autoplayKillEnabled  = !!(detail && detail.autoplayKillEnabled);
    settings.prefetchStripEnabled = !!(detail && detail.prefetchStripEnabled);
    settings.videoPauseEnabled    = !!(detail && detail.videoPauseEnabled);
  }

  // Attach visibility listener at script load time so changes are never missed,
  // even if the init event fires after a visibility transition.
  document.addEventListener('visibilitychange', handleVisibilityChange);

  window.addEventListener('__potatofy_init', (e) => {
    ingestDetail(e.detail);
    applyAll();
  });

  window.addEventListener('__potatofy_settings_update', (e) => {
    ingestDetail(e.detail);
    applyAll();
  });
})();
