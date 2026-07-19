// Heuristic weights for the "estimated RAM/bandwidth/CPU saved" stats.
//
// 1.1.4 — recalibrated again after the audit, alongside removing the heap
// measurement path (performance.memory deltas were statistically unsound:
// bucketed values + Math.max(0, before-after) selection bias + GC misattribution
// inflated the figure). These weights are now the sole content-feature RAM
// estimate, so the rule is: only credit RAM where memory is actually reclaimed.
// CSS-only effects (animation zeroing, display:none site-killers) free NO JS heap
// and NO committed RAM — their win is CPU/GPU/compositor time, credited via cpuMs
// with ramBytes = 0. The real tab-discard before/after measurement (realRamFreed),
// when present, REPLACES the tabDiscard heuristic in computeSavings().

export const STATS_WEIGHTS = {
  // Per blocked tracker/ad request — modest script + heap residency avoided.
  request:          { ramBytes:  80 * 1024,        bwBytes: 25 * 1024, cpuMs: 40 },

  // Per blocked font CDN hit — font atlas residency avoided.
  font:             { ramBytes:  50 * 1024,        bwBytes: 60 * 1024, cpuMs: 25 },

  // Per tab discarded — typical idle tab footprint. The one large legit RAM win;
  // replaced by the real measurement when available.
  tabDiscard:       { ramBytes:  60 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 },

  // Per top-frame page where animation kill was applied. Zeroing CSS animation
  // durations frees no JS heap / committed RAM — the benefit is compositor +
  // main-thread time (cpuMs), so ramBytes = 0 (was a fabricated 4 MB).
  animation:        { ramBytes:  0,                bwBytes: 0,         cpuMs: 15 },

  // Per prefetch/preconnect/dns-prefetch link stripped — pure bandwidth save.
  prefetch:         { ramBytes:  0,                bwBytes: 15 * 1024, cpuMs: 0 },

  // Per image lazy-applied — deferred decode of offscreen images.
  image:            { ramBytes:  80 * 1024,        bwBytes: 0,         cpuMs: 0 },

  // Per <video> paused on a hidden tab — decode buffers + GPU textures released.
  // Real memory (not JS heap); kept conservative (was 20 MB, lowered post-audit).
  videoPause:       { ramBytes:   8 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 },

  // Per autoplay element disarmed — prevented decode-pipeline spin-up.
  autoplay:         { ramBytes:   4 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 },

  // Per 3rd-party script blocked.
  thirdPartyScript: { ramBytes: 120 * 1024,        bwBytes: 80 * 1024, cpuMs: 60 },

  // Per host visit where site-killer CSS was injected. display:none hides nodes
  // but frees no JS heap / DOM allocation — benefit is layout/paint time (cpuMs),
  // so ramBytes = 0 (was a fabricated 15 MB).
  siteKiller:       { ramBytes:  0,                bwBytes: 0,         cpuMs: 30 },

  // Per 3rd-party image blocked.
  thirdPartyImage:  { ramBytes:  60 * 1024,        bwBytes: 40 * 1024, cpuMs: 0 },

  // Per <video> with preload="none" applied. Same class as videoPause; tracked
  // separately so the popup doesn't conflate the two independent toggles.
  videoPreload:     { ramBytes:   8 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 }
};

// Calculate median of numeric array; used by Phase 2 (bandwidth) and Phase 3 (heap)
export function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  // Filter to finite numbers first — a stray null/undefined/non-numeric
  // string in the input would otherwise make the `a - b` comparator return
  // NaN and silently break the sort order.
  const clean = arr.filter(x => Number.isFinite(x));
  if (clean.length === 0) return 0;
  const sorted = clean.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const EMPTY_COUNTERS = {
  blockedRequests: 0,
  blockedFonts: 0,
  tabsDiscarded: 0,
  animationsKilled: 0,
  prefetchStripped: 0,
  imagesLazied: 0,
  videosPaused: 0,
  autoplayKilled: 0,
  thirdPartyScriptsBlocked: 0,
  siteKillerHits: 0,
  thirdPartyImagesBlocked: 0,
  videosPreloadNoned: 0,
  mediaBlocked: 0, // Boost-triggered media (video/audio) blocks — tracked separately
                   // from blockedRequests so tab-boost hits don't inflate the generic
                   // tracker/ad "requests blocked" counter.
  realRamFreed: 0  // Real measurement: bytes freed from tab discard (not heuristic)
};

