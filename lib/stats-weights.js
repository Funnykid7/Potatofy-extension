// Heuristic weights for the "estimated RAM/bandwidth/CPU saved" stats.
//
// 1.1.1 — recalibrated to CONSERVATIVE figures based on Chrome traces on
// Pi 4 (4 GB) and Pi 5 (8 GB). The pre-1.1.1 weights were generous enough
// that visiting a few YouTube tabs could display 6 GB of "RAM saved" — well
// above what's physically possible. New rule of thumb: no single per-event
// weight ≥ 100 MB, headline RAM total bounded by a sanity cap in the popup.

export const STATS_WEIGHTS = {
  // Per blocked tracker/ad request — script + heap residency.
  request:          { ramBytes:  80 * 1024,        bwBytes: 25 * 1024, cpuMs: 40 },

  // Per blocked font CDN hit — font atlas residency.
  font:             { ramBytes:  50 * 1024,        bwBytes: 60 * 1024, cpuMs: 25 },

  // Per tab discarded — typical idle tab footprint.
  tabDiscard:       { ramBytes:  60 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 },

  // Per top-frame page where animation kill was applied (NOT per animation —
  // 1.1.1 changed the counter semantics to dedupe per page visit).
  animation:        { ramBytes:   4 * 1024 * 1024, bwBytes: 0,         cpuMs: 15 },

  // Per prefetch/preconnect/dns-prefetch link stripped — pure bandwidth save.
  prefetch:         { ramBytes:  0,                bwBytes: 15 * 1024, cpuMs: 0 },

  // Per image lazy-applied — decode delta from eager → on-demand.
  image:            { ramBytes:  80 * 1024,        bwBytes: 0,         cpuMs: 0 },

  // Per <video> paused on a hidden tab — codec buffer + GPU texture.
  videoPause:       { ramBytes:  20 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 },

  // Per autoplay element disarmed — prevented prefetch + decode.
  autoplay:         { ramBytes:  10 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 },

  // Per 3rd-party script blocked.
  thirdPartyScript: { ramBytes: 120 * 1024,        bwBytes: 80 * 1024, cpuMs: 60 },

  // Per host visit where site-killer CSS was injected (NOT per selector —
  // 1.1.1 changed counter semantics to dedupe per host).
  siteKiller:       { ramBytes:  15 * 1024 * 1024, bwBytes: 0,         cpuMs: 30 },

  // Per 3rd-party image blocked (renamed from potatoModeApplied in 1.1.1;
  // the old weight of 40 MB/each was the root cause of the 6 GB display bug).
  thirdPartyImage:  { ramBytes:  60 * 1024,        bwBytes: 40 * 1024, cpuMs: 0 },

  // Per <video> with preload="none" applied. Same magnitude class as videoPause
  // (decode buffer + GPU texture savings) but tracked separately so the popup
  // doesn't conflate the two independent toggles.
  videoPreload:     { ramBytes:  20 * 1024 * 1024, bwBytes: 0,         cpuMs: 0 }
};

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
  realRamFreed: 0,  // Real measurement: bytes freed from tab discard (not heuristic)
  heapMeasuredRam: 0  // Real measurement: bytes freed from content features (Phase 3)
};

