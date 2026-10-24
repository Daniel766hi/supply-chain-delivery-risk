/* Fulfilment digital twin + Monte Carlo engine (browser and Node).
 *
 * A JavaScript port of simulation/twin/model.py. Same flow, same rules:
 *   order placed -> dispatch backlog -> dispatched (<= capacity per day) -> transit -> delivered
 * Day-stepped event loop: within a day, orders arrive first, then the
 * dispatcher releases up to capacity (FIFO, or premium modes first).
 * On time  <=>  (dispatch day - order day) + lead time <= promised days.
 *
 * Random numbers: three independent streams per replication (demand, mode,
 * lead time) seeded from the replication number, so scenarios that share a
 * replication number see the same demand and lead-time draws (common random
 * numbers). The generator differs from NumPy's, so individual runs differ
 * from the Python model; distributions agree (see web/check_model.js).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DataCoTwin = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- random numbers: splitmix32 seeding + sfc32 generator ------------------
  function splitmix32(a) {
    return function () {
      a |= 0; a = (a + 0x9e3779b9) | 0;
      let t = a ^ (a >>> 16); t = Math.imul(t, 0x21f0aaad);
      t ^= t >>> 15; t = Math.imul(t, 0x735a2d97);
      return ((t ^= t >>> 15) >>> 0);
    };
  }
  function stream(seed, id) {
    const s = splitmix32((seed * 2654435761) ^ (id * 40503));
    let a = s(), b = s(), c = s(), d = s();
    const next = function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0;
      a = b ^ (b >>> 9); b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11); d = (d + 1) | 0;
      t = (t + d) | 0; c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 12; i++) next();   // discard warm-up draws
    return next;
  }

  // ---- scenario --------------------------------------------------------------
  const DEFAULTS = {
    horizon: 365,
    promise: null,              // {mode: days}; null = today's promises
    capacityFactor: 1.0,        // x busiest observed day; null = unlimited
    promoStart: 30,
    promoDays: 0,
    promoMult: 1.0,
    promoCapFactor: 1.0,        // surge on promotion days
    promoExtraDays: 0,          // extra days quoted on promotion orders
    rule: "FIFO",               // or "PREMIUM_FIRST"
    windowStart: 30,
    windowDays: 60,
  };
  function scenario(over) { return Object.assign({}, DEFAULTS, over || {}); }

  function promiseForTarget(cal, target) {
    const out = {};
    cal.modes.forEach(function (m) {
      const cdf = cal.leadCdf[m];
      let j = 0;
      while (j < cdf.length - 1 && cdf[j] < target - 1e-9) j++;
      out[m] = cal.leadDays[m][j];
    });
    return out;
  }

  // ---- one replication -----------------------------------------------------
  function runOnce(sc, cal, seed, keepPath) {
    const rD = stream(seed, 1), rM = stream(seed, 2), rL = stream(seed, 3);
    const modes = cal.modes, nModes = modes.length;
    const promiseDays = modes.map(function (m) { return (sc.promise || cal.currentPromise)[m]; });
    const mixCum = []; cal.modeMix.reduce(function (acc, p, i) { mixCum[i] = acc + p; return acc + p; }, 0);
    mixCum[nModes - 1] = 1;
    const daily = cal.dailyDemand, nDaily = daily.length;
    const capBase = sc.capacityFactor == null ? Infinity : cal.observedPeak * sc.capacityFactor;
    const promoEnd = sc.promoStart + sc.promoDays;
    const total = sc.horizon + 10;           // let the backlog drain after demand stops

    const placed = [], mode = [], lead = [], promise = [], disp = [];
    const premium = sc.rule === "PREMIUM_FIRST";
    const queues = premium ? modes.map(function () { return { a: [], h: 0 }; }) : [{ a: [], h: 0 }];
    const path = new Int32Array(total);
    let queued = 0;

    for (let day = 0; day < total; day++) {
      const inPromo = day >= sc.promoStart && day < promoEnd;
      if (day < sc.horizon) {
        const mult = inPromo ? sc.promoMult : 1;
        const n = Math.round(daily[Math.floor(rD() * nDaily)] * mult);
        const isPromo = mult !== 1;
        for (let k = 0; k < n; k++) {
          const u = rM();
          let m = 0; while (m < nModes - 1 && u >= mixCum[m]) m++;
          const ul = rL(), cdf = cal.leadCdf[modes[m]];
          let j = 0; while (j < cdf.length - 1 && cdf[j] < ul) j++;
          const id = placed.length;
          placed.push(day); mode.push(m); lead.push(cal.leadDays[modes[m]][j]);
          promise.push(promiseDays[m] + (isPromo ? sc.promoExtraDays : 0)); disp.push(-1);
          queues[premium ? m : 0].a.push(id); queued++;
        }
      }
      let cap = capBase === Infinity ? Infinity : Math.round(capBase * (inPromo ? sc.promoCapFactor : 1));
      for (let q = 0; q < queues.length && cap > 0; q++) {
        const Q = queues[q];
        while (cap > 0 && Q.h < Q.a.length) { disp[Q.a[Q.h++]] = day; cap--; queued--; }
      }
      path[day] = queued;
    }

    // metrics over orders placed in the measurement window
    const lo = sc.windowStart, hi = sc.windowStart + sc.windowDays;
    let n = 0, ok = 0, waitSum = 0, nDisp = 0;
    const modeN = new Array(nModes).fill(0), modeOk = new Array(nModes).fill(0);
    for (let i = 0; i < placed.length; i++) {
      if (placed[i] < lo || placed[i] >= hi) continue;
      n++; modeN[mode[i]]++;
      if (disp[i] >= 0) {
        nDisp++; waitSum += disp[i] - placed[i];
        if (disp[i] - placed[i] + lead[i] <= promise[i]) { ok++; modeOk[mode[i]]++; }
      }
    }
    let peak = 0, lastBusy = -1;
    for (let d = 0; d < total; d++) {
      if (path[d] > peak) peak = path[d];
      if (d >= sc.promoStart && path[d] > 0) lastBusy = d;
    }
    const clear = lastBusy < 0 ? 0 : (path[total - 1] > 0 ? NaN : lastBusy + 1 - sc.promoStart);

    return {
      onTime: n ? ok / n : NaN,
      byMode: modeN.map(function (c, i) { return c ? modeOk[i] / c : NaN; }),
      wait: nDisp ? waitSum / nDisp : NaN,
      peak: peak,
      clear: clear,
      orders: n,
      path: keepPath ? path : null,
    };
  }

  // ---- Monte Carlo -----------------------------------------------------------
  // Runs `reps` paired replications of several scenarios in small batches,
  // yielding to the browser between batches. onProgress(done, reps) after each
  // batch; isCancelled() lets a newer request stop an older one.
  function monteCarlo(scenarios, cal, reps, opts) {
    opts = opts || {};
    const batch = opts.batch || 20, firstSeed = opts.firstSeed || 1000;
    const out = {};
    Object.keys(scenarios).forEach(function (k) { out[k] = []; });
    return new Promise(function (resolve) {
      let i = 0;
      function step() {
        if (opts.isCancelled && opts.isCancelled()) return resolve(null);
        const end = Math.min(reps, i + batch);
        for (; i < end; i++) {
          Object.keys(scenarios).forEach(function (k) {
            out[k].push(runOnce(scenarios[k], cal, firstSeed + i, opts.keepPaths !== false));
          });
        }
        if (opts.onProgress) opts.onProgress(i, reps);
        if (i < reps) (opts.schedule || setTimeout)(step, 0);
        else resolve(out);
      }
      step();
    });
  }

  // ---- statistics ------------------------------------------------------------
  function finite(xs) { return xs.filter(function (x) { return Number.isFinite(x); }); }
  function mean(xs) { xs = finite(xs); return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : NaN; }
  function sd(xs) {
    xs = finite(xs); if (xs.length < 2) return NaN;
    const m = mean(xs); return Math.sqrt(xs.reduce(function (a, x) { return a + (x - m) * (x - m); }, 0) / (xs.length - 1));
  }
  function quantile(xs, q) {
    xs = finite(xs).slice().sort(function (a, b) { return a - b; });
    if (!xs.length) return NaN;
    const pos = (xs.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
  }
  function ci95(xs) {
    const n = finite(xs).length;
    return n > 1 ? 1.96 * sd(xs) / Math.sqrt(n) : NaN;   // normal approx; reps >= 30
  }
  function share(xs, pred) {
    const f = xs.filter(function (x) { return !Number.isNaN(x); });
    return xs.length ? xs.filter(pred).length / xs.length : NaN;
  }
  // Paired t statistic -> two-sided p-value (normal approximation, n >= 30)
  function pairedP(a, b) {
    const d = a.map(function (x, i) { return x - b[i]; });
    const s = sd(d);
    if (!(s > 0)) return NaN;
    const z = Math.abs(mean(d) / (s / Math.sqrt(d.length)));
    return 2 * (1 - normCdf(z));
  }
  function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * z);
    const p = 0.3989423 * Math.exp(-z * z / 2) *
      t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return 1 - p;
  }

  return {
    scenario: scenario, runOnce: runOnce, monteCarlo: monteCarlo, promiseForTarget: promiseForTarget,
    stats: { mean: mean, sd: sd, quantile: quantile, ci95: ci95, share: share, pairedP: pairedP },
  };
});
