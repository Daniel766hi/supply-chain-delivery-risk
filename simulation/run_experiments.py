"""Policy experiments on the fulfilment twin.

    python simulation/run_experiments.py

E1  Promise policy      : today's promises vs promises met 75% / 90% of the time
E2  Promotional shock   : 14-day promotion at 1.5x and 2x demand, six responses,
                          each compared with "no action" by paired t-test
E3  Sensitivity         : promotion size x dispatch-capacity headroom

Key assumption (E2, E3): daily dispatch capacity = the highest daily volume seen
in the calibration year (64 orders). The data shows that level was handled with
no slowdown; it does not show what happens above it. E3 varies this assumption.

Outputs go to simulation/results/ (CSV tables and PNG charts).
"""

from dataclasses import replace
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from twin import FulfilmentTwin, Scenario, load_calibration
from twin.experiment import mean_ci, paired_test, replicate

REPS = 30
SENS_REPS = 20
OUT = Path(__file__).resolve().parent / "results"

PROMO = dict(promo_start=30, promo_days=14, window_start=30, window_days=60)

# chart tokens (reference palette, light mode)
SURFACE, INK, INK_2, GRID, AXIS = "#fcfcfb", "#0b0b0b", "#52514e", "#e1e0d9", "#c3c2b7"
SERIES = ["#2a78d6", "#eb6834", "#1baf7a"]
BLUE_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]


def pct(x):
    return round(100 * x, 1)


# ---------------------------------------------------------------- E1
def e1_promise_policies(cal):
    year = dict(horizon_days=365, window_start=0, window_days=365)
    policies = {
        "Current promises": cal.current_promise,
        "Promise met 75% of the time": cal.promise_for_target(0.75),
        "Promise met 90% of the time": cal.promise_for_target(0.90),
    }
    rows = []
    for name, promise in policies.items():
        df = replicate(Scenario(name=name, promise_days=promise, **year), cal, REPS)
        mean, half = mean_ci(df["on_time_rate"])
        added = sum(share * (promise[m] - cal.current_promise[m])
                    for m, share in zip(cal.modes, cal.mode_mix))
        rows.append({"policy": name,
                     "promise_per_mode": ", ".join(f"{m} {promise[m]}d" for m in cal.modes),
                     "on_time_pct": pct(mean), "ci95_pp": pct(half),
                     "avg_days_added_per_order": round(added, 2)})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- E2
def e2_responses(multiplier):
    """Six ways to respond to a 14-day promotion of the given size."""
    base = Scenario(promo_multiplier=multiplier, **PROMO)
    smoothed = replace(base, promo_days=28, promo_multiplier=1 + (multiplier - 1) / 2)
    return {
        "No action": base,
        "Surge capacity +50% during promo": replace(base, promo_capacity_factor=1.5),
        "Premium modes dispatched first": replace(base, dispatch_rule="PREMIUM_FIRST"),
        "Quote +3 days on promo orders": replace(base, promo_promise_extension=3),
        "Spread promo over 28 days (same volume)": smoothed,
        "Surge +50% and quote +3 days": replace(base, promo_capacity_factor=1.5,
                                               promo_promise_extension=3),
    }


def e2_shock(cal):
    reference = replicate(Scenario(name="No promotion", **PROMO), cal, REPS)
    ref_mean, ref_half = mean_ci(reference["on_time_rate"])
    tables, raw = [], {}
    for mult in (1.5, 2.0):
        runs = {name: replicate(replace(sc, name=name), cal, REPS)
                for name, sc in e2_responses(mult).items()}
        raw[mult] = runs
        control = runs["No action"]
        for name, df in runs.items():
            mean, half = mean_ci(df["on_time_rate"])
            d_mean, d_half, p = paired_test(df["on_time_rate"], control["on_time_rate"])
            clear = df["days_to_clear"]
            tables.append({
                "promo_size": f"{mult}x", "response": name,
                "on_time_pct": pct(mean), "ci95_pp": pct(half),
                "vs_no_action_pp": pct(d_mean), "vs_no_action_ci95_pp": pct(d_half),
                "p_value": None if np.isnan(p) else float(f"{p:.2g}"),
                "on_time_same_day_pct": pct(df["on_time_Same Day"].mean()),
                "avg_dispatch_wait_days": round(df["avg_dispatch_wait"].mean(), 2),
                "peak_backlog_orders": round(df["peak_backlog"].mean()),
                "days_to_clear_backlog": round(clear.mean(), 1) if clear.notna().all() else None,
            })
    table = pd.DataFrame(tables)
    reference_row = {"no_promo_on_time_pct": pct(ref_mean), "ci95_pp": pct(ref_half)}
    return table, reference_row, raw


