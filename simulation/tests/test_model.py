"""Extreme-condition and logic tests for the twin.  Run: python -m pytest simulation/tests"""

import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from twin import FulfilmentTwin, Scenario, load_calibration, simulate  # noqa: E402

CAL = load_calibration()
YEAR = dict(horizon_days=365, window_start=0, window_days=365)


def analytic_on_time(promise):
    """On-time rate implied directly by the historical distribution (no queueing)."""
    total = 0.0
    for mode, share in zip(CAL.modes, CAL.mode_mix):
        ok = CAL.lead_days[mode] <= promise[mode]
        hit = CAL.lead_cdf[mode][ok][-1] if ok.any() else 0.0
        total += share * hit
    return total


def test_zero_demand_creates_no_orders():
    sc = Scenario(promo_start=0, promo_days=250, promo_multiplier=0.0, window_start=0, window_days=250)
    twin = FulfilmentTwin(sc, CAL, seed=1).run()
    assert twin.orders == []
    assert max(twin.backlog_by_day) == 0


def test_unlimited_capacity_never_queues_and_matches_history():
    rates = [simulate(Scenario(capacity_factor=None, **YEAR), CAL, s).on_time_rate for s in range(10)]
    assert abs(np.mean(rates) - analytic_on_time(CAL.current_promise)) < 0.01


def test_zero_capacity_dispatches_nothing():
    r = simulate(Scenario(capacity_factor=0.0, **YEAR), CAL, seed=1)
    assert r.on_time_rate == 0.0
    assert r.undispatched_in_window == r.orders_in_window


def test_orders_are_conserved():
    sc = Scenario(promo_days=14, promo_multiplier=2.0)
    twin = FulfilmentTwin(sc, CAL, seed=3).run()
    dispatched = sum(o.dispatched is not None for o in twin.orders)
    assert dispatched + len(twin.backlog) == len(twin.orders)


def test_baseline_capacity_never_binds():
    # Capacity = highest observed day, demand resamples observed days -> no backlog
    r = simulate(Scenario(**YEAR), CAL, seed=7)
    assert r.peak_backlog == 0 and r.avg_dispatch_wait == 0


def test_same_seed_is_reproducible():
    sc = Scenario(promo_days=14, promo_multiplier=1.5)
    assert simulate(sc, CAL, 11).on_time_rate == simulate(sc, CAL, 11).on_time_rate


def test_premium_first_protects_premium_modes():
    base = dict(promo_days=14, promo_multiplier=2.0)
    fifo = simulate(Scenario(**base), CAL, 5)
    prem = simulate(Scenario(dispatch_rule="PREMIUM_FIRST", **base), CAL, 5)
    assert prem.on_time_by_mode["First Class"] >= fifo.on_time_by_mode["First Class"]
    assert prem.on_time_by_mode["Same Day"] >= fifo.on_time_by_mode["Same Day"]
    # total throughput is the same, so the backlog path is identical
    assert prem.peak_backlog == fifo.peak_backlog


def test_more_capacity_never_hurts():
    base = dict(promo_days=14, promo_multiplier=2.0)
    low = simulate(Scenario(**base), CAL, 2).on_time_rate
    high = simulate(Scenario(promo_capacity_factor=1.5, **base), CAL, 2).on_time_rate
    assert high >= low


def test_promise_for_target_matches_distribution():
    p75 = CAL.promise_for_target(0.75)
    assert p75 == {"Same Day": 1, "First Class": 2, "Second Class": 5, "Standard Class": 5}
    assert analytic_on_time(p75) > 0.75


@pytest.mark.parametrize("factor", [1.0, 1.5])
def test_backlog_clears_after_moderate_shock(factor):
    r = simulate(Scenario(promo_days=14, promo_multiplier=1.5, promo_capacity_factor=factor), CAL, 4)
    assert not math.isnan(r.days_to_clear)
