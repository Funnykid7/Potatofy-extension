import { DEFAULT_SETTINGS, ALLOWED_THRESHOLDS } from './lib/defaults.js';
import { STATS_WEIGHTS, EMPTY_COUNTERS, computeSavings } from './lib/stats-weights.js';

// ---------- Constants ----------

const ALARM_IDLE         = 'potatofy-idle-check';
const ALARM_PRESSURE     = 'potatofy-memory-pressure';
const ALARM_STATS_FLUSH  = 'potatofy-stats-flush';
const ALARM_TAB_PERSIST  = 'potatofy-tab-persist';
const ALARM_DNR_POLL     = 'potatofy-dnr-poll';

const STATIC_RULESET_ID = 'static-blocking-rules';
const FONT_RULESET_ID   = 'font-blocking-rules';

// Dynamic rule ID partitioning. Each range is owned by exactly one sync
// function, which only removes IDs from its own range — so concurrent
// installs can't wipe each other.
const DYNAMIC_RULE_WHITELIST_BASE = 10000; // 10000-10199 — whitelist allow rules
const DYNAMIC_RULE_3P_SCRIPT_ID   = 20000; // single 3rd-party script block
const DYNAMIC_RULE_3P_IMAGE_ID    = 20001; // single 3rd-party image block (foreground potato)
const BOOST_RULE_BASE             = 30000; // 30000-30099 — tab-scoped ephemeral boost rules

const PRESSURE_MIN_AGE_MS = 30 * 1000;
const DNR_POLL_WINDOW_MS  = 5 * 60 * 1000; // getMatchedRules() in production looks back 5 min

const SITE_KILLERS_URL = chrome.runtime.getURL('rules/site-killers.json');

// Detect packaged install. `update_url` is set by the Web Store, absent for
// unpacked dev installs. We use this only to decide whether to also subscribe
// to `onRuleMatchedDebug` (firing in real time in dev) on top of the polled
// path (which works in both modes).
const IS_PACKAGED = !!chrome.runtime.getManifest().update_url;

// ---------- Storage abstraction (R9) ----------
// Source of truth for settings is always chrome.storage.local. When the user
// opts into useCloudSync, we mirror to chrome.storage.sync as a backup, but
// never read from it during normal operation.

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
  if (settings.useCloudSync) {
    try { await chrome.storage.sync.set({ settings }); } catch (e) {}
  }
}

async function migrateLegacySync() {
  const local = await chrome.storage.local.get('settings');
  if (local.settings) return;
  try {
    const sync = await chrome.storage.sync.get('settings');
    if (sync.settings) {
      await chrome.storage.local.set({
        settings: { ...DEFAULT_SETTINGS, ...sync.settings, useCloudSync: false }
      });
    }
  } catch (e) {}
}

// ---------- Promise lock ----------

const lockChains = new Map();

function withLock(key, fn) {
  const prev = lockChains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  lockChains.set(key, next.finally(() => {
    if (lockChains.get(key) === next) lockChains.delete(key);
  }));
  return next;
}

// ---------- Tab activity ----------

const tabLastActive = new Map();
let tabLastActiveDirty = false;

async function rehydrateTabLastActive() {
  try {
    const s = await chrome.storage.session.get('tabLastActive');
    const obj = s.tabLastActive || {};
    tabLastActive.clear();
    for (const [k, v] of Object.entries(obj)) tabLastActive.set(Number(k), v);
  } catch (e) {}
}

function updateTabActivity(tabId) {
  if (typeof tabId !== 'number') return;
  tabLastActive.set(tabId, Date.now());
  tabLastActiveDirty = true;
}

function removeTabActivity(tabId) {
  if (tabLastActive.delete(tabId)) tabLastActiveDirty = true;
}

async function persistTabLastActive() {
  if (!tabLastActiveDirty) return;
  tabLastActiveDirty = false;
  const obj = Object.fromEntries(tabLastActive);
  try { await chrome.storage.session.set({ tabLastActive: obj }); } catch (e) {}
}

// ---------- Stats ----------

const statsHot = { ...EMPTY_COUNTERS };
let statsHotRehydrated = false;

async function rehydrateStatsHot() {
  try {
    const s = await chrome.storage.session.get('statsHot');
    if (s.statsHot) {
      for (const k of Object.keys(s.statsHot)) {
        statsHot[k] = s.statsHot[k];
      }
    }
  } catch (e) {}
  statsHotRehydrated = true;
}

