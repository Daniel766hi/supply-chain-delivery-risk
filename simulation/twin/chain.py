"""End-to-end supply chain twin: supplier -> inbound -> DC stock -> dispatch -> customer.

Extends the dispatch twin (model.py) upstream. Each simulated day:

  1. Supplier ships up to its daily capacity from its order backlog; the goods
     reach the DC `inbound_lead_days` later.
  2. The DC receives today's inbound arrivals.
  3. Customer orders arrive (same demand, mode and lead-time draws as the
     dispatch twin); each order needs a number of units drawn from the real
     units-per-order distribution.
  4. Dispatch: up to `capacity` orders leave, in FIFO or premium-first order,
     and only while the DC has the units in stock. An order that cannot be
     filled blocks the queue behind it (first come, first served).
  5. The DC reorders with an order-up-to policy, reviewed daily:
         target = expected demand over (lead time + 1 day) + safety stock
         order  = max(0, target - inventory position)
     inventory position = on hand + in transit + on order at the supplier
                          - units owed to waiting customers
     Expected demand comes either from exponential smoothing of recent sales
     (REACTIVE) or from the shared promotion plan (PROMO_AWARE).

Calibrated from data: demand, mode mix, lead times, promises, units per order.
Assumptions (adjustable): supplier capacity, inbound lead time, safety stock,
planning method, dispatch capacity. With unlimited supply the model reproduces
the dispatch twin exactly for the same seed (tests/test_chain.py).
"""

from collections import deque
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .inputs import INPUT_DIR, Calibration
from .model import Scenario

FORECAST_ALPHA = 0.2
WARM_UP_DAYS = 10


@dataclass(frozen=True)
class Upstream:
    supplier_capacity_factor: float | None = 1.25   # x mean daily unit demand; None = unlimited
    inbound_lead_days: int = 5
    safety_days: float = 2.0                        # safety stock, in days of mean demand
    planning: str = "REACTIVE"                      # or "PROMO_AWARE"


def load_units_per_order(input_dir=INPUT_DIR):
    df = pd.read_csv(input_dir / "units_per_order.csv").sort_values("units")
    return df["units"].to_numpy(), (df["orders"].cumsum() / df["orders"].sum()).to_numpy()


@dataclass
class ChainResult:
    on_time_rate: float
    on_time_by_mode: dict
    avg_dispatch_wait: float
    peak_backlog: int
    days_to_clear: float
    same_day_rate: float             # window orders dispatched on the day they were placed
    stockout_days: int               # window days when dispatch stopped for lack of stock
    min_on_hand: float
    avg_on_hand_days: float          # average DC stock in the window, in days of mean demand
    bullwhip: float                  # var(DC orders to supplier) / var(customer unit demand)
    peak_supplier_backlog: float
    orders_in_window: int
    paths: dict = field(repr=False, default=None)


