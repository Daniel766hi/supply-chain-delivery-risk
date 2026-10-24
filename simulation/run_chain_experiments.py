"""End-to-end experiments: what happens upstream when a promotion hits?

    python simulation/run_chain_experiments.py

C1  Normal operations   : does the upstream ever bind without a promotion?
                          bullwhip ratio under reactive vs promo-aware planning
C2  Promotion responses : 14-day promotion at 1.5x and 2x; responses added step
                          by step from dispatch surge to a fully coordinated
                          plan; each compared with no action (paired t-test)
C3  Sensitivity         : inbound lead time x safety stock, 1.5x promotion with
                          dispatch surge and reactive planning

Upstream defaults (assumptions, not in the data): supplier capacity 1.25x mean
daily unit demand, inbound lead time 5 days, safety stock 2 days, reactive
planning. Writes CSV tables and PNG charts to simulation/results/.
"""

from dataclasses import replace
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from twin import Scenario, load_calibration
from twin.chain import Upstream, load_units_per_order, simulate_chain
from twin.experiment import mean_ci, paired_test

REPS = 30
SENS_REPS = 20
OUT = Path(__file__).resolve().parent / "results"
PROMO = dict(promo_start=30, promo_days=14, window_start=30, window_days=60)

SURFACE, INK, INK_2, GRID, AXIS = "#fcfcfb", "#0b0b0b", "#52514e", "#e1e0d9", "#c3c2b7"
BLUE, ORANGE, AQUA = "#2a78d6", "#eb6834", "#1baf7a"
BLUE_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]
COLS = ["on_time_rate", "same_day_rate", "stockout_days", "min_on_hand", "avg_on_hand_days",
        "bullwhip", "peak_supplier_backlog", "peak_backlog", "days_to_clear"]


def pct(x):
    return round(100 * x, 1)


def replicate(sc, up, cal, units, reps):
    rows = []
    for i in range(reps):
        r = simulate_chain(sc, up, cal, units, 1000 + i)
        rows.append({c: getattr(r, c) for c in COLS})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- C1
def c1_normal(cal, units):
    year = Scenario(horizon_days=365, window_start=0, window_days=365)
    rows = []
    for name, up in [("Unlimited supply (dispatch twin)", Upstream(supplier_capacity_factor=None)),
                     ("Reactive planning", Upstream()),
                     ("Promotion plan shared (promo-aware)", Upstream(planning="PROMO_AWARE"))]:
        df = replicate(year, up, cal, units, REPS)
        rows.append({"upstream": name, "on_time_pct": pct(df["on_time_rate"].mean()),
                     "stockout_days": round(df["stockout_days"].mean(), 1),
                     "avg_stock_days": round(df["avg_on_hand_days"].mean(), 2) if df["avg_on_hand_days"].notna().all() else None,
                     "bullwhip_ratio": round(df["bullwhip"].mean(), 2) if df["bullwhip"].notna().all() else None})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- C2
def responses(mult):
    base = Scenario(promo_multiplier=mult, **PROMO)
    surge = replace(base, promo_capacity_factor=1.5)
    return {
        "No action": (base, Upstream()),
        "Dispatch surge +50%": (surge, Upstream()),
        "+ share promo plan with supplier": (surge, Upstream(planning="PROMO_AWARE")),
        "+ supplier flex capacity (1.6x)": (surge, Upstream(planning="PROMO_AWARE", supplier_capacity_factor=1.6)),
        "+ quote +3 days on promo orders": (replace(surge, promo_promise_extension=3),
                                            Upstream(planning="PROMO_AWARE", supplier_capacity_factor=1.6)),
    }


def c2_promotion(cal, units):
    rows = []
    for mult in (1.5, 2.0):
        runs = {name: replicate(sc, up, cal, units, REPS) for name, (sc, up) in responses(mult).items()}
        control = runs["No action"]
        for name, df in runs.items():
            m, h = mean_ci(df["on_time_rate"])
            d, dh, p = paired_test(df["on_time_rate"], control["on_time_rate"])
            rows.append({"promo_size": f"{mult}x", "response": name, "on_time_pct": pct(m), "ci95_pp": pct(h),
                         "vs_no_action_pp": pct(d), "p_value": None if np.isnan(p) else float(f"{p:.2g}"),
                         "same_day_dispatch_pct": pct(df["same_day_rate"].mean()),
                         "stockout_days": round(df["stockout_days"].mean(), 1),
                         "bullwhip_ratio": round(df["bullwhip"].mean(), 2),
                         "peak_supplier_backlog_units": round(df["peak_supplier_backlog"].mean()),
                         "peak_dispatch_backlog_orders": round(df["peak_backlog"].mean()),
                         "days_to_clear": round(df["days_to_clear"].mean(), 1) if df["days_to_clear"].notna().all() else None})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- C3
