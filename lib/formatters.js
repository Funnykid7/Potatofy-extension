// Shared display formatters. QUALITY-01/03/04 — now standard ES-module exports
// (no window.PotatofyFmt global, no classic <script>). Imported by popup/popup.js,
// popup/tests.js (both ES modules) and service-worker.js. Because there's no
// `window` reference, the service worker — where `window` is undefined — can
// import normalizeHost from here too instead of keeping a duplicate copy.
// ES modules are strict-mode by default, so no explicit "use strict" is needed.

export function formatBytes(b) {
  // L-4 — normalize non-finite / negative inputs to 0 so NaN or undefined
  // can't leak a "NaN KB" string into the popup if a caller passes one.
  // Number() coerces a numeric string (e.g. from a DOM dataset) instead of
  // silently treating it as non-finite and zeroing it.
  b = Number(b);
  if (!Number.isFinite(b) || b < 0) b = 0;
  // Byte counts are physically integral in every context this is used
  // (transfer sizes, RAM measurements) — floor so e.g. 0.5 doesn't render.
  b = Math.floor(b);
  if (b < 1024) return b + ' B';
  // Compare the ROUNDED display value against the next threshold, not the
  // raw division — otherwise e.g. 1048550 bytes rounds to "1024.0 KB"
  // instead of wrapping up to "1.0 MB".
  const kb = b / 1024;
  if (Number(kb.toFixed(1)) < 1024) return kb.toFixed(1) + ' KB';
  const mb = b / (1024 * 1024);
  if (Number(mb.toFixed(1)) < 1024) return mb.toFixed(1) + ' MB';
  const gb = b / (1024 * 1024 * 1024);
  return gb.toFixed(2) + ' GB';
}

export function formatMs(ms) {
  ms = Number(ms);
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms === 0) return '0 ms';
  const rounded = Math.round(ms);
  // Compare the rounded value, not the raw float, against the unit
  // threshold — otherwise e.g. 999.5ms rounds to "1000 ms" instead of
  // transitioning to "1.0 s".
  if (rounded < 1000) return rounded + ' ms';
  const s = ms / 1000;
  if (Number(s.toFixed(1)) < 60) return s.toFixed(1) + ' s';
  return (ms / 60000).toFixed(1) + ' min';
}

export function normalizeHost(h) {
  // Lowercase (and trim stray whitespace) BEFORE stripping the "www."
  // prefix — the old order ran the case-sensitive regex first, so
  // "WWW.EXAMPLE.COM" kept its www. prefix after lowercasing.
  return (h || '').trim().toLowerCase().replace(/^www\./, '');
}