async function bufferIncrement(patch) {
  if (!statsHotRehydrated) await rehydrateStatsHot();
  let any = false;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (!v) continue;
    statsHot[k] = (statsHot[k] || 0) + v;
    any = true;
  }
  if (any) {
    try { await chrome.storage.session.set({ statsHot }); } catch (e) {}
  }
}

async function flushStatsHotToLocal() {
  return withLock('stats-flush', async () => {
    if (!statsHotRehydrated) await rehydrateStatsHot();
    let any = false;
    for (const k of Object.keys(statsHot)) if (statsHot[k]) { any = true; break; }
    if (!any) return;
    const { stats } = await chrome.storage.local.get('stats');
    const now = Date.now();
    const s = stats || {
      session: { ...EMPTY_COUNTERS, since: now },
      lifetime: { ...EMPTY_COUNTERS, since: now }
    };
    if (!s.session) s.session = { ...EMPTY_COUNTERS, since: now };
    if (!s.lifetime) s.lifetime = { ...EMPTY_COUNTERS, since: now };
    for (const k of Object.keys(statsHot)) {
      const v = statsHot[k];
      if (!v) continue;
      s.session[k] = (s.session[k] || 0) + v;
      s.lifetime[k] = (s.lifetime[k] || 0) + v;
      statsHot[k] = 0;
    }
    await chrome.storage.local.set({ stats: s });
    try { await chrome.storage.session.set({ statsHot }); } catch (e) {}
    updateBadge();
  });
}

async function getStats() {
  const data = await chrome.storage.local.get('stats');
  const now = Date.now();
  const stats = data.stats || {
    session: { ...EMPTY_COUNTERS, since: now },
    lifetime: { ...EMPTY_COUNTERS, since: now }
  };
  if (!stats.session)  stats.session  = { ...EMPTY_COUNTERS, since: now };
  if (!stats.lifetime) stats.lifetime = { ...EMPTY_COUNTERS, since: now };
  return stats;
}

async function resetStatsScope(scope) {
  if (scope !== 'session' && scope !== 'lifetime') return;
  await flushStatsHotToLocal();
  const stats = await getStats();
  stats[scope] = { ...EMPTY_COUNTERS, since: Date.now() };
  await chrome.storage.local.set({ stats });
  updateBadge();
}

// ---------- Badge ----------

let badgeUpdateScheduled = false;

function updateBadge() {
  if (badgeUpdateScheduled) return;
  badgeUpdateScheduled = true;
  Promise.resolve().then(async () => {
    badgeUpdateScheduled = false;
    try {
      const stats = await getStats();
      const total =
        (stats.session.blockedRequests || 0) +
        (stats.session.blockedFonts || 0) +
        (stats.session.tabsDiscarded || 0) +
        (stats.session.thirdPartyScriptsBlocked || 0);
      await chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
      await chrome.action.setBadgeText({ text: total > 0 ? abbreviateCount(total) : '' });
    } catch (e) {}
  });
}

function abbreviateCount(n) {
  if (n < 1000)    return String(n);
  if (n < 10000)   return (n / 1000).toFixed(1) + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(1) + 'M';
}

// ---------- DNR — validation + builders ----------

