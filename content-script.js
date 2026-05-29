(function () {
  // Default shape mirrors the relevant subset of lib/defaults.js. Content
  // scripts can't import modules, so this snapshot is intentional. If a key
  // is added here, also add it to lib/defaults.js and resolveDetail below.
  const DEFAULTS = {
    blockingEnabled: true,
    tabSuspendEnabled: true,
    jsThrottleEnabled: true,
    imageLazyEnabled: true,
    imageLowQualityEnabled: false,
    animationKillEnabled: true,
    autoplayKillEnabled: true,
    prefetchStripEnabled: true,
    videoPauseEnabled: true,
    videoPreloadNoneEnabled: true,
    siteKillersEnabled: true,
    whitelist: [],
    potatoSites: {}
  };

  const STAT_KEYS = new Set([
    'animationsKilled', 'prefetchStripped', 'imagesLazied',
    'videosPaused', 'autoplayKilled', 'siteKillerHits'
  ]);

  let siteKillerCache = null;

  function normalizeHost(h) {
    return (h || '').replace(/^www\./, '').toLowerCase();
  }

  function isHostWhitelisted(hostname, whitelist) {
    const host = normalizeHost(hostname);
    return (whitelist || []).some(d => {
      const dn = normalizeHost(d);
      return host === dn || host.endsWith('.' + dn);
    });
  }

  function killersForHost(hostname, killerMap) {
    if (!killerMap) return [];
    const host = normalizeHost(hostname);
    const out = [];
    for (const [pattern, selectors] of Object.entries(killerMap)) {
      const p = normalizeHost(pattern);
      if (host === p || host.endsWith('.' + p)) {
        if (Array.isArray(selectors)) out.push(...selectors);
      }
    }
    return out;
  }

  async function loadSiteKillers() {
    if (siteKillerCache !== null) return siteKillerCache;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'GET_SITE_KILLERS' });
      siteKillerCache = (reply && reply.killers) || {};
    } catch (e) {
      siteKillerCache = {};
    }
    return siteKillerCache;
  }

  function buildDetail(settings, killerMap) {
    const merged = { ...DEFAULTS, ...(settings || {}) };
    const whitelisted = isHostWhitelisted(location.hostname, merged.whitelist);
    const siteKillers = (merged.siteKillersEnabled && !whitelisted)
      ? killersForHost(location.hostname, killerMap)
      : [];
    return {
      jsThrottleEnabled:       merged.jsThrottleEnabled       && !whitelisted,
      imageLazyEnabled:        merged.imageLazyEnabled        && !whitelisted,
      imageLowQualityEnabled:  merged.imageLowQualityEnabled  && !whitelisted,
      animationKillEnabled:    merged.animationKillEnabled    && !whitelisted,
      autoplayKillEnabled:     merged.autoplayKillEnabled     && !whitelisted,
      prefetchStripEnabled:    merged.prefetchStripEnabled    && !whitelisted,
      videoPauseEnabled:       merged.videoPauseEnabled       && !whitelisted,
      videoPreloadNoneEnabled: merged.videoPreloadNoneEnabled && !whitelisted,
      siteKillersEnabled:      merged.siteKillersEnabled      && !whitelisted,
      siteKillers
    };
  }

  function dispatch(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) {}
  }

  async function init() {
    const [data, killerMap] = await Promise.all([
      chrome.storage.local.get('settings'),
      loadSiteKillers()
    ]);
    dispatch('__potatofy_init', buildDetail(data.settings, killerMap));
  }

  init();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.settings) return;
    loadSiteKillers().then((killerMap) => {
      dispatch('__potatofy_settings_update', buildDetail(changes.settings.newValue, killerMap));
    });
  });

  // Stats bridge — MAIN-world → service worker.
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
    } catch (e) {}
  });
})();
