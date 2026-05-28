const DEFAULTS = {
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
  idleThresholdMinutes: 5,
  whitelist: []
};

const ALLOWED_THRESHOLDS = [1, 3, 5, 10, 15, 30];

const els = {
  blocking:       document.getElementById('toggle-blocking'),
  suspend:        document.getElementById('toggle-suspend'),
  throttle:       document.getElementById('toggle-throttle'),
  image:          document.getElementById('toggle-image'),
  animation:      document.getElementById('toggle-animation'),
  autoplay:       document.getElementById('toggle-autoplay'),
  prefetch:       document.getElementById('toggle-prefetch'),
  video:          document.getElementById('toggle-video'),
  threshold:      document.getElementById('idle-threshold'),
  discardNow:     document.getElementById('discard-now-btn'),
  hostname:       document.getElementById('current-hostname'),
  whitelistBtn:   document.getElementById('whitelist-btn'),
  whitelistList:  document.getElementById('whitelist-list'),
  whitelistCount: document.getElementById('whitelist-count'),
  statsScope:     document.getElementById('stats-scope'),
  statsReset:     document.getElementById('stats-reset'),
  statRam:        document.getElementById('stat-ram'),
  statBw:         document.getElementById('stat-bw'),
  statCpu:        document.getElementById('stat-cpu'),
  statReq:        document.getElementById('stat-req'),
  statTabs:       document.getElementById('stat-tabs'),
  runTestsBtn:    document.getElementById('run-tests-btn'),
  testResults:    document.getElementById('test-results')
};

let currentSettings = { ...DEFAULTS };
let currentHostname = null;
let statsTimer = null;

function normalizeHost(h) {
  return (h || '').replace(/^www\./, '').toLowerCase();
}

async function getActiveHostname() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return null;
  try {
    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return normalizeHost(url.hostname);
  } catch {
    return null;
  }
}

async function loadSettings() {
  const data = await chrome.storage.sync.get('settings');
  currentSettings = { ...DEFAULTS, ...(data.settings || {}) };
}

async function saveSettings() {
  await chrome.storage.sync.set({ settings: currentSettings });
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: currentSettings });
}

function renderToggles() {
  els.blocking.checked  = !!currentSettings.blockingEnabled;
  els.suspend.checked   = !!currentSettings.tabSuspendEnabled;
  els.throttle.checked  = !!currentSettings.jsThrottleEnabled;
  els.image.checked     = !!currentSettings.imageLiteEnabled;
  els.animation.checked = !!currentSettings.animationKillEnabled;
  els.autoplay.checked  = !!currentSettings.autoplayKillEnabled;
  els.prefetch.checked  = !!currentSettings.prefetchStripEnabled;
  els.video.checked     = !!currentSettings.videoPauseEnabled;

  const minutes = Number(currentSettings.idleThresholdMinutes) || 5;
  const safe = ALLOWED_THRESHOLDS.includes(minutes) ? minutes : 5;
  els.threshold.value = String(safe);
  const suspendOn = !!currentSettings.tabSuspendEnabled;
  els.threshold.disabled = !suspendOn;
  els.discardNow.disabled = false; // discard-now works even if auto-suspend is off
}

function renderWhitelistButton() {
  if (!currentHostname) {
    els.whitelistBtn.disabled = true;
    els.whitelistBtn.textContent = 'Unavailable on this page';
    els.whitelistBtn.classList.remove('remove');
    return;
  }
  els.whitelistBtn.disabled = false;
  const isWhitelisted = currentSettings.whitelist.includes(currentHostname);
  if (isWhitelisted) {
    els.whitelistBtn.textContent = 'Remove from Whitelist';
    els.whitelistBtn.classList.add('remove');
  } else {
    els.whitelistBtn.textContent = 'Whitelist This Site';
    els.whitelistBtn.classList.remove('remove');
  }
}