function isValidInitiatorDomain(host) {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase();
  if (!h || h.length > 253) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return false;
  if (!/\.[a-z]{2,}$/.test(h)) return false;
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

function buildThirdPartyBlockRule(id, resourceType, excludedInitiatorDomains, tabIds) {
  const condition = {
    resourceTypes: [resourceType],
    domainType: 'thirdParty'
  };
  if (excludedInitiatorDomains && excludedInitiatorDomains.length > 0) {
    condition.excludedInitiatorDomains = excludedInitiatorDomains;
  }
  if (Array.isArray(tabIds) && tabIds.length > 0) {
    condition.tabIds = tabIds;
  }
  return {
    id,
    priority: 50,
    action: { type: 'block' },
    condition
  };
}

function inManagedRange(id) {
  // syncDynamicRules owns whitelist + global 3p block ranges.
  // Boost rules (30000-30099) are NOT managed here — they're tab-scoped and
  // cleaned by separate handlers, so a settings change must not wipe them.
  return (id >= DYNAMIC_RULE_WHITELIST_BASE && id < DYNAMIC_RULE_WHITELIST_BASE + 200) ||
         id === DYNAMIC_RULE_3P_SCRIPT_ID ||
         id === DYNAMIC_RULE_3P_IMAGE_ID;
}

// ---------- DNR sync (whitelist + global 3rd-party blocks) ----------

async function syncDynamicRules() {
  return withLock('dnr', async () => {
    const settings = await getSettings();
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    // Only touch IDs we own. Boost rules (30000+) are managed separately and
    // must survive a settings update.
    const removeRuleIds = Array.from(new Set(existing.filter(r => inManagedRange(r.id)).map(r => r.id)));

    const valid = (settings.whitelist || []).filter(isValidInitiatorDomain);
    const addRules = valid.map((h, i) => buildWhitelistRule(h, DYNAMIC_RULE_WHITELIST_BASE + i));

    if (settings.thirdPartyScriptBlockEnabled) {
      addRules.push(buildThirdPartyBlockRule(DYNAMIC_RULE_3P_SCRIPT_ID, 'script', valid));
    }
    if (settings.foregroundPotatoEnabled) {
      addRules.push(buildThirdPartyBlockRule(DYNAMIC_RULE_3P_IMAGE_ID, 'image', valid));
    }

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
      return;
    } catch (e) {
      console.warn('[Potatofy] bulk dynamic-rules update failed, retrying per-rule:', e);
    }
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    } catch (e) {}
    for (const rule of addRules) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
      } catch (e) {
        console.warn('[Potatofy] skipping invalid rule:', rule.id, e);
      }
    }
  });
}

// ---------- Static rulesets ----------

async function reconcileStaticRulesets(settings) {
  const enableIds = [];
  const disableIds = [];
  (settings.blockingEnabled ? enableIds : disableIds).push(STATIC_RULESET_ID);
  (settings.blockingEnabled ? enableIds : disableIds).push(FONT_RULESET_ID);
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enableIds,
      disableRulesetIds: disableIds
    });
  } catch (e) {
    console.warn('[Potatofy] reconcileStaticRulesets failed:', e);
  }
}

// ---------- contentSettings (per-site Potato Mode — R4 only, NOT used by Boost) ----------

async function syncPotatoSites() {
  if (!chrome.contentSettings) return;
  const settings = await getSettings();
  const sites = settings.potatoSites || {};
  for (const [host, opts] of Object.entries(sites)) {
    if (!isValidInitiatorDomain(host)) continue;
    const primaryPattern = `*://*.${host}/*`;
    try {
      await chrome.contentSettings.javascript.set({
        primaryPattern,
        setting: opts.js ? 'block' : 'allow'
      });
    } catch (e) {}
    try {
      await chrome.contentSettings.images.set({
        primaryPattern,
        setting: opts.img ? 'block' : 'allow'
      });
    } catch (e) {}
  }
}

async function setPotatoSite(host, opts) {
  if (!isValidInitiatorDomain(host)) return false;
  const settings = await getSettings();
  const sites = { ...(settings.potatoSites || {}) };
  const current = sites[host] || { js: false, img: false };
  const next = {
    js:  opts.js  !== undefined ? !!opts.js  : current.js,
    img: opts.img !== undefined ? !!opts.img : current.img
  };
  if (!next.js && !next.img) {
    delete sites[host];
  } else {
    sites[host] = next;
  }
  settings.potatoSites = sites;
  await saveSettings(settings);

  const primaryPattern = `*://*.${host}/*`;
  if (chrome.contentSettings) {
    try {
      await chrome.contentSettings.javascript.set({
        primaryPattern,
        setting: next.js ? 'block' : 'allow'
      });
    } catch (e) {}
    try {
      await chrome.contentSettings.images.set({
        primaryPattern,
        setting: next.img ? 'block' : 'allow'
      });
    } catch (e) {}
  }
  return true;
}

// ---------- BOOST — tab-ephemeral aggressive blocking (1.1.1 rewrite) ----------
// Stores per-tab rule IDs in memory. On tab close OR navigation away from the
// boosted host, the rule is torn down. Never persists to storage or
// contentSettings, so closing the tab fully reverts the state.

