// Shared display formatters used by both popup.js (ES module) and tests.js
// (classic script). Lives on window.PotatofyFmt because the popup mixes
// module + classic scripts and we need a single source of truth either way.
(function () {
  function formatBytes(b) {
    // L-4 — normalize non-finite / negative inputs to 0 so NaN or undefined
    // can't leak a "NaN KB" string into the popup if a caller passes one.
    if (!Number.isFinite(b) || b < 0) b = 0;
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

  window.PotatofyFmt = { formatBytes, formatMs, normalizeHost };
})();
