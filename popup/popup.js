import { DEFAULT_SETTINGS, ALLOWED_THRESHOLDS, ALLOWED_PRESSURE_MB } from '../lib/defaults.js';
import { formatBytes, formatMs, normalizeHost } from '../lib/formatters.js';

// 1.1.2: detect packaged builds. Diagnostics suite is dev-only — gets hidden
// when running under a Web Store install where update_url is set.
const IS_PACKAGED = !!chrome.runtime.getManifest().update_url;

// 1.1.2 A3 — used by the whitelist cap warning.
const MAX_WHITELIST = 199;

const els = {
  blocking:         document.getElementById('toggle-blocking'),
  suspend:          document.getElementById('toggle-suspend'),
  throttle:         document.getElementById('toggle-throttle'),
  imageLazy:        document.getElementById('toggle-image-lazy'),
  imageLq:          document.getElementById('toggle-image-lq'),
  animation:        document.getElementById('toggle-animation'),
  autoplay:         document.getElementById('toggle-autoplay'),
  prefetch:         document.getElementById('toggle-prefetch'),
  video:            document.getElementById('toggle-video'),
  videoPreload:     document.getElementById('toggle-video-preload'),
  thirdPartyScript: document.getElementById('toggle-3p-script'),
  foregroundPotato: document.getElementById('toggle-foreground-potato'),
  siteKillers:      document.getElementById('toggle-site-killers'),
  pressure:         document.getElementById('toggle-pressure'),
  cloudSync:        document.getElementById('toggle-cloud-sync'),
  syncHosts:        document.getElementById('toggle-sync-hosts'),
  threshold:        document.getElementById('idle-threshold'),
  pressureThresh:   document.getElementById('pressure-threshold'),
  discardNow:       document.getElementById('discard-now-btn'),
  hostname:         document.getElementById('current-hostname'),
  whitelistBtn:     document.getElementById('whitelist-btn'),
  boostBtn:         document.getElementById('boost-tab-btn'),
  killJsBtn:        document.getElementById('kill-js-btn'),
  killImgBtn:       document.getElementById('kill-img-btn'),
  whitelistList:    document.getElementById('whitelist-list'),
  whitelistCount:   document.getElementById('whitelist-count'),
  potatoList:       document.getElementById('potato-list'),
  potatoCount:      document.getElementById('potato-count'),
  statsScope:       document.getElementById('stats-scope'),
  statsReset:       document.getElementById('stats-reset'),
  statRam:          document.getElementById('stat-ram'),
  statBw:           document.getElementById('stat-bw'),
  statCpu:          document.getElementById('stat-cpu'),
  statReq:          document.getElementById('stat-req'),
  stat3p:           document.getElementById('stat-3p'),
  statTabs:         document.getElementById('stat-tabs'),
  runTestsBtn:      document.getElementById('run-tests-btn'),
  testResults:      document.getElementById('test-results')
};

let currentSettings = { ...DEFAULT_SETTINGS };
let currentHostname = null;

let currentTabId = null;
let discardConfirmPending = false;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getActiveHostname() {
  const tab = await getActiveTab();
  currentTabId = tab && Number.isFinite(tab.id) ? tab.id : null;
  if (!tab || !tab.url) return null;
  try {
    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return normalizeHost(url.hostname);
  } catch { return null; }
}

// Mirrors service-worker.js's isHostWhitelisted — a plain `.includes()`
// against the whitelist array missed suffix matches (e.g. a stored
// "www.example.com" entry vs. the normalized "example.com" hostname), so the
// popup could show "Whitelist This Site" for a host the SW already treats as
// whitelisted.
function isHostWhitelisted(hostname, whitelist) {
  const host = normalizeHost(hostname);
  return (whitelist || []).some(d => {
    const dn = normalizeHost(d);
    return host === dn || host.endsWith('.' + dn);
  });
}

// N-3 — single place that merges a stored/changed settings blob over the
// defaults, shared by loadSettings and the storage.onChanged listener so the
// two can't drift.
function mergeSettings(src) {
  const merged = { ...DEFAULT_SETTINGS, ...(src || {}) };
  // The shallow spread above shares the nested whitelist/potatoSites default
  // objects by reference when `src` doesn't provide them — a later in-place
  // mutation (e.g. bindSiteActions' whitelist push/splice) would then corrupt
  // the module-level DEFAULT_SETTINGS for the rest of the popup's lifetime.
  merged.whitelist = Array.isArray(merged.whitelist) ? [...merged.whitelist] : [];
  merged.potatoSites = { ...(merged.potatoSites || {}) };
  return merged;
}

