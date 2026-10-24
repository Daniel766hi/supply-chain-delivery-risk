"""Discrete-event digital twin of DataCo's order-to-delivery flow (SimPy).

Each order is an entity with its own process:

    order placed -> waits in the dispatch backlog -> dispatched -> in transit -> delivered

- Demand: each simulated day resamples a real day's shipped-order count
  (Oct-2016 to Sep-2017), optionally scaled by a promotion multiplier.
- Dispatch: once a day the warehouse releases up to `capacity` orders from the
  backlog, first-in-first-out or premium modes first.
- Transit: each order draws its lead time from the real distribution of its
  shipping mode. Historical lead times already include normal processing, so
  an order dispatched on the day it is placed reproduces history exactly.

Time unit: 1 = one day. An order is late when
    (dispatch day - order day) + lead time > promised days.
"""

from dataclasses import dataclass, field

import numpy as np
import simpy

from .inputs import Calibration


@dataclass(frozen=True)
class Scenario:
    name: str = "Baseline"
    horizon_days: int = 250
    # Promise per mode; None keeps today's promises
    promise_days: dict | None = None
    # Daily dispatch capacity = observed peak volume x this factor (None = unlimited)
    capacity_factor: float | None = 1.0
    # Promotional shock
    promo_start: int = 30
    promo_days: int = 0
    promo_multiplier: float = 1.0
    # Mitigation levers
    promo_capacity_factor: float = 1.0    # surge capacity on promo days (x normal capacity)
    promo_promise_extension: int = 0      # extra promised days quoted on promo orders
    dispatch_rule: str = "FIFO"           # "FIFO" or "PREMIUM_FIRST"
    # Measurement window: orders PLACED in [window_start, window_start + window_days)
    window_start: int = 30
    window_days: int = 60

    def demand_multiplier(self, day: int) -> float:
        in_promo = self.promo_start <= day < self.promo_start + self.promo_days
        return self.promo_multiplier if in_promo else 1.0


class Order:
    __slots__ = ("seq", "mode", "rank", "placed", "lead", "promise", "promo",
                 "dispatched", "delivered", "dispatch_event")

    def __init__(self, seq, mode, rank, placed, lead, promise, promo):
        self.seq, self.mode, self.rank, self.placed = seq, mode, rank, placed
        self.lead, self.promise, self.promo = lead, promise, promo
        self.dispatched = self.delivered = None
        self.dispatch_event = None


