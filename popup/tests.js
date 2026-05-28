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

  // --- Formatter mirrors (must stay in sync with popup.js) ---
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

  function normalizeHost(h) {
    return (h || '').replace(/^www\./, '').toLowerCase();
  }

  // ================================================================
  //  Unit tests — formatters (pure JS, labelled as such)
  // ================================================================

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

  // ================================================================
  //  Integration — chrome.storage
  // ================================================================

  describe('chrome.storage round-trip', () => {
    it('writes and reads back a value', async () => {
      const KEY = '__potatofy_test__';
      const VAL = { ok: true, n: 42 };
      await chrome.storage.local.set({ [KEY]: VAL });
      const got = await chrome.storage.local.get(KEY);
      await chrome.storage.local.remove(KEY);
      expect(got[KEY]).toEqual(VAL);
    });

    it('remove actually deletes the key', async () => {
      const KEY = '__potatofy_test_del__';
      await chrome.storage.local.set({ [KEY]: 1 });
      await chrome.storage.local.remove(KEY);
      const got = await chrome.storage.local.get(KEY);
      expect(got[KEY]).toBeFalsy();
    });
  });

  // ================================================================
  //  Integration — service worker: GET_SETTINGS
  // ================================================================

  describe('GET_SETTINGS — structure', () => {
    async function S() {
      const r = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      return r && r.settings;
    }

    it('service worker responds',              async () => expect(!!(await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }))).toBeTruthy());
    it('returns a settings object',            async () => expect(typeof (await S())).toBe('object'));
    it('blockingEnabled is boolean',           async () => expect(typeof (await S()).blockingEnabled).toBe('boolean'));
    it('tabSuspendEnabled is boolean',         async () => expect(typeof (await S()).tabSuspendEnabled).toBe('boolean'));
    it('jsThrottleEnabled is boolean',         async () => expect(typeof (await S()).jsThrottleEnabled).toBe('boolean'));
    it('imageLiteEnabled is boolean',          async () => expect(typeof (await S()).imageLiteEnabled).toBe('boolean'));
    it('animationKillEnabled is boolean',      async () => expect(typeof (await S()).animationKillEnabled).toBe('boolean'));
    it('autoplayKillEnabled is boolean',       async () => expect(typeof (await S()).autoplayKillEnabled).toBe('boolean'));
    it('prefetchStripEnabled is boolean',      async () => expect(typeof (await S()).prefetchStripEnabled).toBe('boolean'));
    it('videoPauseEnabled is boolean',         async () => expect(typeof (await S()).videoPauseEnabled).toBe('boolean'));
    it('whitelist is an array',                async () => expect(Array.isArray((await S()).whitelist)).toBeTruthy());
  });

  // ================================================================
  //  Integration — service worker: GET_STATS
  // ================================================================

  describe('GET_STATS — structure', () => {
    async function GS() { return chrome.runtime.sendMessage({ type: 'GET_STATS' }); }

    it('service worker responds',               async () => expect(!!(await GS())).toBeTruthy());
    it('reply has stats.session object',        async () => expect(typeof (await GS()).stats.session).toBe('object'));
    it('reply has stats.lifetime object',       async () => expect(typeof (await GS()).stats.lifetime).toBe('object'));
    it('session.blockedRequests is a number',   async () => expect(typeof (await GS()).stats.session.blockedRequests).toBe('number'));
    it('session.tabsDiscarded is a number',     async () => expect(typeof (await GS()).stats.session.tabsDiscarded).toBe('number'));
    it('session.autoplayKilled is a number',    async () => expect(typeof (await GS()).stats.session.autoplayKilled).toBe('number'));
    it('savings.session.ramBytes is a number',  async () => expect(typeof (await GS()).savings.session.ramBytes).toBe('number'));
    it('savings.session.bwBytes is a number',   async () => expect(typeof (await GS()).savings.session.bwBytes).toBe('number'));
    it('reply exposes weights object',          async () => expect(typeof (await GS()).weights).toBe('object'));
  });

  // ================================================================
  //  Integration — computeSavings formula consistency
  //  Uses weights returned by the SW itself so the test never drifts
  //  out of sync if weights are recalibrated.
  // ================================================================

  describe('computeSavings formula consistency', () => {
    it('savings.session matches manual calculation using SW weights', async () => {
      const { stats, weights, savings } = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      const s = stats.session;
      const w = weights;

      const expectedRam =
        (s.blockedRequests  || 0) * w.request.ramBytes +
        (s.blockedFonts     || 0) * w.font.ramBytes +
        (s.tabsDiscarded    || 0) * w.tabDiscard.ramBytes +
        (s.animationsKilled || 0) * w.animation.ramBytes +
        (s.prefetchStripped || 0) * w.prefetch.ramBytes +
        (s.imagesLazied     || 0) * w.image.ramBytes +
        (s.videosPaused     || 0) * w.videoPause.ramBytes +
        (s.autoplayKilled   || 0) * w.autoplay.ramBytes;

      const expectedBw =
        (s.blockedRequests  || 0) * w.request.bwBytes +
        (s.blockedFonts     || 0) * w.font.bwBytes +
        (s.prefetchStripped || 0) * w.prefetch.bwBytes;

      const expectedCpu =
        (s.blockedRequests  || 0) * w.request.cpuMs +
        (s.blockedFonts     || 0) * w.font.cpuMs +
        (s.animationsKilled || 0) * w.animation.cpuMs;

      expect(savings.session.ramBytes).toBe(expectedRam);
      expect(savings.session.bwBytes).toBe(expectedBw);
      expect(savings.session.cpuMs).toBe(expectedCpu);
    });

    it('weights object has all expected keys', async () => {
      const { weights } = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      for (const key of ['request', 'font', 'tabDiscard', 'animation', 'prefetch', 'image', 'videoPause', 'autoplay']) {
        expect(typeof weights[key]).toBe('object');
      }
    });

    it('all weight ramBytes are positive numbers', async () => {
      const { weights } = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      for (const key of Object.keys(weights)) {
        expect(typeof weights[key].ramBytes).toBe('number');
        expect(weights[key].ramBytes > 0).toBeTruthy();
      }
    });
  });

  // ================================================================
  //  Integration — STATS_INCREMENT round-trip
  // ================================================================

  describe('STATS_INCREMENT round-trip', () => {
    it('incremented blockedRequests shows in GET_STATS', async () => {
      const before = (await chrome.runtime.sendMessage({ type: 'GET_STATS' })).stats.session.blockedRequests || 0;
      await chrome.runtime.sendMessage({ type: 'STATS_INCREMENT', patch: { blockedRequests: 5 } });
      // Give the 250ms debounce time to flush.
      await new Promise(r => setTimeout(r, 400));
      const after = (await chrome.runtime.sendMessage({ type: 'GET_STATS' })).stats.session.blockedRequests || 0;
      expect(after - before).toBe(5);
    });

    it('incremented autoplayKilled shows in GET_STATS', async () => {
      const before = (await chrome.runtime.sendMessage({ type: 'GET_STATS' })).stats.session.autoplayKilled || 0;
      await chrome.runtime.sendMessage({ type: 'STATS_INCREMENT', patch: { autoplayKilled: 2 } });
      await new Promise(r => setTimeout(r, 400));
      const after = (await chrome.runtime.sendMessage({ type: 'GET_STATS' })).stats.session.autoplayKilled || 0;
      expect(after - before).toBe(2);
    });
  });

  // ================================================================
  //  Integration — settings persistence
  // ================================================================

  describe('Settings persistence', () => {
    it('storage.sync change propagates to GET_SETTINGS', async () => {
      const original = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).settings;
      const flipped = !original.prefetchStripEnabled;
      const updated = { ...original, prefetchStripEnabled: flipped };
      await chrome.storage.sync.set({ settings: updated });
      const readBack = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).settings;
      // Restore immediately before asserting so we don't leave state dirty.
      await chrome.storage.sync.set({ settings: original });
      expect(readBack.prefetchStripEnabled).toBe(flipped);
    });
  });

  // ================================================================
  //  Integration — whitelist storage
  // ================================================================

  describe('Whitelist storage', () => {
    it('add a hostname, read it back, then clean up', async () => {
      const TEST_HOST = '__potatofy-test-host__.example';
      const original = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).settings;
      const withHost = { ...original, whitelist: [...(original.whitelist || []), TEST_HOST] };
      await chrome.storage.sync.set({ settings: withHost });
      const readBack = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).settings;
      await chrome.storage.sync.set({ settings: original });
      expect(readBack.whitelist.includes(TEST_HOST)).toBeTruthy();
    });
  });

  // ================================================================
  //  Runner
  // ================================================================

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
