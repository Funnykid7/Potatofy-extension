import { DEFAULT_SETTINGS, ALLOWED_THRESHOLDS, ALLOWED_PRESSURE_MB } from './lib/defaults.js';
import { STATS_WEIGHTS, EMPTY_COUNTERS, computeSavings, median } from './lib/stats-weights.js';
import { normalizeHost } from './lib/formatters.js';

// Per-flush upper bound on stat increments. Guards against compromised content
// scripts or buggy reporters from corrupting lifetime counters with absurd
// values (e.g. Number.MAX_SAFE_INTEGER). Per-second pageload counts realistic
// only into the low thousands; 100k gives ~50x headroom.
const MAX_INCREMENT = 100_000;

// Phase 2 — upper bound per calibration category. Legitimate resource sizes
// stay well below 100 MB; values above this indicate a spoofed message from
// a page script trying to inflate the bandwidth-saved display.
const MAX_CALIBRATION_BYTES = 100_000_000;

// 1.1.3 — absolute counter ceiling. Even at MAX_INCREMENT per message and
// the per-tab rate limit below, a long-lived attack could still inflate a
// single counter past this without the ceiling. 1B is far above any plausible
// lifetime display value (Chrome traces top out around 10-100M for the heaviest
// counters), and stays well inside JS safe-integer range.
const MAX_COUNTER_VALUE = 1_000_000_000;

// Per-tab rate limit for STATS_INCREMENT (defense-in-depth; the legitimate sender
// is our own ISOLATED-world content script). Cap each tab to STATS_RATE_MAX
// messages per STATS_RATE_WINDOW_MS. Excess is dropped silently so a caller
// cannot infer the rate limit and adapt to it.
const STATS_RATE_WINDOW_MS = 10_000;
const STATS_RATE_MAX = 500;
const statsRateByTab = new Map(); // tabId -> { windowStart, count }
const calibRateByTab = new Map(); // tabId -> { windowStart, count } — separate budget for calibration/heap
const gcsRateByTab = new Map();   // tabId -> { windowStart, count } — GET_CONTENT_SETTINGS only,
                                   // so a calibration-heavy page can't exhaust the shared calibration
                                   // budget and starve feature initialization for the rest of the window
const GCS_RATE_MAX = 10; // should only fire once per page load; 10 gives generous headroom

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
  // Reads that leak host lists, stats, or extension state. All legitimate callers
  // are popup / tests.js (sender.tab undefined) — the privileged check passes them
  // through and rejects any tab sender. Since SEC-01 (content script moved to the
  // ISOLATED world; MAIN-world page scripts can't reach chrome.runtime) this is
  // defense-in-depth rather than an actively-reachable surface, but it stays so the
  // guarantee holds even if a content-script bug or refactor ever forwards these.
  'GET_SETTINGS', 'GET_STATS', 'GET_BOOST_STATUS', 'GET_SITE_KILLERS'
]);

const MAX_WHITELIST = 199; // base + 199 = 10199, last id inside [10000, 10200)
const MAX_POTATO_SITES = 199; // BUG-105 — mirror the whitelist's bound; potatoSites had no cap

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
    // Do not cache the failure — leave siteKillerCache null so the next call
    // retries the fetch instead of permanently disabling site killers.
    return {};
  }
  return siteKillerCache;
}

// QUALITY-03 — normalizeHost is imported from lib/formatters.js (the SW is a
// `type: module` worker and already imports other lib modules), so the duplicate
// local copy is gone.

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
  // BUG-2 — pick only the single most-specific (longest) matching pattern instead
  // of concatenating every ancestor match, so e.g. m.youtube.com no longer also
  // inherits youtube.com's (desktop) selectors, and old.reddit.com no longer
  // inherits reddit.com's.
  let bestLen = -1;
  let bestSelectors = null;
  for (const [pattern, selectors] of Object.entries(killerMap)) {
    const p = normalizeHost(pattern);
    if ((host === p || host.endsWith('.' + p)) && p.length > bestLen) {
      bestLen = p.length;
      bestSelectors = selectors;
    }
  }
  return Array.isArray(bestSelectors) ? bestSelectors.slice() : [];
}

// 1.1.3 — synchronous detail builder. Used by both buildContentDetail (which
// fetches settings + killerMap from storage) and broadcastSettingsUpdate
// (which fetches them ONCE outside the loop). Avoids N×storage I/O per
// settings change.
// QUALITY-05 — one list of the boolean feature flags sent to the content script,
// so adding a content toggle is a single-line change here (kept in sync with the
// content script's `settings` object).
const CONTENT_DETAIL_BOOL_KEYS = [
  'jsThrottleEnabled', 'imageLazyEnabled', 'imageLowQualityEnabled',
  'animationKillEnabled', 'autoplayKillEnabled', 'prefetchStripEnabled',
  'videoPauseEnabled', 'videoPreloadNoneEnabled', 'siteKillersEnabled'
];

function buildContentDetailFromCache(hostname, settings, killerMap) {
  const whitelisted = isHostWhitelisted(hostname, settings.whitelist);
  const siteKillers = (settings.siteKillersEnabled && !whitelisted)
    ? killersForHost(hostname, killerMap)
    : [];
  const detail = { siteKillers };
  for (const k of CONTENT_DETAIL_BOOL_KEYS) {
    detail[k] = !!settings[k] && !whitelisted;
  }
  return detail;
}

async function buildContentDetail(hostname) {
  const settings = await getSettings();
  const killerMap = await getSiteKillers();
  return buildContentDetailFromCache(hostname, settings, killerMap);
}

// Broadcast settings update to every content script in every tab. Used by the
// chrome.storage.onChanged listener so popup/settings changes propagate without
// the old CustomEvent bus (which was the Finding 1 attack surface).
// chrome.tabs.sendMessage delivers to the ISOLATED-world content script via
// chrome.runtime.onMessage, which applies them and relays jsThrottleEnabled to
// the MAIN-world throttle snippet over postMessage.
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
    // PERF-11 — skip discarded tabs: they have no live content script, so the
    // send just rejects (extra failed IPC + churn) for nothing.
    if (tab.discarded) continue;
    if (!/^https?:/.test(tab.url)) continue;
    let hostname = '';
    try { hostname = new URL(tab.url).hostname; } catch (e) { continue; }
    const detail = buildContentDetailFromCache(hostname, settings, killerMap);
    // BUG-14 — restrict to the top-level frame (frameId 0). chrome.tabs.sendMessage
    // with no frameId delivers to every frame in the tab, so a `detail` computed
    // from the top-level tab.url would overwrite a cross-origin iframe's own
    // correctly host-scoped settings (set via GET_CONTENT_SETTINGS at frame init)
    // with the wrong domain's whitelist/killer state.
    sends.push(chrome.tabs.sendMessage(tab.id, { type: 'POTATOFY_SETTINGS_UPDATE', detail }, { frameId: 0 }));
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
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  // Shallow-spread above still shares the nested potatoSites object with the
  // stored value — clone it so callers mutating the returned settings can't
  // corrupt storage-backed state before it's written back.
  merged.potatoSites = { ...(merged.potatoSites || {}) };
  return merged;
}

