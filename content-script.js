(function () {
  const DEFAULTS = {
    blockingEnabled: true,
    tabSuspendEnabled: true,
    jsThrottleEnabled: true,
    imageLiteEnabled: true,
    animationKillEnabled: true,
    autoplayKillEnabled: true,
    prefetchStripEnabled: true,
    videoPauseEnabled: true,
    whitelist: []
  };

  // Stats message types accepted from the MAIN-world page bridge.
  const STAT_KEYS = new Set(['animationsKilled', 'prefetchStripped', 'imagesLazied', 'videosPaused', 'autoplayKilled']);

  function normalizeHost(h) {
    return (h || '').replace(/^www\./, '').toLowerCase();
  }

  function isHostWhitelisted(hostname, whitelist) {
    const host = normalizeHost(hostname);
    return whitelist.some(d => {
      const dn = normalizeHost(d);
      return host === dn || host.endsWith('.' + dn);
    });
  }

  function buildDetail(settings) {
    const merged = { ...DEFAULTS, ...(settings || {}) };
    const whitelisted = isHostWhitelisted(location.hostname, merged.whitelist);
    return {
      jsThrottleEnabled:     merged.jsThrottleEnabled    && !whitelisted,
      imageLiteEnabled:      merged.imageLiteEnabled     && !whitelisted,
      animationKillEnabled:  merged.animationKillEnabled && !whitelisted,
      autoplayKillEnabled:   merged.autoplayKillEnabled  && !whitelisted,
      prefetchStripEnabled:  merged.prefetchStripEnabled && !whitelisted,
      videoPauseEnabled:     merged.videoPauseEnabled    && !whitelisted
    };
  }

  function dispatch(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (e) {
      // CustomEvent dispatch can fail in unusual frame contexts; ignore.
    }
  }

  chrome.storage.sync.get('settings', (data) => {
    dispatch('__potatofy_init', buildDetail(data.settings));
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes.settings) return;
    dispatch('__potatofy_settings_update', buildDetail(changes.settings.newValue));
  });

  // Bridge stat counters from the MAIN-world content script back to the
  // service worker. Debounced on the MAIN-world side; we just forward.
  window.addEventListener('__potatofy_stat', (e) => {
    const patch = e && e.detail;
    if (!patch || typeof patch !== 'object') return;
    const safe = {};
    for (const k of Object.keys(patch)) {
      if (!STAT_KEYS.has(k)) continue;
      const n = Number(patch[k]);
      if (Number.isFinite(n) && n > 0) safe[k] = Math.floor(n);
    }
    if (Object.keys(safe).length === 0) return;
    try {
      chrome.runtime.sendMessage({ type: 'STATS_INCREMENT', patch: safe });
    } catch (e) {
      // Extension context may be invalidated during reloads; safe to ignore.
    }
  });
})();