async function loadSettings() {
  try {
    const data = await chrome.storage.local.get('settings');
    currentSettings = mergeSettings(data.settings);
  } catch (e) {
    currentSettings = mergeSettings({});
  }
}

let toastTimer = null;
let toastFadeTimer = null;
function showToast(msg) {
  // Reuse any existing toast element to avoid stacking.
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.classList.remove('fade-out');
  // Force the entrance animation to replay even when reusing an existing
  // element — removing the class, forcing a reflow, then re-adding it
  // restarts the CSS animation instead of silently no-op'ing because the
  // class was already present from a prior toast.
  el.classList.remove('toast-animate-in');
  void el.offsetWidth; // force reflow
  el.classList.add('toast-animate-in');
  el.textContent = msg;
  if (toastTimer) clearTimeout(toastTimer);
  if (toastFadeTimer) clearTimeout(toastFadeTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('fade-out');
    toastFadeTimer = setTimeout(() => { el.remove(); toastFadeTimer = null; }, 200);
    toastTimer = null;
  }, 3000);
}

async function pushSettings() {
  await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: currentSettings });
}

function renderToggles() {
  els.blocking.checked         = !!currentSettings.blockingEnabled;
  els.suspend.checked          = !!currentSettings.tabSuspendEnabled;
  els.throttle.checked         = !!currentSettings.jsThrottleEnabled;
  els.imageLazy.checked        = !!currentSettings.imageLazyEnabled;
  els.imageLq.checked          = !!currentSettings.imageLowQualityEnabled;
  els.animation.checked        = !!currentSettings.animationKillEnabled;
  els.autoplay.checked         = !!currentSettings.autoplayKillEnabled;
  els.prefetch.checked         = !!currentSettings.prefetchStripEnabled;
  els.video.checked            = !!currentSettings.videoPauseEnabled;
  els.videoPreload.checked     = !!currentSettings.videoPreloadNoneEnabled;
  els.thirdPartyScript.checked = !!currentSettings.thirdPartyScriptBlockEnabled;
  els.foregroundPotato.checked = !!currentSettings.foregroundPotatoEnabled;
  els.siteKillers.checked      = !!currentSettings.siteKillersEnabled;
  els.pressure.checked         = !!currentSettings.memoryPressureEnabled;
  els.cloudSync.checked        = !!currentSettings.useCloudSync;
  els.syncHosts.checked        = !!currentSettings.syncHostsToCloud;
  // The site-list sync sub-toggle is meaningful only when cloud sync is on.
  els.syncHosts.disabled       = !currentSettings.useCloudSync;

  const minutes = Number(currentSettings.idleThresholdMinutes) || 5;
  els.threshold.value = String(ALLOWED_THRESHOLDS.includes(minutes) ? minutes : 5);
  els.threshold.disabled = !currentSettings.tabSuspendEnabled;
  // Don't blindly re-enable while a "Discarded N tabs" confirmation is still
  // showing — a storage.onChanged-triggered renderAll() firing during that
  // 2s window would otherwise let the button be clicked again before its own
  // confirmation animation finishes/resets.
  els.discardNow.disabled = discardConfirmPending;

  const pmb = Number(currentSettings.memoryPressureThresholdMB) || 500;
  els.pressureThresh.value = String(ALLOWED_PRESSURE_MB.includes(pmb) ? pmb : 500);
  els.pressureThresh.disabled = !currentSettings.memoryPressureEnabled;
}

// NIT-2 — single place that sets the boost button's default label so neither
// refreshBoostState nor the click-handler's restore timeout can drift out of sync.
function setBoostBtnDefault() {
  els.boostBtn.replaceChildren();
  els.boostBtn.append('Boost ');
  const em = document.createElement('em');
  em.textContent = 'this tab';
  els.boostBtn.appendChild(em);
}

// D: queries SW for the current tab's boost status and renders an active
// state on the boost button so the user can see (and cancel) an active boost.
async function refreshBoostState() {
  if (!Number.isFinite(currentTabId) || !currentHostname) {
    els.boostBtn.dataset.boosted = '0';
    els.boostBtn.classList.remove('active');
    setBoostBtnDefault(); // reset stale "Remove boost" text left from a prior tab
    return;
  }
  try {
    const reply = await chrome.runtime.sendMessage({
      type: 'GET_BOOST_STATUS', tabId: currentTabId
    });
    const boosted = !!(reply && reply.boosted);
    els.boostBtn.dataset.boosted = boosted ? '1' : '0';
    els.boostBtn.classList.toggle('active', boosted);
    if (boosted) {
      els.boostBtn.textContent = 'Remove boost';
    } else {
      setBoostBtnDefault();
    }
  } catch (e) {
    els.boostBtn.dataset.boosted = '0';
    els.boostBtn.classList.remove('active');
    setBoostBtnDefault();
  }
}