# ---------------------------------------------------------------- E3
def e3_sensitivity(cal):
    rows = []
    for headroom in (1.0, 1.1, 1.25, 1.5):
        for mult in (1.0, 1.25, 1.5, 2.0, 2.5):
            sc = Scenario(name=f"{mult}x/{headroom}", capacity_factor=headroom,
                          promo_multiplier=mult, **PROMO)
            df = replicate(sc, cal, SENS_REPS)
            rows.append({"capacity_headroom": headroom,
                         "capacity_orders_per_day": round(cal.observed_peak * headroom),
                         "promo_size": mult,
                         "on_time_pct": pct(df["on_time_rate"].mean()),
                         "peak_backlog_orders": round(df["peak_backlog"].mean()),
                         "days_to_clear_backlog": round(df["days_to_clear"].mean(), 1)
                         if df["days_to_clear"].notna().all() else None})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- charts
def style(ax):
    ax.set_facecolor(SURFACE)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(AXIS)
    ax.tick_params(colors=INK_2, labelsize=9)
    ax.grid(axis="y", color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def chart_backlog(cal, path):
    """Mean backlog per day for a 2x promotion under three responses."""
    responses = e2_responses(2.0)
    picks = ["No action", "Surge capacity +50% during promo", "Spread promo over 28 days (same volume)"]
    fig, ax = plt.subplots(figsize=(8, 4.2), facecolor=SURFACE)
    style(ax)
    ax.axvspan(30, 44, color=GRID, alpha=0.6, linewidth=0)
    ax.text(37, 0.98, "14-day\npromo", transform=ax.get_xaxis_transform(),
            ha="center", va="top", color=INK_2, fontsize=8.5)
    for color, name in zip(SERIES, picks):
        paths = [FulfilmentTwin(replace(responses[name], name=name), cal, 1000 + i).run().backlog_by_day
                 for i in range(REPS)]
        mean = np.mean(paths, axis=0)[:160]
        ax.plot(mean, color=color, linewidth=2, label=name)
        peak = int(np.argmax(mean))
        ax.annotate(f"peak {mean[peak]:.0f}", (peak, mean[peak]), xytext=(7, 0),
                    textcoords="offset points", fontsize=8.5, color=INK, va="center")
    ax.set_xlim(0, 160)
    ax.set_xlabel("Simulation day", color=INK_2, fontsize=9)
    ax.set_ylabel("Orders waiting for dispatch", color=INK_2, fontsize=9)
    ax.set_ylim(0, 720)
    ax.set_title("Backlog after a 2x promotion (capacity 64 orders/day, mean of 30 runs)",
                 color=INK, fontsize=11, loc="left", pad=12)
    ax.legend(frameon=False, fontsize=8.5, labelcolor=INK_2, loc="center right")
    fig.tight_layout()
    fig.savefig(path, dpi=160, facecolor=SURFACE)
    plt.close(fig)


def chart_responses(table, reference, path):
    """On-time rate per response for the 2x promotion, with 95% CI."""
    t = table[table["promo_size"] == "2.0x"].iloc[::-1]
    fig, ax = plt.subplots(figsize=(8, 4.2), facecolor=SURFACE)
    style(ax)
    ax.grid(axis="y", visible=False)
    ax.grid(axis="x", color=GRID, linewidth=0.6)
    y = np.arange(len(t))
    ax.barh(y, t["on_time_pct"], xerr=t["ci95_pp"], color=SERIES[0], height=0.6,
            error_kw=dict(ecolor=INK_2, elinewidth=1, capsize=3))
    for yi, v in zip(y, t["on_time_pct"]):
        ax.text(v + 1.5, yi, f"{v:.1f}%", va="center", fontsize=9, color=INK)
    ax.axvline(reference["no_promo_on_time_pct"], color=INK_2, linestyle="--", linewidth=1)
    ax.text(reference["no_promo_on_time_pct"] + 1, -0.75,
            f"no promotion: {reference['no_promo_on_time_pct']:.1f}%", fontsize=8.5, color=INK_2)
    ax.set_ylim(-1, len(t) - 0.5)
    ax.set_yticks(y, t["response"], color=INK)
    ax.set_xlim(0, 100)
    ax.set_xlabel("On-time rate of orders placed in the 60 days from promo start (%)",
                  color=INK_2, fontsize=9)
    ax.set_title("2x promotion: on-time delivery by response (30 runs, 95% CI)",
                 color=INK, fontsize=11, loc="left", pad=12)
    fig.tight_layout()
    fig.savefig(path, dpi=160, facecolor=SURFACE)
    plt.close(fig)


def chart_sensitivity(sens, path):
    grid = sens.pivot(index="capacity_orders_per_day", columns="promo_size", values="on_time_pct")
    grid = grid.sort_index(ascending=False)
    cmap = matplotlib.colors.LinearSegmentedColormap.from_list("blue", BLUE_RAMP)
    fig, ax = plt.subplots(figsize=(7, 3.8), facecolor=SURFACE)
    ax.set_facecolor(SURFACE)
    im = ax.imshow(grid.values, cmap=cmap, vmin=0, vmax=50, aspect="auto")
    for (i, j), v in np.ndenumerate(grid.values):
        ax.text(j, i, f"{v:.1f}%", ha="center", va="center", fontsize=9,
                color="#ffffff" if v > 25 else INK)
    ax.set_xticks(range(grid.shape[1]), [f"{c}x" for c in grid.columns], color=INK_2)
    ax.set_yticks(range(grid.shape[0]), grid.index, color=INK_2)
    ax.set_xlabel("Promotion demand (x normal, 14 days)", color=INK_2, fontsize=9)
    ax.set_ylabel("Dispatch capacity (orders/day)", color=INK_2, fontsize=9)
    ax.set_title("On-time rate across promotion size and capacity (20 runs each)",
                 color=INK, fontsize=11, loc="left")
    for s in ax.spines.values():
        s.set_visible(False)
    cbar = fig.colorbar(im, ax=ax, fraction=0.04)
    cbar.ax.tick_params(colors=INK_2, labelsize=8)
    cbar.outline.set_visible(False)
    fig.tight_layout()
    fig.savefig(path, dpi=160, facecolor=SURFACE)
    plt.close(fig)


def main():
    cal = load_calibration()
    OUT.mkdir(exist_ok=True)
    pd.set_option("display.width", 200)
    pd.set_option("display.max_columns", 20)

    print("E1  Promise policy (no promotion, 30 x 1 year)")
    e1 = e1_promise_policies(cal)
    e1.to_csv(OUT / "e1_promise_policies.csv", index=False)
    print(e1.to_string(index=False), "\n")

    print("E2  Promotional shock: responses vs no action (30 runs each, paired t-test)")
    e2, reference, _ = e2_shock(cal)
    e2.to_csv(OUT / "e2_shock_responses.csv", index=False)
    pd.DataFrame([reference]).to_csv(OUT / "e2_no_promotion_reference.csv", index=False)
    print(f"No-promotion reference: {reference}")
    print(e2.to_string(index=False), "\n")

    print("E3  Sensitivity: promotion size x capacity (no action, 20 runs each)")
    e3 = e3_sensitivity(cal)
    e3.to_csv(OUT / "e3_sensitivity.csv", index=False)
    print(e3.pivot(index="capacity_orders_per_day", columns="promo_size", values="on_time_pct")
          .to_string(), "\n")

    chart_backlog(cal, OUT / "backlog_2x_promo.png")
    chart_responses(e2, reference, OUT / "responses_2x_promo.png")
    chart_sensitivity(e3, OUT / "sensitivity_heatmap.png")
    print(f"Charts written to {OUT}")


if __name__ == "__main__":
    main()
