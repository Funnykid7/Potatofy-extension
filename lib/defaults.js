// Single source of truth for default settings. Imported by service-worker.js
// and popup/popup.js as an ES module. Content scripts receive resolved values
// via chrome.runtime (GET_CONTENT_SETTINGS / POTATOFY_SETTINGS_UPDATE), so
// they don't import this file.

export const ALLOWED_THRESHOLDS = [1, 3, 5, 10, 15, 30];
export const ALLOWED_PRESSURE_MB = [200, 350, 500, 750, 1000, 1500];

export const DEFAULT_SETTINGS = {
  // Network blocking (DNR static ruleset)
  blockingEnabled: true,

  // Tab management
  tabSuspendEnabled: true,
  idleThresholdMinutes: 5,
  memoryPressureEnabled: true,
  memoryPressureThresholdMB: 500,

  // Background-tab JS / animation
  jsThrottleEnabled: true,
  animationKillEnabled: true,

  // Image handling — split from old imageLiteEnabled (B6)
  imageLazyEnabled: true,        // safe: loading=lazy, decoding=async, fetchpriority=low
  imageLowQualityEnabled: false, // opt-in: also strips srcset/sizes (can backfire on HiDPI)

  // Media
  autoplayKillEnabled: true,
  videoPauseEnabled: true,
  videoPreloadNoneEnabled: true, // R7: preload=none on visible videos too

  // Network hints
  prefetchStripEnabled: true,

  // Maximum-savings features (new in 1.1.0, default ON)
  thirdPartyScriptBlockEnabled: true, // R3
  foregroundPotatoEnabled: true,      // R10
  siteKillersEnabled: true,           // R5

  // Storage backend (R9): off by default — no Google sync overhead on Pi
  useCloudSync: false,
  syncHostsToCloud: false,

  // Per-host preferences
  whitelist: [],
  potatoSites: {} // { host: { js: bool, img: bool } } — R4
};