function renderWhitelistButton() {
  if (!currentHostname) {
    els.whitelistBtn.disabled = true;
    els.whitelistBtn.textContent = 'Unavailable on this page';
    els.whitelistBtn.classList.remove('remove');
    els.boostBtn.disabled = true;
    els.killJsBtn.disabled = true;
    els.killImgBtn.disabled = true;
    return;
  }
  els.whitelistBtn.disabled = false;
  els.boostBtn.disabled = false;
  els.killJsBtn.disabled = false;
  els.killImgBtn.disabled = false;
  const isWl = isHostWhitelisted(currentHostname, currentSettings.whitelist);
  if (isWl) {
    els.whitelistBtn.textContent = 'Remove from Whitelist';
    els.whitelistBtn.classList.add('remove');
  } else {
    els.whitelistBtn.textContent = 'Whitelist This Site';
    els.whitelistBtn.classList.remove('remove');
  }
  const potato = (currentSettings.potatoSites || {})[currentHostname] || { js: false, img: false };
  els.killJsBtn.textContent = potato.js ? 'Restore JS here' : 'Kill JS here';
  els.killImgBtn.textContent = potato.img ? 'Restore images here' : 'Kill images here';
  els.killJsBtn.classList.toggle('active', !!potato.js);
  els.killImgBtn.classList.toggle('active', !!potato.img);
}

// ---------- Section meta (X/Y on count per accordion section) ----------

const SECTION_TOGGLE_MAP = {
  standard: ['blockingEnabled', 'tabSuspendEnabled', 'jsThrottleEnabled', 'imageLazyEnabled',
             'animationKillEnabled', 'autoplayKillEnabled', 'prefetchStripEnabled', 'videoPauseEnabled'],
  max:      ['thirdPartyScriptBlockEnabled', 'foregroundPotatoEnabled', 'siteKillersEnabled',
             'videoPreloadNoneEnabled', 'imageLowQualityEnabled'],
  memory:   ['memoryPressureEnabled'],
  site:     ['useCloudSync', 'syncHostsToCloud']
};

function renderSectionMeta() {
  for (const [key, settingKeys] of Object.entries(SECTION_TOGGLE_MAP)) {
    const el = document.querySelector(`[data-meta-for="${key}"]`);
    if (!el) continue;
    const total = settingKeys.length;
    const on = settingKeys.filter(k => !!currentSettings[k]).length;
    el.textContent = `${on}/${total} on`;
  }
}

function renderWhitelistList() {
  els.whitelistList.replaceChildren();
  const list = currentSettings.whitelist || [];
  els.whitelistCount.textContent = String(list.length);
  for (const host of list) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = host;
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.title = `Remove ${host}`;
    btn.addEventListener('click', async () => {
      // H-6 — read the live whitelist inside the handler instead of closing over
      // the render-time `list`. A settings update (storage.onChanged) can replace
      // currentSettings.whitelist between renders; filtering the stale array would
      // silently drop any entries added since this row was rendered.
      const prev = currentSettings.whitelist || [];
      try {
        currentSettings.whitelist = prev.filter(h => h !== host);
        await pushSettings();
        renderAll();
      } catch (e) {
        // Revert — otherwise the row visually disappears even though the SW
        // never actually removed it from the persisted whitelist.
        currentSettings.whitelist = prev;
        renderAll();
        showToast('Failed to save — please try again');
      }
    });
    li.appendChild(span);
    li.appendChild(btn);
    els.whitelistList.appendChild(li);
  }
}

function renderPotatoList() {
  els.potatoList.replaceChildren();
  const sites = currentSettings.potatoSites || {};
  const hosts = Object.keys(sites);
  els.potatoCount.textContent = String(hosts.length);
  for (const host of hosts) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    const flags = [];
    if (sites[host].js) flags.push('JS off');
    if (sites[host].img) flags.push('IMG off');
    span.textContent = `${host} — ${flags.join(', ') || 'idle'}`;
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.title = `Clear potato mode for ${host}`;
    btn.addEventListener('click', async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'TOGGLE_POTATO_SITE', host, js: false, img: false });
        await loadSettings();
        renderAll();
      } catch (e) {
        showToast('Failed to save — please try again');
      }
    });
    li.appendChild(span);
    li.appendChild(btn);
    els.potatoList.appendChild(li);
  }
}