// PRECONDITION: caller must already hold withLock('settings'). This is the body
// of saveSettings without the lock, so a read-modify-write caller (QA-02, e.g.
// setPotatoSite) can do its read, mutation, and this write inside ONE lock
// acquisition without deadlocking on a re-entrant nested withLock('settings').
async function saveSettingsLocked(settings) {
  await chrome.storage.local.set({ settings });
  if (settings.useCloudSync) {
    // Privacy default: ship only feature toggles + numeric thresholds. The
    // whitelist and per-site potato map describe browsing habits and stay
    // local unless the user explicitly opts in via syncHostsToCloud.
    const syncPayload = { ...settings };
    if (!settings.syncHostsToCloud) {
      // 1.1.3 — actively purge host data that pre-existed the opt-out.
      // Without this, a previously-synced whitelist lingers on Google's
      // servers and can be re-imported on a fresh device via
      // migrateLegacySync (Sec.HIGH.4). The write below already replaces the
      // whole `settings` key with a host-free payload, so that alone
      // guarantees the purge — no need to separately read+clean+write first.
      delete syncPayload.whitelist;
      delete syncPayload.potatoSites;
    }
    // 1.1.3 — chrome.storage.sync enforces an 8KB-per-item quota. A large
    // whitelist/potatoSites payload can silently exceed it; detect that before
    // writing and drop the host data (falling back to the toggles-only payload)
    // instead of letting the whole write reject into a swallowed, invisible
    // failure. Also log so a still-oversized payload's failure isn't silent.
    const quota = chrome.storage.sync.QUOTA_BYTES_PER_ITEM || 8192;
    if (JSON.stringify(syncPayload).length > quota && (syncPayload.whitelist || syncPayload.potatoSites)) {
      console.warn('[Potatofy] cloud sync payload exceeds quota; omitting host data');
      delete syncPayload.whitelist;
      delete syncPayload.potatoSites;
    }
    try {
      await chrome.storage.sync.set({ settings: syncPayload });
    } catch (e) {
      console.warn('[Potatofy] cloud sync write failed:', e && e.message ? e.message : e);
    }
  } else {
    // useCloudSync off entirely — wipe the sync area so nothing lives on
    // Google's servers. Opting out IS the consent; no confirmation prompt.
    try { await chrome.storage.sync.clear(); } catch (e) {}
  }
}

async function saveSettings(settings) {
  // 1.1.3 — serialize the local + sync writes so two rapid UPDATE_SETTINGS
  // calls cannot interleave their sync writes and leave the sync store with
  // a stale older value (Sec.MEDIUM.11).
  return withLock('settings', () => saveSettingsLocked(settings));
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
      // Independent try/catch: a `remove` failure must not be treated the
      // same as "nothing to migrate" — fall through to the outer catch's
      // sync.clear() so stale host data can't linger either way.
      try { await chrome.storage.sync.remove('settings'); } catch (e) {
        try { await chrome.storage.sync.clear(); } catch (e2) {}
      }
    }
  } catch (e) {
    try { await chrome.storage.sync.clear(); } catch (e2) {}
  }
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
      if (Object.keys(sites).length >= MAX_POTATO_SITES) break;
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
    for (const [k, v] of Object.entries(obj)) {
      const tabId = Number(k);
      if (Number.isFinite(tabId) && tabId >= 0) tabLastActive.set(tabId, v);
    }
  } catch (e) {}
}

let persistTabTimer = null;
// PERF-12 / QA-09 — persist tab activity EVENT-DRIVEN (debounced) instead of via a
// dedicated 1-min wake alarm (which kept the SW from ever suspending) and without
// relying on the unreliable onSuspend (which can't await async work). A pending
// setTimeout keeps the SW alive until it fires (same pattern as scheduleBroadcast),
// so the debounced write lands; the debounce coalesces rapid tab switches into one
// write (kind to SD-card-backed Pi storage).
function schedulePersistTabLastActive() {
  if (persistTabTimer) return;
  persistTabTimer = setTimeout(() => {
    persistTabTimer = null;
    persistTabLastActive().catch(() => {});
  }, 2000);
}

function updateTabActivity(tabId) {
  if (typeof tabId !== 'number') return;
  tabLastActive.set(tabId, Date.now());
  tabLastActiveDirty = true;
  schedulePersistTabLastActive();
}

function removeTabActivity(tabId) {
  if (tabLastActive.delete(tabId)) {
    tabLastActiveDirty = true;
    schedulePersistTabLastActive();
  }
}

async function persistTabLastActive() {
  if (!tabLastActiveDirty) return;
  const obj = Object.fromEntries(tabLastActive);
  try {
    await chrome.storage.session.set({ tabLastActive: obj });
    tabLastActiveDirty = false; // only clear after the write succeeds
  } catch (e) {}
}

// ---------- Stats ----------

const statsHot = { ...EMPTY_COUNTERS };
let statsHotRehydrated = false;

async function rehydrateStatsHot() {
  try {
    const s = await chrome.storage.session.get('statsHot');
    if (s.statsHot) {
      for (const k of Object.keys(s.statsHot)) {
        if (k in EMPTY_COUNTERS) {
          const v = s.statsHot[k];
          statsHot[k] = Number.isFinite(v) ? v : 0;
        }
      }
    }
  } catch (e) {}
  statsHotRehydrated = true;
}

async function bufferIncrement(patch) {
  // QA-03 — wait for the wake-time rehydration to finish before touching statsHot,
  // so two increments racing right after a SW wake don't both run rehydrateStatsHot
  // in parallel (the slower write clobbering the faster). _wakeReady already runs
  // rehydrateStatsHot once on every wake; awaiting it makes the guard below a
  // no-op on the hot path while closing the cold-start race.
  await _wakeReady;
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
    // Accumulate into a temp object first and only zero statsHot AFTER the
    // storage.local.set below succeeds — otherwise a write failure (e.g.
    // quota exhaustion) silently drops the increments for good.
    const flushed = {};
    for (const k of Object.keys(statsHot)) {
      const v = statsHot[k];
      if (!v) continue;
      // M-4 / SEC-2 — clamp the persistent accumulation at MAX_COUNTER_VALUE.
      // bufferIncrement caps the hot buffer, but the flush had no ceiling, so
      // sustained STATS_INCREMENT abuse across tabs/SW restarts could drift a
      // stored counter past Number.MAX_SAFE_INTEGER and corrupt displayed values.
      s.session[k]  = Math.min((s.session[k]  || 0) + v, MAX_COUNTER_VALUE);
      s.lifetime[k] = Math.min((s.lifetime[k] || 0) + v, MAX_COUNTER_VALUE);
      flushed[k] = v;
    }
    try {
      await chrome.storage.local.set({ stats: s });
    } catch (e) {
      // 1.1.3 — surface quota-exhaustion failures instead of swallowing.
      console.warn('[Potatofy] stats flush failed:', e && e.message ? e.message : e);
      return;
    }
    // Subtract exactly what was just persisted rather than zeroing outright —
    // bufferIncrement() isn't gated by this lock and can add to statsHot[k]
    // during the storage.local.set await above; an unconditional zero would
    // wipe out that concurrent increment without it ever being written.
    for (const k of Object.keys(flushed)) statsHot[k] = Math.max(0, (statsHot[k] || 0) - flushed[k]);
    try { await chrome.storage.session.set({ statsHot }); } catch (e) {}
    updateBadge();
  });
}

