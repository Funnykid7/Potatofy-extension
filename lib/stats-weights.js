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
  realRamFreed: 0  // Real measurement: bytes freed from tab discard (not heuristic)
};

export function computeSavings(counters) {
  const w = STATS_WEIGHTS;
  const c = counters || {};

  // Real measurement: actual RAM freed from tab discard (not heuristic)
  const realRamFreedBytes = (c.realRamFreed || 0);

  // Heuristic estimates for other features (fallback if real measurement unavailable)
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

  // Bandwidth is always heuristic-based (no direct measurement available)
  const bw =
    (c.blockedRequests          || 0) * w.request.bwBytes +
    (c.blockedFonts             || 0) * w.font.bwBytes +
    (c.prefetchStripped         || 0) * w.prefetch.bwBytes +
    (c.thirdPartyScriptsBlocked || 0) * w.thirdPartyScript.bwBytes +
    (c.thirdPartyImagesBlocked  || 0) * w.thirdPartyImage.bwBytes;

  // CPU is always heuristic-based (no measurement API available)
  const cpuMs =
    (c.blockedRequests          || 0) * w.request.cpuMs +
    (c.blockedFonts             || 0) * w.font.cpuMs +
    (c.animationsKilled         || 0) * w.animation.cpuMs +
    (c.thirdPartyScriptsBlocked || 0) * w.thirdPartyScript.cpuMs +
    (c.siteKillerHits           || 0) * w.siteKiller.cpuMs;

  // Total RAM = real measurement + estimated (from other features)
  // Subtract the heuristic tab discard estimate from total since we have real measurement
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
      estimated: { ramBytes: estimatedRamBytes - realRamFreedBytes }
    }
  };
}
