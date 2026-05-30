import { DEFAULT_SETTINGS, ALLOWED_THRESHOLDS, ALLOWED_PRESSURE_MB } from './lib/defaults.js';
import { STATS_WEIGHTS, EMPTY_COUNTERS, computeSavings, median } from './lib/stats-weights.js';

// Per-flush upper bound on stat increments. Guards against compromised content
// scripts or buggy reporters from corrupting lifetime counters with absurd
// values (e.g. Number.MAX_SAFE_INTEGER). Per-second pageload counts realistic
// only into the low thousands; 100k gives ~50x headroom.
const MAX_INCREMENT = 100_000;

// Phase 3 — upper bound on a single heap measurement. V8's practical heap
// limit is ~4 GB; 512 MB is a generous ceiling for any single feature's delta.
const MAX_HEAP_FREED_BYTES = 512 * 1024 * 1024;

// 1.1.3 — absolute counter ceiling. Even at MAX_INCREMENT per message and
// the per-tab rate limit below, a long-lived attack could still inflate a
// single counter past this without the ceiling. 1B is far above any plausible
// lifetime display value (Chrome traces top out around 10-100M for the heaviest
// counters), and stays well inside JS safe-integer range.
const MAX_COUNTER_VALUE = 1_000_000_000;

// 1.1.3 — per-tab rate limit for STATS_INCREMENT. Page scripts in the
// MAIN-world context can call this handler. Cap each tab to STATS_RATE_MAX
// messages per STATS_RATE_WINDOW_MS. Excess is dropped silently so the page
// cannot infer the rate limit and adapt to it.
const STATS_RATE_WINDOW_MS = 10_000;
const STATS_RATE_MAX = 500;
const statsRateByTab = new Map(); // tabId -> { windowStart, count }

const BOOLEAN_SETTING_KEYS = [
  'blockingEnabled', 'tabSuspendEnabled', 'jsThrottleEnabled',
  'imageLazyEnabled', 'imageLowQualityEnabled', 'animationKillEnabled',
  'autoplayKillEnabled', 'prefetchStripEnabled', 'videoPauseEnabled',
  'videoPreloadNoneEnabled', 'thirdPartyScriptBlockEnabled',
  'foregroundPotatoEnabled', 'siteKillersEnabled', 'memoryPressureEnabled',
  'useCloudSync', 'syncHostsToCloud'
];

const PRIVILEGED_MESSAGE_TYPES = new Set([
  // Writes
  'UPDATE_SETTINGS', 'BOOST_TAB', 'CLEAR_BOOST', 'DISCARD_NOW',
  'RESET_STATS', 'TOGGLE_POTATO_SITE',
  // Reads that leak host lists, stats, or extension state. All callers are
  // popup / tests.js (sender.tab undefined) — the privileged check passes
  // them through. Page scripts in the MAIN-world content script's context
  // can reach chrome.runtime via window.chrome; this set keeps them out.
  'GET_SETTINGS', 'GET_STATS', 'GET_BOOST_STATUS', 'GET_SITE_KILLERS'
]);

const MAX_WHITELIST = 199; // base + 199 = 10199, last id inside [10000, 10200)

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
// N-2 — BOOST_RULE_BASE MUST stay divisible by 3. classifyMatch() decodes the
// resource type from ruleId % 3 (0→image, 1→script, 2→media), and
// nextBoostRuleIds() allocates 3-ID groups on that assumption. Changing this to
// a non-multiple-of-3 base would silently misclassify every boost match.
const BOOST_RULE_BASE             = 30000; // 30000-30099 — tab-scoped ephemeral boost rules

const PRESSURE_MIN_AGE_MS = 30 * 1000;
const DNR_POLL_WINDOW_MS  = 5 * 60 * 1000; // getMatchedRules() in production looks back 5 min

const SITE_KILLERS_URL = chrome.runtime.getURL('rules/site-killers.json');

// In-memory cache of site-killers.json. Loaded once per SW wake; survives
// for the SW's lifetime. Re-fetched on the next wake since SW termination
// drops the cache.
let siteKillerCache = null;
async function getSiteKillers() {
  if (siteKillerCache !== null) return siteKillerCache;
  try {
    const res = await fetch(SITE_KILLERS_URL);
    siteKillerCache = await res.json();
  } catch (e) {
    siteKillerCache = {};
  }
  return siteKillerCache;
}

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

