"""Calibration inputs for the twin, read from the CSVs exported by sql/07."""

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

INPUT_DIR = Path(__file__).resolve().parent.parent / "inputs"


@dataclass(frozen=True)
class Calibration:
    daily_demand: np.ndarray       # shipped orders per historical day (resampled by the twin)
    modes: tuple                   # shipping modes, ordered by promise (Same Day first)
    mode_mix: np.ndarray           # probability an order uses each mode
    current_promise: dict          # mode -> promised days today
    lead_days: dict                # mode -> array of possible actual lead times (days)
    lead_cdf: dict                 # mode -> cumulative probability for each lead time
    observed_peak: int             # highest daily volume seen without any slowdown

    def promise_for_target(self, target: float) -> dict:
        """Shortest promise per mode that would have been met >= target of the time."""
        return {m: int(self.lead_days[m][np.argmax(self.lead_cdf[m] >= target - 1e-9)])
                for m in self.modes}


def load_calibration(input_dir: Path = INPUT_DIR) -> Calibration:
    demand = pd.read_csv(input_dir / "daily_demand.csv")
    lead = pd.read_csv(input_dir / "lead_time_distribution.csv")

    by_mode = lead.groupby(["shipping_mode", "promised_days"], as_index=False)["orders"].sum()
    by_mode = by_mode.sort_values("promised_days")
    modes = tuple(by_mode["shipping_mode"])

    lead_days, lead_cdf = {}, {}
    for mode in modes:
        rows = lead[lead["shipping_mode"] == mode].sort_values("actual_days")
        lead_days[mode] = rows["actual_days"].to_numpy()
        lead_cdf[mode] = rows["orders"].cumsum().to_numpy() / rows["orders"].sum()

    return Calibration(
        daily_demand=demand["shipped_orders"].to_numpy(),
        modes=modes,
        mode_mix=(by_mode["orders"] / by_mode["orders"].sum()).to_numpy(),
        current_promise=dict(zip(by_mode["shipping_mode"], by_mode["promised_days"])),
        lead_days=lead_days,
        lead_cdf=lead_cdf,
        observed_peak=int(demand["shipped_orders"].max()),
    )
