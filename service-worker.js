const ALARM_NAME = 'potatofy-idle-check';
const BADGE_ALARM = 'potatofy-badge-refresh';
const PRESSURE_ALARM = 'potatofy-memory-pressure';
const DEFAULT_IDLE_MINUTES = 5;
const PRESSURE_MIN_AGE_MS = 30 * 1000;
const DYNAMIC_RULE_ID_BASE = 10000;
const STATIC_RULESET_ID = 'static-blocking-rules';

// IDs reserved for font-blocking rules in rules/static-rules.json — used to
// classify a blocked request as a font vs a generic tracker for stats weighting.
const FONT_RULE_IDS = new Set([40, 41, 42, 43, 44]);

const DEFAULT_SETTINGS = {
  blockingEnabled: true,
  tabSuspendEnabled: true,
  jsThrottleEnabled: true,
  imageLiteEnabled: true,
  animationKillEnabled: true,
  autoplayKillEnabled: true,
  prefetchStripEnabled: true,
  videoPauseEnabled: true,
  memoryPressureEnabled: true,
  memoryPressureThresholdMB: 500,
  idleThresholdMinutes: DEFAULT_IDLE_MINUTES,
  whitelist: []
};

// Heuristic weights calibrated against Pi 4 memory traces.
// request/font: V8 heap + DNR overhead per blocked script/pixel.
// tabDiscard: typical tab footprint (50–150 MB, median 80 MB).
// animation: GPU compositor + repaint savings (1–4 MB measured, using 3 MB).
// prefetch: DNS resolver state + TCP speculative-connect buffer.
// image: decoded bitmap delta from srcset→base-src (avg ~512 KB).
// videoPause: codec buffer + GPU texture memory freed (~40–60 MB).
// autoplay: pre-rolled video/audio buffer prevented (~20–50 MB, using 30 MB).
const STATS_WEIGHTS = {
  request:   { ramBytes: 120 * 1024,        bwBytes: 25 * 1024, cpuMs: 40 },
  font:      { ramBytes:  80 * 1024,        bwBytes: 60 * 1024, cpuMs: 25 },
  tabDiscard:{ ramBytes:  80 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 },
  animation: { ramBytes:   3 * 1024 * 1024, bwBytes: 0,         cpuMs: 15 },
  prefetch:  { ramBytes:  50 * 1024,        bwBytes: 30 * 1024, cpuMs: 0 },
  image:     { ramBytes: 512 * 1024,        bwBytes: 0,         cpuMs: 0 },
  videoPause:{ ramBytes:  50 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 },
  autoplay:  { ramBytes:  30 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 }
};

const EMPTY_COUNTERS = {
  blockedRequests: 0,
  blockedFonts: 0,
  tabsDiscarded: 0,
  animationsKilled: 0,
  prefetchStripped: 0,
  imagesLazied: 0,
  videosPaused: 0,
  autoplayKilled: 0
};

const sessionStorage = chrome.storage.session || chrome.storage.local;

async function getSettings() {
  const data = await chrome.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}

async function getTabLastActive() {
  try {
    const data = await sessionStorage.get('tabLastActive');
    return data.tabLastActive || {};
  } catch (e) {
    return {};
  }
}

async function setTabLastActive(tabLastActive) {
  try {
    await sessionStorage.set({ tabLastActive });
  } catch (e) {
    // Storage may be full or unavailable; tab suspend will still work using minIdleMs fallback.
  }
}

async function updateTabActivity(tabId) {
  const tabLastActive = await getTabLastActive();
  tabLastActive[tabId] = Date.now();
  await setTabLastActive(tabLastActive);
}

async function removeTabActivity(tabId) {
  const tabLastActive = await getTabLastActive();
  delete tabLastActive[tabId];
  await setTabLastActive(tabLastActive);
}

// ---------- Stats ----------

