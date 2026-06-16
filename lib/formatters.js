// Shared display formatters. QUALITY-01/03/04 — now standard ES-module exports
// (no window.PotatofyFmt global, no classic <script>). Imported by popup/popup.js,
// popup/tests.js (both ES modules) and service-worker.js. Because there's no
// `window` reference, the service worker — where `window` is undefined — can
// import normalizeHost from here too instead of keeping a duplicate copy.
// ES modules are strict-mode by default, so no explicit "use strict" is needed.

export function formatBytes(b) {
  // L-4 — normalize non-finite / negative inputs to 0 so NaN or undefined
  // can't leak a "NaN KB" string into the popup if a caller passes one.
  if (!Number.isFinite(b) || b < 0) b = 0;
  if (!b || b < 1024) return (b || 0) + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function formatMs(ms) {
  if (!ms) return '0 ms';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  return (ms / 60000).toFixed(1) + ' min';
}

export function normalizeHost(h) {
  return (h || '').replace(/^www\./, '').toLowerCase();
}
