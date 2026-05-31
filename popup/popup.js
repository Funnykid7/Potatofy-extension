import { DEFAULT_SETTINGS, ALLOWED_THRESHOLDS, ALLOWED_PRESSURE_MB } from '../lib/defaults.js';

// 1.1.2: detect packaged builds. Diagnostics suite is dev-only — gets hidden
// when running under a Web Store install where update_url is set.
const IS_PACKAGED = !!chrome.runtime.getManifest().update_url;

// E3: shared formatters loaded by ../lib/formatters.js classic script.
const { formatBytes, formatMs, normalizeHost } = window.PotatofyFmt;

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

// N-3 — single place that merges a stored/changed settings blob over the
// defaults, shared by loadSettings and the storage.onChanged listener so the
// two can't drift.
function mergeSettings(src) {
  return { ...DEFAULT_SETTINGS, ...(src || {}) };
}

async function loadSettings() {
  const data = await chrome.storage.local.get('settings');
  currentSettings = mergeSettings(data.settings);
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
  els.discardNow.disabled = false;

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
  const isWl = (currentSettings.whitelist || []).includes(currentHostname);
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
      const cur = currentSettings.whitelist || [];
      currentSettings.whitelist = cur.filter(h => h !== host);
      await pushSettings();
      renderAll();
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
      await chrome.runtime.sendMessage({ type: 'TOGGLE_POTATO_SITE', host, js: false, img: false });
      await loadSettings();
      renderAll();
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

async function restoreSectionState() {
  try {
    const data = await chrome.storage.session.get(SECTION_STATE_KEY);
    const state = data[SECTION_STATE_KEY];
    if (!state || typeof state !== 'object') return;
    for (const el of document.querySelectorAll('details.section')) {
      const k = el.dataset.section;
      if (k in state) el.open = !!state[k];
    }
  } catch (e) {}
}

function bindSectionPersist() {
  const sections = document.querySelectorAll('details.section');
  for (const el of sections) {
    el.addEventListener('toggle', async () => {
      try {
        const data = await chrome.storage.session.get(SECTION_STATE_KEY);
        const state = (data && data[SECTION_STATE_KEY]) || {};
        state[el.dataset.section] = el.open;
        await chrome.storage.session.set({ [SECTION_STATE_KEY]: state });
      } catch (e) {}
    });
  }
}

// ---------- Stats (P4: push-based via storage.onChanged) ----------
// formatBytes / formatMs come from window.PotatofyFmt — shared with tests.js.

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

    // Check if we have real measurements (from tab discard + heap measurement)
    const hasRealMeasurement = (counters.realRamFreed || 0) > 0;
    const hasHeapMeasurement = (savings.breakdown?.measured?.ramBytes ?? 0) > 0;
    const hasMeasuredData = hasRealMeasurement || hasHeapMeasurement;
    const ramPrefix = hasMeasuredData ? '' : (isCapped ? '≥' : '~');

    // Build RAM display with breakdown details
    let ramDisplay = ramPrefix + formatBytes(ramDisplayed);
    if (hasMeasuredData && savings.breakdown && !isCapped) {
      const parts = [];
      if (hasRealMeasurement && savings.breakdown?.real?.ramBytes) {
        parts.push(`${formatBytes(savings.breakdown.real.ramBytes)} (measured)`);
      }
      if (hasHeapMeasurement && savings.breakdown?.measured?.ramBytes) {
        parts.push(`${formatBytes(savings.breakdown.measured.ramBytes)} (heap measured)`);
      }
      if ((savings.breakdown?.estimated?.ramBytes ?? 0) > 0) {
        parts.push(`${formatBytes(savings.breakdown.estimated.ramBytes)} (estimated)`);
      }
      if (parts.length > 0) {
        ramDisplay += ` [${parts.join(' + ')}]`;
      }
    }

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
      await pushSettings();
    });
  }
}

function bindSuspendControls() {
  els.threshold.addEventListener('change', async () => {
    const v = Number(els.threshold.value);
    currentSettings.idleThresholdMinutes = ALLOWED_THRESHOLDS.includes(v) ? v : 5;
    await pushSettings();
  });

  els.pressureThresh.addEventListener('change', async () => {
    const v = Number(els.pressureThresh.value);
    currentSettings.memoryPressureThresholdMB = ALLOWED_PRESSURE_MB.includes(v) ? v : 500;
    await pushSettings();
  });

  els.discardNow.addEventListener('click', async () => {
    const original = els.discardNow.textContent;
    els.discardNow.disabled = true;
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
      els.discardNow.disabled = false;
    }, 2000);
  });
}