// 1.1.3 — synchronous detail builder. Used by both buildContentDetail (which
// fetches settings + killerMap from storage) and broadcastSettingsUpdate
// (which fetches them ONCE outside the loop). Avoids N×storage I/O per
// settings change.
function buildContentDetailFromCache(hostname, settings, killerMap) {
  const whitelisted = isHostWhitelisted(hostname, settings.whitelist);
  const siteKillers = (settings.siteKillersEnabled && !whitelisted)
    ? killersForHost(hostname, killerMap)
    : [];
  return {
    jsThrottleEnabled:       !!settings.jsThrottleEnabled       && !whitelisted,
    imageLazyEnabled:        !!settings.imageLazyEnabled        && !whitelisted,
    imageLowQualityEnabled:  !!settings.imageLowQualityEnabled  && !whitelisted,
    animationKillEnabled:    !!settings.animationKillEnabled    && !whitelisted,
    autoplayKillEnabled:     !!settings.autoplayKillEnabled     && !whitelisted,
    prefetchStripEnabled:    !!settings.prefetchStripEnabled    && !whitelisted,
    videoPauseEnabled:       !!settings.videoPauseEnabled       && !whitelisted,
    videoPreloadNoneEnabled: !!settings.videoPreloadNoneEnabled && !whitelisted,
    siteKillersEnabled:      !!settings.siteKillersEnabled      && !whitelisted,
    siteKillers
  };
}

async function buildContentDetail(hostname) {
  const settings = await getSettings();
  const killerMap = await getSiteKillers();
  return buildContentDetailFromCache(hostname, settings, killerMap);
}

// Broadcast settings update to every content script in every tab. Used by the
// chrome.storage.onChanged listener so popup/settings changes propagate
// without the isolated/MAIN-world CustomEvent bus (which was the Finding 1
// attack surface). chrome.tabs.sendMessage delivers to all content scripts
// in the tab; MAIN-world scripts receive via chrome.runtime.onMessage.
//
// 1.1.3 — settings + killerMap are fetched ONCE per broadcast (was N times).
async function broadcastSettingsUpdate() {
  let tabs, settings, killerMap;
  try {
    [tabs, settings, killerMap] = await Promise.all([
      chrome.tabs.query({}),
      getSettings(),
      getSiteKillers()
    ]);
  } catch (e) { return; }
  // N-5 — fan the per-tab sends out in parallel instead of awaiting each in a
  // serial loop. On a Pi with many tabs the serial version added up to a
  // noticeable broadcast latency; allSettled tolerates tabs without a content
  // script (chrome:// URLs etc.) the same way the old per-tab catch did.
  const sends = [];
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (!/^https?:/.test(tab.url)) continue;
    let hostname = '';
    try { hostname = new URL(tab.url).hostname; } catch (e) { continue; }
    const detail = buildContentDetailFromCache(hostname, settings, killerMap);
    sends.push(chrome.tabs.sendMessage(tab.id, { type: 'POTATOFY_SETTINGS_UPDATE', detail }));
  }
  await Promise.allSettled(sends);
}

// 1.1.3 — coalesce rapid settings changes so 5 quick toggles produce 1
// broadcast instead of 5. 50ms is short enough to feel instant but long
// enough to merge a typical click burst.
let broadcastTimer = null;
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastSettingsUpdate();
  }, 50);
}

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
  // 1.1.3 — serialize the local + sync writes so two rapid UPDATE_SETTINGS
  // calls cannot interleave their sync writes and leave the sync store with
  // a stale older value (Sec.MEDIUM.11).
  return withLock('settings', async () => {
    await chrome.storage.local.set({ settings });
    if (settings.useCloudSync) {
      // Privacy default: ship only feature toggles + numeric thresholds. The
      // whitelist and per-site potato map describe browsing habits and stay
      // local unless the user explicitly opts in via syncHostsToCloud.
      const syncPayload = { ...settings };
      if (!settings.syncHostsToCloud) {
        delete syncPayload.whitelist;
        delete syncPayload.potatoSites;
        // 1.1.3 — actively purge host data that pre-existed the opt-out.
        // Without this, a previously-synced whitelist lingers on Google's
        // servers and can be re-imported on a fresh device via
        // migrateLegacySync (Sec.HIGH.4).
        try {
          const existing = await chrome.storage.sync.get('settings');
          if (existing.settings && (existing.settings.whitelist || existing.settings.potatoSites)) {
            const cleaned = { ...existing.settings };
            delete cleaned.whitelist;
            delete cleaned.potatoSites;
            await chrome.storage.sync.set({ settings: cleaned });
          }
        } catch (e) {}
      }
      try { await chrome.storage.sync.set({ settings: syncPayload }); } catch (e) {}
    } else {
      // useCloudSync off entirely — wipe the sync area so nothing lives on
      // Google's servers. Opting out IS the consent; no confirmation prompt.
      try { await chrome.storage.sync.clear(); } catch (e) {}
    }
  });
}