export function computeSavings(counters, calibration = null) {
  const w = STATS_WEIGHTS;
  const c = counters || {};
  const cal = calibration || {};

  // Real measurement: actual RAM freed from tab discard (OS before/after query).
  // Clamped to >= 0 — a corrupted/negative stored value (e.g. other processes
  // allocated memory during the measurement window on a prior version without
  // the Math.max(0, ...) guard) must not flip the total savings negative.
  const realRamFreedBytes = Math.max(0, c.realRamFreed || 0);

  // Heuristic RAM estimate from per-feature counters × conservative weights.
  // (The former Phase 3 heap-measurement multipliers were removed — see header.)
  const estimatedRamBytes =
    (c.blockedRequests          || 0) * w.request.ramBytes +
    (c.blockedFonts             || 0) * w.font.ramBytes +
    (c.tabsDiscarded            || 0) * w.tabDiscard.ramBytes +
    (c.animationsKilled         || 0) * w.animation.ramBytes +
    (c.prefetchStripped         || 0) * w.prefetch.ramBytes +
    (c.imagesLazied             || 0) * w.image.ramBytes +
    (c.videosPaused             || 0) * w.videoPause.ramBytes +
    (c.autoplayKilled           || 0) * w.autoplay.ramBytes +
    (c.thirdPartyScriptsBlocked || 0) * w.thirdPartyScript.ramBytes +
    (c.siteKillerHits           || 0) * w.siteKiller.ramBytes +
    (c.thirdPartyImagesBlocked  || 0) * w.thirdPartyImage.ramBytes +
    (c.videosPreloadNoned       || 0) * w.videoPreload.ramBytes;

  // Bandwidth: use calibrated medians where available, else heuristic weights.
  // ?? (not ||) so a legitimately-calibrated median of exactly 0 bytes (e.g.
  // an empty tracking pixel) isn't discarded in favor of the heuristic —
  // only a genuinely absent (null/undefined) calibration value falls back.
  const bw =
    (c.blockedRequests          || 0) * (cal.trackers ?? w.request.bwBytes) +
    (c.blockedFonts             || 0) * (cal.fonts ?? w.font.bwBytes) +
    (c.prefetchStripped         || 0) * w.prefetch.bwBytes +
    (c.thirdPartyScriptsBlocked || 0) * (cal.scripts ?? w.thirdPartyScript.bwBytes) +
    (c.thirdPartyImagesBlocked  || 0) * (cal.images ?? w.thirdPartyImage.bwBytes);

  // CPU is always heuristic-based (no measurement API available).
  const cpuMs =
    (c.blockedRequests          || 0) * w.request.cpuMs +
    (c.blockedFonts             || 0) * w.font.cpuMs +
    (c.animationsKilled         || 0) * w.animation.cpuMs +
    (c.thirdPartyScriptsBlocked || 0) * w.thirdPartyScript.cpuMs +
    (c.siteKillerHits           || 0) * w.siteKiller.cpuMs;

  // When a real tab-discard measurement exists, use it IN PLACE OF the tabDiscard
  // heuristic (real + the remaining per-feature estimates); otherwise everything
  // is heuristic. Breakdown invariant: real + estimated === ramBytes.
  const tabDiscardHeuristic = (c.tabsDiscarded || 0) * w.tabDiscard.ramBytes;
  let totalRamBytes, estimatedBreakdownBytes;
  if (realRamFreedBytes > 0) {
    // Real measurement replaces the tabDiscard heuristic. With exactly one
    // discard in this counter window, the real measurement unambiguously
    // covers that single discard, so use it directly — even if it's below
    // the heuristic average (e.g. a light/near-blank tab legitimately freed
    // less than the "typical idle tab" estimate). With multiple discards,
    // some may have failed to produce a real measurement (only incrementing
    // tabsDiscarded, not realRamFreed), so floor to the heuristic to avoid
    // understating the total when only some of them had real numbers.
    const tabDiscardSavings = (c.tabsDiscarded === 1)
      ? realRamFreedBytes
      : Math.max(realRamFreedBytes, tabDiscardHeuristic);
    estimatedBreakdownBytes = Math.max(0, estimatedRamBytes - tabDiscardHeuristic) + (tabDiscardSavings - realRamFreedBytes);
    totalRamBytes = realRamFreedBytes + estimatedBreakdownBytes;
  } else {
    estimatedBreakdownBytes = estimatedRamBytes;
    totalRamBytes = estimatedRamBytes;
  }

  return {
    ramBytes: totalRamBytes,
    bwBytes: bw,
    cpuMs: cpuMs,
    breakdown: {
      real:      { ramBytes: realRamFreedBytes },
      estimated: { ramBytes: estimatedBreakdownBytes }
    }
  };
}