function renderWhitelistList() {
  els.whitelistList.innerHTML = '';
  els.whitelistCount.textContent = currentSettings.whitelist.length;
  for (const host of currentSettings.whitelist) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = host;
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.title = `Remove ${host}`;
    btn.addEventListener('click', async () => {
      currentSettings.whitelist = currentSettings.whitelist.filter(h => h !== host);
      await saveSettings();
      renderAll();
    });
    li.appendChild(span);
    li.appendChild(btn);
    els.whitelistList.appendChild(li);
  }
}

function renderAll() {
  renderToggles();
  renderWhitelistButton();
  renderWhitelistList();
}

// ---------- Stats ----------

function formatBytes(b) {
  if (!b || b < 1024) return (b || 0) + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatMs(ms) {
  if (!ms) return '0 ms';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  return (ms / 60000).toFixed(1) + ' min';
}

function formatCount(n) {
  return (n || 0).toLocaleString();
}

async function refreshStats() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
    if (!reply || !reply.stats) return;
    const scope = els.statsScope.value || 'session';
    const counters = reply.stats[scope] || {};
    const savings = (reply.savings && reply.savings[scope]) || { ramBytes: 0, bwBytes: 0, cpuMs: 0 };
    els.statRam.textContent  = '~' + formatBytes(savings.ramBytes);
    els.statBw.textContent   = '~' + formatBytes(savings.bwBytes);
    els.statCpu.textContent  = '~' + formatMs(savings.cpuMs);
    els.statReq.textContent  = formatCount((counters.blockedRequests || 0) + (counters.blockedFonts || 0));
    els.statTabs.textContent = formatCount(counters.tabsDiscarded || 0);
  } catch (e) {
    // SW may be inactive momentarily; ignore.
  }
}

function startStatsPolling() {
  refreshStats();
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(refreshStats, 2000);
}

// ---------- Bindings ----------

function bindToggles() {
  const map = [
    [els.blocking,  'blockingEnabled'],
    [els.suspend,   'tabSuspendEnabled'],
    [els.throttle,  'jsThrottleEnabled'],
    [els.image,     'imageLiteEnabled'],
    [els.animation, 'animationKillEnabled'],
    [els.autoplay,  'autoplayKillEnabled'],
    [els.prefetch,  'prefetchStripEnabled'],
    [els.video,     'videoPauseEnabled']
  ];
  for (const [el, key] of map) {
    el.addEventListener('change', async () => {
      currentSettings[key] = el.checked;
      if (el === els.suspend) {
        els.threshold.disabled = !el.checked;
      }
      await saveSettings();
    });
  }
}

function bindSuspendControls() {
  els.threshold.addEventListener('change', async () => {
    const v = Number(els.threshold.value);
    currentSettings.idleThresholdMinutes = ALLOWED_THRESHOLDS.includes(v) ? v : 5;
    await saveSettings();
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

function bindWhitelistBtn() {
  els.whitelistBtn.addEventListener('click', async () => {
    if (!currentHostname) return;
    const idx = currentSettings.whitelist.indexOf(currentHostname);
    if (idx >= 0) {
      currentSettings.whitelist.splice(idx, 1);
    } else {
      currentSettings.whitelist.push(currentHostname);
    }
    await saveSettings();
    renderAll();
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
      const report = await window.runTests();
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

function bindStatsControls() {
  els.statsScope.addEventListener('change', refreshStats);
  els.statsReset.addEventListener('click', async () => {
    const scope = els.statsScope.value || 'session';
    await chrome.runtime.sendMessage({ type: 'RESET_STATS', scope });
    refreshStats();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  currentHostname = await getActiveHostname();
  els.hostname.textContent = currentHostname || 'unavailable';
  await loadSettings();
  renderAll();
  bindToggles();
  bindSuspendControls();
  bindWhitelistBtn();
  bindStatsControls();
  bindDiagnosticsBtn();
  startStatsPolling();
});

window.addEventListener('unload', () => {
  if (statsTimer) clearInterval(statsTimer);
});
