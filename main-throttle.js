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
  let timerSeq = ((Math.random() * 0x3FFFFFFF) | 0) + 0x40000000;
  const MAX_PENDING_TIMERS = 240;

  // ---- Suppressed rAF queue (negative ids, native-disjoint) ----
  const pendingRaf = new Map();
  let rafCounter = 0;
  const MAX_PENDING_RAF = 240;

  function shadowedSetTimeout(fn, delay, ...args) {
    if (isHidden() && jsThrottleEnabled && typeof fn === 'function') {
      const id = ++timerSeq;
      pendingTimers.set(id, { fn, args });
      if (pendingTimers.size > MAX_PENDING_TIMERS) {
        const oldest = pendingTimers.keys().next().value; // Map preserves insertion order
        pendingTimers.delete(oldest);
      }
      return id;
    }
    return _setTimeout(fn, delay, ...args);
  }

  function shadowedClearTimeout(id) {
    if (pendingTimers.delete(id)) return;
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
    _cancelAnimationFrame(id);
  }

  function drainPendingTimers() {
    if (pendingTimers.size === 0) return;
    const snapshot = Array.from(pendingTimers.values());
    pendingTimers.clear();
    for (const { fn, args } of snapshot) { try { fn(...args); } catch (e) {} }
  }

  function drainPendingRaf() {
    if (pendingRaf.size === 0) return;
    const snapshot = Array.from(pendingRaf.values());
    pendingRaf.clear();
    for (const cb of snapshot) { try { _requestAnimationFrame(cb); } catch (e) {} }
  }

  function installOverrides() {
    if (active) return;
    active = true;
    window.setTimeout            = shadowedSetTimeout;
    window.clearTimeout          = shadowedClearTimeout;
    window.requestAnimationFrame = shadowedRequestAnimationFrame;
    window.cancelAnimationFrame  = shadowedCancelAnimationFrame;
  }

  function removeOverrides() {
    if (!active) return;
    active = false;
    window.setTimeout            = _setTimeout;
    window.clearTimeout          = _clearTimeout;
    window.requestAnimationFrame = _requestAnimationFrame;
    window.cancelAnimationFrame  = _cancelAnimationFrame;
  }

  // Install overrides only while throttling AND hidden (mirrors the old
  // applyThrottle/restoreOriginals-on-visibility behavior — native timers when
  // visible). Always drain any queued work once the tab is visible again.
  function sync() {
    if (jsThrottleEnabled && isHidden()) {
      installOverrides();
    } else {
      removeOverrides();
      if (!isHidden()) { drainPendingTimers(); drainPendingRaf(); }
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
