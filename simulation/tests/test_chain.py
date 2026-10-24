"""Tests for the end-to-end chain model.  Run: python -m pytest simulation/tests"""

import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from twin import Scenario, load_calibration, simulate  # noqa: E402
from twin.chain import Upstream, load_units_per_order, simulate_chain  # noqa: E402

CAL = load_calibration()
UNITS = load_units_per_order()
UNLIMITED = Upstream(supplier_capacity_factor=None)


@pytest.mark.parametrize("sc", [
    Scenario(horizon_days=365, window_start=0, window_days=365),
    Scenario(promo_days=14, promo_multiplier=1.5),
    Scenario(promo_days=14, promo_multiplier=2.0, promo_capacity_factor=1.5, promo_promise_extension=3),
    Scenario(promo_days=14, promo_multiplier=2.0, dispatch_rule="PREMIUM_FIRST"),
])
@pytest.mark.parametrize("seed", [1000, 1007])
def test_unlimited_supply_reproduces_dispatch_twin_exactly(sc, seed):
    a = simulate(sc, CAL, seed)
    b = simulate_chain(sc, UNLIMITED, CAL, UNITS, seed)
    assert a.on_time_rate == b.on_time_rate
    assert a.peak_backlog == b.peak_backlog
    assert (a.days_to_clear == b.days_to_clear) or (math.isnan(a.days_to_clear) and math.isnan(b.days_to_clear))
    assert a.on_time_by_mode == pytest.approx(b.on_time_by_mode, nan_ok=True)


def test_default_upstream_never_binds_in_normal_operations():
    for seed in range(1000, 1005):
        r = simulate_chain(Scenario(horizon_days=365, window_start=0, window_days=365), Upstream(), CAL, UNITS, seed)
        assert r.stockout_days == 0
        assert r.on_time_rate == simulate(Scenario(horizon_days=365, window_start=0, window_days=365), CAL, seed).on_time_rate


def test_units_are_conserved():
    sc = Scenario(promo_days=14, promo_multiplier=2.0, promo_capacity_factor=1.5)
    p = simulate_chain(sc, Upstream(), CAL, UNITS, 1001, keep_paths=True).paths
    # day-to-day stock change = units received - units shipped; nothing is ever negative
    assert np.allclose(np.diff(p["on_hand"]), p["received"][1:] - p["shipped_units"][1:])
    assert np.all(p["on_hand"] >= -1e-9)
    assert np.all(p["supplier_backlog"] >= -1e-9) and np.all(p["in_transit"] >= -1e-9)


def test_zero_supplier_capacity_stops_dispatch_once_stock_runs_out():
    sc = Scenario(promo_days=0, horizon_days=120, window_start=20, window_days=60)
    r = simulate_chain(sc, Upstream(supplier_capacity_factor=0.0), CAL, UNITS, 1000)
    assert r.on_time_rate < 0.05
    assert r.stockout_days == 60


def test_promo_aware_planning_removes_bullwhip_in_normal_operations():
    sc = Scenario(horizon_days=365, window_start=0, window_days=365)
    reactive = simulate_chain(sc, Upstream(), CAL, UNITS, 1000).bullwhip
    aware = simulate_chain(sc, Upstream(planning="PROMO_AWARE"), CAL, UNITS, 1000).bullwhip
    assert reactive > 3 and aware == pytest.approx(1.0, abs=0.15)


def test_more_supplier_capacity_never_hurts():
    sc = Scenario(promo_days=14, promo_multiplier=2.0, promo_capacity_factor=1.5)
    low = simulate_chain(sc, Upstream(supplier_capacity_factor=1.1), CAL, UNITS, 1002).on_time_rate
    high = simulate_chain(sc, Upstream(supplier_capacity_factor=2.0), CAL, UNITS, 1002).on_time_rate
    assert high >= low


def test_dispatch_surge_moves_the_constraint_upstream():
    sc = Scenario(promo_days=14, promo_multiplier=1.5, promo_capacity_factor=1.5)
    no_surge = simulate_chain(Scenario(promo_days=14, promo_multiplier=1.5), Upstream(), CAL, UNITS, 1000)
    surge = simulate_chain(sc, Upstream(), CAL, UNITS, 1000)
    assert no_surge.stockout_days == 0 and surge.stockout_days > 0