async function getStats() {
  const data = await chrome.storage.local.get('stats');
  const now = Date.now();
  const stats = data.stats || {
    session: { ...EMPTY_COUNTERS, since: now },
    lifetime: { ...EMPTY_COUNTERS, since: now }
  };
  if (!stats.session) stats.session = { ...EMPTY_COUNTERS, since: now };
  if (!stats.lifetime) stats.lifetime = { ...EMPTY_COUNTERS, since: now };
  return stats;
}

async function saveStats(stats) {
  await chrome.storage.local.set({ stats });
}

let statsBuffer = { ...EMPTY_COUNTERS };
let statsFlushTimer = null;

function bufferIncrement(patch) {
  for (const k of Object.keys(patch)) {
    statsBuffer[k] = (statsBuffer[k] || 0) + (patch[k] || 0);
  }
  if (!statsFlushTimer) {
    statsFlushTimer = setTimeout(flushStats, 250);
  }
}

async function flushStats() {
  statsFlushTimer = null;
  const patch = statsBuffer;
  statsBuffer = { ...EMPTY_COUNTERS };
  let any = false;
  for (const k of Object.keys(patch)) {
    if (patch[k]) { any = true; break; }
  }
  if (!any) return;
  const stats = await getStats();
  for (const k of Object.keys(patch)) {
    stats.session[k] = (stats.session[k] || 0) + patch[k];
    stats.lifetime[k] = (stats.lifetime[k] || 0) + patch[k];
  }
  await saveStats(stats);
  scheduleBadgeUpdate();
}

function computeSavings(counters) {
  const w = STATS_WEIGHTS;
  const ram =
    (counters.blockedRequests  || 0) * w.request.ramBytes +
    (counters.blockedFonts     || 0) * w.font.ramBytes +
    (counters.tabsDiscarded    || 0) * w.tabDiscard.ramBytes +
    (counters.animationsKilled || 0) * w.animation.ramBytes +
    (counters.prefetchStripped || 0) * w.prefetch.ramBytes +
    (counters.imagesLazied     || 0) * w.image.ramBytes +
    (counters.videosPaused     || 0) * w.videoPause.ramBytes +
    (counters.autoplayKilled   || 0) * w.autoplay.ramBytes;
  const bw =
    (counters.blockedRequests  || 0) * w.request.bwBytes +
    (counters.blockedFonts     || 0) * w.font.bwBytes +
    (counters.prefetchStripped || 0) * w.prefetch.bwBytes;
  const cpuMs =
    (counters.blockedRequests  || 0) * w.request.cpuMs +
    (counters.blockedFonts     || 0) * w.font.cpuMs +
    (counters.animationsKilled || 0) * w.animation.cpuMs;
  return { ramBytes: ram, bwBytes: bw, cpuMs };
}

async function resetStatsScope(scope) {
  const stats = await getStats();
  if (scope === 'session' || scope === 'lifetime') {
    stats[scope] = { ...EMPTY_COUNTERS, since: Date.now() };
    await saveStats(stats);
    scheduleBadgeUpdate();
  }
}

// ---------- Badge ----------

let badgeUpdateTimer = null;

function scheduleBadgeUpdate() {
  if (badgeUpdateTimer) return;
  badgeUpdateTimer = setTimeout(() => {
    badgeUpdateTimer = null;
    updateBadge();
  }, 10000);
}

function abbreviateCount(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

async function updateBadge() {
  try {
    const stats = await getStats();
    const total =
      stats.session.blockedRequests +
      stats.session.blockedFonts +
      stats.session.tabsDiscarded;
    await chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
    await chrome.action.setBadgeText({ text: total > 0 ? abbreviateCount(total) : '' });
  } catch (e) {
    // setBadge* can fail very early at install; safe to ignore.
  }
}

// ---------- DNR & whitelist ----------

// Chrome DNR's initiatorDomains accepts registrable domains only:
// no IPs, no `localhost`, no TLD-only strings. A single bad entry causes
// updateDynamicRules to reject the whole call, which would wipe every
// whitelist rule. Filter first, then fall back to per-rule add on error.
function isValidInitiatorDomain(host) {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase();
  if (!h || h.length > 253) return false;
  // Must contain a dot and a 2+ char TLD section, and only host-safe chars.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return false;
  if (!/\.[a-z]{2,}$/.test(h)) return false;
  // Reject IPv4 literals.
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h)) return false;
  return true;
}