function renderAll() {
  renderToggles();
  renderWhitelistButton();
  renderWhitelistList();
  renderPotatoList();
  renderSectionMeta();
}

// ---------- Accordion state persistence ----------

const SECTION_STATE_KEY = 'popupSectionOpen';

// In-memory mirror of the persisted state, updated synchronously on every
// toggle. Previously each toggle handler did its own read-modify-write
// straight to session storage; two sections toggled in rapid succession
// could read the same stale snapshot and the second write would clobber the
// first section's change.
let sectionState = {};
let sectionPersistTimer = null;

async function restoreSectionState() {
  try {
    const data = await chrome.storage.session.get(SECTION_STATE_KEY);
    const state = data[SECTION_STATE_KEY];
    if (state && typeof state === 'object') sectionState = { ...state };
    // Also covers the nested whitelist/potato-mode accordions (details.nested-list)
    // — previously excluded because they lack the .section class, so users
    // with large lists had to manually re-expand them on every popup open.
    for (const el of document.querySelectorAll('details.section, details.nested-list')) {
      const k = el.dataset.section;
      if (k in sectionState) el.open = !!sectionState[k];
    }
  } catch (e) {}
}

function bindSectionPersist() {
  const sections = document.querySelectorAll('details.section, details.nested-list');
  for (const el of sections) {
    el.addEventListener('toggle', () => {
      sectionState[el.dataset.section] = el.open;
      if (sectionPersistTimer) return;
      sectionPersistTimer = setTimeout(async () => {
        sectionPersistTimer = null;
        try { await chrome.storage.session.set({ [SECTION_STATE_KEY]: sectionState }); } catch (e) {}
      }, 300);
    });
  }
}

// ---------- Stats (P4: push-based via storage.onChanged) ----------
// formatBytes / formatMs imported from ../lib/formatters.js (shared with tests.js).

async function refreshStats() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
    if (!reply || !reply.stats) return;
    const scope = els.statsScope.value || 'session';
    const counters = reply.stats[scope] || {};
    const savings = (reply.savings && reply.savings[scope]) || { ramBytes: 0, bwBytes: 0, cpuMs: 0 };

    // 1.1.1 sanity cap: never display a "RAM saved" value larger than 85% of
    // the device's physical memory. Guards against future counter bugs from
    // showing impossible numbers like the 6 GB-on-8 GB-Pi case.
    const capMB = Number(reply.deviceCapacityMB) || 0;
    const capBytes = capMB > 0 ? Math.floor(capMB * 0.85 * 1024 * 1024) : Infinity;
    const ramDisplayed = Math.min(savings.ramBytes, capBytes);
    const isCapped = ramDisplayed < savings.ramBytes;

    // "Measured" RAM = the real tab-discard before/after measurement (realRamFreed).
    // When present the headline isn't purely heuristic, so drop the "~" estimate
    // prefix. (The former heap-measurement breakdown.measured branch was removed.)
    const hasMeasuredData = (counters.realRamFreed || 0) > 0 || (savings.breakdown?.real?.ramBytes ?? 0) > 0;
    // isCapped must win regardless of hasMeasuredData — the displayed value
    // was clamped down from the true total, so showing it as an exact
    // measurement (no prefix) would misrepresent it even when part of the
    // total came from a real measurement.
    const ramPrefix = isCapped ? '≥' : (hasMeasuredData ? '' : '~');
    const ramDisplay = ramPrefix + formatBytes(ramDisplayed);

    els.statRam.textContent  = ramDisplay;
    els.statBw.textContent   = '~' + formatBytes(savings.bwBytes);
    els.statCpu.textContent  = '~' + formatMs(savings.cpuMs);
    els.statReq.textContent  = ((counters.blockedRequests || 0) + (counters.blockedFonts || 0)).toLocaleString();
    // 3rd-party scripts + images both count toward the "3rd-party" stat row.
    els.stat3p.textContent   = ((counters.thirdPartyScriptsBlocked || 0) +
                                (counters.thirdPartyImagesBlocked  || 0)).toLocaleString();
    els.statTabs.textContent = (counters.tabsDiscarded || 0).toLocaleString();
  } catch (e) {}
}

// ---------- Bindings ----------