export function computeSavings(counters, calibration = null, heapMeasurements = null) {
  const w = STATS_WEIGHTS;
  const c = counters || {};
  const cal = calibration || {};
  const hm = heapMeasurements || {};

  // Real measurement: actual RAM freed from tab discard (not heuristic)
  const realRamFreedBytes = (c.realRamFreed || 0);

  // Phase 3: Calculate heap measurements from real data
  let heapMeasuredRamBytes = 0;
  const heapMultipliers = {};

  if (hm && typeof hm === 'object') {
    // For each feature with measurements, calculate average heap freed
    const features = ['animationsKilled', 'videoPaused', 'videosPreloadNoned', 'autoplayKilled', 'imagesLazied', 'siteKillerHits'];

    for (const feature of features) {
      if (hm[feature] && Array.isArray(hm[feature]) && hm[feature].length > 0) {
        const measurements = hm[feature].map(m => m.freed).filter(x => x > 0);
        if (measurements.length > 0) {
          const sorted = [...measurements].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          const avgHeap = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
          heapMultipliers[feature] = avgHeap;
        }
      }
    }
  }

  // Heuristic estimates for other features (fallback if real measurement unavailable)
  // Use measured heap values where available, else use heuristic weights
  let estimatedRamBytes =
    (c.blockedRequests          || 0) * w.request.ramBytes +
    (c.blockedFonts             || 0) * w.font.ramBytes +
    (c.tabsDiscarded            || 0) * w.tabDiscard.ramBytes +
    (c.animationsKilled         || 0) * (heapMultipliers.animationsKilled || w.animation.ramBytes) +
    (c.prefetchStripped         || 0) * w.prefetch.ramBytes +
    (c.imagesLazied             || 0) * (heapMultipliers.imagesLazied || w.image.ramBytes) +
    (c.videosPaused             || 0) * (heapMultipliers.videoPaused || w.videoPause.ramBytes) +
    (c.autoplayKilled           || 0) * (heapMultipliers.autoplayKilled || w.autoplay.ramBytes) +
    (c.thirdPartyScriptsBlocked || 0) * w.thirdPartyScript.ramBytes +
    (c.siteKillerHits           || 0) * (heapMultipliers.siteKillerHits || w.siteKiller.ramBytes) +
    (c.thirdPartyImagesBlocked  || 0) * w.thirdPartyImage.ramBytes +
    (c.videosPreloadNoned       || 0) * (heapMultipliers.videosPreloadNoned || w.videoPreload.ramBytes);

  // Count actual heap-measured bytes (sum of all features with real measurements)
  for (const feature of Object.keys(heapMultipliers)) {
    const counter = c[feature] || 0;
    if (counter > 0) {
      heapMeasuredRamBytes += counter * heapMultipliers[feature];
    }
  }

  // Bandwidth: use calibrated values if available, else fallback to heuristic
  const bw =
    (c.blockedRequests          || 0) * (cal.trackers || w.request.bwBytes) +
    (c.blockedFonts             || 0) * (cal.fonts || w.font.bwBytes) +
    (c.prefetchStripped         || 0) * w.prefetch.bwBytes +
    (c.thirdPartyScriptsBlocked || 0) * (cal.scripts || w.thirdPartyScript.bwBytes) +
    (c.thirdPartyImagesBlocked  || 0) * (cal.images || w.thirdPartyImage.bwBytes);

  // CPU is always heuristic-based (no measurement API available)
  const cpuMs =
    (c.blockedRequests          || 0) * w.request.cpuMs +
    (c.blockedFonts             || 0) * w.font.cpuMs +
    (c.animationsKilled         || 0) * w.animation.cpuMs +
    (c.thirdPartyScriptsBlocked || 0) * w.thirdPartyScript.cpuMs +
    (c.siteKillerHits           || 0) * w.siteKiller.cpuMs;

  // Total RAM = real measurement + heap measured + estimated (from other features)
  let totalRamBytes = realRamFreedBytes;
  if (realRamFreedBytes > 0) {
    // Replace heuristic tab discard with real measurement
    totalRamBytes += (estimatedRamBytes - (c.tabsDiscarded || 0) * w.tabDiscard.ramBytes);
  } else {
    // No real measurement; use all heuristics
    totalRamBytes = estimatedRamBytes;
  }

  return {
    ramBytes: totalRamBytes,
    bwBytes: bw,
    cpuMs: cpuMs,
    breakdown: {
      real: { ramBytes: realRamFreedBytes },
      measured: { ramBytes: heapMeasuredRamBytes },
      estimated: { ramBytes: estimatedRamBytes - heapMeasuredRamBytes - realRamFreedBytes }
    }
  };
}
