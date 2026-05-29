// Self-contained async test runner. Runs inside the extension popup context so
// all chrome.* APIs are real — no mocks, no build step needed.
(function () {
  const suites = [];
  let _current = null;

  function describe(label, fn) {
    const suite = { label, tests: [] };
    suites.push(suite);
    _current = suite;
    fn();
    _current = null;
  }

  function it(label, fn) {
    if (_current) _current.tests.push({ label, fn });
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      return a.every((v, i) => deepEqual(v, b[i]));
    }
    if (typeof a === 'object') {
      const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
      if (ka.join() !== kb.join()) return false;
      return ka.every(k => deepEqual(a[k], b[k]));
    }
    return false;
  }

  function expect(actual) {
    return {
      toBe(expected) {
        if (actual !== expected)
          throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      },
      toEqual(expected) {
        if (!deepEqual(actual, expected))
          throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      },
      toBeTruthy() {
        if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`);
      },
      toBeFalsy() {
        if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`);
      }
    };
  }

  // --- Formatters (mirror popup.js) ---
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
  function normalizeHost(h) { return (h || '').replace(/^www\./, '').toLowerCase(); }

  describe('[unit] formatBytes', () => {
    it('0 → 0 B',        () => expect(formatBytes(0)).toBe('0 B'));
    it('null → 0 B',     () => expect(formatBytes(null)).toBe('0 B'));
    it('512 → 512 B',    () => expect(formatBytes(512)).toBe('512 B'));
    it('1024 → 1.0 KB',  () => expect(formatBytes(1024)).toBe('1.0 KB'));
    it('1 MB → 1.0 MB',  () => expect(formatBytes(1024 * 1024)).toBe('1.0 MB'));
    it('1 GB → 1.00 GB', () => expect(formatBytes(1024 ** 3)).toBe('1.00 GB'));
  });

  describe('[unit] formatMs', () => {
    it('0 → 0 ms',        () => expect(formatMs(0)).toBe('0 ms'));
    it('500 → 500 ms',    () => expect(formatMs(500)).toBe('500 ms'));
    it('1500 → 1.5 s',    () => expect(formatMs(1500)).toBe('1.5 s'));
    it('90000 → 1.5 min', () => expect(formatMs(90000)).toBe('1.5 min'));
  });

  describe('[unit] normalizeHost', () => {
    it('strips www.',             () => expect(normalizeHost('www.example.com')).toBe('example.com'));
    it('lowercases',              () => expect(normalizeHost('EXAMPLE.COM')).toBe('example.com'));
    it('leaves non-www alone',    () => expect(normalizeHost('sub.example.com')).toBe('sub.example.com'));
    it('handles null gracefully', () => expect(normalizeHost(null)).toBe(''));
    it('handles empty string',    () => expect(normalizeHost('')).toBe(''));
  });

  describe('chrome.storage round-trip', () => {
    it('local writes and reads back', async () => {
      const KEY = '__potatofy_test__';
      const VAL = { ok: true, n: 42 };
      await chrome.storage.local.set({ [KEY]: VAL });
      const got = await chrome.storage.local.get(KEY);
      await chrome.storage.local.remove(KEY);
      expect(got[KEY]).toEqual(VAL);
    });
    it('session writes and reads back', async () => {
      const KEY = '__potatofy_test_session__';
      await chrome.storage.session.set({ [KEY]: 1 });
      const got = await chrome.storage.session.get(KEY);
      await chrome.storage.session.remove(KEY);
      expect(got[KEY]).toBe(1);
    });
  });

  describe('GET_SETTINGS — shape (1.1.0)', () => {
    async function S() {
      const r = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      return r && r.settings;
    }
    it('service worker responds',            async () => expect(!!(await S())).toBeTruthy());
    it('blockingEnabled is boolean',         async () => expect(typeof (await S()).blockingEnabled).toBe('boolean'));
    it('tabSuspendEnabled is boolean',       async () => expect(typeof (await S()).tabSuspendEnabled).toBe('boolean'));
    it('jsThrottleEnabled is boolean',       async () => expect(typeof (await S()).jsThrottleEnabled).toBe('boolean'));
    it('imageLazyEnabled is boolean',        async () => expect(typeof (await S()).imageLazyEnabled).toBe('boolean'));
    it('imageLowQualityEnabled is boolean',  async () => expect(typeof (await S()).imageLowQualityEnabled).toBe('boolean'));
    it('animationKillEnabled is boolean',    async () => expect(typeof (await S()).animationKillEnabled).toBe('boolean'));
    it('autoplayKillEnabled is boolean',     async () => expect(typeof (await S()).autoplayKillEnabled).toBe('boolean'));
    it('prefetchStripEnabled is boolean',    async () => expect(typeof (await S()).prefetchStripEnabled).toBe('boolean'));
    it('videoPauseEnabled is boolean',       async () => expect(typeof (await S()).videoPauseEnabled).toBe('boolean'));
    it('videoPreloadNoneEnabled is boolean', async () => expect(typeof (await S()).videoPreloadNoneEnabled).toBe('boolean'));
    it('thirdPartyScriptBlockEnabled is boolean',
       async () => expect(typeof (await S()).thirdPartyScriptBlockEnabled).toBe('boolean'));
    it('foregroundPotatoEnabled is boolean', async () => expect(typeof (await S()).foregroundPotatoEnabled).toBe('boolean'));
    it('siteKillersEnabled is boolean',      async () => expect(typeof (await S()).siteKillersEnabled).toBe('boolean'));
    it('memoryPressureEnabled is boolean',   async () => expect(typeof (await S()).memoryPressureEnabled).toBe('boolean'));
    it('useCloudSync is boolean',            async () => expect(typeof (await S()).useCloudSync).toBe('boolean'));
    it('whitelist is an array',              async () => expect(Array.isArray((await S()).whitelist)).toBeTruthy());
    it('potatoSites is an object',           async () => expect(typeof (await S()).potatoSites).toBe('object'));
    it('idleThresholdMinutes is a number',   async () => expect(typeof (await S()).idleThresholdMinutes).toBe('number'));
    it('memoryPressureThresholdMB is a number',
       async () => expect(typeof (await S()).memoryPressureThresholdMB).toBe('number'));
  });

  describe('GET_STATS — shape (1.1.0)', () => {
    async function GS() { return chrome.runtime.sendMessage({ type: 'GET_STATS' }); }
    it('service worker responds',                      async () => expect(!!(await GS())).toBeTruthy());
    it('reply has stats.session object',               async () => expect(typeof (await GS()).stats.session).toBe('object'));
    it('reply has stats.lifetime object',              async () => expect(typeof (await GS()).stats.lifetime).toBe('object'));
    it('session.blockedRequests is a number',          async () => expect(typeof (await GS()).stats.session.blockedRequests).toBe('number'));
    it('session.blockedFonts is a number',             async () => expect(typeof (await GS()).stats.session.blockedFonts).toBe('number'));
    it('session.thirdPartyScriptsBlocked is a number', async () => expect(typeof (await GS()).stats.session.thirdPartyScriptsBlocked).toBe('number'));
    it('session.thirdPartyImagesBlocked is a number',  async () => expect(typeof (await GS()).stats.session.thirdPartyImagesBlocked).toBe('number'));
    it('session.siteKillerHits is a number',           async () => expect(typeof (await GS()).stats.session.siteKillerHits).toBe('number'));
    it('reply exposes deviceCapacityMB',               async () => expect(typeof (await GS()).deviceCapacityMB === 'number' || (await GS()).deviceCapacityMB === null).toBeTruthy());
    it('savings.session.ramBytes is a number',         async () => expect(typeof (await GS()).savings.session.ramBytes).toBe('number'));
    it('reply exposes weights object',                 async () => expect(typeof (await GS()).weights).toBe('object'));
    it('weights includes thirdPartyScript',            async () => expect(typeof (await GS()).weights.thirdPartyScript).toBe('object'));
  });

  describe('computeSavings — formula consistency', () => {
    it('savings.session matches manual calculation', async () => {
      const { stats, weights, savings } = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      const s = stats.session, w = weights;
      const expectedRam =
        (s.blockedRequests          || 0) * w.request.ramBytes +
        (s.blockedFonts             || 0) * w.font.ramBytes +
        (s.tabsDiscarded            || 0) * w.tabDiscard.ramBytes +
        (s.animationsKilled         || 0) * w.animation.ramBytes +
        (s.prefetchStripped         || 0) * w.prefetch.ramBytes +
        (s.imagesLazied             || 0) * w.image.ramBytes +
        (s.videosPaused             || 0) * w.videoPause.ramBytes +
        (s.autoplayKilled           || 0) * w.autoplay.ramBytes +
        (s.thirdPartyScriptsBlocked || 0) * w.thirdPartyScript.ramBytes +
        (s.siteKillerHits           || 0) * w.siteKiller.ramBytes +
        (s.thirdPartyImagesBlocked  || 0) * w.thirdPartyImage.ramBytes;
      expect(savings.session.ramBytes).toBe(expectedRam);
    });

    it('all weight ramBytes are non-negative', async () => {
      const { weights } = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      for (const key of Object.keys(weights)) {
        expect(weights[key].ramBytes >= 0).toBeTruthy();
      }
    });

    it('no per-event ramBytes weight exceeds 100 MB (1.1.1 sanity)', async () => {
      const { weights } = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      const CAP = 100 * 1024 * 1024;
      // tabDiscard is the only legit large per-event weight (an actual full
      // tab's memory). Everything else should be bounded.
      for (const [key, w] of Object.entries(weights)) {
        if (key === 'tabDiscard') continue;
        if (w.ramBytes > CAP) {
          throw new Error(`weight "${key}" ramBytes ${w.ramBytes} exceeds 100 MB cap`);
        }
      }
      expect(true).toBeTruthy();
    });

    it('tabDiscard weight is bounded under 200 MB', async () => {
      const { weights } = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      expect(weights.tabDiscard.ramBytes < 200 * 1024 * 1024).toBeTruthy();
    });
  });

  describe('STATS_INCREMENT — round-trip', () => {
    it('blockedRequests propagates', async () => {
      const before = (await chrome.runtime.sendMessage({ type: 'GET_STATS' })).stats.session.blockedRequests || 0;
      await chrome.runtime.sendMessage({ type: 'STATS_INCREMENT', patch: { blockedRequests: 5 } });
      const after = (await chrome.runtime.sendMessage({ type: 'GET_STATS' })).stats.session.blockedRequests || 0;
      expect(after - before).toBe(5);
    });
    it('blockedFonts propagates (B8 — separate bucket from blockedRequests)', async () => {
      const before = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      const beforeFonts = before.stats.session.blockedFonts || 0;
      const beforeReqs = before.stats.session.blockedRequests || 0;
      await chrome.runtime.sendMessage({ type: 'STATS_INCREMENT', patch: { blockedFonts: 3 } });
      const after = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      expect((after.stats.session.blockedFonts || 0) - beforeFonts).toBe(3);
      // Crucial: a font increment must NOT bleed into the request counter.
      expect((after.stats.session.blockedRequests || 0) - beforeReqs).toBe(0);
    });
    it('thirdPartyScriptsBlocked propagates', async () => {
      const before = (await chrome.runtime.sendMessage({ type: 'GET_STATS' })).stats.session.thirdPartyScriptsBlocked || 0;
      await chrome.runtime.sendMessage({ type: 'STATS_INCREMENT', patch: { thirdPartyScriptsBlocked: 7 } });
      const after = (await chrome.runtime.sendMessage({ type: 'GET_STATS' })).stats.session.thirdPartyScriptsBlocked || 0;
      expect(after - before).toBe(7);
    });

    it('thirdPartyImagesBlocked propagates (1.1.1 renamed counter)', async () => {
      const before = (await chrome.runtime.sendMessage({ type: 'GET_STATS' })).stats.session.thirdPartyImagesBlocked || 0;
      await chrome.runtime.sendMessage({ type: 'STATS_INCREMENT', patch: { thirdPartyImagesBlocked: 4 } });
      const after = (await chrome.runtime.sendMessage({ type: 'GET_STATS' })).stats.session.thirdPartyImagesBlocked || 0;
      expect(after - before).toBe(4);
    });
  });

  describe('Boost — tab-ephemeral (1.1.1)', () => {
    it('GET_BOOST_STATUS for non-boosted tab returns false', async () => {
      const reply = await chrome.runtime.sendMessage({ type: 'GET_BOOST_STATUS', tabId: -1 });
      expect(reply && reply.boosted === false).toBeTruthy();
    });
    it('BOOST_TAB rejects invalid tab id', async () => {
      const reply = await chrome.runtime.sendMessage({
        type: 'BOOST_TAB', host: 'example.com', tabId: -1
      });
      expect(reply && reply.ok === false).toBeTruthy();
    });
  });

  describe('Settings persistence (local — 1.1.0 R9)', () => {
    it('storage.local change propagates to GET_SETTINGS', async () => {
      const original = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).settings;
      const flipped = !original.prefetchStripEnabled;
      const updated = { ...original, prefetchStripEnabled: flipped };
      await chrome.storage.local.set({ settings: updated });
      const readBack = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).settings;
      await chrome.storage.local.set({ settings: original });
      expect(readBack.prefetchStripEnabled).toBe(flipped);
    });
  });

  describe('Whitelist storage', () => {
    it('add, read back, clean up', async () => {
      const TEST_HOST = '__potatofy-test-host__.example';
      const original = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).settings;
      const withHost = { ...original, whitelist: [...(original.whitelist || []), TEST_HOST] };
      await chrome.storage.local.set({ settings: withHost });
      const readBack = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).settings;
      await chrome.storage.local.set({ settings: original });
      expect(readBack.whitelist.includes(TEST_HOST)).toBeTruthy();
    });
  });

  describe('Site killers (R5)', () => {
    it('GET_SITE_KILLERS returns an object', async () => {
      const reply = await chrome.runtime.sendMessage({ type: 'GET_SITE_KILLERS' });
      expect(reply.ok).toBeTruthy();
      expect(typeof reply.killers).toBe('object');
    });
    it('includes youtube.com entry', async () => {
      const reply = await chrome.runtime.sendMessage({ type: 'GET_SITE_KILLERS' });
      expect(Array.isArray(reply.killers['youtube.com'])).toBeTruthy();
    });
  });

  // ---------- Runner ----------
  async function runTests() {
    const results = [];
    for (const suite of suites) {
      for (const test of suite.tests) {
        let ok = false, error = null;
        try {
          await test.fn();
          ok = true;
        } catch (e) {
          error = e.message || String(e);
        }
        results.push({ suite: suite.label, name: test.label, ok, error });
      }
    }
    const passed = results.filter(r => r.ok).length;
    return { passed, failed: results.length - passed, total: results.length, results };
  }

  window.runTests = runTests;
})();