function bindToggles() {
  const map = [
    [els.blocking,         'blockingEnabled'],
    [els.suspend,          'tabSuspendEnabled'],
    [els.throttle,         'jsThrottleEnabled'],
    [els.imageLazy,        'imageLazyEnabled'],
    [els.imageLq,          'imageLowQualityEnabled'],
    [els.animation,        'animationKillEnabled'],
    [els.autoplay,         'autoplayKillEnabled'],
    [els.prefetch,         'prefetchStripEnabled'],
    [els.video,            'videoPauseEnabled'],
    [els.videoPreload,     'videoPreloadNoneEnabled'],
    [els.thirdPartyScript, 'thirdPartyScriptBlockEnabled'],
    [els.foregroundPotato, 'foregroundPotatoEnabled'],
    [els.siteKillers,      'siteKillersEnabled'],
    [els.pressure,         'memoryPressureEnabled'],
    [els.cloudSync,        'useCloudSync'],
    [els.syncHosts,        'syncHostsToCloud']
  ];
  for (const [el, key] of map) {
    el.addEventListener('change', async () => {
      // Capture pre-mutation state so a failed save can be rolled back —
      // otherwise the toggle stayed visually flipped even though the SW
      // never actually applied the change.
      const prev = currentSettings[key];
      const prevSyncHostsToCloud = currentSettings.syncHostsToCloud;
      currentSettings[key] = el.checked;
      if (el === els.suspend) els.threshold.disabled = !el.checked;
      if (el === els.pressure) els.pressureThresh.disabled = !el.checked;
      if (el === els.cloudSync) {
        els.syncHosts.disabled = !el.checked;
        if (!el.checked) {
          // Turning off cloud sync also turns off the host opt-in so the next
          // toggle of cloud sync defaults safely back to "feature flags only".
          currentSettings.syncHostsToCloud = false;
          els.syncHosts.checked = false;
        }
      }
      // Disable while the save is in flight so rapid re-toggling can't fire
      // overlapping UPDATE_SETTINGS calls whose responses land out of order.
      el.disabled = true;
      try {
        await pushSettings();
      } catch (e) {
        currentSettings[key] = prev;
        currentSettings.syncHostsToCloud = prevSyncHostsToCloud;
        renderAll();
        showToast('Failed to save — please try again');
      } finally {
        el.disabled = false;
      }
    });
  }
}

function bindSuspendControls() {
  els.threshold.addEventListener('change', async () => {
    const prev = currentSettings.idleThresholdMinutes;
    const v = Number(els.threshold.value);
    currentSettings.idleThresholdMinutes = ALLOWED_THRESHOLDS.includes(v) ? v : 5;
    els.threshold.disabled = true;
    try {
      await pushSettings();
    } catch (e) {
      currentSettings.idleThresholdMinutes = prev;
      renderAll();
      showToast('Failed to save — please try again');
      return; // renderAll() above already restored the correct disabled state
    }
    els.threshold.disabled = !currentSettings.tabSuspendEnabled;
  });

  els.pressureThresh.addEventListener('change', async () => {
    const prev = currentSettings.memoryPressureThresholdMB;
    const v = Number(els.pressureThresh.value);
    currentSettings.memoryPressureThresholdMB = ALLOWED_PRESSURE_MB.includes(v) ? v : 500;
    els.pressureThresh.disabled = true;
    try {
      await pushSettings();
    } catch (e) {
      currentSettings.memoryPressureThresholdMB = prev;
      renderAll();
      showToast('Failed to save — please try again');
      return;
    }
    els.pressureThresh.disabled = !currentSettings.memoryPressureEnabled;
  });

  els.discardNow.addEventListener('click', async () => {
    const original = els.discardNow.textContent;
    els.discardNow.disabled = true;
    discardConfirmPending = true;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'DISCARD_NOW' });
      const count = (reply && reply.count) || 0;
      els.discardNow.textContent = `Discarded ${count} tab${count === 1 ? '' : 's'}`;
      els.discardNow.classList.add('confirmed');
      refreshStats();
    } catch (e) {
      els.discardNow.textContent = 'Failed';
    }
    setTimeout(() => {
      els.discardNow.textContent = original;
      els.discardNow.classList.remove('confirmed');
      discardConfirmPending = false;
      els.discardNow.disabled = false;
    }, 2000);
  });
}

