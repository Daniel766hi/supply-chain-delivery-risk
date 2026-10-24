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
    // Upstream (supplier -> inbound -> DC stock). null = unlimited stock (dispatch-only twin).
    // { supplierCapFactor: x mean daily units (null = unlimited), inboundLead: days,
    //   safetyDays: days of mean demand, planning: "REACTIVE" | "PROMO_AWARE" }
    chain: null,
  };
  const CHAIN_DEFAULTS = { supplierCapFactor: 1.25, inboundLead: 5, safetyDays: 2, planning: "REACTIVE" };
  const FORECAST_ALPHA = 0.2, WARM_UP_DAYS = 10;
  function meanDailyUnits(cal) {
    let e = 0, prev = 0;
    cal.unitsValues.forEach(function (u, i) { e += u * (cal.unitsCdf[i] - prev); prev = cal.unitsCdf[i]; });
    return cal.dailyDemand.reduce(function (a, b) { return a + b; }, 0) / cal.dailyDemand.length * e;
  }
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

  // ---- one replication, stepped a day at a time ------------------------------
  // createRun() exposes the day loop so the 3D view can animate it; runOnce()
  // drives the same loop to the end. Both draw random numbers in the same order.
  function createRun(sc, cal, seed) {
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
    let queued = 0, day = 0, shippedTotal = 0, onTimeTotal = 0;

    // upstream state (same initial pipeline as simulation/twin/chain.py)
    const ch = sc.chain ? Object.assign({}, CHAIN_DEFAULTS, sc.chain) : null;
    const rU = ch ? stream(seed, 4) : null;
    const units = [];
    let meanUnits = 0, L = 0, supplierCap = Infinity, safety = 0, unlimited = true;
    let arrivals = null, inTransit = 0, onHand = Infinity, supplierBacklog = 0, forecast = 0, owed = 0;
    const cp = {};
    if (ch) {
      meanUnits = meanDailyUnits(cal); L = ch.inboundLead;
      unlimited = ch.supplierCapFactor == null;
      supplierCap = unlimited ? Infinity : meanUnits * ch.supplierCapFactor;
      safety = ch.safetyDays * meanUnits;
      arrivals = new Float64Array(total + L + 1);
      for (let d = 0; d < L; d++) arrivals[d] = meanUnits;
      inTransit = meanUnits * L; onHand = unlimited ? Infinity : safety + meanUnits; forecast = meanUnits;
      ["onHand", "inTransit", "supplierBacklog", "demandUnits", "reorder", "received", "supplierShipped", "stockBlocked"]
        .forEach(function (k) { cp[k] = new Float64Array(total); });
    }
    const multAt = function (t) { return t >= sc.promoStart && t < promoEnd ? sc.promoMult : 1; };

    function step() {
      const inPromo = day >= sc.promoStart && day < promoEnd;
      let arrived = 0, supplierShip = 0, received = 0, demandUnits = 0;
      if (ch && !unlimited) {                       // 1-2. supplier ships, DC receives
        supplierShip = Math.min(supplierCap, supplierBacklog);
        supplierBacklog -= supplierShip;
        arrivals[day + L] += supplierShip; inTransit += supplierShip;
        received = arrivals[day]; inTransit -= received; onHand += received;
      }
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
          if (ch) {
            const uu = rU(); let ui = 0;
            while (ui < cal.unitsCdf.length - 1 && cal.unitsCdf[ui] < uu) ui++;
            units.push(cal.unitsValues[ui]); demandUnits += cal.unitsValues[ui]; owed += cal.unitsValues[ui];
          }
          queues[premium ? m : 0].a.push(id); queued++;
        }
        arrived = n;
      }
      const capacity = capBase === Infinity ? Infinity : Math.round(capBase * (inPromo ? sc.promoCapFactor : 1));
      let cap = capacity, shipped = 0, onTime = 0, blocked = false, shippedUnits = 0;
      for (let q = 0; q < queues.length && cap > 0 && !blocked; q++) {
        const Q = queues[q];
        while (cap > 0 && Q.h < Q.a.length) {
          const o = Q.a[Q.h];
          if (ch && onHand < units[o]) { blocked = true; break; }   // first come, first served
          Q.h++;
          if (ch) { onHand -= units[o]; owed -= units[o]; shippedUnits += units[o]; }
          disp[o] = day; cap--; queued--; shipped++;
          if (day - placed[o] + lead[o] <= promise[o]) onTime++;
        }
      }
      shippedTotal += shipped; onTimeTotal += onTime;
      path[day] = queued;
      let reorder = 0;
      if (ch && !unlimited) {                       // 5. order-up-to replenishment
        let expected;
        if (ch.planning === "PROMO_AWARE") {
          expected = 0;
          for (let t = day + 1; t <= day + L + 1; t++) expected += meanUnits * multAt(t);
        } else {
          forecast = FORECAST_ALPHA * demandUnits + (1 - FORECAST_ALPHA) * forecast;
          expected = forecast * (L + 1);
        }
        reorder = Math.max(0, expected + safety - (onHand + inTransit + supplierBacklog - owed));
        supplierBacklog += reorder;
      }
      if (ch) {
        cp.onHand[day] = unlimited ? NaN : onHand; cp.inTransit[day] = inTransit; cp.supplierBacklog[day] = supplierBacklog;
        cp.demandUnits[day] = demandUnits; cp.reorder[day] = reorder; cp.received[day] = received;
        cp.supplierShipped[day] = supplierShip; cp.stockBlocked[day] = blocked ? 1 : 0;
      }
      const out = { day: day, arrived: arrived, shipped: shipped, onTime: onTime, backlog: queued,
                    capacity: capacity, inPromo: inPromo, shippedTotal: shippedTotal, onTimeTotal: onTimeTotal,
                    chain: ch ? { onHand: onHand, inTransit: inTransit, supplierBacklog: supplierBacklog, demandUnits: demandUnits,
                                  reorder: reorder, received: received, supplierShipped: supplierShip, stockBlocked: blocked,
                                  shippedUnits: shippedUnits, meanUnits: meanUnits, safety: safety, lead: L,
                                  supplierCap: supplierCap } : null };
      day++;
      return out;
    }

    function summary(keepPath) {
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
      let sameDay = 0, stockoutDays = NaN, minOnHand = NaN, avgOnHandDays = NaN, bullwhip = NaN, peakSupplier = NaN;
      for (let i = 0; i < placed.length; i++) if (placed[i] >= lo && placed[i] < hi && disp[i] === placed[i]) sameDay++;
      if (ch) {
        stockoutDays = 0; peakSupplier = 0;
        for (let d = lo; d < hi; d++) stockoutDays += cp.stockBlocked[d];
        for (let d = 0; d < total; d++) peakSupplier = Math.max(peakSupplier, cp.supplierBacklog[d]);
        if (!unlimited) {
          minOnHand = Infinity; let s = 0;
          for (let d = lo; d < hi; d++) { minOnHand = Math.min(minOnHand, cp.onHand[d]); s += cp.onHand[d]; }
          avgOnHandDays = s / (hi - lo) / meanUnits;
          const v = function (arr) {
            let m = 0; const n2 = sc.horizon - WARM_UP_DAYS;
            for (let d = WARM_UP_DAYS; d < sc.horizon; d++) m += arr[d]; m /= n2;
            let q = 0; for (let d = WARM_UP_DAYS; d < sc.horizon; d++) q += (arr[d] - m) * (arr[d] - m);
            return q / n2;
          };
          const dv = v(cp.demandUnits); bullwhip = dv > 0 ? v(cp.reorder) / dv : NaN;
        }
      }
      return {
        sameDay: n ? sameDay / n : NaN, stockoutDays: stockoutDays, minOnHand: minOnHand,
        avgOnHandDays: avgOnHandDays, bullwhip: bullwhip, peakSupplierBacklog: peakSupplier,
        chainPaths: keepPath && ch ? cp : null,
        onTime: n ? ok / n : NaN,
        byMode: modeN.map(function (c, i) { return c ? modeOk[i] / c : NaN; }),
        wait: nDisp ? waitSum / nDisp : NaN,
        peak: peak,
        clear: clear,
        orders: n,
        path: keepPath ? path : null,
      };
    }

    // inbound shipments still on the road at the end of `day`: [{ shipped, arrives, units }]
    function inbound() {
      const out = [];
      if (!ch || unlimited) return out;
      for (let s = Math.max(0, day - L); s < day; s++) if (cp.supplierShipped[s] > 0) out.push({ shipped: s, arrives: s + L, units: cp.supplierShipped[s] });
      return out;
    }
    return { step: step, summary: summary, inbound: inbound, total: total, done: function () { return day >= total; } };
  }

  function runOnce(sc, cal, seed, keepPath) {
    const run = createRun(sc, cal, seed);
    while (!run.done()) run.step();
    return run.summary(keepPath);
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
    scenario: scenario, chainDefaults: CHAIN_DEFAULTS, meanDailyUnits: meanDailyUnits, runOnce: runOnce, createRun: createRun, monteCarlo: monteCarlo, promiseForTarget: promiseForTarget,
    stats: { mean: mean, sd: sd, quantile: quantile, ci95: ci95, share: share, pairedP: pairedP },
  };
});