def c3_sensitivity(cal, units):
    sc = Scenario(promo_multiplier=1.5, promo_capacity_factor=1.5, **PROMO)
    rows = []
    for lead in (2, 5, 10):
        for safety in (0.5, 2.0, 4.0):
            df = replicate(sc, Upstream(inbound_lead_days=lead, safety_days=safety), cal, units, SENS_REPS)
            rows.append({"inbound_lead_days": lead, "safety_days": safety, "on_time_pct": pct(df["on_time_rate"].mean()),
                         "stockout_days": round(df["stockout_days"].mean(), 1),
                         "avg_stock_days": round(df["avg_on_hand_days"].mean(), 2)})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- charts
def style(ax):
    ax.set_facecolor(SURFACE)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(AXIS)
    ax.tick_params(colors=INK_2, labelsize=9)
    ax.grid(axis="y", color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def chart_bullwhip(cal, units, path):
    """One run, 1.5x promotion with dispatch surge: what the DC orders from the supplier."""
    sc = Scenario(promo_multiplier=1.5, promo_capacity_factor=1.5, **PROMO)
    fig, axes = plt.subplots(2, 1, figsize=(8.5, 6), sharex=True, facecolor=SURFACE)
    for ax, (title, up) in zip(axes, [("Reactive planning (forecast from recent sales)", Upstream()),
                                     ("Promotion plan shared with the supplier", Upstream(planning="PROMO_AWARE"))]):
        style(ax)
        r = simulate_chain(sc, up, cal, units, 1000, keep_paths=True)
        days = np.arange(130)
        ax.axvspan(30, 44, color=GRID, alpha=0.7, linewidth=0)
        ax.plot(days, r.paths["demand_units"][:130], color=INK_2, linewidth=1.2, label="Customer demand (units/day)")
        ax.plot(days, r.paths["reorder"][:130], color=ORANGE, linewidth=2, label="DC orders to supplier (units/day)")
        ax.plot(days, r.paths["on_hand"][:130], color=BLUE, linewidth=2, label="DC stock on hand (units)")
        ax.set_title(f"{title}: bullwhip ratio {r.bullwhip:.2f}, stockout days {r.stockout_days}",
                     color=INK, fontsize=10.5, loc="left")
        ax.set_ylim(bottom=0)
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, frameon=False, fontsize=8.5, labelcolor=INK_2, loc="lower center", ncol=3)
    axes[1].set_xlabel("Simulation day (promotion shaded)", color=INK_2, fontsize=9)
    fig.tight_layout(rect=(0, 0.05, 1, 1))
    fig.savefig(path, dpi=160, facecolor=SURFACE)
    plt.close(fig)


def chart_responses(c2, path):
    t = c2[c2["promo_size"] == "1.5x"].iloc[::-1]
    fig, ax = plt.subplots(figsize=(8.5, 3.8), facecolor=SURFACE)
    style(ax)
    ax.grid(axis="y", visible=False)
    ax.grid(axis="x", color=GRID, linewidth=0.6)
    y = np.arange(len(t))
    ax.barh(y, t["on_time_pct"], xerr=t["ci95_pp"], color=BLUE, height=0.6,
            error_kw=dict(ecolor=INK_2, elinewidth=1, capsize=3))
    for yi, v, ci, s in zip(y, t["on_time_pct"], t["ci95_pp"], t["stockout_days"]):
        ax.text(v + ci + 1.5, yi, f"{v:.1f}%  ·  {s:.1f} stockout days", va="center", fontsize=8.5, color=INK)
    ax.set_yticks(y, t["response"], color=INK)
    ax.set_xlim(0, 100)
    ax.set_xlabel("On-time delivery, orders placed in the 60 days from promo start (%)", color=INK_2, fontsize=9)
    ax.set_title("1.5x promotion, end to end: responses added step by step (30 runs, 95% CI)",
                 color=INK, fontsize=10.5, loc="left", pad=10)
    fig.tight_layout()
    fig.savefig(path, dpi=160, facecolor=SURFACE)
    plt.close(fig)


def main():
    cal, units = load_calibration(), load_units_per_order()
    OUT.mkdir(exist_ok=True)
    pd.set_option("display.width", 220)
    pd.set_option("display.max_columns", 20)

    print("C1  Normal operations (30 x 1 year)")
    c1 = c1_normal(cal, units)
    c1.to_csv(OUT / "c1_upstream_normal.csv", index=False)
    print(c1.to_string(index=False), "\n")

    print("C2  Promotion responses, end to end (30 runs each, paired vs no action)")
    c2 = c2_promotion(cal, units)
    c2.to_csv(OUT / "c2_chain_responses.csv", index=False)
    print(c2.to_string(index=False), "\n")

    print("C3  Sensitivity: inbound lead time x safety stock (1.5x promo, dispatch surge, reactive)")
    c3 = c3_sensitivity(cal, units)
    c3.to_csv(OUT / "c3_upstream_sensitivity.csv", index=False)
    print(c3.pivot(index="inbound_lead_days", columns="safety_days", values="on_time_pct").to_string(), "\n")

    chart_bullwhip(cal, units, OUT / "chain_bullwhip.png")
    chart_responses(c2, OUT / "chain_responses.png")
    print(f"Charts written to {OUT}")


if __name__ == "__main__":
    main()