function bindSiteActions() {
  els.whitelistBtn.addEventListener('click', async () => {
    if (!currentHostname) return;
    const prevList = currentSettings.whitelist || [];
    // Clone instead of mutating in place — the live array can be replaced by
    // a concurrent storage.onChanged update between the read and the write,
    // orphaning an in-place push/splice on the old array reference.
    const list = [...prevList];
    const idx = list.indexOf(currentHostname);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      if (list.length >= MAX_WHITELIST) {
        showToast(`Whitelist limit reached (${MAX_WHITELIST}). Remove an entry first.`);
        return;
      }
      list.push(currentHostname);
    }
    currentSettings.whitelist = list;
    // 1.1.3 G3: disable while the SW round-trip is in flight so a fast
    // double-click can't re-add a just-removed host (or vice versa).
    // renderWhitelistButton re-enables when renderAll runs.
    els.whitelistBtn.disabled = true;
    try {
      await pushSettings();
      renderAll();
    } catch (e) {
      currentSettings.whitelist = prevList;
      renderAll();
      showToast('Failed to save — please try again');
    }
  });

  els.boostBtn.addEventListener('click', async () => {
    if (!currentHostname || !Number.isFinite(currentTabId)) return;
    // D: toggle behaviour — if already boosted, send CLEAR_BOOST instead.
    const isBoosted = els.boostBtn.dataset.boosted === '1';
    const clickedTabId = currentTabId; // tab this click applies to
    els.boostBtn.disabled = true;
    try {
      if (isBoosted) {
        await chrome.runtime.sendMessage({ type: 'CLEAR_BOOST', tabId: currentTabId });
        els.boostBtn.textContent = 'Boost removed';
      } else {
        const reply = await chrome.runtime.sendMessage({
          type: 'BOOST_TAB', host: currentHostname, tabId: currentTabId
        });
        if (reply && reply.ok) {
          els.boostBtn.textContent = 'Boosted ✓';
          els.boostBtn.classList.add('confirmed');
        } else if (reply && reply.reason === 'whitelisted') {
          els.boostBtn.textContent = 'Whitelisted — no effect';
        } else if (reply && reply.reason === 'host_mismatch') {
          els.boostBtn.textContent = 'Tab navigated — try again';
        } else {
          els.boostBtn.textContent = 'Failed';
        }
      }
    } catch (e) {
      els.boostBtn.textContent = 'Failed';
    }
    setTimeout(async () => {
      els.boostBtn.classList.remove('confirmed');
      // If the user switched to a different (or invalid) tab while the 1.8s
      // confirmation was showing, leave this button alone — the tab-activation
      // handler already owns its state for the new tab context.
      if (currentTabId !== clickedTabId || !currentHostname) return;
      els.boostBtn.disabled = false;
      // refreshBoostState() itself sets the correct label (default text or
      // "Remove boost"); calling setBoostBtnDefault() first, before it
      // resolves, caused a one-frame flash to the wrong label for tabs that
      // were still actually boosted.
      await refreshBoostState();
    }, 1800);
  });

  els.killJsBtn.addEventListener('click', async () => {
    if (!currentHostname) return;
    const current = (currentSettings.potatoSites || {})[currentHostname] || { js: false, img: false };
    const nextJs = !current.js;
    els.killJsBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({
        type: 'TOGGLE_POTATO_SITE', host: currentHostname, js: nextJs
      });
      // Optimistically update in-memory state instead of loadSettings(),
      // which re-reads chrome.storage.local and could race the SW's async
      // write — briefly flashing the pre-toggle state back before the
      // storage.onChanged listener corrected it a moment later.
      const sites = { ...(currentSettings.potatoSites || {}) };
      const next = { js: nextJs, img: current.img };
      if (!next.js && !next.img) delete sites[currentHostname];
      else sites[currentHostname] = next;
      currentSettings.potatoSites = sites;
      renderAll();
    } catch (e) {
      showToast('Failed to save — please try again');
    } finally {
      els.killJsBtn.disabled = false;
    }
  });

  els.killImgBtn.addEventListener('click', async () => {
    if (!currentHostname) return;
    const current = (currentSettings.potatoSites || {})[currentHostname] || { js: false, img: false };
    const nextImg = !current.img;
    els.killImgBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({
        type: 'TOGGLE_POTATO_SITE', host: currentHostname, img: nextImg
      });
      const sites = { ...(currentSettings.potatoSites || {}) };
      const next = { js: current.js, img: nextImg };
      if (!next.js && !next.img) delete sites[currentHostname];
      else sites[currentHostname] = next;
      currentSettings.potatoSites = sites;
      renderAll();
    } catch (e) {
      showToast('Failed to save — please try again');
    } finally {
      els.killImgBtn.disabled = false;
    }
  });
}