// Phase 2 — validates that calibration data from content script has the
// expected shape before writing to storage.
function isValidCalibrationData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  for (const k of ['trackers', 'fonts', 'scripts', 'images']) {
    if (!Number.isFinite(d[k]) || d[k] < 0 || d[k] > MAX_CALIBRATION_BYTES) return false;
  }
  return true;
}

// ---------- Bandwidth calibration (in-memory buffer) ----------
// PERF-10 / SEC-03 / QA-17 — calibration samples previously hit chrome.storage on
// EVERY message (constant LevelDB I/O on a Pi SD card) via an UNLOCKED
// read-modify-write (lost updates under multi-tab concurrency), and pushed
// ZERO-valued categories that decayed real samples out of a single shared
// 100-entry window. Now: per-category in-memory rolling windows holding only
// non-zero samples, persisted to storage on the periodic stats-flush alarm.
const CALIB_CATEGORIES = ['trackers', 'fonts', 'scripts', 'images'];
const CALIB_MAX = 100;
const calibHistory = { trackers: [], fonts: [], scripts: [], images: [] };
let calibDirty = false;
// Bumped on every recordCalibration() call that sets calibDirty; lets
// flushCalibration() detect whether a new sample arrived while its write
// was in flight, so it doesn't clear calibDirty out from under that sample.
let calibVersion = 0;

async function rehydrateCalibration() {
  try {
    const s = await chrome.storage.local.get('calibrationHistory');
    const h = s.calibrationHistory;
    if (h && typeof h === 'object' && !Array.isArray(h)) {
      for (const cat of CALIB_CATEGORIES) {
        if (Array.isArray(h[cat])) {
          calibHistory[cat] = h[cat].filter(x => Number.isFinite(x) && x > 0).slice(-CALIB_MAX);
        }
      }
    }
  } catch (e) {}
}

function recordCalibration(data) {
  // QA-17 — append only NON-ZERO samples, with a separate window per category so
  // a rarely-loaded category (e.g. fonts) can't flush other categories' real
  // samples out of a shared window.
  let changed = false;
  for (const cat of CALIB_CATEGORIES) {
    const v = data[cat];
    if (Number.isFinite(v) && v > 0) {
      const arr = calibHistory[cat];
      arr.push(v);
      if (arr.length > CALIB_MAX) arr.shift();
      changed = true;
    }
  }
  if (changed) { calibDirty = true; calibVersion++; }
}

function computeCalibration() {
  let any = false;
  const out = {};
  for (const cat of CALIB_CATEGORIES) {
    out[cat] = median(calibHistory[cat]); // median([]) === 0
    if (calibHistory[cat].length > 0) any = true;
  }
  if (!any) return null;
  out.lastUpdated = Date.now();
  return out;
}