const boostedTabs = new Map(); // tabId → { ruleId, host }
let boostRuleCounter = 0;

function nextBoostRuleId() {
  // 100-slot ring inside [30000, 30099].
  boostRuleCounter = (boostRuleCounter + 1) % 100;
  return BOOST_RULE_BASE + boostRuleCounter;
}

async function boostTab(tabId, host) {
  if (typeof tabId !== 'number' || tabId < 0) return false;
  if (!isValidInitiatorDomain(host)) return false;

  return withLock('dnr', async () => {
    // Clear any existing boost rule for this tab first.
    const prev = boostedTabs.get(tabId);
    const removeRuleIds = prev ? [prev.ruleId] : [];

    const ruleId = nextBoostRuleId();
    const addRules = [
      buildThirdPartyBlockRule(ruleId, 'image', null, [tabId]),
      // Also block 3rd-party scripts + media on the boosted tab. We use a
      // single rule per resource type by reusing the same ID range with an
      // offset of +50 within the ring (still within [30000, 30099]).
    ];

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
      boostedTabs.set(tabId, { ruleId, host });
      try { await chrome.tabs.reload(tabId); } catch (e) {}
      return true;
    } catch (e) {
      console.warn('[Potatofy] boost install failed:', e);
      return false;
    }
  });
}

async function clearBoostForTab(tabId) {
  const info = boostedTabs.get(tabId);
  if (!info) return;
  boostedTabs.delete(tabId);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [info.ruleId], addRules: [] });
  } catch (e) {}
}

async function maybeClearBoostOnNavigation(tabId, newUrl) {
  const info = boostedTabs.get(tabId);
  if (!info || !newUrl) return;
  try {
    const u = new URL(newUrl);
    const newHost = u.hostname.replace(/^www\./, '').toLowerCase();
    if (newHost !== info.host && !newHost.endsWith('.' + info.host)) {
      await clearBoostForTab(tabId);
    }
  } catch (e) {}
}

// ---------- Tab discard ----------

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
  const now = Date.now();
  const windows = await chrome.windows.getAll({ populate: true });

  const candidates = [];
  for (const win of windows) {
    const activeTab = (win.tabs || []).find(t => t.active);
    const activeId = activeTab ? activeTab.id : -1;
    for (const tab of (win.tabs || [])) {
      if (shouldSkipTabForDiscard(tab, activeId)) continue;
      if (minIdleMs > 0) {
        const lastActive = tabLastActive.get(tab.id) || 0;
        if (now - lastActive < minIdleMs) continue;
      }
      candidates.push(tab.id);
    }
  }
  if (candidates.length === 0) return 0;

  const results = await Promise.allSettled(candidates.map(id => chrome.tabs.discard(id)));
  const discarded = results.filter(r => r.status === 'fulfilled').length;
  if (discarded > 0) bufferIncrement({ tabsDiscarded: discarded });
  return discarded;
}

async function checkIdleTabs() {
  await _wakeReady;
  const settings = await getSettings();
  if (!settings.tabSuspendEnabled) return;
  const minutes = ALLOWED_THRESHOLDS.includes(Number(settings.idleThresholdMinutes))
    ? Number(settings.idleThresholdMinutes)
    : 5;
  const idleMs = Math.max(1, minutes) * 60 * 1000;
  await discardEligibleTabs({ minIdleMs: idleMs });
}

// ---------- Memory pressure ----------

async function getDeviceCapacityMB() {
  try {
    const s = await chrome.storage.session.get('deviceCapacityMB');
    if (s.deviceCapacityMB) return s.deviceCapacityMB;
    if (!chrome.system || !chrome.system.memory) return null;
    const info = await chrome.system.memory.getInfo();
    const cap = Math.round((info.capacity || 0) / (1024 * 1024));
    if (cap > 0) await chrome.storage.session.set({ deviceCapacityMB: cap });
    return cap || null;
  } catch (e) {
    return null;
  }
}