async function migrateLegacySync() {
  const local = await chrome.storage.local.get('settings');
  if (local.settings) return;
  try {
    const sync = await chrome.storage.sync.get('settings');
    if (sync.settings) {
      const validated = validateSettings({ ...sync.settings, useCloudSync: false });
      await chrome.storage.local.set({ settings: validated });
      // 1.1.3 — purge the sync copy after migration so a third device cannot
      // pick it up. If the user wanted cloud sync, they will opt in again
      // on the new device and saveSettings will rewrite the sync payload.
      try { await chrome.storage.sync.remove('settings'); } catch (e) {}
    }
  } catch (e) {}
}

// ---------- Settings validation ----------
// Single boundary check. Used by every storage-writing path so malformed
// inputs (compromised sync, buggy popup, hypothetical future content-script
// sender) can't poison stored state with wrong-shaped fields.

function validateSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of BOOLEAN_SETTING_KEYS) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  const idleN = Number(raw.idleThresholdMinutes);
  if (ALLOWED_THRESHOLDS.includes(idleN)) out.idleThresholdMinutes = idleN;
  const pressureN = Number(raw.memoryPressureThresholdMB);
  if (ALLOWED_PRESSURE_MB.includes(pressureN)) out.memoryPressureThresholdMB = pressureN;
  if (Array.isArray(raw.whitelist)) {
    out.whitelist = raw.whitelist
      .filter(h => typeof h === 'string' && isValidInitiatorDomain(h))
      .slice(0, MAX_WHITELIST);
  }
  // 1.1.3 — explicit Object.prototype check guards against prototype-pollution
  // sources that aren't plain literals (Proxy, Object.create(null), modified
  // prototypes from a compromised parse path). Output uses Object.create(null)
  // so even a future bug here cannot pollute Object.prototype downstream.
  // M-5 — accept both a plain-object and a null-prototype map. The validator's
  // own output uses Object.create(null); requiring exactly Object.prototype
  // meant a re-validation of that output (same SW lifetime) would silently wipe
  // every per-site override. null and Object.prototype are both pollution-safe.
  const potatoProto = raw.potatoSites && typeof raw.potatoSites === 'object'
    ? Object.getPrototypeOf(raw.potatoSites)
    : false;
  if (
    raw.potatoSites &&
    typeof raw.potatoSites === 'object' &&
    !Array.isArray(raw.potatoSites) &&
    (potatoProto === Object.prototype || potatoProto === null)
  ) {
    const sites = Object.create(null);
    for (const [k, v] of Object.entries(raw.potatoSites)) {
      if (isValidInitiatorDomain(k) && v && typeof v === 'object' && !Array.isArray(v)) {
        sites[k] = { js: !!v.js, img: !!v.img };
      }
    }
    out.potatoSites = sites;
  }
  return out;
}

// ---------- Promise lock ----------

const lockChains = new Map();

function withLock(key, fn) {
  const prev = lockChains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => fn());
  const chain = next.finally(() => {
    if (lockChains.get(key) === chain) lockChains.delete(key);
  });
  // NEW-BUG-3 — `chain` (the finallyPromise stored in lockChains) has no
  // rejection handler between lock tasks: it's only "handled" when the NEXT
  // withLock call does prev.catch(()=>{}) on it. In the window between those
  // two calls DevTools reports an unhandled rejection. Attaching .catch here
  // closes that window without swallowing the rejection seen by awaiting callers
  // (those await `next`, a separate promise branch).
  chain.catch(() => {});
  lockChains.set(key, chain);
  // M-1 / L-7 — guard `next` too so a future non-awaited withLock() call
  // surfaces its rejection as a visible warning instead of silence.
  next.catch(e => console.warn('[Potatofy] lock task rejected:', key, e && e.message ? e.message : e));
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
    // 1.1.3 — clamp to MAX_COUNTER_VALUE so sustained abuse cannot drive
    // a counter to MAX_SAFE_INTEGER or exhaust storage quota over a long run.
    statsHot[k] = Math.min((statsHot[k] || 0) + v, MAX_COUNTER_VALUE);
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
      // M-4 / SEC-2 — clamp the persistent accumulation at MAX_COUNTER_VALUE.
      // bufferIncrement caps the hot buffer, but the flush had no ceiling, so
      // sustained STATS_INCREMENT abuse across tabs/SW restarts could drift a
      // stored counter past Number.MAX_SAFE_INTEGER and corrupt displayed values.
      s.session[k]  = Math.min((s.session[k]  || 0) + v, MAX_COUNTER_VALUE);
      s.lifetime[k] = Math.min((s.lifetime[k] || 0) + v, MAX_COUNTER_VALUE);
      statsHot[k] = 0;
    }
    try {
      await chrome.storage.local.set({ stats: s });
    } catch (e) {
      // 1.1.3 — surface quota-exhaustion failures instead of swallowing.
      console.warn('[Potatofy] stats flush failed:', e && e.message ? e.message : e);
    }
    try { await chrome.storage.session.set({ statsHot }); } catch (e) {}
    updateBadge();
  });
}