async function flushCalibration() {
  if (!calibDirty) return;
  const versionAtStart = calibVersion;
  try {
    await chrome.storage.local.set({
      calibrationHistory: { ...calibHistory },
      calibratedBandwidth: computeCalibration()
    });
    // Only clear calibDirty if no new sample arrived (via recordCalibration)
    // while the write above was in flight — otherwise that sample's dirty
    // flag would be wiped even though it wasn't included in this write.
    if (calibVersion === versionAtStart) calibDirty = false;
  } catch (e) {
    console.warn('[Potatofy] calibration flush failed:', e && e.message ? e.message : e);
  }
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

// Separate rate-limit bucket for CALIBRATE_BANDWIDTH so a burst of DOM-mutation
// stats can't exhaust the shared STATS_INCREMENT budget and drop calibration data.
function calibrationRateAllow(tabId) {
  if (tabId == null) return true;
  const now = Date.now();
  const entry = calibRateByTab.get(tabId);
  if (!entry || now - entry.windowStart > STATS_RATE_WINDOW_MS) {
    calibRateByTab.set(tabId, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= STATS_RATE_MAX) return false;
  entry.count++;
  return true;
}

// GET_CONTENT_SETTINGS gets its own low-budget bucket (was sharing calibRateByTab
// with CALIBRATE_BANDWIDTH — a calibration-heavy page could exhaust the 500/10s
// budget and starve GET_CONTENT_SETTINGS, blocking feature initialization for the
// rest of the window). It should only fire once per page load, so the budget is
// deliberately much smaller.
function gcsRateAllow(tabId) {
  if (tabId == null) return true;
  const now = Date.now();
  const entry = gcsRateByTab.get(tabId);
  if (!entry || now - entry.windowStart > STATS_RATE_WINDOW_MS) {
    gcsRateByTab.set(tabId, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= GCS_RATE_MAX) return false;
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
  // flushStatsHotToLocal() acquires and releases the 'stats-flush' lock
  // internally, so re-acquiring it here for the whole function (instead of
  // just around the reset write) would deadlock — use a plain nested call for
  // the flush, then hold the lock ourselves for the read-modify-write below
  // so a concurrent alarm-triggered flush can't race it.
  await flushStatsHotToLocal();
  await withLock('stats-flush', async () => {
    const stats = await getStats();
    stats[scope] = { ...EMPTY_COUNTERS, since: Date.now() };
    await chrome.storage.local.set({ stats });
  });
  updateBadge();
}

// ---------- Badge ----------

let badgeUpdateScheduled = false;

function updateBadge() {
  if (badgeUpdateScheduled) return;
  badgeUpdateScheduled = true;
  Promise.resolve().then(async () => {
    try {
      const stats = await getStats();
      const total =
        (stats.session.blockedRequests || 0) +
        (stats.session.blockedFonts || 0) +
        (stats.session.tabsDiscarded || 0) +
        (stats.session.thirdPartyScriptsBlocked || 0) +
        (stats.session.thirdPartyImagesBlocked || 0) +
        (stats.session.mediaBlocked || 0);
      await chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
      await chrome.action.setBadgeText({ text: total > 0 ? abbreviateCount(total) : '' });
    } catch (e) {
    } finally {
      // Only clear the debounce flag once the async work (including the
      // setBadgeText write) has actually finished, so overlapping calls
      // can't launch parallel updates that resolve out of order.
      badgeUpdateScheduled = false;
    }
  });
}

function abbreviateCount(n) {
  // Keep the badge text at 4 characters or fewer — Chrome truncates longer
  // text, and e.g. "10.0k"/"1000k" (5 chars) were getting cut off.
  if (n < 1000)    return String(n);
  if (n < 9950)    return (n / 1000).toFixed(1) + 'k';
  if (n < 999500)  return Math.round(n / 1000) + 'k';
  if (n < 9950000) return (n / 1000000).toFixed(1) + 'M';
  return Math.round(n / 1000000) + 'M';
}

// ---------- DNR — validation + builders ----------

function isValidInitiatorDomain(host) {
  if (typeof host !== 'string') return false;
  const h = host.trim().toLowerCase();
  if (!h || h.length > 253) return false;
  // QA-14 — accept local development hosts so Raspberry Pi (and other) users can
  // whitelist / manage settings for their own servers. These previously failed
  // the public-domain regex and were silently dropped, so the popup briefly showed
  // them whitelisted and then reverted.
  if (h === 'localhost' || h === '::1') return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;          // loopback
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;           // RFC-1918
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;             // RFC-1918
  if (/^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // RFC-1918
  // Public domains: at least one dot + a 2+ char alphanumeric TLD; bare public
  // IPs rejected. Reject IPs FIRST — a TLD regex that also matched digits
  // would make the dedicated IP check below unreachable dead code (all IPv4
  // addresses end in a digit).
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return false;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h)) return false;
  // [a-z0-9-]{2,} (not just [a-z]{2,}) so Punycode/IDN TLDs like .xn--p1ai are
  // accepted rather than silently rejected.
  if (!/\.[a-z0-9-]{2,}$/.test(h)) return false;
  return true;
}

// QA-14 — Chrome's DNR initiatorDomains matches hostnames; bare IP literals are
// not reliably matchable there. We still accept local IPs for whitelist / potato /
// boost bookkeeping (so settings persist and the content layer + contentSettings
// exemptions apply via isHostWhitelisted), but skip emitting DNR allow-rules for
// them. Hostname-form locals (localhost, *.local) are fine for DNR.
function isDnrInitiatorDomain(host) {
  if (!isValidInitiatorDomain(host)) return false;
  const h = host.trim().toLowerCase();
  if (h === '::1') return false;
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
// `settings` is passed in by the caller (which already fetched it for
// reconcileStaticRulesets) rather than re-fetched here, so a concurrent
// UPDATE_SETTINGS write between two internal getSettings() calls can't leave
// this function and its caller operating on different settings snapshots
// within the same lock.
async function syncDynamicRulesLocked(settings) {
  let ok = true;
  {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    // Only touch IDs we own. Boost rules (30000+) are managed separately and
    // must survive a settings update.
    const removeRuleIds = Array.from(new Set(existing.filter(r => inManagedRange(r.id)).map(r => r.id)));

    // Hard cap at MAX_WHITELIST so we never emit IDs outside [10000, 10200).
    // Anything past the cap would orphan rules — inManagedRange wouldn't pick
    // them up on the next sync and they'd accumulate until the 5000-rule
    // dynamic budget is exhausted.
    // QA-14 — emit DNR allow-rules only for DNR-matchable hosts (skips bare IPs).
    const valid = (settings.whitelist || [])
      .filter(isDnrInitiatorDomain)
      .slice(0, MAX_WHITELIST);
    const addRules = valid.map((h, i) => buildWhitelistRule(h, DYNAMIC_RULE_WHITELIST_BASE + i));

    // QUALITY-07 — do NOT pass excludedInitiatorDomains. The priority-100 whitelist
    // allow-rules above already override these priority-50 block rules for
    // whitelisted hosts, so the exclusion list was redundant — and dropping it
    // sidesteps Chrome's per-condition domain-count limit when the whitelist is large
    // (the old code silently lost 3rd-party blocking once the whitelist exceeded it).
    if (settings.thirdPartyScriptBlockEnabled) {
      addRules.push(buildThirdPartyBlockRule(DYNAMIC_RULE_3P_SCRIPT_ID, 'script', null));
    }
    if (settings.foregroundPotatoEnabled) {
      addRules.push(buildThirdPartyBlockRule(DYNAMIC_RULE_3P_IMAGE_ID, 'image', null));
    }

    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
      return true;
    } catch (e) {
      console.warn('[Potatofy] bulk dynamic-rules update failed, retrying per-rule:', e);
    }
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    } catch (e) {
      // Bulk removal also failed — fall back to removing each ID individually
      // so a still-present old rule can't collide with the adds below and
      // lock sync up until the next SW restart.
      for (const id of removeRuleIds) {
        try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [id], addRules: [] }); }
        catch (e2) { console.warn('[Potatofy] failed to remove stale rule:', id, e2); ok = false; }
      }
    }
    for (const rule of addRules) {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
      } catch (e) {
        // Rule ID still present (removal above didn't fully land) — retry
        // once with an explicit remove-then-add instead of giving up.
        try {
          await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [rule.id], addRules: [rule] });
        } catch (e2) {
          console.warn('[Potatofy] skipping invalid rule:', rule.id, e2);
          ok = false;
        }
      }
    }
  }
  return ok;
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
    return true;
  } catch (e) {
    console.warn('[Potatofy] reconcileStaticRulesets failed:', e);
    return false;
  }
}

// ---------- contentSettings (per-site Potato Mode — R4 only, NOT used by Boost) ----------

async function syncPotatoSites() {
  if (!chrome.contentSettings) return true;
  // QA-05 — reconcile from scratch: clear ALL of the extension's own
  // contentSettings overrides, then write ONLY active 'block' rules. The old code
  // wrote 'allow' for non-blocked sites, which overrode the user's own global
  // default (e.g. globally-blocked JS got force-allowed) and left a permanent
  // per-site record cluttering the profile. Clearing first + only emitting blocks
  // means a removed/disabled site reverts to the user's default.
  try { await chrome.contentSettings.javascript.clear({}); } catch (e) {}
  try { await chrome.contentSettings.images.clear({}); } catch (e) {}
  const settings = await getSettings();
  const whitelist = settings.whitelist || [];
  const sites = settings.potatoSites || {};
  const jobs = [];
  for (const [host, opts] of Object.entries(sites)) {
    if (!isValidInitiatorDomain(host)) continue;
    // Whitelisting a site must exempt it from potato-mode blocks too —
    // otherwise a whitelisted domain with a leftover potatoSites entry stays
    // blocked despite the user explicitly opting it out.
    if (isHostWhitelisted(host, whitelist)) continue;
    for (const primaryPattern of [`*://*.${host}/*`, `*://${host}/*`]) {
      if (opts.js) {
        jobs.push(chrome.contentSettings.javascript.set({ primaryPattern, setting: 'block' }));
      }
      if (opts.img) {
        jobs.push(chrome.contentSettings.images.set({ primaryPattern, setting: 'block' }));
      }
    }
  }
  const results = await Promise.allSettled(jobs);
  return !results.some(r => r.status === 'rejected');
}