function bindStatsControls() {
  els.statsScope.addEventListener('change', refreshStats);
  els.statsReset.addEventListener('click', async () => {
    const scope = els.statsScope.value || 'session';
    try {
      await chrome.runtime.sendMessage({ type: 'RESET_STATS', scope });
      refreshStats();
    } catch (e) {
      showToast('Failed to save — please try again');
    }
  });
}

function bindStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes.stats || changes.calibratedBandwidth)) {
      refreshStats();
    }
    if (areaName === 'local' && changes.settings) {
      currentSettings = mergeSettings(changes.settings.newValue);
      renderAll();
    }
  });
}

// 1.1.1: refresh hostname/site state when the user switches tabs while the
// popup is open (e.g. pinned popup window). Without this, the "Current site"
// row stayed stuck on whichever tab was active at popup open.
function bindTabActivation() {
  if (!chrome.tabs || !chrome.tabs.onActivated) return;
  // Tag each refresh with a sequence number so an EARLIER call that happens
  // to resolve AFTER a later one (rapid tab switching, or a background tab
  // finishing a load) discards its now-stale result instead of clobbering
  // the UI with the wrong tab's hostname.
  let refreshSeq = 0;
  const refreshSite = async () => {
    const seq = ++refreshSeq;
    const hostname = await getActiveHostname();
    if (seq !== refreshSeq) return; // superseded by a newer call
    currentHostname = hostname;
    els.hostname.textContent = currentHostname || 'unavailable';
    renderWhitelistButton();
    await refreshBoostState();
  };
  chrome.tabs.onActivated.addListener(() => { refreshSite().catch(() => {}); });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === currentTabId && changeInfo.url) refreshSite().catch(() => {});
  });
}

function renderTestResults({ passed, failed, total, results }) {
  const allPass = failed === 0;
  els.testResults.replaceChildren();
  const summary = document.createElement('div');
  summary.className = 'test-summary ' + (allPass ? 'all-pass' : 'has-fail');
  summary.textContent = allPass
    ? `✓ All ${total} tests passed`
    : `${passed}/${total} passed - ${failed} failed`;
  els.testResults.appendChild(summary);
  let lastSuite = null;
  for (const r of results) {
    if (r.suite !== lastSuite) {
      const label = document.createElement('div');
      label.className = 'test-suite-label';
      label.textContent = r.suite;
      els.testResults.appendChild(label);
      lastSuite = r.suite;
    }
    const line = document.createElement('div');
    line.className = 'test-line ' + (r.ok ? 'test-pass' : 'test-fail');
    const icon = document.createElement('span');
    icon.className = 'test-icon';
    icon.textContent = r.ok ? '✓' : '✗';
    const name = document.createElement('span');
    name.className = 'test-name';
    name.textContent = r.name;
    line.appendChild(icon);
    line.appendChild(name);
    els.testResults.appendChild(line);
    if (!r.ok && r.error) {
      const err = document.createElement('span');
      err.className = 'test-error';
      err.textContent = r.error;
      els.testResults.appendChild(err);
    }
  }
  els.testResults.classList.remove('hidden');
}

function bindDiagnosticsBtn() {
  let diagnosticsRunning = false;
  let preDiagnosticsSettings = null;

  // An MV3 popup document is torn down the instant it loses focus, killing
  // any in-flight JS -- including the try/finally cleanup blocks inside the
  // diagnostics runner that restore settings mutated during a test. Best-effort
  // restore the pre-run snapshot here so a popup closed mid-run doesn't leave
  // the user's real settings stuck in a synthetic test state.
  window.addEventListener('pagehide', () => {
    if (diagnosticsRunning && preDiagnosticsSettings) {
      chrome.storage.local.set({ settings: preDiagnosticsSettings }).catch(() => {});
    }
  });

  els.runTestsBtn.addEventListener('click', async () => {
    els.runTestsBtn.disabled = true;
    els.runTestsBtn.textContent = 'Running…';
    diagnosticsRunning = true;
    preDiagnosticsSettings = structuredClone(currentSettings);
    try {
      const tests = window.__potatofyTests;
      if (!tests || typeof tests.run !== 'function') {
        throw new Error('test runner not loaded');
      }
      const report = await tests.run();
      renderTestResults(report);
    } catch (e) {
      els.testResults.replaceChildren();
      const summary = document.createElement('div');
      summary.className = 'test-summary has-fail';
      summary.textContent = 'Runner error: ' + (e && e.message ? e.message : String(e));
      els.testResults.appendChild(summary);
      els.testResults.classList.remove('hidden');
    }
    diagnosticsRunning = false;
    preDiagnosticsSettings = null;
    els.runTestsBtn.textContent = 'Run Diagnostics';
    els.runTestsBtn.disabled = false;
  });
}