// Phase 3 — whitelisted feature names for heap measurements.
const VALID_HEAP_FEATURES = new Set([
  'animationsKilled', 'videosPaused', 'videosPreloadNoned',
  'autoplayKilled', 'imagesLazied', 'siteKillerHits'
]);

// Phase 2 — validates that calibration data from content script has the
// expected shape before writing to storage.
function isValidCalibrationData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  for (const k of ['trackers', 'ads', 'fonts', 'scripts', 'images']) {
    if (!Number.isFinite(d[k]) || d[k] < 0) return false;
  }
  return true;
}

// 1.1.3 — per-tab rate limiter for STATS_INCREMENT. Returns true if the call
// is within the per-tab budget; false drops silently. Pages that probe should
// observe identical no-op behavior whether they were below or above the cap.
function statsRateAllow(tabId) {
  if (tabId == null) return true; // popup/test calls (no tab) are unmetered
  const now = Date.now();
  const entry = statsRateByTab.get(tabId);
  if (!entry || now - entry.windowStart > STATS_RATE_WINDOW_MS) {
    statsRateByTab.set(tabId, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= STATS_RATE_MAX) return false;
  entry.count++;
  return true;
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
  // syncDynamicRulesLocked owns whitelist + global 3p block ranges.
  // Boost rules (30000-30099) are NOT managed here — they're tab-scoped and
  // cleaned by separate handlers, so a settings change must not wipe them.
  return (id >= DYNAMIC_RULE_WHITELIST_BASE && id < DYNAMIC_RULE_WHITELIST_BASE + 200) ||
         id === DYNAMIC_RULE_3P_SCRIPT_ID ||
         id === DYNAMIC_RULE_3P_IMAGE_ID;
}

// ---------- DNR sync (whitelist + global 3rd-party blocks) ----------

// PRECONDITION: caller must hold withLock('dnr'). Both call sites (bootstrap,
// UPDATE_SETTINGS) run reconcileStaticRulesets + this + syncPotatoSites under
// ONE lock acquisition (H-5) instead of releasing and re-acquiring between them.
async function syncDynamicRulesLocked() {
  {
    const settings = await getSettings();
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    // Only touch IDs we own. Boost rules (30000+) are managed separately and
    // must survive a settings update.
    const removeRuleIds = Array.from(new Set(existing.filter(r => inManagedRange(r.id)).map(r => r.id)));

    // Hard cap at MAX_WHITELIST so we never emit IDs outside [10000, 10200).
    // Anything past the cap would orphan rules — inManagedRange wouldn't pick
    // them up on the next sync and they'd accumulate until the 5000-rule
    // dynamic budget is exhausted.
    const valid = (settings.whitelist || [])
      .filter(isValidInitiatorDomain)
      .slice(0, MAX_WHITELIST);
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
  }
}

// ---------- Static rulesets ----------
// PRECONDITION: caller must hold withLock('dnr'). Both call sites (bootstrap,
// UPDATE_SETTINGS) wrap this; nothing else should call it directly.

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
    for (const primaryPattern of [`*://*.${host}/*`, `*://${host}/*`]) {
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

  if (chrome.contentSettings) {
    for (const primaryPattern of [`*://*.${host}/*`, `*://${host}/*`]) {
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
  }
  return true;
}

// ---------- BOOST — tab-ephemeral aggressive blocking (1.1.1 rewrite) ----------
// Stores per-tab rule IDs in memory and session storage. On tab close OR
// navigation away from the boosted host, rules are torn down. Each boost
// installs 3 consecutive rules: image(+0), script(+1), media(+2), using a
// 33-slot ring within [30000, 30098] (3 IDs per slot).

const boostedTabs = new Map(); // tabId → { ruleIds: [id, id+1, id+2], host }
// Start at -3 so the first nextBoostRuleIds() call lands on slot 0
// ([30000, 30001, 30002]). A 0 init would skip slot 0 entirely on fresh starts
// yet allow rehydrateBoostedTabs to restore something at slot 0 — the
// resulting mismatch would mark a live restored entry as an orphan.
let boostRuleCounter = -3;
let boostedTabsDirty = false;

function nextBoostRuleIds() {
  // 33-slot ring of 3-ID groups inside [30000, 30098]. BOOST_RULE_BASE (30000)
  // is divisible by 3, so ruleId % 3 reliably encodes resource type:
  // 0 → image, 1 → script, 2 → media. Returns { ids, evictedIds } — when all
  // 33 slots are held by live boosts the oldest entry is evicted from the map
  // and its rule IDs are returned so the caller folds them into the install's
  // removeRuleIds (avoids "rule already exists" failures and races).
  for (let attempts = 0; attempts < 33; attempts++) {
    boostRuleCounter = (boostRuleCounter + 3) % 99;
    const base = BOOST_RULE_BASE + boostRuleCounter;
    let inUse = false;
    for (const v of boostedTabs.values()) {
      if (v.ruleIds && v.ruleIds[0] === base) { inUse = true; break; }
    }
    if (!inUse) return { ids: [base, base + 1, base + 2], evictedIds: [] };
  }
  // 1.1.3 — All 33 slots held. Evict the oldest (Map preserves insertion
  // order) AND reuse its own base offset for the new allocation. The previous
  // code advanced boostRuleCounter by +3 after 33 iterations, which lands on
  // (pre_loop + 3) % 99 — typically slot 0, even when the evicted slot was
  // slot K ≠ 0. That caused "rule already exists" failures after a SW
  // rehydration where the oldest Map entry was not at slot 0 (Code.HIGH.5).
  const oldestKey = boostedTabs.keys().next().value;
  let evictedIds = [];
  if (oldestKey !== undefined) {
    const info = boostedTabs.get(oldestKey);
    if (info && Array.isArray(info.ruleIds)) evictedIds = info.ruleIds;
    boostedTabs.delete(oldestKey);
    boostedTabsDirty = true;
  }
  let base;
  if (evictedIds.length > 0) {
    base = evictedIds[0];
    boostRuleCounter = base - BOOST_RULE_BASE;
  } else {
    boostRuleCounter = (boostRuleCounter + 3) % 99;
    base = BOOST_RULE_BASE + boostRuleCounter;
  }
  return { ids: [base, base + 1, base + 2], evictedIds };
}

async function persistBoostedTabs() {
  if (!boostedTabsDirty) return;
  boostedTabsDirty = false;
  const obj = {};
  for (const [k, v] of boostedTabs) obj[String(k)] = v;
  try { await chrome.storage.session.set({ boostedTabs: obj }); } catch (e) {}
}

async function rehydrateBoostedTabs() {
  try {
    const s = await chrome.storage.session.get('boostedTabs');
    const obj = s.boostedTabs || {};
    boostedTabs.clear();
    for (const [k, v] of Object.entries(obj)) {
      const tabId = Number(k);
      if (!isNaN(tabId) && v && Array.isArray(v.ruleIds)) {
        boostedTabs.set(tabId, v);
        // M-7 — bias boostRuleCounter toward the highest restored slot so the
        // next allocation tends to start beyond live entries. This is a hint,
        // not a guarantee of contiguity: nextBoostRuleIds() still scans the ring
        // and skips any slot already held in boostedTabs, so a non-contiguous
        // restore (e.g. slots 0 and 32 live) is handled correctly regardless.
        for (const id of v.ruleIds) {
          const offset = id - BOOST_RULE_BASE;
          if (offset >= 0 && offset < 99) {
            const base = offset - (offset % 3);
            if (base > boostRuleCounter) boostRuleCounter = base;
          }
        }
      }
    }
    // GC orphaned boost rules not represented in the restored map.
    const allRuleIds = new Set([...boostedTabs.values()].flatMap(v => v.ruleIds));
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const orphanIds = existing
      .filter(r => r.id >= BOOST_RULE_BASE && r.id < BOOST_RULE_BASE + 100 && !allRuleIds.has(r.id))
      .map(r => r.id);
    if (orphanIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: orphanIds, addRules: [] });
    }
  } catch (e) {}
}