function buildWhitelistRule(hostname, id) {
  return {
    id,
    priority: 100,
    action: { type: 'allow' },
    condition: {
      initiatorDomains: [hostname],
      resourceTypes: [
        'main_frame', 'sub_frame', 'stylesheet', 'script', 'image',
        'font', 'object', 'xmlhttprequest', 'ping', 'csp_report',
        'media', 'websocket', 'other'
      ]
    }
  };
}

async function syncWhitelistRules() {
  const settings = await getSettings();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map(r => r.id);

  const valid = (settings.whitelist || []).filter(isValidInitiatorDomain);
  const addRules = valid.map((hostname, i) => buildWhitelistRule(hostname, DYNAMIC_RULE_ID_BASE + i));

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    return;
  } catch (e) {
    console.warn('[Potatofy] bulk whitelist sync failed, retrying per-rule:', e);
  }

  // Fall back: clear all, then add rules one at a time so a single bad
  // entry doesn't block the rest from being applied.
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
  } catch (e) {
    console.warn('[Potatofy] could not clear dynamic rules:', e);
  }
  for (const rule of addRules) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
    } catch (e) {
      console.warn('[Potatofy] skipping invalid whitelist rule:', rule.condition.initiatorDomains, e);
    }
  }
}

async function toggleStaticRuleset(enabled) {
  try {
    if (enabled) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [STATIC_RULESET_ID] });
    } else {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [STATIC_RULESET_ID] });
    }
  } catch (e) {
    console.warn('[Potatofy] toggleStaticRuleset failed:', e);
  }
}

function setupAlarms() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  // Memory-pressure alarm runs every 30s. Chrome's minimum periodInMinutes
  // is 0.5 in MV3 unpacked builds; round up to 1 if Chrome rejects it.
  try {
    chrome.alarms.create(PRESSURE_ALARM, { periodInMinutes: 0.5 });
  } catch (e) {
    chrome.alarms.create(PRESSURE_ALARM, { periodInMinutes: 1 });
  }
}

function shouldSkipTabForDiscard(tab, activeTabIdInWindow) {
  if (tab.active && tab.id === activeTabIdInWindow) return true;
  if (tab.pinned) return true;
  if (tab.discarded) return true;
  if (tab.audible) return true;
  if (!tab.url) return true;
  if (tab.url.startsWith('chrome://')) return true;
  if (tab.url.startsWith('chrome-extension://')) return true;
  return false;
}

async function discardEligibleTabs({ minIdleMs = 0 } = {}) {
  const tabLastActive = await getTabLastActive();
  const now = Date.now();
  const windows = await chrome.windows.getAll({ populate: true });

  let discarded = 0;
  for (const win of windows) {
    const activeTab = win.tabs.find(t => t.active);
    const activeId = activeTab ? activeTab.id : -1;
    for (const tab of win.tabs) {
      if (shouldSkipTabForDiscard(tab, activeId)) continue;
      if (minIdleMs > 0) {
        const lastActive = tabLastActive[tab.id] || 0;
        if (now - lastActive < minIdleMs) continue;
      }
      try {
        await chrome.tabs.discard(tab.id);
        discarded++;
      } catch (e) {
        // Tabs that are loading or devtools-attached can't be discarded.
      }
    }
  }
  if (discarded > 0) bufferIncrement({ tabsDiscarded: discarded });
  return discarded;
}

async function checkIdleTabs() {
  const settings = await getSettings();
  if (!settings.tabSuspendEnabled) return;
  const minutes = Number(settings.idleThresholdMinutes) || DEFAULT_IDLE_MINUTES;
  const idleMs = Math.max(1, minutes) * 60 * 1000;
  await discardEligibleTabs({ minIdleMs: idleMs });
}