// Privacy Policy Modal
const privacyModal = document.getElementById('privacy-modal');
const privacyCheckbox = document.getElementById('privacy-accept-check');
const privacyAcceptBtn = document.getElementById('privacy-accept-btn');

async function checkPrivacyAcceptance() {
  try {
    const data = await chrome.storage.local.get('privacyAccepted');
    return data.privacyAccepted === true;
  } catch (e) {
    console.warn('[Potatofy] Could not check privacy status:', e);
    return false;
  }
}

function showPrivacyModal() {
  privacyModal.style.display = 'flex';
  const popupEl = document.querySelector('.popup');
  popupEl.style.pointerEvents = 'none';
  popupEl.style.opacity = '0.4';
  // pointer-events:none only blocks mouse/touch — a keyboard user could still
  // Tab into the toggles/buttons underneath and activate them with the
  // privacy policy unaccepted. `inert` removes the subtree from the tab
  // order (and from AT) entirely.
  popupEl.inert = true;
  privacyCheckbox.focus();
}

function hidePrivacyModal() {
  privacyModal.style.display = 'none';
  const popupEl = document.querySelector('.popup');
  popupEl.style.pointerEvents = 'auto';
  popupEl.style.opacity = '1';
  popupEl.inert = false;
}

privacyCheckbox.addEventListener('change', () => {
  privacyAcceptBtn.disabled = !privacyCheckbox.checked;
});

privacyAcceptBtn.addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ privacyAccepted: true });
  } catch (e) {
    console.error('[Potatofy] Could not save privacy acceptance:', e);
    return;
  }
  try {
    hidePrivacyModal();
    await initPopup();
  } catch (e) {
    console.error('[Potatofy] initPopup failed after privacy acceptance:', e);
    showPrivacyModal();
    showToast('Something went wrong — please try again');
  }
});

// The native behavior of closing the extension popup on Escape is owned by
// the browser shell — intercepting the keydown here cannot prevent that, so
// this listener was a no-op.

// bindAllOnce() registers every event listener exactly once, no matter how
// many times initPopup() itself runs. Previously each bind*() call was
// re-invoked on every initPopup() retry (e.g. the privacy-modal accept path
// re-entering after an earlier failure), which registered a second,
// duplicate listener on every toggle/button — one click then fired every
// handler twice.
let _bindsDone = false;
function bindAllOnce() {
  if (_bindsDone) return;
  _bindsDone = true;
  bindToggles();
  bindSuspendControls();
  bindSiteActions();
  bindStatsControls();
  bindDiagnosticsBtn();
  bindStorageListener();
  bindSectionPersist();
  bindTabActivation();
}

// Promise-based guard instead of a boolean: concurrent/overlapping calls
// await the SAME in-flight attempt rather than one silently short-circuiting
// on a flag that was already set true before any async work completed. On
// failure the guard is cleared so a genuine retry (e.g. re-accepting the
// privacy modal) re-runs the init sequence instead of getting stuck
// half-initialized forever.
let _initPromise = null;
async function initPopup() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    currentHostname = await getActiveHostname();
    els.hostname.textContent = currentHostname || 'unavailable';
    await loadSettings();
    await restoreSectionState();
    renderAll();
    bindAllOnce();
    // E1: hide the diagnostics accordion in packaged (Web Store) installs so
    // end users can't accidentally wipe their session stats via the test suite.
    // Removed from the DOM entirely rather than display:none — the latter left
    // it as the `.section:last-of-type` element for CSS purposes, so the
    // last genuinely *visible* section lost its bottom-border rule.
    if (IS_PACKAGED && els.runTestsBtn) {
      const section = els.runTestsBtn.closest('details.section--diag');
      if (section) section.remove();
    }
    refreshStats();
    // Justifies the pulsing "live" badge on the stats card — without a poll
    // loop, displayed numbers only updated on the SW's own ~60s flush cadence
    // (or a manual action), which could lag well behind "live".
    setInterval(refreshStats, 3000);
    await refreshBoostState();
  })();
  try {
    await _initPromise;
  } catch (e) {
    _initPromise = null;
    throw e;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Check privacy policy acceptance first
  const accepted = await checkPrivacyAcceptance();
  if (!accepted) {
    showPrivacyModal();
    return;
  }
  try {
    await initPopup();
  } catch (e) {
    console.error('[Potatofy] initPopup failed on DOMContentLoaded:', e);
    showToast('Something went wrong — please try again');
  }
});
