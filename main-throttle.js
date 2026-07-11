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
  let rafCounter = 0;
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
        pendingTimers.set(id, { fn: callable, args, delay: Math.max(0, Number(delay) || 0), queuedAt: Date.now() });
        if (pendingTimers.size > MAX_PENDING_TIMERS) {
          const oldest = pendingTimers.keys().next().value; // Map preserves insertion order
          pendingTimers.delete(oldest);
        }
        return id;
      }
    }
    return _setTimeout(fn, delay, ...args);
  }

  function shadowedClearTimeout(id) {
    if (pendingTimers.delete(id)) return;
    if (rescheduledTimers.has(id)) {
      _clearTimeout(rescheduledTimers.get(id));
      rescheduledTimers.delete(id);
      return;
    }
    return _clearTimeout(id);
  }

  function shadowedRequestAnimationFrame(cb) {
    if (isHidden() && jsThrottleEnabled) {
      const id = --rafCounter; // negative → can never collide with a real positive id
      pendingRaf.set(id, cb);
      if (pendingRaf.size > MAX_PENDING_RAF) {
        const oldest = pendingRaf.keys().next().value;
        pendingRaf.delete(oldest);
      }
      return id;
    }
    return _requestAnimationFrame(cb);
  }

  function shadowedCancelAnimationFrame(id) {
    if (pendingRaf.delete(id)) return;
    if (rescheduledRaf.has(id)) {
      _cancelAnimationFrame(rescheduledRaf.get(id));
      rescheduledRaf.delete(id);
      return;
    }
    _cancelAnimationFrame(id);
  }

  function drainPendingTimers() {
    if (pendingTimers.size === 0) return;
    const now = Date.now();
    const ids = Array.from(pendingTimers.keys());
    for (const id of ids) {
      const item = pendingTimers.get(id);
      if (!item) continue; // already cancelled earlier in this same loop
      pendingTimers.delete(id); // delete BEFORE scheduling so shadowedClearTimeout
                                 // can't find a stale entry for an id that's already
                                 // been promoted to a native reschedule
      const remaining = Math.max(0, item.delay - (now - item.queuedAt));
      // Reschedule with the REMAINING delay via the native timer instead of
      // firing instantly — preserves the page's requested timing (a 5-minute
      // timer doesn't fast-forward to "now" just because the tab refocused
      // 10 seconds in) and naturally spreads a large queued batch out over
      // real time instead of bursting it all in one synchronous loop.
      const nativeId = _setTimeout(() => {
        rescheduledTimers.delete(id);
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
      rescheduledTimers.set(id, nativeId);
    }
  }

  function drainPendingRaf() {
    if (pendingRaf.size === 0) return;
    const entries = Array.from(pendingRaf.entries());
    pendingRaf.clear();
    for (const [id, cb] of entries) {
      try {
        const nativeId = _requestAnimationFrame((ts) => {
          rescheduledRaf.delete(id);
          cb(ts); // let errors surface natively — don't swallow them here
        });
        rescheduledRaf.set(id, nativeId);
      } catch (e) {}
    }
  }

  // ---- requestIdleCallback shadowing (mirrors the setTimeout queue) ----
  // Previously entirely unshadowed: background idle-loop scripts bypassed
  // the throttle completely.
  const pendingIdleCallbacks = new Map(); // synthetic id -> cb
  let idleSeq = ((Math.random() * 0x3FFFFFFF) | 0) + 0x60000000;

  function shadowedRequestIdleCallback(cb, opts) {
    if (isHidden() && jsThrottleEnabled && typeof cb === 'function') {
      const id = ++idleSeq;
      pendingIdleCallbacks.set(id, cb);
      return id;
    }
    return _requestIdleCallback(cb, opts);
  }

  function shadowedCancelIdleCallback(id) {
    if (pendingIdleCallbacks.delete(id)) return;
    return _cancelIdleCallback(id);
  }

  function drainPendingIdleCallbacks() {
    if (pendingIdleCallbacks.size === 0) return;
    const snapshot = Array.from(pendingIdleCallbacks.values());
    pendingIdleCallbacks.clear();
    for (const cb of snapshot) { try { _requestIdleCallback(cb); } catch (e) {} }
  }

  // ---- setInterval shadowing ----
  // Previously entirely unshadowed: any interval a page created ran on its
  // native cadence regardless of throttling, bypassing the JS-throttle
  // feature for one of the most common background-polling patterns. Mirrors
  // shadowedSetTimeout's scope: only intervals CREATED while hidden +
  // throttled are captured; one created while visible uses the native timer
  // directly, same as setTimeout already does.
  const pendingIntervals = new Map(); // synthetic id -> { fn, args, delay }
  let intervalSeq = ((Math.random() * 0x3FFFFFFF) | 0) + 0x50000000;

  function shadowedSetInterval(fn, delay, ...args) {
    if (isHidden() && jsThrottleEnabled && typeof fn === 'function') {
      const id = ++intervalSeq;
      pendingIntervals.set(id, { fn, args, delay });
      return id;
    }
    return _setInterval(fn, delay, ...args);
  }

  function shadowedClearInterval(id) {
    if (pendingIntervals.delete(id)) return;
    return _clearInterval(id);
  }

  function drainPendingIntervals() {
    if (pendingIntervals.size === 0) return;
    const entries = Array.from(pendingIntervals.values());
    pendingIntervals.clear();
    for (const { fn, args, delay } of entries) {
      try { _setInterval(fn, delay, ...args); } catch (e) {}
    }
  }

  function installOverrides() {
    if (active) return;
    active = true;
    window.setTimeout            = shadowedSetTimeout;
    window.clearTimeout          = shadowedClearTimeout;
    window.requestAnimationFrame = shadowedRequestAnimationFrame;
    window.cancelAnimationFrame  = shadowedCancelAnimationFrame;
    window.setInterval           = shadowedSetInterval;
    window.clearInterval         = shadowedClearInterval;
    window.requestIdleCallback   = shadowedRequestIdleCallback;
    window.cancelIdleCallback    = shadowedCancelIdleCallback;
  }

  function removeOverrides() {
    if (!active) return;
    active = false;
    window.setTimeout            = _setTimeout;
    window.clearTimeout          = _clearTimeout;
    window.requestAnimationFrame = _requestAnimationFrame;
    window.cancelAnimationFrame  = _cancelAnimationFrame;
    window.setInterval           = _setInterval;
    window.clearInterval         = _clearInterval;
    window.requestIdleCallback   = _requestIdleCallback;
    window.cancelIdleCallback    = _cancelIdleCallback;
  }

  // Install overrides only while throttling AND hidden (mirrors the old
  // applyThrottle/restoreOriginals-on-visibility behavior — native timers when
  // visible). Always drain any queued work once the tab is visible again OR
  // once throttling itself was just turned off — previously queued timers
  // stayed stranded in memory if the user disabled the throttle feature while
  // the tab was still hidden.
  function sync() {
    if (jsThrottleEnabled && isHidden()) {
      installOverrides();
    } else {
      removeOverrides();
      if (!isHidden() || !jsThrottleEnabled) {
        drainPendingTimers();
        drainPendingRaf();
        drainPendingIntervals();
        drainPendingIdleCallbacks();
      }
    }
  }

  document.addEventListener('visibilitychange', sync);

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__ptfy !== MSG_TAG) return;
    jsThrottleEnabled = !!d.jsThrottleEnabled;
    sync();
  });
})();