class FulfilmentTwin:
    def __init__(self, scenario: Scenario, cal: Calibration, seed: int):
        self.sc, self.cal = scenario, cal
        # Separate random streams (common random numbers): demand and lead times
        # stay identical across scenarios that share a seed and a demand profile,
        # so differences between mitigations come from the policy, not from noise.
        demand_ss, mode_ss, lead_ss = np.random.SeedSequence(seed).spawn(3)
        self.rng_demand = np.random.default_rng(demand_ss)
        self.rng_mode = np.random.default_rng(mode_ss)
        self.rng_lead = np.random.default_rng(lead_ss)

        self.promise = dict(scenario.promise_days or cal.current_promise)
        self.rank = {m: i for i, m in enumerate(cal.modes)}
        self.base_capacity = (None if scenario.capacity_factor is None
                              else cal.observed_peak * scenario.capacity_factor)

        self.env = simpy.Environment()
        self.backlog: list[Order] = []
        self.orders: list[Order] = []
        self.backlog_by_day: list[int] = []

    # --- processes -------------------------------------------------------
    def demand(self):
        for day in range(self.sc.horizon_days):
            n = int(round(self.rng_demand.choice(self.cal.daily_demand)
                          * self.sc.demand_multiplier(day)))
            mode_idx = self.rng_mode.choice(len(self.cal.modes), size=n, p=self.cal.mode_mix)
            u = self.rng_lead.random(n)
            promo = self.sc.demand_multiplier(day) != 1.0
            for i, u_i in zip(mode_idx, u):
                mode = self.cal.modes[i]
                lead = int(self.cal.lead_days[mode][np.searchsorted(self.cal.lead_cdf[mode], u_i)])
                promise = self.promise[mode] + (self.sc.promo_promise_extension if promo else 0)
                order = Order(len(self.orders), mode, self.rank[mode], day, lead, promise, promo)
                self.orders.append(order)
                self.env.process(self.order_flow(order))
            yield self.env.timeout(1)

    def order_flow(self, order: Order):
        order.dispatch_event = self.env.event()
        self.backlog.append(order)
        yield order.dispatch_event                 # wait for a dispatch slot
        order.dispatched = int(self.env.now)
        yield self.env.timeout(order.lead)         # transit
        order.delivered = order.dispatched + order.lead

    def dispatcher(self):
        yield self.env.timeout(0.5)                # dispatch runs after the day's orders arrive
        while True:
            day = int(self.env.now)
            capacity = self.capacity(day)
            if self.sc.dispatch_rule == "PREMIUM_FIRST":
                self.backlog.sort(key=lambda o: (o.rank, o.seq))
            n = len(self.backlog) if capacity is None else min(capacity, len(self.backlog))
            released, self.backlog = self.backlog[:n], self.backlog[n:]
            for order in released:
                order.dispatch_event.succeed()
            self.backlog_by_day.append(len(self.backlog))
            yield self.env.timeout(1)

    def capacity(self, day: int):
        if self.base_capacity is None:
            return None
        in_promo = self.sc.promo_start <= day < self.sc.promo_start + self.sc.promo_days
        factor = self.sc.promo_capacity_factor if in_promo else 1.0
        return int(round(self.base_capacity * factor))

    # --- run -------------------------------------------------------------
    def run(self):
        self.env.process(self.demand())
        self.env.process(self.dispatcher())
        self.env.run(until=self.sc.horizon_days + 10)   # let in-transit orders land
        return self


@dataclass
class RunResult:
    on_time_rate: float
    on_time_by_mode: dict
    avg_dispatch_wait: float
    orders_in_window: int
    undispatched_in_window: int
    peak_backlog: int
    days_to_clear: float          # promo start -> backlog back to 0 (0 if none, nan if never)
    backlog_by_day: list = field(repr=False)


def _mean(values) -> float:
    return float(np.mean(values)) if len(values) else float("nan")


def summarise(twin: FulfilmentTwin) -> RunResult:
    sc = twin.sc
    lo, hi = sc.window_start, sc.window_start + sc.window_days
    window = [o for o in twin.orders if lo <= o.placed < hi]

    def on_time(o):  # never dispatched before the horizon -> counted late
        return o.delivered is not None and o.delivered - o.placed <= o.promise

    by_mode = {}
    for mode in twin.cal.modes:
        sub = [o for o in window if o.mode == mode]
        by_mode[mode] = _mean([on_time(o) for o in sub])

    dispatched = [o for o in window if o.dispatched is not None]
    backlog = twin.backlog_by_day
    # days from promo start until the backlog is back to zero (0 if none formed)
    busy = [d for d in range(sc.promo_start, len(backlog)) if backlog[d] > 0]
    if not busy:
        days_to_clear = 0.0
    elif backlog[-1] > 0:
        days_to_clear = float("nan")         # never cleared within the horizon
    else:
        days_to_clear = float(busy[-1] + 1 - sc.promo_start)

    return RunResult(
        on_time_rate=_mean([on_time(o) for o in window]),
        on_time_by_mode=by_mode,
        avg_dispatch_wait=_mean([o.dispatched - o.placed for o in dispatched]),
        orders_in_window=len(window),
        undispatched_in_window=len(window) - len(dispatched),
        peak_backlog=int(max(backlog)),
        days_to_clear=days_to_clear,
        backlog_by_day=backlog,
    )


def simulate(scenario: Scenario, cal: Calibration, seed: int) -> RunResult:
    return summarise(FulfilmentTwin(scenario, cal, seed).run())