def simulate_chain(sc: Scenario, up: Upstream, cal: Calibration, units, seed: int,
                   keep_paths: bool = False) -> ChainResult:
    unit_values, unit_cdf = units
    demand_ss, mode_ss, lead_ss, units_ss = np.random.SeedSequence(seed).spawn(4)
    rng_demand = np.random.default_rng(demand_ss)
    rng_mode = np.random.default_rng(mode_ss)
    rng_lead = np.random.default_rng(lead_ss)
    rng_units = np.random.default_rng(units_ss)

    modes = cal.modes
    promise = dict(sc.promise_days or cal.current_promise)
    base_capacity = None if sc.capacity_factor is None else cal.observed_peak * sc.capacity_factor
    total = sc.horizon_days + 10

    mean_units = float(cal.daily_demand.mean() * (unit_values * np.diff(np.r_[0, unit_cdf])).sum())
    L = up.inbound_lead_days
    supplier_cap = np.inf if up.supplier_capacity_factor is None else mean_units * up.supplier_capacity_factor
    unlimited = up.supplier_capacity_factor is None
    safety = up.safety_days * mean_units

    # initial state: a steady pipeline at mean demand
    arrivals = np.zeros(total + L + 1)
    arrivals[:L] = mean_units
    in_transit = mean_units * L
    on_hand = np.inf if unlimited else safety + mean_units
    supplier_backlog, forecast, owed_units = 0.0, mean_units, 0

    placed, mode_of, lead, prom, units_of, disp = [], [], [], [], [], []
    premium = sc.dispatch_rule == "PREMIUM_FIRST"
    queues = [deque() for _ in modes] if premium else [deque()]
    rank = {m: i for i, m in enumerate(modes)}

    p = {k: np.zeros(total) for k in ("backlog", "on_hand", "in_transit", "supplier_backlog",
                                      "demand_units", "reorder", "received", "shipped_orders", "shipped_units",
                                      "stock_blocked")}

    for day in range(total):
        in_promo = sc.promo_start <= day < sc.promo_start + sc.promo_days
        # 1-2. supplier ships, DC receives
        if not unlimited:
            ship = min(supplier_cap, supplier_backlog)
            supplier_backlog -= ship
            arrivals[day + L] += ship
            in_transit += ship
            in_transit -= arrivals[day]
            on_hand += arrivals[day]
            p["received"][day] = arrivals[day]
        # 3. customer orders
        demand_units = 0
        if day < sc.horizon_days:
            n = int(round(rng_demand.choice(cal.daily_demand) * sc.demand_multiplier(day)))
            mode_idx = rng_mode.choice(len(modes), size=n, p=cal.mode_mix)
            u = rng_lead.random(n)
            uu = rng_units.random(n)
            is_promo = sc.demand_multiplier(day) != 1.0
            for i, u_i, uu_i in zip(mode_idx, u, uu):
                m = modes[i]
                k = len(placed)
                placed.append(day); mode_of.append(m)
                lead.append(int(cal.lead_days[m][np.searchsorted(cal.lead_cdf[m], u_i)]))
                prom.append(promise[m] + (sc.promo_promise_extension if is_promo else 0))
                q_units = int(unit_values[np.searchsorted(unit_cdf, uu_i)])
                units_of.append(q_units); disp.append(None)
                queues[rank[m] if premium else 0].append(k)
                demand_units += q_units
                owed_units += q_units
        # 4. dispatch (capacity and stock)
        if base_capacity is None:
            cap = np.inf
        else:
            cap = int(round(base_capacity * (sc.promo_capacity_factor if in_promo else 1.0)))
        shipped, shipped_units, blocked = 0, 0, False
        for q in queues:
            while q and cap > 0:
                k = q[0]
                if on_hand < units_of[k]:
                    blocked = True
                    break
                q.popleft()
                on_hand -= units_of[k]; owed_units -= units_of[k]
                disp[k] = day; cap -= 1; shipped += 1; shipped_units += units_of[k]
            if blocked or cap <= 0:
                break
        # 5. replenishment decision
        reorder = 0.0
        if not unlimited:
            if up.planning == "PROMO_AWARE":
                expected = sum(mean_units * sc.demand_multiplier(t) for t in range(day + 1, day + L + 2))
            else:
                forecast = FORECAST_ALPHA * demand_units + (1 - FORECAST_ALPHA) * forecast
                expected = forecast * (L + 1)
            position = on_hand + in_transit + supplier_backlog - owed_units
            reorder = max(0.0, expected + safety - position)
            supplier_backlog += reorder

        p["backlog"][day] = sum(len(q) for q in queues)
        p["on_hand"][day] = on_hand if not unlimited else np.nan
        p["in_transit"][day] = in_transit
        p["supplier_backlog"][day] = supplier_backlog
        p["demand_units"][day] = demand_units
        p["reorder"][day] = reorder
        p["shipped_orders"][day] = shipped
        p["shipped_units"][day] = shipped_units
        p["stock_blocked"][day] = blocked

    return _summarise(sc, cal, mean_units, unlimited, placed, mode_of, lead, prom, disp, p, keep_paths)


def _summarise(sc, cal, mean_units, unlimited, placed, mode_of, lead, prom, disp, p, keep_paths):
    lo, hi = sc.window_start, sc.window_start + sc.window_days
    window = [k for k in range(len(placed)) if lo <= placed[k] < hi]

    def on_time(k):
        return disp[k] is not None and disp[k] + lead[k] - placed[k] <= prom[k]

    def mean(xs):
        return float(np.mean(xs)) if len(xs) else float("nan")

    by_mode = {m: mean([on_time(k) for k in window if mode_of[k] == m]) for m in cal.modes}
    backlog = p["backlog"]
    busy = [d for d in range(sc.promo_start, len(backlog)) if backlog[d] > 0]
    if not busy:
        clear = 0.0
    elif backlog[-1] > 0:
        clear = float("nan")
    else:
        clear = float(busy[-1] + 1 - sc.promo_start)

    span = slice(WARM_UP_DAYS, sc.horizon_days)
    dv = np.var(p["demand_units"][span])
    bullwhip = float("nan") if unlimited or dv == 0 else float(np.var(p["reorder"][span]) / dv)
    win = slice(lo, hi)

    return ChainResult(
        on_time_rate=mean([on_time(k) for k in window]),
        on_time_by_mode=by_mode,
        avg_dispatch_wait=mean([disp[k] - placed[k] for k in window if disp[k] is not None]),
        peak_backlog=int(backlog.max()),
        days_to_clear=clear,
        same_day_rate=mean([disp[k] == placed[k] for k in window]),
        stockout_days=int(p["stock_blocked"][win].sum()),
        min_on_hand=float("nan") if unlimited else float(np.min(p["on_hand"][win])),
        avg_on_hand_days=float("nan") if unlimited else float(np.mean(p["on_hand"][win]) / mean_units),
        bullwhip=bullwhip,
        peak_supplier_backlog=float(p["supplier_backlog"].max()),
        orders_in_window=len(window),
        paths=p if keep_paths else None,
    )