function bindSiteActions() {
  els.whitelistBtn.addEventListener('click', async () => {
    if (!currentHostname) return;
    const list = currentSettings.whitelist || [];
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
    await pushSettings();
    renderAll();
  });

  els.boostBtn.addEventListener('click', async () => {
    if (!currentHostname || !Number.isFinite(currentTabId)) return;
    // D: toggle behaviour — if already boosted, send CLEAR_BOOST instead.
    const isBoosted = els.boostBtn.dataset.boosted === '1';
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
        } else {
          els.boostBtn.textContent = 'Failed';
        }
      }
    } catch (e) {
      els.boostBtn.textContent = 'Failed';
    }
    setTimeout(async () => {
      // SEC-3 / NIT-2 — restore via the shared helper (single source of truth).
      setBoostBtnDefault();
      els.boostBtn.classList.remove('confirmed');
      els.boostBtn.disabled = false;
      await refreshBoostState();
    }, 1800);
  });

  els.killJsBtn.addEventListener('click', async () => {
    if (!currentHostname) return;
    const current = (currentSettings.potatoSites || {})[currentHostname] || { js: false, img: false };
    await chrome.runtime.sendMessage({
      type: 'TOGGLE_POTATO_SITE', host: currentHostname, js: !current.js
    });
    await loadSettings();
    renderAll();
  });

  els.killImgBtn.addEventListener('click', async () => {
    if (!currentHostname) return;
    const current = (currentSettings.potatoSites || {})[currentHostname] || { js: false, img: false };
    await chrome.runtime.sendMessage({
      type: 'TOGGLE_POTATO_SITE', host: currentHostname, img: !current.img
    });
    await loadSettings();
    renderAll();
  });
}

function bindStatsControls() {
  els.statsScope.addEventListener('change', refreshStats);
  els.statsReset.addEventListener('click', async () => {
    const scope = els.statsScope.value || 'session';
    await chrome.runtime.sendMessage({ type: 'RESET_STATS', scope });
    refreshStats();
  });
}

function bindStorageListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes.stats || changes.heapMeasurements || changes.calibratedBandwidth)) {
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
  const refreshSite = async () => {
    currentHostname = await getActiveHostname();
    els.hostname.textContent = currentHostname || 'unavailable';
    renderWhitelistButton();
    await refreshBoostState();
  };
  chrome.tabs.onActivated.addListener(refreshSite);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === currentTabId && changeInfo.url) refreshSite();
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
  els.runTestsBtn.addEventListener('click', async () => {
    els.runTestsBtn.disabled = true;
    els.runTestsBtn.textContent = 'Running…';
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
  document.querySelector('.popup').style.pointerEvents = 'none';
  document.querySelector('.popup').style.opacity = '0.4';
  privacyCheckbox.focus();
}

function hidePrivacyModal() {
  privacyModal.style.display = 'none';
  document.querySelector('.popup').style.pointerEvents = 'auto';
  document.querySelector('.popup').style.opacity = '1';
}

privacyCheckbox.addEventListener('change', () => {
  privacyAcceptBtn.disabled = !privacyCheckbox.checked;
});

privacyAcceptBtn.addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ privacyAccepted: true });
    hidePrivacyModal();
    await initPopup();
  } catch (e) {
    console.error('[Potatofy] Could not save privacy acceptance:', e);
  }
});

privacyModal.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
  }
});

let _initDone = false;
async function initPopup() {
  if (_initDone) return;
  _initDone = true;
  currentHostname = await getActiveHostname();
  els.hostname.textContent = currentHostname || 'unavailable';
  await loadSettings();
  await restoreSectionState();
  renderAll();
  bindToggles();
  bindSuspendControls();
  bindSiteActions();
  bindStatsControls();
  bindDiagnosticsBtn();
  bindStorageListener();
  bindSectionPersist();
  bindTabActivation();
  // E1: hide the diagnostics accordion in packaged (Web Store) installs so
  // end users can't accidentally wipe their session stats via the test suite.
  if (IS_PACKAGED && els.runTestsBtn) {
    const section = els.runTestsBtn.closest('details.section--diag');
    if (section) section.style.display = 'none';
  }
  refreshStats();
  await refreshBoostState();
}

document.addEventListener('DOMContentLoaded', async () => {
  // Check privacy policy acceptance first
  const accepted = await checkPrivacyAcceptance();
  if (!accepted) {
    showPrivacyModal();
    return;
  }
  await initPopup();
});