async function boostTab(tabId, host) {
  if (typeof tabId !== 'number' || tabId < 0) return { ok: false, reason: 'invalid_tab' };
  if (!isValidInitiatorDomain(host)) return { ok: false, reason: 'invalid_host' };

  return withLock('dnr', async () => {
    // M-2 — verify that the tab claimed by `tabId` is actually on `host` INSIDE
    // the lock, immediately before the rule install. Doing this outside the lock
    // left a TOCTOU window where the tab could navigate between the check and the
    // install, so boost rules (and the stored info.host that navigation-clear
    // keys off) could end up bound to the wrong site. chrome.tabs.get failure is
    // a soft-pass — a non-existent tab's tabIds-scoped DNR rule is a harmless
    // no-op, and we still want the whitelist / install_failed paths to surface.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url) {
        let tabHost = '';
        try { tabHost = new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) {}
        const claim = host.replace(/^www\./, '').toLowerCase();
        if (tabHost && tabHost !== claim && !tabHost.endsWith('.' + claim)) {
          return { ok: false, reason: 'host_mismatch' };
        }
      }
    } catch (e) {
      // tab not found — fall through
    }

    // 1.1.3 — whitelist check lives INSIDE the lock so a concurrent
    // UPDATE_SETTINGS that adds `host` to the whitelist cannot complete
    // between our pre-check and the rule install. Boost rules use priority
    // 50; whitelist allow rules use priority 100 — installing both would
    // silently no-op the boost and lie to the popup.
    // M-9 — use isHostWhitelisted so `www.` normalization matches the canonical
    // whitelist path (the old inline check missed `www.example.com` vs `example.com`).
    const settings = await getSettings();
    if (isHostWhitelisted(host, settings.whitelist)) {
      return { ok: false, reason: 'whitelisted' };
    }

    const prev = boostedTabs.get(tabId);
    const { ids: [imgId, scriptId, mediaId], evictedIds } = nextBoostRuleIds();
    // Remove the previous boost for this tab + anything evicted from the ring.
    const removeRuleIds = [
      ...(prev ? prev.ruleIds : []),
      ...evictedIds
    ];
    const addRules = [
      buildThirdPartyBlockRule(imgId,    'image',  null, [tabId]),
      buildThirdPartyBlockRule(scriptId, 'script', null, [tabId]),
      buildThirdPartyBlockRule(mediaId,  'media',  null, [tabId]),
    ];

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
      boostedTabs.set(tabId, { ruleIds: [imgId, scriptId, mediaId], host });
      boostedTabsDirty = true;
      await persistBoostedTabs();
      try { await chrome.tabs.reload(tabId); } catch (e) {}
      return { ok: true };
    } catch (e) {
      console.warn('[Potatofy] boost install failed:', e);
      return { ok: false, reason: 'install_failed' };
    }
  });
}