async function setPotatoSite(host, opts) {
  if (!isValidInitiatorDomain(host)) return false;
  const cleanHost = normalizeHost(host);
  // QA-02 — read + modify + write atomically under the settings lock so a
  // concurrent UPDATE_SETTINGS can't clobber this per-site change (or vice-versa).
  // saveSettingsLocked (not saveSettings) avoids re-entering the held lock.
  const applied = await withLock('settings', async () => {
    const settings = await getSettings();
    const sites = { ...(settings.potatoSites || {}) };
    const current = sites[cleanHost] || { js: false, img: false };
    const next = {
      js:  opts.js  !== undefined ? !!opts.js  : current.js,
      img: opts.img !== undefined ? !!opts.img : current.img
    };
    // BUG-2 — enforce the MAX_POTATO_SITES cap on this path too (previously
    // only validateSettings() checked it); only blocks adding a genuinely
    // new host, never an edit to one already present.
    if (!(cleanHost in sites) && Object.keys(sites).length >= MAX_POTATO_SITES) return false;
    if (!next.js && !next.img) delete sites[cleanHost];
    else sites[cleanHost] = next;
    settings.potatoSites = sites;
    await saveSettingsLocked(settings);
    return true;
  });

  if (!applied) return false;

  // QA-05 — reconcile contentSettings (clear-all + re-apply only active blocks)
  // under the same 'dnr' lock the other sync paths (bootstrap, UPDATE_SETTINGS)
  // use, so the clear can't interleave with a concurrent reconcile.
  if (chrome.contentSettings) {
    await withLock('dnr', () => syncPotatoSites());
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
  const obj = {};
  for (const [k, v] of boostedTabs) obj[String(k)] = v;
  try {
    await chrome.storage.session.set({ boostedTabs: obj });
    boostedTabsDirty = false; // only clear after the write succeeds
  } catch (e) {}
}

async function rehydrateBoostedTabs() {
  try {
    const s = await chrome.storage.session.get('boostedTabs');
    const obj = s.boostedTabs || {};
    boostedTabs.clear();
    for (const [k, v] of Object.entries(obj)) {
      const tabId = Number(k);
      if (Number.isFinite(tabId) && tabId >= 0 && v && Array.isArray(v.ruleIds) &&
          typeof v.host === 'string' && isValidInitiatorDomain(v.host)) {
        const validRuleIds = v.ruleIds.filter(
          id => Number.isInteger(id) && id >= BOOST_RULE_BASE && id < BOOST_RULE_BASE + 100
        );
        if (validRuleIds.length !== v.ruleIds.length) continue;
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
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const orphanIds = existing
      .filter(r => r.id >= BOOST_RULE_BASE && r.id < BOOST_RULE_BASE + 100 && !allRuleIds.has(r.id))
      .map(r => r.id);
    if (orphanIds.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: orphanIds, addRules: [] });
    }
  } catch (e) {}
}

async function boostTab(tabId, host) {
  if (typeof tabId !== 'number' || tabId < 0) return { ok: false, reason: 'invalid_tab' };
  if (!isValidInitiatorDomain(host)) return { ok: false, reason: 'invalid_host' };
  await _wakeReady;

  return withLock('dnr', async () => {
    // M-2 — verify that the tab claimed by `tabId` is actually on `host` INSIDE
    // the lock, immediately before the rule install. Doing this outside the lock
    // left a TOCTOU window where the tab could navigate between the check and the
    // install, so boost rules (and the stored info.host that navigation-clear
    // keys off) could end up bound to the wrong site. chrome.tabs.get failure is
    // a soft-pass — a non-existent tab's tabIds-scoped DNR rule is a harmless
    // no-op, and we still want the whitelist / install_failed paths to surface.
    // Normalized once and reused below both for the mismatch check and for
    // what gets stored in boostedTabs — storing the raw, un-normalized `host`
    // (e.g. "www.example.com") made maybeClearBoostOnNavigation's normalized
    // comparison always mismatch on reload, instantly clearing the boost for
    // any www.-prefixed site.
    const claim = normalizeHost(host);

    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url) {
        let tabHost = '';
        try { tabHost = normalizeHost(new URL(tab.url).hostname); } catch (e) {}
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
    let ids, evictedIds;
    if (prev && Array.isArray(prev.ruleIds) && prev.ruleIds.length === 3) {
      // Re-boosting an already-boosted tab: reuse its existing rule IDs
      // instead of allocating a new triplet. nextBoostRuleIds() treats the
      // tab's own slot as "in use" (it's still in boostedTabs), so calling it
      // here would always allocate fresh IDs and, once the 33-slot ring is
      // full, evict an unrelated tab's boost just to satisfy a re-boost that
      // didn't need a new slot at all.
      ids = prev.ruleIds;
      evictedIds = [];
    } else {
      ({ ids, evictedIds } = nextBoostRuleIds());
    }
    const [imgId, scriptId, mediaId] = ids;
    // Remove the previous boost for this tab (including the reused-IDs case —
    // updateSessionRules processes removals before adds, so folding the same
    // IDs into removeRuleIds is required even when re-adding them, matching
    // every other rule-install path in this file) + anything evicted from the ring.
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
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
      boostedTabs.set(tabId, { ruleIds: ids, host: claim });
      boostedTabsDirty = true;
      await persistBoostedTabs();
      try { await chrome.tabs.reload(tabId); } catch (e) {}
      return { ok: true };
    } catch (e) {
      console.warn('[Potatofy] boost install failed:', e);
      // nextBoostRuleIds() may have already evicted an unrelated tab's
      // bookkeeping entry before this DNR call was attempted. Persist that
      // change even on failure so the next SW restart's orphan-rule GC (see
      // rehydrateBoostedTabs) sees accurate in-memory state rather than a
      // stale pre-eviction snapshot.
      await persistBoostedTabs();
      return { ok: false, reason: 'install_failed' };
    }
  });
}