async function checkMemoryPressure() {
  const settings = await getSettings();
  if (!settings.tabSuspendEnabled) return;
  if (!settings.memoryPressureEnabled) return;
  if (!chrome.system || !chrome.system.memory) return;
  try {
    const info = await chrome.system.memory.getInfo();
    const freeMB = (info.availableCapacity || 0) / (1024 * 1024);
    const totalMB = (info.capacity || 0) / (1024 * 1024);
    const thresholdMB = Number(settings.memoryPressureThresholdMB) || 500;
    const freePct = totalMB > 0 ? freeMB / totalMB : 1;
    // Trigger if below absolute threshold OR below 15% free (low-RAM devices).
    if (freeMB < thresholdMB || freePct < 0.15) {
      await discardEligibleTabs({ minIdleMs: PRESSURE_MIN_AGE_MS });
    }
  } catch (e) {
    // system.memory may be unavailable; safe to ignore.
  }
}

// ---------- DNR feedback ----------

if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const rule = info && info.rule;
    if (!rule) return;
    // Ignore dynamic allow-rules (whitelist) — they're not "blocks".
    if (rule.ruleId >= DYNAMIC_RULE_ID_BASE) return;
    if (FONT_RULE_IDS.has(rule.ruleId)) {
      bufferIncrement({ blockedFonts: 1 });
    } else {
      bufferIncrement({ blockedRequests: 1 });
    }
  });
}

// ---------- Lifecycle ----------

// Flush any buffered stats immediately when Chrome suspends the service worker
// so in-flight counts are not lost between SW wake cycles.
chrome.runtime.onSuspend.addListener(() => {
  if (statsFlushTimer) {
    clearTimeout(statsFlushTimer);
    statsFlushTimer = null;
    flushStats();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get('settings');
  if (!current.settings) {
    await saveSettings(DEFAULT_SETTINGS);
  } else {
    // Backfill any missing new toggles for users upgrading from v1.
    const merged = { ...DEFAULT_SETTINGS, ...current.settings };
    await saveSettings(merged);
  }
  await syncWhitelistRules();
  setupAlarms();
  updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  setupAlarms();
  // New browser session — reset session-scope counters, keep lifetime.
  const stats = await getStats();
  stats.session = { ...EMPTY_COUNTERS, since: Date.now() };
  await saveStats(stats);
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) checkIdleTabs();
  if (alarm.name === BADGE_ALARM) updateBadge();
  if (alarm.name === PRESSURE_ALARM) checkMemoryPressure();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  updateTabActivity(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    updateTabActivity(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabActivity(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'UPDATE_SETTINGS') {
    (async () => {
      await saveSettings(msg.settings);
      await syncWhitelistRules();
      await toggleStaticRuleset(!!msg.settings.blockingEnabled);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'GET_SETTINGS') {
    (async () => {
      const settings = await getSettings();
      sendResponse({ settings });
    })();
    return true;
  }

  if (msg.type === 'STATS_INCREMENT' && msg.patch) {
    const safe = {};
    for (const k of Object.keys(EMPTY_COUNTERS)) {
      const v = Number(msg.patch[k]);
      if (Number.isFinite(v) && v > 0) safe[k] = Math.floor(v);
    }
    bufferIncrement(safe);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'GET_STATS') {
    (async () => {
      const stats = await getStats();
      sendResponse({
        stats,
        weights: STATS_WEIGHTS,
        savings: {
          session: computeSavings(stats.session),
          lifetime: computeSavings(stats.lifetime)
        }
      });
    })();
    return true;
  }

  if (msg.type === 'DISCARD_NOW') {
    (async () => {
      const count = await discardEligibleTabs({ minIdleMs: 0 });
      sendResponse({ ok: true, count });
    })();
    return true;
  }

  if (msg.type === 'RESET_STATS') {
    (async () => {
      await resetStatsScope(msg.scope);
      sendResponse({ ok: true });
    })();
    return true;
  }
});
