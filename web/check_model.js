/* Cross-checks the JavaScript engine against the Python model.
 *
 *   node web/check_model.js
 *
 * Re-runs the 12 promotion experiments (E2) and the no-promotion baseline
 * with 500 replications each, then compares the mean on-time rate, peak
 * backlog and days to clear with simulation/results/e2_shock_responses.csv
 * (Python, 30 replications). The two engines use different random-number
 * generators, so agreement is judged statistically: |difference| must be
 * within 3 standard errors (plus a small rounding allowance).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const T = require("./twin.js");
const CAL = require("./calibration.js");

const REPS = 500;
const ROOT = path.join(__dirname, "..");
const csv = fs.readFileSync(path.join(ROOT, "simulation/results/e2_shock_responses.csv"), "utf8")
  .trim().split("\n").map((l) => l.split(","));
const head = csv.shift();
const py = csv.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));

const PROMO = { horizon: 250, promoStart: 30, promoDays: 14, windowStart: 30, windowDays: 60 };
function responses(mult) {
  const base = Object.assign({}, PROMO, { promoMult: mult });
  return {
    "No action": base,
    "Surge capacity +50% during promo": Object.assign({}, base, { promoCapFactor: 1.5 }),
    "Premium modes dispatched first": Object.assign({}, base, { rule: "PREMIUM_FIRST" }),
    "Quote +3 days on promo orders": Object.assign({}, base, { promoExtraDays: 3 }),
    "Spread promo over 28 days (same volume)": Object.assign({}, base, { promoDays: 28, promoMult: 1 + (mult - 1) / 2 }),
    "Surge +50% and quote +3 days": Object.assign({}, base, { promoCapFactor: 1.5, promoExtraDays: 3 }),
  };
}

function runMany(over) {
  const sc = T.scenario(over);
  const runs = [];
  for (let i = 0; i < REPS; i++) runs.push(T.runOnce(sc, CAL, 1000 + i, false));
  return runs;
}

let failures = 0;
const rows = [];
function compare(label, jsVals, pyMean, pySe, unit, slack) {
  const jm = T.stats.mean(jsVals), jse = T.stats.sd(jsVals) / Math.sqrt(jsVals.length);
  const se = Math.sqrt(pySe * pySe + jse * jse);
  const diff = jm - pyMean;
  const ok = Math.abs(diff) <= 3 * se + slack;
  if (!ok) failures++;
  rows.push({ check: label, python: +pyMean.toFixed(2), javascript: +jm.toFixed(2), diff: +diff.toFixed(2),
              limit: +(3 * se + slack).toFixed(2), unit, status: ok ? "PASS" : "FAIL" });
}

// Baseline: on-time rate with no promotion vs history (42.89%)
const base = runMany({ horizon: 365, windowStart: 0, windowDays: 365 });
compare("Baseline on-time vs history", base.map((r) => 100 * r.onTime), 42.89, 0, "%", 0.3);

for (const mult of [1.5, 2.0]) {
  const res = responses(mult);
  for (const [name, over] of Object.entries(res)) {
    const p = py.find((r) => r.promo_size === `${mult.toFixed(1)}x` && r.response === name);
    const runs = runMany(over);
    const label = `${mult.toFixed(1)}x | ${name}`;
    // Python reports the 95% CI half-width of the mean over 30 runs -> SE = ci / 2.045
    compare(label + " | on-time", runs.map((r) => 100 * r.onTime), +p.on_time_pct, +p.ci95_pp / 2.045, "%", 0.15);
    // Python peak/clear are rounded means; allow 3 SE of the JS mean x sqrt(500/30) plus rounding
    const peaks = runs.map((r) => r.peak);
    compare(label + " | peak backlog", peaks, +p.peak_backlog_orders,
            T.stats.sd(peaks) / Math.sqrt(30), "orders", 1);
    if (p.days_to_clear_backlog !== "") {
      const clears = runs.map((r) => r.clear);
      compare(label + " | days to clear", clears, +p.days_to_clear_backlog,
              T.stats.sd(clears) / Math.sqrt(30), "days", 1);
    }
  }
}

console.table(rows);
console.log(failures ? `${failures} check(s) FAILED` : `All ${rows.length} checks passed`);
process.exit(failures ? 1 : 0);
