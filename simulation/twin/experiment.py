"""Replication and paired-comparison helpers shared by the run_* scripts."""

import numpy as np
import pandas as pd
from scipy import stats

from .model import Scenario, simulate

RESULT_COLS = ["on_time_rate", "avg_dispatch_wait", "peak_backlog", "days_to_clear",
               "orders_in_window", "undispatched_in_window"]


def replicate(scenario: Scenario, cal, reps: int, first_seed: int = 1000) -> pd.DataFrame:
    """Run `reps` replications. Seed i is shared across scenarios (common random numbers)."""
    rows = []
    for i in range(reps):
        r = simulate(scenario, cal, first_seed + i)
        row = {"scenario": scenario.name, "rep": i, **{c: getattr(r, c) for c in RESULT_COLS}}
        row.update({f"on_time_{m}": v for m, v in r.on_time_by_mode.items()})
        rows.append(row)
    return pd.DataFrame(rows)


def mean_ci(x, level: float = 0.95):
    x = np.asarray(x, dtype=float)
    x = x[~np.isnan(x)]
    if len(x) < 2:
        return (float(x.mean()) if len(x) else float("nan")), float("nan")
    half = stats.t.ppf(0.5 + level / 2, len(x) - 1) * x.std(ddof=1) / np.sqrt(len(x))
    return float(x.mean()), float(half)


def paired_test(treatment, control):
    """Paired t-test on per-replication differences (same seeds)."""
    diff = np.asarray(treatment, dtype=float) - np.asarray(control, dtype=float)
    mean, half = mean_ci(diff)
    if np.allclose(diff, diff[0]):          # identical every replication: no variance to test
        return mean, half, float("nan")
    return mean, half, float(stats.ttest_rel(treatment, control).pvalue)