async function checkMemoryPressure() {
  await _wakeReady;
  const settings = await getSettings();
  if (!settings.tabSuspendEnabled) return;
  if (!settings.memoryPressureEnabled) return;
  if (!chrome.system || !chrome.system.memory) return;
  try {
    const info = await chrome.system.memory.getInfo();
    const freeMB = (info.availableCapacity || 0) / (1024 * 1024);
    const totalMB = (info.capacity || 0) / (1024 * 1024);
    const absoluteMB = Number(settings.memoryPressureThresholdMB) || 500;

    const cap = await getDeviceCapacityMB();
    let pctMin;
    if (cap && cap < 2048)      pctMin = 0.25;
    else if (cap && cap < 4096) pctMin = 0.20;
    else                        pctMin = 0.15;

    const freePct = totalMB > 0 ? freeMB / totalMB : 1;
    if (freeMB < absoluteMB || freePct < pctMin) {
      await discardEligibleTabs({ minIdleMs: PRESSURE_MIN_AGE_MS });
    }
  } catch (e) {}
}

// ---------- DNR feedback (production-safe via polling) ----------
// `onRuleMatchedDebug` only fires for unpacked extensions. `getMatchedRules`
// works in both modes when `declarativeNetRequestFeedback` is granted, but
// only returns matches from the last ~5 minutes in production. We poll once
// a minute and dedupe by timestamp.

function classifyMatch(rule) {
  if (!rule) return null;
  if (rule.ruleId === DYNAMIC_RULE_3P_SCRIPT_ID) return 'thirdPartyScriptsBlocked';
  if (rule.ruleId === DYNAMIC_RULE_3P_IMAGE_ID)  return 'thirdPartyImagesBlocked';
  if (rule.ruleId >= BOOST_RULE_BASE && rule.ruleId < BOOST_RULE_BASE + 100) return 'thirdPartyImagesBlocked';
  if (rule.ruleId >= DYNAMIC_RULE_WHITELIST_BASE && rule.ruleId < DYNAMIC_RULE_3P_SCRIPT_ID) return null;
  if (rule.rulesetId === FONT_RULESET_ID) return 'blockedFonts';
  return 'blockedRequests';
}

async function pollDNRMatches() {
  await _wakeReady;
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.getMatchedRules) return;
  try {
    const session = await chrome.storage.session.get('dnrLastPollTs');
    const lastTs = Number(session.dnrLastPollTs) || (Date.now() - DNR_POLL_WINDOW_MS);
    const filter = { minTimeStamp: lastTs };
    const result = await chrome.declarativeNetRequest.getMatchedRules(filter);
    const matches = (result && result.rulesMatchedInfo) || [];
    if (matches.length === 0) {
      await chrome.storage.session.set({ dnrLastPollTs: Date.now() });
      return;
    }
    const patch = Object.create(null);
    let newestTs = lastTs;
    for (const m of matches) {
      const key = classifyMatch(m.rule);
      if (!key) continue;
      patch[key] = (patch[key] || 0) + 1;
      if (m.timeStamp > newestTs) newestTs = m.timeStamp;
    }
    if (Object.keys(patch).length > 0) {
      await bufferIncrement(patch);
    }
    // Advance past the newest seen, plus 1ms to avoid re-counting the same.
    await chrome.storage.session.set({ dnrLastPollTs: newestTs + 1 });
  } catch (e) {
    // getMatchedRules throws if quota is exceeded; safe to skip and retry.
  }
}

// Dev-only real-time path. In production this listener never fires, but
// keeping it active in dev gives faster feedback when iterating locally.
if (!IS_PACKAGED &&
    chrome.declarativeNetRequest &&
    chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const key = classifyMatch(info && info.rule);
    if (key) bufferIncrement({ [key]: 1 });
  });
}

// ---------- Alarms ----------

function setupAlarms() {
  chrome.alarms.create(ALARM_IDLE,        { periodInMinutes: 1 });
  chrome.alarms.create(ALARM_STATS_FLUSH, { periodInMinutes: 0.5 });
  chrome.alarms.create(ALARM_TAB_PERSIST, { periodInMinutes: 0.5 });
  chrome.alarms.create(ALARM_DNR_POLL,    { periodInMinutes: 1 });
  try {
    chrome.alarms.create(ALARM_PRESSURE, { periodInMinutes: 0.5 });
  } catch (e) {
    chrome.alarms.create(ALARM_PRESSURE, { periodInMinutes: 1 });
  }
}

// ---------- Lifecycle ----------