// PRECONDITION: caller holds withLock('dnr'). The teardown body without the lock,
// so the navigation path (which already holds the lock) can reuse it.
async function clearBoostForTabLocked(tabId) {
  const info = boostedTabs.get(tabId);
  if (!info) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: info.ruleIds, addRules: [] });
  } catch (e) {
    // Rules are still active — keep the bookkeeping so the tab is still
    // reported as boosted and a future clear can retry, instead of dropping
    // tracking for rules that are actually still installed.
    console.warn('[Potatofy] failed to remove boost rules, keeping bookkeeping for retry:', tabId, e);
    return;
  }
  boostedTabs.delete(tabId);
  boostedTabsDirty = true;
  await persistBoostedTabs();
}

async function clearBoostForTab(tabId) {
  // QA-04 — serialize under the same 'dnr' lock boostTab holds, so a clear that
  // arrives WHILE a boost is mid-install runs AFTER the install commits to
  // boostedTabs (instead of finding it empty, no-op'ing, and leaving rules
  // orphaned on a tab that has navigated away).
  return withLock('dnr', () => clearBoostForTabLocked(tabId));
}

async function maybeClearBoostOnNavigation(tabId, newUrl) {
  if (!newUrl) return;
  // Ignore non-http(s) schemes (about:blank flashes during SPA routing,
  // data:, chrome://, etc.). We deliberately leave the boost installed for those.
  if (!newUrl.startsWith('http://') && !newUrl.startsWith('https://')) return;
  let newHost;
  try {
    newHost = new URL(newUrl).hostname.replace(/^www\./, '').toLowerCase();
  } catch (e) { return; }
  // QA-04 — do the lookup + host comparison + teardown INSIDE the 'dnr' lock so a
  // boost still installing for this tab has committed to boostedTabs before we
  // read it. The old code read boostedTabs unlocked and returned early when the
  // install hadn't landed yet, leaving the boost active after navigation.
  await withLock('dnr', async () => {
    const info = boostedTabs.get(tabId);
    if (!info) return;
    if (newHost !== info.host && !newHost.endsWith('.' + info.host)) {
      await clearBoostForTabLocked(tabId);
    }
  });
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

// ALARM_IDLE and ALARM_PRESSURE both fire every minute and can land at the
// same time; without a lock, checkIdleTabs() and checkMemoryPressure() could
// both gather the same candidate tabs and issue overlapping discard calls,
// double-counting tabsDiscarded/realRamFreed.
async function discardEligibleTabs(opts) {
  return withLock('discard', () => discardEligibleTabsLocked(opts));
}

async function discardEligibleTabsLocked({ minIdleMs = 0 } = {}) {
  const now = Date.now();
  const windows = await chrome.windows.getAll({ populate: true });

  const candidates = [];
  for (const win of windows) {
    // BUG-1 — only the FOCUSED window's active tab is exempt from discard. Every
    // window has its own 'active' tab regardless of window focus, so without this
    // check the active tab of every background/minimized window was permanently
    // protected from discard too.
    const activeTab = win.focused ? (win.tabs || []).find(t => t.active) : null;
    const activeId = activeTab ? activeTab.id : -1;
    for (const tab of (win.tabs || [])) {
      if (shouldSkipTabForDiscard(tab, activeId)) continue;
      if (minIdleMs > 0) {
        // QA-01 — fall back to the tab's own lastAccessed (Chrome 121+), then to
        // `now`, when we have no recorded activity. Tabs that pre-existed this SW
        // wake or were restored on browser startup have no tabLastActive entry
        // until session storage repopulates it; the old `|| 0` made (now - 0)
        // exceed any threshold, so every such tab was discarded on the first idle
        // check (~1 min after startup), ignoring the user's idle threshold.
        const lastActive = tabLastActive.get(tab.id) || tab.lastAccessed || now;
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
    // PERF-02 — give the OS time to reclaim the discarded renderers' memory before
    // measuring. Querying immediately (as the old code did) catches the processes
    // mid-teardown, so availableCapacity has barely moved and realRamFreed reads ~0,
    // under-reporting the extension's single most concrete benefit.
    await new Promise(r => setTimeout(r, 750));
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
    await bufferIncrement(increment);
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
    // BUG-32 — use a presence check, not a truthiness check, so a legitimately
    // cached 0 is treated as cached rather than re-queried every call.
    if (typeof s.deviceCapacityMB === 'number') return s.deviceCapacityMB || null;
    if (!chrome.system || !chrome.system.memory) return null;
    const info = await chrome.system.memory.getInfo();
    const cap = Math.round((info.capacity || 0) / (1024 * 1024));
    await chrome.storage.session.set({ deviceCapacityMB: cap });
    return cap || null;
  } catch (e) {
    return null;
  }
}

async function checkMemoryPressure() {
  await _wakeReady;
  const settings = await getSettings();
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
    if (offset === 2) return 'mediaBlocked';    // media — own bucket, not the
                                                 // generic tracker/ad counter
    return 'thirdPartyImagesBlocked';           // offset === 0
  }
  if (rule.ruleId >= DYNAMIC_RULE_WHITELIST_BASE && rule.ruleId < DYNAMIC_RULE_3P_SCRIPT_ID) return null;
  if (rule.rulesetId === FONT_RULESET_ID) return 'blockedFonts';
  return 'blockedRequests';
}

async function pollDNRMatches() {
  await _wakeReady;
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.getMatchedRules) return;
  let queryStartTs = Date.now();
  try {
    const session = await chrome.storage.session.get('dnrLastPollTs');
    const lastTs = Number(session.dnrLastPollTs) || (Date.now() - DNR_POLL_WINDOW_MS);
    queryStartTs = Date.now();
    const filter = { minTimeStamp: lastTs };
    const result = await chrome.declarativeNetRequest.getMatchedRules(filter);
    const matches = (result && result.rulesMatchedInfo) || [];
    if (matches.length === 0) {
      // Advance to the timestamp captured BEFORE the query started, not
      // Date.now() evaluated after it resolves — otherwise a match landing
      // during the query's own in-flight window is silently skipped.
      await chrome.storage.session.set({ dnrLastPollTs: queryStartTs });
      return;
    }
    const patch = Object.create(null);
    let newestTs = lastTs;
    for (const m of matches) {
      // Advance newestTs for EVERY match, including unclassified ones (e.g.
      // whitelist rules), BEFORE the classify/continue below. Previously an
      // unclassified match as the newest in a batch never advanced newestTs,
      // so the poll window stalled and the same match was re-fetched every
      // minute for up to the full 5-minute retention window.
      if (m.timeStamp > newestTs) newestTs = m.timeStamp;
      const key = classifyMatch(m.rule);
      if (!key) continue;
      patch[key] = (patch[key] || 0) + 1;
    }
    if (Object.keys(patch).length > 0) {
      await bufferIncrement(patch);
    }
    // Advance past the newest seen, plus 1ms to avoid re-counting the same.
    await chrome.storage.session.set({ dnrLastPollTs: newestTs + 1 });
  } catch (e) {
    // getMatchedRules throws if quota is exceeded. Advance past this window
    // instead of leaving dnrLastPollTs stuck — otherwise the next successful
    // poll replays the whole un-advanced backlog and double-counts matches
    // already counted in a previous cycle.
    try { await chrome.storage.session.set({ dnrLastPollTs: queryStartTs }); } catch (e2) {}
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
  // QA-06 / PERF-09 — chrome.alarms clamps any period < 1 min to 1 min in PACKAGED
  // builds, so the old sub-minute cadences (0.25 / 0.5) were a fiction in
  // production. Use honest >=1 min periods. PERF-12 — ALARM_TAB_PERSIST is gone:
  // tab activity is persisted event-driven (schedulePersistTabLastActive), so the
  // SW no longer wakes every minute just to write it. Net: 4 alarms, all 1 min.
  const desired = {
    [ALARM_IDLE]:        { periodInMinutes: 1 },
    [ALARM_STATS_FLUSH]: { periodInMinutes: 1 },
    [ALARM_DNR_POLL]:    { periodInMinutes: 1 },
    [ALARM_PRESSURE]:    { periodInMinutes: 1 },
  };
  // Clear an obsolete ALARM_TAB_PERSIST left over from an upgraded install so it
  // doesn't keep waking the worker with no handler.
  try { await chrome.alarms.clear(ALARM_TAB_PERSIST); } catch (e) {}
  for (const [name, opts] of Object.entries(desired)) {
    const existing = await chrome.alarms.get(name);
    // L-5 — recreate when the period changed across an extension upgrade.
    // Previously an existing alarm was left untouched, so a new version's
    // cadence wouldn't take effect until the extension was reinstalled.
    if (!existing || existing.periodInMinutes !== opts.periodInMinutes) {
      try { await chrome.alarms.create(name, opts); } catch (e) {
        console.warn('[Potatofy] failed to create alarm:', name, e);
      }
    }
  }
}

// ---------- Lifecycle ----------

async function bootstrap(isStartup) {
  // QA-07 — register alarms FIRST, in their own try/catch, so a failure in any
  // later step (migration, settings read, DNR sync) can't leave the extension
  // with no background tasks at all (tab suspension, stats flush, DNR poll, memory
  // pressure all dead). Alarms don't depend on settings, so ordering them first
  // is safe.
  try { await setupAlarms(); } catch (e) { console.warn('[Potatofy] setupAlarms failed:', e); }

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
    await syncDynamicRulesLocked(current);
    await syncPotatoSites();
  });
  await getDeviceCapacityMB();
  if (isStartup) {
    // Restored tabs begin loading and sending stat messages concurrently with
    // startup — serialize this read-modify-write with the stats-flush lock so
    // a concurrent flush can't interleave and lose freshly-buffered counts.
    await withLock('stats-flush', async () => {
      const stats = await getStats();
      stats.session = { ...EMPTY_COUNTERS, since: Date.now() };
      await chrome.storage.local.set({ stats });
    });
  }
  updateBadge();
}

