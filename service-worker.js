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
  prefetchStripEnabled: true,
  videoPauseEnabled: true,
  memoryPressureEnabled: true,
  memoryPressureThresholdMB: 500,
  idleThresholdMinutes: DEFAULT_IDLE_MINUTES,
  whitelist: []
};

// Weights tuned against the real Pi 4 trace deltas in the repo
// (with-extension vs without-extension memory dumps). Adjust here to retune.
const STATS_WEIGHTS = {
  request:   { ramBytes: 120 * 1024,        bwBytes: 25 * 1024, cpuMs: 40 },
  font:      { ramBytes:  80 * 1024,        bwBytes: 60 * 1024, cpuMs: 25 },
  tabDiscard:{ ramBytes:  80 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 },
  animation: { ramBytes:  12 * 1024 * 1024, bwBytes: 0,         cpuMs: 15 },
  prefetch:  { ramBytes:  50 * 1024,        bwBytes: 30 * 1024, cpuMs: 0 },
  image:     { ramBytes:   2 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 },
  videoPause:{ ramBytes:  50 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 }
};

const EMPTY_COUNTERS = {
  blockedRequests: 0,
  blockedFonts: 0,
  tabsDiscarded: 0,
  animationsKilled: 0,
  prefetchStripped: 0,
  imagesLazied: 0,
  videosPaused: 0
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
  const data = await sessionStorage.get('tabLastActive');
  return data.tabLastActive || {};
}

async function setTabLastActive(tabLastActive) {
  await sessionStorage.set({ tabLastActive });
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
    statsFlushTimer = setTimeout(flushStats, 1000);
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
    counters.blockedRequests   * w.request.ramBytes +
    counters.blockedFonts      * w.font.ramBytes +
    counters.tabsDiscarded     * w.tabDiscard.ramBytes +
    counters.animationsKilled  * w.animation.ramBytes +
    counters.prefetchStripped  * w.prefetch.ramBytes +
    counters.imagesLazied      * w.image.ramBytes +
    counters.videosPaused      * w.videoPause.ramBytes;
  const bw =
    counters.blockedRequests   * w.request.bwBytes +
    counters.blockedFonts      * w.font.bwBytes +
    counters.prefetchStripped  * w.prefetch.bwBytes;
  const cpuMs =
    counters.blockedRequests   * w.request.cpuMs +
    counters.blockedFonts      * w.font.cpuMs +
    counters.animationsKilled  * w.animation.cpuMs;
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

async function syncWhitelistRules() {
  const settings = await getSettings();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map(r => r.id);

  const addRules = settings.whitelist.map((hostname, i) => ({
    id: DYNAMIC_RULE_ID_BASE + i,
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
  }));

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
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
    const thresholdMB = Number(settings.memoryPressureThresholdMB) || 500;
    if (freeMB < thresholdMB) {
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