async function bootstrap(isStartup) {
  await migrateLegacySync();
  const settings = await getSettings();
  if (!isStartup) {
    await saveSettings({ ...DEFAULT_SETTINGS, ...settings });
  }
  // Wrap DNR work in the dnr lock to serialize against any message-handler
  // updates that arrive concurrently.
  await withLock('dnr', async () => {
    await reconcileStaticRulesets(settings);
  });
  await syncDynamicRules();
  await syncPotatoSites();
  await getDeviceCapacityMB();
  await rehydrateTabLastActive();
  await rehydrateStatsHot();
  setupAlarms();
  if (isStartup) {
    const stats = await getStats();
    stats.session = { ...EMPTY_COUNTERS, since: Date.now() };
    await chrome.storage.local.set({ stats });
  }
  updateBadge();
}

// Every SW wake re-runs this top-level. Kick off rehydration eagerly so
// alarm handlers awaiting _wakeReady get fresh in-memory state.
const _wakeReady = (async () => {
  await rehydrateTabLastActive();
  await rehydrateStatsHot();
})().catch(e => console.error('[Potatofy] wake-rehydrate failed', e));

chrome.runtime.onInstalled.addListener(() => { bootstrap(false); });
chrome.runtime.onStartup.addListener(() => { bootstrap(true); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_IDLE)             checkIdleTabs();
  else if (alarm.name === ALARM_PRESSURE)    checkMemoryPressure();
  else if (alarm.name === ALARM_STATS_FLUSH) flushStatsHotToLocal();
  else if (alarm.name === ALARM_TAB_PERSIST) persistTabLastActive();
  else if (alarm.name === ALARM_DNR_POLL)    pollDNRMatches();
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  updateTabActivity(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    updateTabActivity(tabId);
  }
  // Auto-clear boost when the user navigates the tab to a different host.
  if (changeInfo.url) {
    maybeClearBoostOnNavigation(tabId, changeInfo.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabActivity(tabId);
  clearBoostForTab(tabId);
});

chrome.runtime.onSuspend.addListener(() => {
  persistTabLastActive();
  flushStatsHotToLocal();
});

// ---------- Messages ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'GET_SETTINGS') {
    (async () => {
      const settings = await getSettings();
      sendResponse({ settings });
    })();
    return true;
  }

  if (msg.type === 'UPDATE_SETTINGS') {
    (async () => {
      const settings = { ...DEFAULT_SETTINGS, ...(msg.settings || {}) };
      await saveSettings(settings);
      await reconcileStaticRulesets(settings);
      await syncDynamicRules();
      await syncPotatoSites();
      sendResponse({ ok: true });
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
      await flushStatsHotToLocal();
      const stats = await getStats();
      const cap = await getDeviceCapacityMB();
      sendResponse({
        stats,
        weights: STATS_WEIGHTS,
        deviceCapacityMB: cap,
        savings: {
          session:  computeSavings(stats.session),
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

  if (msg.type === 'TOGGLE_POTATO_SITE') {
    (async () => {
      const ok = await setPotatoSite(msg.host, { js: msg.js, img: msg.img });
      sendResponse({ ok });
    })();
    return true;
  }

  if (msg.type === 'BOOST_TAB') {
    // 1.1.1: tab-ephemeral. Installs a tabIds-scoped DNR rule and reloads
    // the tab. No contentSettings writes, no persisted state.
    (async () => {
      const tabId = Number(msg.tabId);
      const host = msg.host;
      if (!Number.isFinite(tabId) || tabId < 0) {
        sendResponse({ ok: false, reason: 'invalid_tab' });
        return;
      }
      const ok = await boostTab(tabId, host);
      sendResponse({ ok });
    })();
    return true;
  }

  if (msg.type === 'CLEAR_BOOST') {
    (async () => {
      const tabId = Number(msg.tabId);
      if (Number.isFinite(tabId)) await clearBoostForTab(tabId);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'GET_BOOST_STATUS') {
    const tabId = Number(msg.tabId);
    sendResponse({ boosted: boostedTabs.has(tabId) });
    return false;
  }

  if (msg.type === 'GET_SITE_KILLERS') {
    (async () => {
      try {
        const res = await fetch(SITE_KILLERS_URL);
        const data = await res.json();
        sendResponse({ ok: true, killers: data });
      } catch (e) {
        sendResponse({ ok: false, killers: {} });
      }
    })();
    return true;
  }
});