// Every SW wake re-runs this top-level. Kick off rehydration eagerly so
// alarm handlers awaiting _wakeReady get fresh in-memory state. bootstrap()
// awaits _wakeReady before proceeding, so rehydration is guaranteed to have
// run before any of bootstrap's own code executes — no need to call the
// rehydrate* functions again inside bootstrap.
const _wakeReady = (async () => {
  await rehydrateTabLastActive();
  await rehydrateStatsHot();
  await rehydrateBoostedTabs();
  await rehydrateCalibration();
})().catch(e => console.error('[Potatofy] wake-rehydrate failed', e));

chrome.runtime.onInstalled.addListener(() => {
  // An extension update can ship a new rules/site-killers.json while the SW
  // stays alive across the update; without this, the stale cached version
  // would keep serving until the next SW restart.
  siteKillerCache = null;
  bootstrap(false).catch(e => console.error('[Potatofy] bootstrap (install) failed:', e));
});
chrome.runtime.onStartup.addListener(() => {
  bootstrap(true).catch(e => console.error('[Potatofy] bootstrap (startup) failed:', e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  // QA-11 — each handler is async; attach .catch so a storage/API rejection
  // surfaces as a log instead of an unhandled promise rejection (which can flag
  // the worker as unstable). ALARM_TAB_PERSIST removed (PERF-12): tab activity is
  // now persisted event-driven via schedulePersistTabLastActive().
  let p;
  if (alarm.name === ALARM_IDLE)             p = checkIdleTabs();
  else if (alarm.name === ALARM_PRESSURE)    p = checkMemoryPressure();
  else if (alarm.name === ALARM_STATS_FLUSH) p = Promise.all([flushStatsHotToLocal(), flushCalibration()]);
  else if (alarm.name === ALARM_DNR_POLL)    p = pollDNRMatches();
  if (p && typeof p.catch === 'function') {
    p.catch(e => console.warn('[Potatofy] alarm', alarm.name, 'failed:', e));
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  updateTabActivity(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    // BUG-107 — only treat a load as user activity if the tab is actually
    // focused; otherwise a self-reloading background tab (meta-refresh,
    // polling dashboard) keeps resetting tabLastActive forever and is never
    // considered idle for discard.
    chrome.tabs.get(tabId).then(tab => {
      if (tab && tab.active) updateTabActivity(tabId);
    }).catch(e => {});
  }
  // Auto-clear boost when the user navigates the tab to a different host.
  if (changeInfo.url) {
    maybeClearBoostOnNavigation(tabId, changeInfo.url)
      .catch(e => console.warn('[Potatofy] maybeClearBoostOnNavigation failed:', e));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeTabActivity(tabId);
  // QA-11 — clearBoostForTab is async; catch so a teardown rejection doesn't
  // become an unhandled promise rejection.
  clearBoostForTab(tabId).catch(e => console.warn('[Potatofy] clearBoostForTab failed:', e));
  // H-2 — drop the per-tab rate-limit entries so neither Map can grow
  // unbounded across a long session of opening/closing tabs.
  statsRateByTab.delete(tabId);
  calibRateByTab.delete(tabId);
  gcsRateByTab.delete(tabId);
});

chrome.runtime.onSuspend.addListener(() => {
  // MV3 can still kill the worker mid-await here — onSuspend is best-effort,
  // not a reliable flush point — but awaiting (and including the previously
  // missing flushCalibration call) at least gives pending writes a chance to
  // land instead of guaranteeing they're dropped.
  Promise.all([persistTabLastActive(), flushStatsHotToLocal(), flushCalibration()])
    .catch(e => console.warn('[Potatofy] onSuspend flush failed:', e));
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
      try {
        const settings = await getSettings();
        sendResponse({ settings });
      } catch (e) {
        // QA-08 — the only handler that lacked a try/catch; a storage failure
        // would leave the port open with no response until Chrome times it out.
        console.warn('[Potatofy] GET_SETTINGS failed:', e);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === 'UPDATE_SETTINGS') {
    (async () => {
      try {
        const settings = validateSettings(msg.settings || {});
        await saveSettings(settings);
        // H-5 / M-8 — reconcile + dynamic-rule sync + per-site sync under a single
        // dnr lock so concurrent UPDATE_SETTINGS / boost installs can't interleave.
        // BUG-104 — capture each helper's success so a real DNR/contentSettings
        // failure surfaces as ok:false instead of always reporting success once
        // settings were merely persisted.
        let rulesOk = true;
        await withLock('dnr', async () => {
          const staticOk = await reconcileStaticRulesets(settings);
          const dynamicOk = await syncDynamicRulesLocked(settings);
          const potatoOk = await syncPotatoSites();
          rulesOk = staticOk && dynamicOk && potatoOk;
        });
        sendResponse({ ok: rulesOk });
      } catch (e) {
        console.warn('[Potatofy] UPDATE_SETTINGS failed:', e);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === 'STATS_INCREMENT' && msg.patch) {
    // Rate-limit per tab as defense-in-depth. The legitimate sender is our own
    // (now ISOLATED-world) content script; the cap bounds abuse without breaking
    // its normal debounced batches if the surface is ever reachable.
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!statsRateAllow(tabId)) {
      sendResponse({ ok: true });
      return false;
    }
    const safe = {};
    for (const k of Object.keys(EMPTY_COUNTERS)) {
      if (k === 'realRamFreed') continue; // internal-only; written by SW, not content scripts
      const v = Number(msg.patch[k]);
      if (Number.isFinite(v) && v > 0 && v <= MAX_INCREMENT) safe[k] = Math.floor(v);
    }
    // QUALITY-08 — await the buffer write before responding (return true keeps the
    // port open). The old fire-and-forget let a follow-up GET_STATS flush the hot
    // buffer to local storage before this increment had landed, dropping it.
    (async () => {
      try { await bufferIncrement(safe); } catch (e) {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'GET_STATS') {
    (async () => {
      try {
        await _wakeReady; // ensure calibHistory is rehydrated before computeCalibration()
        await flushStatsHotToLocal();
        const stats = await getStats();
        const cap = await getDeviceCapacityMB();
        const calibration = computeCalibration();
        sendResponse({
          stats,
          weights: STATS_WEIGHTS,
          deviceCapacityMB: cap,
          calibration: calibration,
          savings: {
            session:  computeSavings(stats.session, calibration),
            lifetime: computeSavings(stats.lifetime, calibration)
          }
        });
      } catch (e) {
        console.warn('[Potatofy] GET_STATS failed:', e);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === 'DISCARD_NOW') {
    (async () => {
      try {
        const count = await discardEligibleTabs({ minIdleMs: 0 });
        sendResponse({ ok: true, count });
      } catch (e) {
        console.warn('[Potatofy] DISCARD_NOW failed:', e);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === 'RESET_STATS') {
    (async () => {
      try {
        await _wakeReady;
        await resetStatsScope(msg.scope);
        sendResponse({ ok: true });
      } catch (e) {
        console.warn('[Potatofy] RESET_STATS failed:', e);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === 'TOGGLE_POTATO_SITE') {
    (async () => {
      try {
        const ok = await setPotatoSite(msg.host, { js: msg.js, img: msg.img });
        sendResponse({ ok });
      } catch (e) {
        console.warn('[Potatofy] TOGGLE_POTATO_SITE failed:', e);
        sendResponse({ ok: false });
      }
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
      try {
        const result = await boostTab(tabId, host);
        sendResponse(result);
      } catch (e) {
        console.warn('[Potatofy] boostTab threw:', e);
        sendResponse({ ok: false, reason: 'install_failed' });
      }
    })();
    return true;
  }

  if (msg.type === 'CLEAR_BOOST') {
    (async () => {
      try {
        const tabId = Number(msg.tabId);
        if (Number.isFinite(tabId)) await clearBoostForTab(tabId);
        sendResponse({ ok: true });
      } catch (e) {
        console.warn('[Potatofy] clearBoost threw:', e);
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_BOOST_STATUS') {
    (async () => {
      // Wait for rehydrateBoostedTabs() to finish before reading boostedTabs —
      // otherwise a query that arrives right after a SW wake can see an empty
      // map and falsely report the tab as unboosted.
      await _wakeReady;
      const tabId = Number(msg.tabId);
      sendResponse({ boosted: boostedTabs.has(tabId) });
    })();
    return true;
  }

  if (msg.type === 'GET_SITE_KILLERS') {
    (async () => {
      try {
        const killers = await getSiteKillers();
        sendResponse({ ok: true, killers });
      } catch (e) {
        console.warn('[Potatofy] getSiteKillers threw:', e);
        sendResponse({ ok: false, killers: {} });
      }
    })();
    return true;
  }

  // SEC-01: the content script now runs in the ISOLATED world, so OUR content
  // script (not a page script) is the caller here, and sender.tab / sender.url are
  // populated. Page scripts in the MAIN world cannot reach chrome.runtime, so this
  // is no longer page-reachable. We still derive the host from sender.url (not
  // msg.host) for tab senders: it's the authoritative source and closes a
  // whitelist-membership oracle if the surface ever reopens (e.g. a future
  // externally_connectable). Non-tab senders (the popup) legitimately pass msg.host.
  if (msg.type === 'GET_CONTENT_SETTINGS') {
    // Keep the per-tab rate limit as cheap defense-in-depth so a tight
    // settings-polling loop can't sustain SW wake pressure on a Raspberry Pi.
    const _gcsTabId = sender && sender.tab ? sender.tab.id : null;
    if (_gcsTabId !== null && !gcsRateAllow(_gcsTabId)) {
      sendResponse({ ok: false });
      return false;
    }
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
    if (!calibrationRateAllow(tabId)) { sendResponse({ ok: true }); return false; }
    // PERF-10 / SEC-03 — record into the in-memory buffer only; no per-message
    // storage read-modify-write. Persisted on the periodic stats-flush alarm.
    // Await _wakeReady so we don't append to a not-yet-rehydrated buffer.
    if (isValidCalibrationData(msg.data)) {
      (async () => { await _wakeReady; recordCalibration(msg.data); })();
    }
    sendResponse({ ok: true });
    return false;
  }

  // HEAP_MEASUREMENT removed (PERF-01): the performance.memory heap-delta path was
  // statistically unsound and is gone. The content script no longer sends it.
});

// When settings change (popup toggle, sync, direct storage write), push the
// new per-host detail to every active content script. This replaces the
// chrome.storage.onChanged + CustomEvent path that the old isolated-world
// bridge used.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.settings) return;
  scheduleBroadcast();
});