async function clearBoostForTab(tabId) {
  const info = boostedTabs.get(tabId);
  if (!info) return;
  boostedTabs.delete(tabId);
  boostedTabsDirty = true;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: info.ruleIds, addRules: [] });
  } catch (e) {}
  await persistBoostedTabs();
}

async function maybeClearBoostOnNavigation(tabId, newUrl) {
  const info = boostedTabs.get(tabId);
  if (!info || !newUrl) return;
  // Ignore non-http(s) schemes (about:blank flashes during SPA routing,
  // data:, chrome://, etc.). new URL('about:blank') throws — the old catch
  // swallowed it but left the boost installed; that's actually what we want,
  // so make the intent explicit here.
  if (!newUrl.startsWith('http://') && !newUrl.startsWith('https://')) return;
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
  if (tab.url.startsWith('devtools://')) return true;
  if (tab.url.startsWith('about:')) return true;
  if (tab.url.startsWith('file://')) return true;
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

  // Measure free memory BEFORE discard
  let memBefore = null;
  try {
    if (chrome.system && chrome.system.memory) {
      const info = await chrome.system.memory.getInfo();
      memBefore = info.availableCapacity || 0;
    }
  } catch (e) {
    console.warn('[Potatofy] Failed to measure memory before discard:', e);
  }

  // Discard tabs
  const results = await Promise.allSettled(candidates.map(id => chrome.tabs.discard(id)));
  // L-2 — count only tabs Chrome actually discarded. chrome.tabs.discard
  // fulfills with the updated Tab (discarded:true) on success, but can also
  // fulfill with undefined when Chrome declines to discard — those must not
  // inflate the tabsDiscarded stat.
  const discarded = results.filter(r => r.status === 'fulfilled' && r.value && r.value.discarded).length;

  // Measure free memory AFTER discard and calculate real freed RAM
  if (discarded > 0) {
    let realFreedBytes = 0;
    try {
      if (chrome.system && chrome.system.memory && memBefore !== null) {
        const info = await chrome.system.memory.getInfo();
        const memAfter = info.availableCapacity || 0;
        // availableCapacity increases when memory is freed, so: freed = after - before
        realFreedBytes = Math.max(0, memAfter - memBefore);
      }
    } catch (e) {
      console.warn('[Potatofy] Failed to measure memory after discard:', e);
    }

    // Buffer both the discard count and real freed memory
    const increment = { tabsDiscarded: discarded };
    if (realFreedBytes > 0) {
      increment.realRamFreed = realFreedBytes;
    }
    bufferIncrement(increment);
  }
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
//
// The `declarativeNetRequestFeedback` permission in manifest.json exists for
// this polling path. In production, getMatchedRules returns only rule IDs and
// timestamps (NOT full URLs); the polled metadata stays inside the SW.

function classifyMatch(rule) {
  if (!rule) return null;
  if (rule.ruleId === DYNAMIC_RULE_3P_SCRIPT_ID) return 'thirdPartyScriptsBlocked';
  if (rule.ruleId === DYNAMIC_RULE_3P_IMAGE_ID)  return 'thirdPartyImagesBlocked';
  if (rule.ruleId >= BOOST_RULE_BASE && rule.ruleId < BOOST_RULE_BASE + 100) {
    const offset = rule.ruleId % 3;
    if (offset === 1) return 'thirdPartyScriptsBlocked';
    if (offset === 2) return 'blockedRequests'; // media, reuses request bucket
    return 'thirdPartyImagesBlocked';           // offset === 0
  }
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

async function setupAlarms() {
  // 15-second flush interval: onSuspend can't await async work, so any
  // counters still in the hot buffer when the SW is terminated are lost.
  // Halving the cadence halves the worst-case loss on Pi-class devices
  // where the SW gets terminated under memory pressure frequently.
  const desired = {
    [ALARM_IDLE]:        { periodInMinutes: 1    },
    [ALARM_STATS_FLUSH]: { periodInMinutes: 0.25 },
    [ALARM_TAB_PERSIST]: { periodInMinutes: 0.5  },
    [ALARM_DNR_POLL]:    { periodInMinutes: 1    },
    [ALARM_PRESSURE]:    { periodInMinutes: 0.5  },
  };
  for (const [name, opts] of Object.entries(desired)) {
    const existing = await chrome.alarms.get(name);
    // L-5 — recreate when the period changed across an extension upgrade.
    // Previously an existing alarm was left untouched, so a new version's
    // cadence wouldn't take effect until the extension was reinstalled.
    if (!existing || existing.periodInMinutes !== opts.periodInMinutes) {
      chrome.alarms.create(name, opts);
    }
  }
}

// ---------- Lifecycle ----------

async function bootstrap(isStartup) {
  await migrateLegacySync();
  // H-4 — wait for in-memory state (boostedTabs, tabLastActive, statsHot) to
  // rehydrate before saveSettings fires a storage.onChanged broadcast and before
  // any early GET_BOOST_STATUS query, so neither observes empty state.
  await _wakeReady;
  const settings = await getSettings();
  if (!isStartup) {
    await saveSettings({ ...DEFAULT_SETTINGS, ...settings });
  }
  // H-5 / M-8 — run the static-ruleset reconcile, dynamic-rule sync, and
  // per-site contentSettings sync under a SINGLE dnr lock acquisition. Splitting
  // them across separate locks left windows where a concurrent UPDATE_SETTINGS
  // could interleave and then be overwritten by bootstrap's later sync.
  //
  // NEW-BUG-2 — reconcileStaticRulesets previously received the pre-saveSettings
  // snapshot while syncDynamicRulesLocked/syncPotatoSites called getSettings()
  // internally and saw the post-save state. Re-read inside the lock so all three
  // functions operate on the same settings version.
  await withLock('dnr', async () => {
    const current = await getSettings();
    await reconcileStaticRulesets(current);
    await syncDynamicRulesLocked();
    await syncPotatoSites();
  });
  await getDeviceCapacityMB();
  await rehydrateTabLastActive();
  await rehydrateStatsHot();
  await rehydrateBoostedTabs();
  await setupAlarms();
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
  await rehydrateBoostedTabs();
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
  // H-2 — drop the per-tab rate-limit entry so statsRateByTab can't grow
  // unbounded across a long session of opening/closing tabs.
  statsRateByTab.delete(tabId);
});

chrome.runtime.onSuspend.addListener(() => {
  persistTabLastActive();
  flushStatsHotToLocal();
});

// ---------- Messages ----------

// ========== Message Handler ==========

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // Defense-in-depth sender validation. Manifest has no externally_connectable
  // so web pages can't reach this handler today, but a future content-script
  // bug or message-passing refactor could expose privileged operations.
  // Extension pages (popup) have sender.tab === undefined; content scripts
  // always have sender.tab set.
  if (PRIVILEGED_MESSAGE_TYPES.has(msg.type) && sender && sender.tab != null) {
    // Intentional: no sendResponse. Chrome closes the port and the caller
    // receives "runtime.lastError: message port closed". This is the desired
    // rejection signal — we don't want to confirm which message types exist
    // or whether validation rejected vs. failed for some other reason.
    return;
  }

  if (msg.type === 'GET_SETTINGS') {
    (async () => {
      const settings = await getSettings();
      sendResponse({ settings });
    })();
    return true;
  }

  if (msg.type === 'UPDATE_SETTINGS') {
    (async () => {
      const settings = validateSettings(msg.settings || {});
      await saveSettings(settings);
      // H-5 / M-8 — reconcile + dynamic-rule sync + per-site sync under a single
      // dnr lock so concurrent UPDATE_SETTINGS / boost installs can't interleave.
      await withLock('dnr', async () => {
        await reconcileStaticRulesets(settings);
        await syncDynamicRulesLocked();
        await syncPotatoSites();
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'STATS_INCREMENT' && msg.patch) {
    // 1.1.3 — rate-limit per tab. Page scripts in MAIN-world content-script
    // context can reach this handler; the limit caps abuse without breaking
    // legitimate traffic from our own content script.
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!statsRateAllow(tabId)) {
      sendResponse({ ok: true });
      return false;
    }
    const safe = {};
    for (const k of Object.keys(EMPTY_COUNTERS)) {
      const v = Number(msg.patch[k]);
      if (Number.isFinite(v) && v > 0 && v <= MAX_INCREMENT) safe[k] = Math.floor(v);
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
      const storedCal = await chrome.storage.local.get('calibratedBandwidth');
      const calibration = storedCal.calibratedBandwidth || null;
      const storedHeap = await chrome.storage.local.get('heapMeasurements');
      const heapMeasurements = storedHeap.heapMeasurements || null;
      sendResponse({
        stats,
        weights: STATS_WEIGHTS,
        deviceCapacityMB: cap,
        calibration: calibration,
        heapMeasurements: heapMeasurements,
        savings: {
          session:  computeSavings(stats.session, calibration, heapMeasurements),
          lifetime: computeSavings(stats.lifetime, calibration, heapMeasurements)
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
    // the tab. No contentSettings writes, no persisted state. The result
    // shape is { ok, reason? } — popup uses reason to surface specific
    // failures (e.g. "whitelisted").
    (async () => {
      const tabId = Number(msg.tabId);
      const host = msg.host;
      if (!Number.isFinite(tabId) || tabId < 0) {
        sendResponse({ ok: false, reason: 'invalid_tab' });
        return;
      }
      const result = await boostTab(tabId, host);
      sendResponse(result);
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
      const killers = await getSiteKillers();
      sendResponse({ ok: true, killers });
    })();
    return true;
  }

  // 1.1.3: MAIN-world content scripts CAN reach chrome.runtime through
  // window.chrome, so this handler is also reachable from page scripts. To
  // prevent a whitelist-membership oracle (probe arbitrary hosts and observe
  // the all-false response that whitelisted hosts produce), ignore msg.host
  // when the sender is a content script and derive the host from sender.url
  // instead. Page scripts can only ask about their own host — which they
  // already know — so the oracle is closed.
  if (msg.type === 'GET_CONTENT_SETTINGS') {
    (async () => {
      let host = '';
      if (sender && sender.tab != null) {
        if (sender.url) {
          try { host = new URL(sender.url).hostname; } catch (e) {}
        }
      } else if (typeof msg.host === 'string') {
        host = msg.host;
      }
      try {
        const detail = await buildContentDetail(host);
        sendResponse({ ok: true, detail });
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === 'CALIBRATE_BANDWIDTH') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!statsRateAllow(tabId)) { sendResponse({ ok: true }); return false; }
    (async () => {
      try {
        if (!isValidCalibrationData(msg.data)) return;
        const stored = await chrome.storage.local.get('calibrationHistory');
        const history = stored.calibrationHistory || [];

        history.push(msg.data);
        if (history.length > 100) history.shift();

        const aggregated = {
          trackers: median(history.map(h => h.trackers).filter(x => x > 0)),
          ads: median(history.map(h => h.ads).filter(x => x > 0)),
          fonts: median(history.map(h => h.fonts).filter(x => x > 0)),
          scripts: median(history.map(h => h.scripts).filter(x => x > 0)),
          images: median(history.map(h => h.images).filter(x => x > 0)),
          lastUpdated: Date.now()
        };

        await chrome.storage.local.set({
          calibrationHistory: history,
          calibratedBandwidth: aggregated
        });
      } catch (e) {
        console.warn('[Potatofy] Bandwidth calibration failed:', e);
      }
    })();
    return false;
  }

  // ========== Phase 3: Heap Memory Measurement ==========
  if (msg.type === 'HEAP_MEASUREMENT') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!statsRateAllow(tabId)) { sendResponse({ ok: true }); return false; }
    (async () => {
      try {
        const feature = msg.feature;
        const freed = msg.freed;

        if (!VALID_HEAP_FEATURES.has(feature) || !Number.isFinite(freed) || freed <= 0 || freed > MAX_HEAP_FREED_BYTES) {
          return;
        }

        const stored = await chrome.storage.local.get('heapMeasurements');
        const measurements = stored.heapMeasurements || {};

        measurements[feature] = measurements[feature] || [];
        measurements[feature].push({
          freed: freed,
          timestamp: Date.now()
        });

        // Keep rolling window of last 100 measurements per feature.
        if (measurements[feature].length > 100) {
          measurements[feature] = measurements[feature].slice(-100);
        }

        await chrome.storage.local.set({ heapMeasurements: measurements });
      } catch (e) {
        console.warn('[Potatofy] Heap measurement storage failed:', e);
      }
    })();
    return false;
  }
});

// When settings change (popup toggle, sync, direct storage write), push the
// new per-host detail to every active content script. This replaces the
// chrome.storage.onChanged + CustomEvent path that the old isolated-world
// bridge used.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.settings) return;
  scheduleBroadcast();
});
