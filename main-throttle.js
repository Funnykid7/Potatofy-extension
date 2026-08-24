// Potatofy — MAIN-world timer throttle.
//
// Why this file exists: overriding window.setTimeout / requestAnimationFrame so
// the PAGE's own background timers are throttled requires running in the page's
// MAIN world. But MAIN-world scripts have no access to chrome.* APIs (chrome.runtime
// is undefined there), which is exactly the SEC-01 bug that broke the old single
// MAIN-world content script. So Potatofy now splits in two:
//   - content-script.js runs in the ISOLATED world (has chrome.runtime; owns all
//     messaging, DOM features, observers, calibration).
//   - this file runs in the MAIN world (manifest content_scripts world:"MAIN") and
//     does ONE thing: throttle the page's setTimeout/rAF on hidden tabs.
// The ISOLATED script drives this one with a single boolean (jsThrottleEnabled)
// over window.postMessage. The payload carries no privileged data, so a page
// spoofing the message can only toggle throttling of its own timers — harmless.
(function () {
  'use strict';

  // Saved originals — captured at document_start before any page script can
  // override them.
  const _setTimeout            = window.setTimeout.bind(window);
  const _clearTimeout          = window.clearTimeout.bind(window);
  const _requestAnimationFrame = (window.requestAnimationFrame || function () { return 0; }).bind(window);
  const _cancelAnimationFrame  = (window.cancelAnimationFrame  || function () {}).bind(window);
  const _setInterval           = window.setInterval.bind(window);
  const _clearInterval         = window.clearInterval.bind(window);
  const _requestIdleCallback   = (window.requestIdleCallback || function (cb) { return _setTimeout(cb, 1); }).bind(window);
  const _cancelIdleCallback    = (window.cancelIdleCallback  || function () {}).bind(window);

  // Native Map/Array method references, captured before any page script can
  // pollute Map.prototype or reassign Array.from (BUG-51). All queue access
  // below goes through these instead of calling the instance methods directly.
  const _mapSet     = Map.prototype.set;
  const _mapGet     = Map.prototype.get;
  const _mapHas     = Map.prototype.has;
  const _mapDelete  = Map.prototype.delete;
  const _mapClear   = Map.prototype.clear;
  const _mapKeys    = Map.prototype.keys;
  const _mapEntries = Map.prototype.entries;
  const _arrayFrom  = Array.from;
  const _hasOwnProperty = Object.prototype.hasOwnProperty;
  function mapSet(m, k, v) { return _mapSet.call(m, k, v); }
  function mapGet(m, k) { return _mapGet.call(m, k); }
  function mapHas(m, k) { return _mapHas.call(m, k); }
  function mapDelete(m, k) { return _mapDelete.call(m, k); }
  function mapClear(m) { return _mapClear.call(m); }
  function mapKeys(m) { return _mapKeys.call(m); }
  function mapEntries(m) { return _mapEntries.call(m); }

  // Discriminator for the cross-world handshake. Fixed (not randomized) because
  // both worlds must agree on it without a negotiation round-trip; the payload is
  // only a boolean so a fixed tag costs nothing in security terms.
  const MSG_TAG = '__ptfy_thr';

  let jsThrottleEnabled = false; // mirrors the setting, pushed from ISOLATED world
  let active = false;            // whether our overrides are currently installed

  function isHidden() { return document.visibilityState === 'hidden'; }

  // ---- Suppressed setTimeout queue (QUALITY-02): defer, don't drop ----
  // The pre-fix code returned a sentinel id and silently discarded the callback,
  // permanently breaking recursive timeout chains (SPA autosave, heartbeats) on
  // hidden tabs. We now queue the callback and replay it when the tab returns to
  // the foreground — same queue/drain shape already used for rAF below.
  //
  // Synthetic ids live in the upper 30 bits (high, unpredictable, disjoint from
  // real low-integer timer ids) so shadowedClearTimeout can forward unknown ids
  // to the native clearTimeout without collision.
  const pendingTimers = new Map();
  // synthetic id -> native id, for entries that have been drained (promoted
  // to a real, delay-preserving native setTimeout) but haven't fired yet —
  // lets shadowedClearTimeout keep cancelling them through that window.
  const rescheduledTimers = new Map();
  let timerSeq = ((Math.random() * 0x3FFFFFFF) | 0) + 0x40000000;
  // Raised from 240 — the file's own design says "defer, don't drop" (see
  // above), but the old cap silently dropped the oldest (potentially most
  // important, e.g. autosave) queued callback once exceeded, which happens
  // quickly on long-hidden tabs with many small timeouts. A much larger cap
  // makes silent drops for a legitimate page essentially unreachable while
  // still bounding worst-case memory for a runaway page.
  const MAX_PENDING_TIMERS = 2000;

  // ---- Suppressed rAF queue (negative ids, native-disjoint) ----
  const pendingRaf = new Map();
  // synthetic id -> native id, for the window between drain (re-dispatch to
  // the native rAF, which mints a NEW native id) and the callback actually
  // firing — without this, a page that called cancelAnimationFrame(oldId)
  // during that window found nothing to cancel (the native API doesn't
  // recognize our synthetic negative ids) and the "cancelled" frame ran anyway.
  const rescheduledRaf = new Map();
  // Seeded at a high positive constant (disjoint from real native rAF ids,
  // which are small increasing positive integers) and incremented, rather than
  // starting at 0 and decrementing, so synthetic ids are never negative/zero —
  // page code that gates on `if (rafId > 0)` before treating an id as valid
  // no longer misbehaves on synthetic ids minted while hidden+throttled.
  let rafCounter = 0x20000000;
  const MAX_PENDING_RAF = 240;

  // typeof fn === 'function' used to let legacy string-eval timers
  // (setTimeout("code()", delay)) fall straight through to the native timer,
  // bypassing the throttle entirely. Wrap strings in a thunk so they queue
  // like any other callback.
  function toCallable(fn) {
    if (typeof fn === 'function') return fn;
    if (typeof fn === 'string') {
      const code = fn;
      return () => { (0, eval)(code); }; // indirect eval — runs in global scope, matching native setTimeout("code")
    }
    return null;
  }

  function shadowedSetTimeout(fn, delay, ...args) {
    if (isHidden() && jsThrottleEnabled) {
      const callable = toCallable(fn);
      if (callable) {
        const id = ++timerSeq;
        mapSet(pendingTimers, id, { fn: callable, args, delay: Math.max(0, Number(delay) || 0), queuedAt: Date.now() });
        if (pendingTimers.size > MAX_PENDING_TIMERS) {
          const oldest = mapKeys(pendingTimers).next().value; // Map preserves insertion order
          mapDelete(pendingTimers, oldest);
        }
        return id;
      }
    }
    return _setTimeout(fn, delay, ...args);
  }

  function shadowedClearTimeout(id) {
    id = Number(id); // synthetic ids are numeric Map keys; coerce so
                      // clearTimeout(String(id)) still finds the entry
                      // instead of silently falling through to the native
                      // no-op (BUG-71)
    if (mapDelete(pendingTimers, id)) return;
    if (mapHas(rescheduledTimers, id)) {
      _clearTimeout(mapGet(rescheduledTimers, id));
      mapDelete(rescheduledTimers, id);
      return;
    }
    return _clearTimeout(id);
  }

  function shadowedRequestAnimationFrame(cb) {
    if (isHidden() && jsThrottleEnabled) {
      const id = ++rafCounter; // high positive range → can never collide with a real native id
      mapSet(pendingRaf, id, cb);
      if (pendingRaf.size > MAX_PENDING_RAF) {
        const oldest = mapKeys(pendingRaf).next().value;
        mapDelete(pendingRaf, oldest);
      }
      return id;
    }
    return _requestAnimationFrame(cb);
  }

  function shadowedCancelAnimationFrame(id) {
    id = Number(id); // see shadowedClearTimeout — coerce so a stringified id
                      // still matches the numeric Map key (BUG-71)
    if (mapDelete(pendingRaf, id)) return;
    if (mapHas(rescheduledRaf, id)) {
      _cancelAnimationFrame(mapGet(rescheduledRaf, id));
      mapDelete(rescheduledRaf, id);
      return;
    }
    _cancelAnimationFrame(id);
  }

  function drainPendingTimers() {
    if (pendingTimers.size === 0) return;
    const now = Date.now();
    const ids = _arrayFrom(mapKeys(pendingTimers));
    for (const id of ids) {
      const item = mapGet(pendingTimers, id);
      if (!item) continue; // already cancelled earlier in this same loop
      mapDelete(pendingTimers, id); // delete BEFORE scheduling so shadowedClearTimeout
                                 // can't find a stale entry for an id that's already
                                 // been promoted to a native reschedule
      const remaining = Math.max(0, item.delay - (now - item.queuedAt));
      // Reschedule with the REMAINING delay via the native timer instead of
      // firing instantly — preserves the page's requested timing (a 5-minute
      // timer doesn't fast-forward to "now" just because the tab refocused
      // 10 seconds in) and naturally spreads a large queued batch out over
      // real time instead of bursting it all in one synchronous loop.
      const nativeId = _setTimeout(() => {
        mapDelete(rescheduledTimers, id);
        try {
          // Native setTimeout guarantees `this === window` inside the
          // callback; a bare `fn(...args)` call under 'use strict' would
          // instead pass `this === undefined`, breaking scripts that rely on
          // the native contract.
          item.fn.apply(window, item.args);
        } catch (e) {
          // Let the error surface natively (visible to window.onerror / error
          // trackers) instead of swallowing it, by rethrowing on a fresh
          // macrotask so it doesn't unwind into our own call stack.
          _setTimeout(() => { throw e; }, 0);
        }
      }, remaining);
      mapSet(rescheduledTimers, id, nativeId);
    }
  }

  function drainPendingRaf() {
    if (pendingRaf.size === 0) return;
    const entries = _arrayFrom(mapEntries(pendingRaf));
    mapClear(pendingRaf);
    for (const [id, cb] of entries) {
      try {
        const nativeId = _requestAnimationFrame((ts) => {
          mapDelete(rescheduledRaf, id);
          cb(ts); // let errors surface natively — don't swallow them here
        });
        mapSet(rescheduledRaf, id, nativeId);
      } catch (e) {}
    }
  }

  // ---- requestIdleCallback shadowing (mirrors the setTimeout queue) ----
  // Previously entirely unshadowed: background idle-loop scripts bypassed
  // the throttle completely.
  const pendingIdleCallbacks = new Map(); // synthetic id -> { cb, opts }
  let idleSeq = ((Math.random() * 0x3FFFFFFF) | 0) + 0x60000000;
  // synthetic id -> native id, for entries that have been drained (promoted to
  // a real requestIdleCallback) but haven't fired yet — mirrors
  // rescheduledTimers/rescheduledRaf so shadowedCancelIdleCallback can still
  // cancel them through that window.
  const rescheduledIdleCallbacks = new Map();
  const MAX_PENDING_IDLE_CALLBACKS = 240;

  function shadowedRequestIdleCallback(cb, opts) {
    if (isHidden() && jsThrottleEnabled && typeof cb === 'function') {
      const id = ++idleSeq;
      mapSet(pendingIdleCallbacks, id, { cb, opts });
      if (pendingIdleCallbacks.size > MAX_PENDING_IDLE_CALLBACKS) {
        const oldest = mapKeys(pendingIdleCallbacks).next().value;
        mapDelete(pendingIdleCallbacks, oldest);
      }
      return id;
    }
    return _requestIdleCallback(cb, opts);
  }

  function shadowedCancelIdleCallback(id) {
    if (mapDelete(pendingIdleCallbacks, id)) return;
    if (mapHas(rescheduledIdleCallbacks, id)) {
      _cancelIdleCallback(mapGet(rescheduledIdleCallbacks, id));
      mapDelete(rescheduledIdleCallbacks, id);
      return;
    }
    return _cancelIdleCallback(id);
  }

  function drainPendingIdleCallbacks() {
    if (pendingIdleCallbacks.size === 0) return;
    const entries = _arrayFrom(mapEntries(pendingIdleCallbacks));
    mapClear(pendingIdleCallbacks);
    for (const [id, { cb, opts }] of entries) {
      try {
        const nativeId = _requestIdleCallback((deadline) => {
          mapDelete(rescheduledIdleCallbacks, id);
          cb(deadline);
        }, opts);
        mapSet(rescheduledIdleCallbacks, id, nativeId);
      } catch (e) {}
    }
  }

  // ---- setInterval shadowing ----
  // Previously entirely unshadowed: any interval a page created ran on its
  // native cadence regardless of throttling, bypassing the JS-throttle
  // feature for one of the most common background-polling patterns. Mirrors
  // shadowedSetTimeout's scope for intervals CREATED while hidden
  // (pendingIntervals/rescheduledIntervals below). An interval created while
  // visible is armed as a real native interval right away, but is tracked in
  // activeIntervals so that if the tab is later hidden, sync() can pause it
  // (clear the native timer, keep the bookkeeping) and resume it on
  // refocus — instead of letting it run at full native cadence forever in
  // the background, which used to defeat the throttle for this case.
  const pendingIntervals = new Map(); // synthetic id -> { fn, args, delay }
  let intervalSeq = ((Math.random() * 0x3FFFFFFF) | 0) + 0x50000000;
  // synthetic id -> native id, for entries that have been drained (promoted
  // to a real native setInterval) — mirrors rescheduledTimers/rescheduledRaf
  // so shadowedClearInterval can still cancel them once drained.
  const rescheduledIntervals = new Map();
  const MAX_PENDING_INTERVALS = 2000;

  // returnedId -> { fn, args, delay, nativeId }. nativeId is null while
  // paused (tab hidden); the map key (nativeId at creation time) is what
  // the page holds onto and passes to clearInterval, so it must never change.
  const activeIntervals = new Map();
  const MAX_ACTIVE_INTERVALS = 2000;

  function shadowedSetInterval(fn, delay, ...args) {
    if (isHidden() && jsThrottleEnabled) {
      const callable = toCallable(fn);
      if (callable) {
        const id = ++intervalSeq;
        mapSet(pendingIntervals, id, { fn: callable, args, delay });
        if (pendingIntervals.size > MAX_PENDING_INTERVALS) {
          const oldest = mapKeys(pendingIntervals).next().value;
          mapDelete(pendingIntervals, oldest);
        }
        return id;
      }
    }
    const nativeId = _setInterval(fn, delay, ...args);
    mapSet(activeIntervals, nativeId, { fn, args, delay, nativeId });
    if (activeIntervals.size > MAX_ACTIVE_INTERVALS) {
      const oldest = mapKeys(activeIntervals).next().value;
      mapDelete(activeIntervals, oldest);
    }
    return nativeId;
  }

  function shadowedClearInterval(id) {
    if (mapDelete(pendingIntervals, id)) return;
    if (mapHas(rescheduledIntervals, id)) {
      _clearInterval(mapGet(rescheduledIntervals, id));
      mapDelete(rescheduledIntervals, id);
      return;
    }
    if (mapHas(activeIntervals, id)) {
      const entry = mapGet(activeIntervals, id);
      if (entry.nativeId !== null) _clearInterval(entry.nativeId);
      mapDelete(activeIntervals, id);
      return;
    }
    return _clearInterval(id);
  }

  function drainPendingIntervals() {
    if (pendingIntervals.size === 0) return;
    const entries = _arrayFrom(mapEntries(pendingIntervals));
    mapClear(pendingIntervals);
    for (const [id, { fn, args, delay }] of entries) {
      try {
        const nativeId = _setInterval(fn, delay, ...args);
        mapSet(rescheduledIntervals, id, nativeId);
      } catch (e) {}
    }
  }

  // Pauses intervals that were created (and left running) while the tab was
  // visible — see activeIntervals above. Called from sync() right before a
  // hide+throttle transition: clears each one's native timer but keeps the
  // map entry (nativeId set to null) so shadowedClearInterval can still find
  // it by the page's id, and resumeActiveIntervals() can re-arm it later.
  function pauseActiveIntervals() {
    for (const [, entry] of mapEntries(activeIntervals)) {
      if (entry.nativeId !== null) {
        _clearInterval(entry.nativeId);
        entry.nativeId = null;
      }
    }
  }

  // Re-arms intervals paused by pauseActiveIntervals() when the tab is shown
  // again. Interval semantics have no "remaining time" to preserve, so resume
  // simply starts a fresh native interval at full `delay` — same cadence as
  // when the interval was first created.
  function resumeActiveIntervals() {
    for (const [, entry] of mapEntries(activeIntervals)) {
      if (entry.nativeId === null) {
        try {
          entry.nativeId = _setInterval(entry.fn, entry.delay, ...entry.args);
        } catch (e) {}
      }
    }
  }

  // toString spoofing: without this, `window.setTimeout.toString()` on a
  // hidden+throttled tab would reveal the shadow function's real source
  // instead of a native-code stub, trivially exposing the extension's
  // presence to page script.
  function spoofNative(fn, name) {
    fn.toString = () => `function ${name}() { [native code] }`;
    return fn;
  }
  spoofNative(shadowedSetTimeout, 'setTimeout');
  spoofNative(shadowedClearTimeout, 'clearTimeout');
  spoofNative(shadowedRequestAnimationFrame, 'requestAnimationFrame');
  spoofNative(shadowedCancelAnimationFrame, 'cancelAnimationFrame');
  spoofNative(shadowedSetInterval, 'setInterval');
  spoofNative(shadowedClearInterval, 'clearInterval');
  spoofNative(shadowedRequestIdleCallback, 'requestIdleCallback');
  spoofNative(shadowedCancelIdleCallback, 'cancelIdleCallback');

  // Whatever was on window.* immediately before we installed our shadows —
  // may be a third-party library's own wrapper (Zone.js, Sentry, etc.), not
  // necessarily the bare native. Saved on install, restored on remove, so a
  // library wrapper installed while the tab was visible survives a
  // hide→throttle→refocus cycle instead of being silently discarded.
  let savedSetTimeout, savedClearTimeout, savedRAF, savedCAF, savedRIC, savedCIC;

  function installOverrides() {
    if (active) return;
    active = true;
    savedSetTimeout   = window.setTimeout;
    savedClearTimeout = window.clearTimeout;
    savedRAF          = window.requestAnimationFrame;
    savedCAF          = window.cancelAnimationFrame;
    savedRIC           = window.requestIdleCallback;
    savedCIC            = window.cancelIdleCallback;
    window.setTimeout            = shadowedSetTimeout;
    window.clearTimeout          = shadowedClearTimeout;
    window.requestAnimationFrame = shadowedRequestAnimationFrame;
    window.cancelAnimationFrame  = shadowedCancelAnimationFrame;
    window.requestIdleCallback   = shadowedRequestIdleCallback;
    window.cancelIdleCallback    = shadowedCancelIdleCallback;
  }

  function removeOverrides() {
    if (!active) return;
    active = false;
    window.setTimeout            = savedSetTimeout;
    window.clearTimeout          = savedClearTimeout;
    window.requestAnimationFrame = savedRAF;
    window.cancelAnimationFrame  = savedCAF;
    window.requestIdleCallback   = savedRIC;
    window.cancelIdleCallback    = savedCIC;
  }

  // setInterval/clearInterval have a DIFFERENT install lifecycle than the
  // group above: an already-running interval can only be paused/resumed (see
  // activeIntervals) if shadowedSetInterval/shadowedClearInterval are already
  // installed at the moment the page CREATES it — which may be while the tab
  // is still visible (installOverrides() above only installs while hidden).
  // So these two are installed/removed whenever jsThrottleEnabled changes,
  // independent of visibility, while setTimeout/rAF/idle-callback keep the
  // hidden-only gating (they don't need pause/resume — a one-shot timer or
  // frame callback just runs to completion, or gets queued, same as before).
  let intervalOverridesActive = false;
  let savedSetInterval, savedClearInterval;

  function installIntervalOverrides() {
    if (intervalOverridesActive) return;
    intervalOverridesActive = true;
    savedSetInterval   = window.setInterval;
    savedClearInterval = window.clearInterval;
    window.setInterval   = shadowedSetInterval;
    window.clearInterval = shadowedClearInterval;
  }

  function removeIntervalOverrides() {
    if (!intervalOverridesActive) return;
    intervalOverridesActive = false;
    window.setInterval   = savedSetInterval;
    window.clearInterval = savedClearInterval;
  }

  // setTimeout/rAF/idle-callback overrides install only while throttling AND
  // hidden (mirrors the old applyThrottle/restoreOriginals-on-visibility
  // behavior — native timers when visible); setInterval/clearInterval
  // install/remove on jsThrottleEnabled alone, independent of hidden (see
  // installIntervalOverrides above). Always drain any queued work once the
  // tab is visible again OR once throttling itself was just turned off —
  // previously queued timers stayed stranded in memory if the user disabled
  // the throttle feature while the tab was still hidden.
  function sync() {
    if (jsThrottleEnabled) {
      installIntervalOverrides();
    } else {
      removeIntervalOverrides();
    }
    if (jsThrottleEnabled && isHidden()) {
      pauseActiveIntervals();
      installOverrides();
    } else {
      removeOverrides();
      if (!isHidden() || !jsThrottleEnabled) {
        drainPendingTimers();
        drainPendingRaf();
        drainPendingIntervals();
        drainPendingIdleCallbacks();
        resumeActiveIntervals();
      }
    }
  }

  document.addEventListener('visibilitychange', sync);

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !_hasOwnProperty.call(d, '__ptfy') || d.__ptfy !== MSG_TAG) return;
    jsThrottleEnabled = _hasOwnProperty.call(d, 'jsThrottleEnabled') && !!d.jsThrottleEnabled;
    sync();
  });
})();
