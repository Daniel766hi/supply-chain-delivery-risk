"""Validates the twin against history (Oct-2016 to Sep-2017).

    python simulation/run_validation.py

Runs the baseline (today's promises, no promotion) for 30 simulated years and
compares demand, mode mix and on-time rates with the calibration data.
Writes simulation/results/validation.csv.
"""

from pathlib import Path

import numpy as np
import pandas as pd

from twin import FulfilmentTwin, Scenario, load_calibration
from twin.experiment import mean_ci

REPS = 30
OUT = Path(__file__).resolve().parent / "results"


def historical_on_time(cal, mode, promise):
    ok = cal.lead_days[mode] <= promise
    return float(cal.lead_cdf[mode][ok][-1]) if ok.any() else 0.0


def main():
    cal = load_calibration()
    scenario = Scenario(name="Baseline", horizon_days=365, window_start=0, window_days=365)

    sims = []
    for i in range(REPS):
        twin = FulfilmentTwin(scenario, cal, seed=1000 + i).run()
        orders = pd.DataFrame({
            "placed": [o.placed for o in twin.orders],
            "mode": [o.mode for o in twin.orders],
            "on_time": [o.delivered - o.placed <= o.promise for o in twin.orders],
            "lead": [o.lead for o in twin.orders],
            "wait": [o.dispatched - o.placed for o in twin.orders],
        })
        daily = orders.groupby("placed").size()
        rec = {"Daily orders: mean": daily.mean(), "Daily orders: std dev": daily.std(),
               "Dispatch wait (days): mean": orders["wait"].mean(),
               "On-time rate: all modes": orders["on_time"].mean()}
        for m in cal.modes:
            sub = orders[orders["mode"] == m]
            rec[f"Mode share: {m}"] = len(sub) / len(orders)
            rec[f"On-time rate: {m}"] = sub["on_time"].mean()
            rec[f"Avg lead time (days): {m}"] = sub["lead"].mean()
        sims.append(rec)
    sims = pd.DataFrame(sims)

    hist = {"Daily orders: mean": cal.daily_demand.mean(),
            "Daily orders: std dev": cal.daily_demand.std(ddof=1),
            "Dispatch wait (days): mean": 0.0}
    hist_on_time = 0.0
    for m, share in zip(cal.modes, cal.mode_mix):
        rate = historical_on_time(cal, m, cal.current_promise[m])
        probs = np.diff(np.concatenate([[0.0], cal.lead_cdf[m]]))
        hist[f"Mode share: {m}"] = share
        hist[f"On-time rate: {m}"] = rate
        hist[f"Avg lead time (days): {m}"] = float((cal.lead_days[m] * probs).sum())
        hist_on_time += share * rate
    hist["On-time rate: all modes"] = hist_on_time

    rows = []
    for metric in sims.columns:
        mean, half = mean_ci(sims[metric])
        h = hist[metric]
        rows.append({"metric": metric, "history": round(h, 4), "twin_mean": round(mean, 4),
                     "twin_ci95_low": round(mean - half, 4), "twin_ci95_high": round(mean + half, 4),
                     "abs_diff": round(abs(mean - h), 4)})
    table = pd.DataFrame(rows)

    OUT.mkdir(exist_ok=True)
    table.to_csv(OUT / "validation.csv", index=False)
    with pd.option_context("display.width", 140, "display.max_columns", 10):
        print(table.to_string(index=False))


if __name__ == "__main__":
    main()
