"""Interactive front end for the fulfilment digital twin.

    streamlit run simulation/app.py

Every number on screen comes from running the SimPy model in twin/ - the app
adds controls and charts, no logic of its own. Each scenario is run alongside
"no response" on the same random seeds, so the comparison is paired.
"""

import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parent))
from twin import FulfilmentTwin, Scenario, load_calibration  # noqa: E402
from twin.experiment import mean_ci, paired_test  # noqa: E402
from twin.model import summarise  # noqa: E402

RESULTS = Path(__file__).resolve().parent / "results"
PROMO_START, WINDOW_DAYS, HORIZON = 30, 60, 365

# Reference palette (light): see dataviz guidance
INK, INK_2, MUTED, GRID, AXIS, SURFACE = "#0b0b0b", "#52514e", "#8a8984", "#e1e0d9", "#c3c2b7", "#fcfcfb"
BLUE, ORANGE, AQUA = "#2a78d6", "#eb6834", "#1baf7a"
GOOD, BAD = "#006300", "#b42318"

st.set_page_config(page_title="Fulfilment Digital Twin", page_icon="📦", layout="wide")

st.markdown(f"""
<style>
  .block-container {{ padding-top: 2rem; padding-bottom: 2rem; max-width: 1280px; }}
  h1 {{ font-size: 1.75rem !important; font-weight: 650 !important; letter-spacing: -0.01em; }}
  .subtitle {{ color: {INK_2}; font-size: 0.98rem; margin: -0.6rem 0 1.2rem 0; max-width: 60rem; }}
  .kpi {{ background: #ffffff; border: 1px solid rgba(11,11,11,0.08); border-radius: 10px;
          padding: 14px 16px 12px 16px; height: 100%; }}
  .kpi .label {{ color: {INK_2}; font-size: 0.8rem; font-weight: 500; margin-bottom: 4px; }}
  .kpi .value {{ color: {INK}; font-size: 1.7rem; font-weight: 650; line-height: 1.15;
                 font-variant-numeric: tabular-nums; }}
  .kpi .delta {{ font-size: 0.82rem; margin-top: 4px; font-variant-numeric: tabular-nums; }}
  .kpi .note {{ color: {MUTED}; font-size: 0.75rem; margin-top: 2px; }}
  .good {{ color: {GOOD}; }} .bad {{ color: {BAD}; }} .flat {{ color: {INK_2}; }}
  .pill {{ display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.78rem;
           background: #eef4fc; color: #184f95; margin: 0 6px 6px 0; border: 1px solid #cde2fb; }}
  .section-note {{ color: {INK_2}; font-size: 0.85rem; margin-top: -0.5rem; margin-bottom: 0.2rem; }}
  h3 {{ font-size: 1.12rem !important; font-weight: 620 !important; padding-top: 0.6rem !important; }}
  .kpi {{ min-height: 138px; }}
  .verdict {{ border-left: 4px solid {BLUE}; background: #ffffff; border-radius: 0 10px 10px 0;
              padding: 12px 16px; margin: 14px 0 6px 0; color: {INK}; font-size: 0.97rem; line-height: 1.5;
              border-top: 1px solid rgba(11,11,11,0.06); border-right: 1px solid rgba(11,11,11,0.06);
              border-bottom: 1px solid rgba(11,11,11,0.06); }}
  .verdict.good {{ border-left-color: {GOOD}; }} .verdict.bad {{ border-left-color: {BAD}; }}
  .verdict b {{ font-weight: 650; }}
  [data-testid="stSidebar"] {{ background: #f6f5f2; }}
  [data-testid="stSidebar"] h3 {{ font-size: 0.74rem !important; text-transform: uppercase; letter-spacing: 0.07em;
                                  color: {INK_2} !important; font-weight: 600 !important;
                                  margin: 0.9rem 0 0 0 !important; padding: 0.4rem 0 0 0 !important;
                                  border-top: 1px solid rgba(11,11,11,0.08); }}
</style>
""", unsafe_allow_html=True)


# ------------------------------------------------------------------ model runs
@st.cache_resource
def calibration():
    return load_calibration()


@st.cache_data(show_spinner=False, max_entries=64)
def run_scenario(params: tuple, reps: int):
    """Run `reps` replications; return per-rep metrics and mean daily paths."""
    sc = Scenario(**dict(params))
    cal = calibration()
    rows, backlog, demand, dispatched = [], [], [], []
    for i in range(reps):
        twin = FulfilmentTwin(sc, cal, seed=1000 + i).run()
        r = summarise(twin)
        rows.append({"on_time": r.on_time_rate, "wait": r.avg_dispatch_wait,
                     "peak": r.peak_backlog, "clear": r.days_to_clear,
                     **{f"mode::{m}": v for m, v in r.on_time_by_mode.items()}})
        backlog.append(twin.backlog_by_day[:HORIZON])
        placed = np.bincount([o.placed for o in twin.orders], minlength=HORIZON)[:HORIZON]
        sent = np.bincount([o.dispatched for o in twin.orders if o.dispatched is not None],
                           minlength=HORIZON + 10)[:HORIZON]
        demand.append(placed)
        dispatched.append(sent)
    backlog = np.array(backlog, dtype=float)
    return {
        "reps": pd.DataFrame(rows),
        "backlog_mean": backlog.mean(axis=0),
        "backlog_p10": np.percentile(backlog, 10, axis=0),
        "backlog_p90": np.percentile(backlog, 90, axis=0),
        "demand_mean": np.mean(demand, axis=0),
        "dispatched_mean": np.mean(dispatched, axis=0),
    }


def as_params(sc: Scenario) -> tuple:
    d = {k: v for k, v in sc.__dict__.items()}
    if d["promise_days"] is not None:
        d["promise_days"] = dict(d["promise_days"])
    # dicts aren't hashable for the cache key -> freeze to a sorted tuple, rebuilt in run_scenario
    return tuple(sorted((k, (tuple(sorted(v.items())) if isinstance(v, dict) else v)) for k, v in d.items()))


def thaw(params: tuple) -> tuple:
    return tuple((k, dict(v) if k == "promise_days" and v is not None else v) for k, v in params)


# ------------------------------------------------------------------ presets
PRESETS = {
    "Normal operations": dict(promo_mult=1.0, promo_days=14, capacity=64, surge=0, extra_days=0,
                              rule="First in, first out", policy="Current promises", spread=False),
    "1.5x promo, no response": dict(promo_mult=1.5, promo_days=14, capacity=64, surge=0, extra_days=0,
                                        rule="First in, first out", policy="Current promises", spread=False),
    "1.5x promo, surge capacity": dict(promo_mult=1.5, promo_days=14, capacity=64, surge=50, extra_days=0,
                                           rule="First in, first out", policy="Current promises", spread=False),
    "2x promo, surge + quote": dict(promo_mult=2.0, promo_days=14, capacity=64, surge=50, extra_days=3,
                                                rule="First in, first out", policy="Current promises", spread=False),
    "2x promo, premium first": dict(promo_mult=2.0, promo_days=14, capacity=64, surge=0, extra_days=0,
                                        rule="Premium modes first", policy="Current promises", spread=False),
    "Realistic promises": dict(promo_mult=1.0, promo_days=14, capacity=64, surge=0, extra_days=0,
                                                   rule="First in, first out", policy="Promise met 75% of the time",
                                                   spread=False),
}
KEYS = ["promo_mult", "promo_days", "capacity", "surge", "extra_days", "rule", "policy", "spread"]


def apply_preset():
    for k, v in PRESETS[st.session_state.preset].items():
        st.session_state[k] = v


if "promo_mult" not in st.session_state:
    st.session_state.preset = "1.5x promo, no response"
    apply_preset()

cal = calibration()

# ------------------------------------------------------------------ sidebar
with st.sidebar:
    st.markdown("## Scenario")
    st.selectbox("Start from a preset", list(PRESETS), key="preset", on_change=apply_preset)

    st.markdown("### Promotion")
    st.slider("Demand during promotion (x normal)", 1.0, 3.0, step=0.25, key="promo_mult",
              help="1.0 = no promotion. Normal demand averages 54.6 shipped orders a day.")
    st.slider("Promotion length (days)", 7, 28, step=7, key="promo_days")
    st.checkbox("Spread the same extra volume over twice as many days", key="spread",
                help="Halves the uplift and doubles the length: same total extra orders, gentler peak.")

    st.markdown("### Capacity")
    st.slider("Normal dispatch capacity (orders/day)", 56, 120, step=2, key="capacity",
              help="64 = the busiest day in the calibration year, the highest level the data shows "
                   "being handled without slowdown. Higher values are assumptions.")
    st.slider("Surge capacity during promotion (+%)", 0, 100, step=10, key="surge")

    st.markdown("### Customer promise")
    st.radio("Promise policy", ["Current promises", "Promise met 75% of the time",
                                "Promise met 90% of the time"], key="policy")
    st.slider("Extra days quoted on promotion orders", 0, 5, key="extra_days")
    st.radio("Dispatch order when there is a backlog", ["First in, first out", "Premium modes first"],
             key="rule", help="Premium = Same Day and First Class.")

    st.markdown("### Simulation")
    reps = st.select_slider("Replications", options=[5, 10, 20, 30], value=10,
                            help="More runs = tighter confidence intervals, slower.")
    st.caption("Each run simulates one year of orders. Common random numbers: the scenario and "
               "its no-response comparison see identical demand and lead times.")

# ------------------------------------------------------------------ build scenarios
s = st.session_state
promise = {"Current promises": None,
           "Promise met 75% of the time": cal.promise_for_target(0.75),
           "Promise met 90% of the time": cal.promise_for_target(0.90)}[s.policy]
promo_days = s.promo_days * (2 if s.spread else 1)
promo_mult = 1 + (s.promo_mult - 1) / 2 if s.spread else s.promo_mult
cap_factor = s.capacity / cal.observed_peak

common = dict(horizon_days=HORIZON, promo_start=PROMO_START, window_start=PROMO_START,
              window_days=WINDOW_DAYS, capacity_factor=cap_factor)
scenario = Scenario(name="Your scenario", promise_days=promise, promo_days=promo_days,
                    promo_multiplier=promo_mult, promo_capacity_factor=1 + s.surge / 100,
                    promo_promise_extension=s.extra_days,
                    dispatch_rule="PREMIUM_FIRST" if s.rule == "Premium modes first" else "FIFO", **common)
# Same promotion (unspread), no response, today's promises
no_response = Scenario(name="No response", promo_days=s.promo_days, promo_multiplier=s.promo_mult, **common)
no_promo = Scenario(name="No promotion", promo_days=0, promo_multiplier=1.0,
                    **{**common, "capacity_factor": 1.0})

with st.spinner(f"Running {reps} simulated years per scenario..."):
    res = run_scenario(thaw(as_params(scenario)), reps)
    ref = run_scenario(thaw(as_params(no_response)), reps)
    base = run_scenario(thaw(as_params(no_promo)), reps)

# ------------------------------------------------------------------ header
st.title("Fulfilment Digital Twin")
st.markdown(
    "<div class='subtitle'>Discrete-event simulation of DataCo's order-to-delivery flow, calibrated on "
    "19,936 real orders (Oct 2016 – Sep 2017). Set a promotion and a response on the left. The twin "
    "compares it with doing nothing, run on the same random draws.</div>", unsafe_allow_html=True)

pills = [f"Promotion {s.promo_mult:g}x for {s.promo_days} days" if s.promo_mult > 1 else "No promotion"]
if s.spread and s.promo_mult > 1:
    pills.append(f"spread: {promo_mult:g}x for {promo_days} days")
pills.append(f"Capacity {s.capacity}/day")
if s.surge:
    pills.append(f"Surge +{s.surge}%")
if s.extra_days:
    pills.append(f"Quote +{s.extra_days} days")
if s.rule == "Premium modes first":
    pills.append("Premium first")
if promise:
    pills.append(s.policy)
st.markdown("".join(f"<span class='pill'>{p}</span>" for p in pills), unsafe_allow_html=True)


# ------------------------------------------------------------------ KPI tiles
def fmt_pct(x):
    return "–" if np.isnan(x) else f"{100 * x:.1f}%"


def delta_html(diff, unit, better_when_higher, half=None, p=None, digits=1):
    if diff is None or np.isnan(diff):
        return "<div class='delta flat'>&nbsp;</div>"
    if same_as_reference:
        return "<div class='delta flat'>Same as no response</div>"
    cls = "flat" if abs(diff) < 10 ** -digits / 2 else (
        "good" if (diff > 0) == better_when_higher else "bad")
    arrow = "▲" if diff > 0 else ("▼" if diff < 0 else "")
    ci = f" ± {half:.{digits}f}" if half is not None and not np.isnan(half) else ""
    sig = ""
    if p is not None and not np.isnan(p):
        sig = " · significant" if p < 0.05 else " · not significant"
    return f"<div class='delta {cls}'>{arrow} {diff:+.{digits}f}{unit}{ci} vs no response{sig}</div>"


def tile(col, label, value, delta, note):
    col.markdown(f"<div class='kpi'><div class='label'>{label}</div><div class='value'>{value}</div>"
                 f"{delta}<div class='note'>{note}</div></div>", unsafe_allow_html=True)


# The comparison run shares capacity and promotion, so the scenario equals it when no lever is pulled
same_as_reference = (s.surge == 0 and s.extra_days == 0 and s.rule == "First in, first out"
                     and promise is None and not s.spread)
r, c = res["reps"], ref["reps"]
on_time, _ = mean_ci(r["on_time"])
d_on, d_half, d_p = paired_test(r["on_time"], c["on_time"])
base_on, _ = mean_ci(base["reps"]["on_time"])
peak, ref_peak = r["peak"].mean(), c["peak"].mean()
clear_ok = r["clear"].notna().all()
clear, ref_clear = r["clear"].mean(), c["clear"].mean()
wait, ref_wait = r["wait"].mean(), c["wait"].mean()

k1, k2, k3, k4 = st.columns(4)
tile(k1, "On-time delivery", fmt_pct(on_time),
     delta_html(100 * d_on, " pp", True, 100 * d_half, d_p),
     f"Orders placed in the {WINDOW_DAYS} days from promotion start · normal: {fmt_pct(base_on)}")
tile(k2, "Peak dispatch backlog", f"{peak:,.0f} orders",
     delta_html(peak - ref_peak, "", False, digits=0), "Orders waiting for a dispatch slot")
tile(k3, "Days to clear backlog", f"{clear:.0f} days" if clear_ok else "> 1 year",
     delta_html(clear - ref_clear, " days", False, digits=0) if clear_ok and c["clear"].notna().all()
     else "<div class='delta flat'>&nbsp;</div>",
     "From promotion start until nothing is waiting")
tile(k4, "Average dispatch wait", f"{wait:.1f} days",
     delta_html(wait - ref_wait, " days", False), "Time an order waits before it ships")

clear_txt = f"clears in about {clear:.0f} days" if clear_ok else "does not clear within a year"
if s.promo_mult == 1.0 and promise is None:
    verdict, tone = (f"<b>No promotion.</b> Demand stays within capacity, nothing queues, and "
                     f"{fmt_pct(on_time)} of orders arrive on time. The remaining lateness comes from the "
                     f"promises themselves: try the 75% promise policy.", "")
elif s.promo_mult == 1.0:
    verdict, tone = (f"<b>No promotion, {s.policy.lower()}.</b> On-time delivery is {fmt_pct(on_time)} "
                     f"against {fmt_pct(base_on)} with today's promises: the gap is pure promise-setting.", "good")
elif same_as_reference:
    verdict, tone = (f"<b>No response.</b> The promotion pushes demand above capacity: on-time delivery falls "
                     f"from {fmt_pct(base_on)} to {fmt_pct(on_time)}, and the backlog peaks at "
                     f"{peak:,.0f} orders and {clear_txt}. Add a response on the left to compare.", "bad")
else:
    sig = "significant" if (not np.isnan(d_p) and d_p < 0.05) else "not statistically significant"
    tone = "good" if d_on > 0.005 else ("bad" if d_on < -0.005 else "")
    verdict = (f"<b>{100 * d_on:+.1f} pp on-time delivery vs no response</b> ({fmt_pct(on_time)} vs "
               f"{fmt_pct(c['on_time'].mean())}, {sig} over {reps} paired runs). Backlog peaks at "
               f"{peak:,.0f} orders (vs {ref_peak:,.0f}) and {clear_txt}. Normal on-time rate without a "
               f"promotion: {fmt_pct(base_on)}.")
st.markdown(f"<div class='verdict {tone}'>{verdict}</div>", unsafe_allow_html=True)


# ------------------------------------------------------------------ charts
def base_layout(fig, height=360, yaxis_title=None, xaxis_title=None):
    fig.update_layout(
        height=height, margin=dict(l=8, r=8, t=28, b=8), plot_bgcolor=SURFACE, paper_bgcolor=SURFACE,
        font=dict(family="Inter, system-ui, sans-serif", size=12, color=INK_2),
        hovermode="x unified", hoverlabel=dict(bgcolor="#ffffff", font_color=INK, bordercolor=AXIS),
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1, font=dict(size=12)),
    )
    fig.update_xaxes(showgrid=False, linecolor=AXIS, ticks="outside", tickcolor=AXIS, title=xaxis_title,
                     zeroline=False)
    fig.update_yaxes(gridcolor=GRID, gridwidth=1, zeroline=False, linecolor=AXIS, title=yaxis_title,
                     rangemode="tozero")
    return fig


def promo_band(fig, days, label=True):
    if days and (s.promo_mult > 1):
        fig.add_vrect(x0=PROMO_START, x1=PROMO_START + days, fillcolor=GRID, opacity=0.55, line_width=0,
                      layer="below")
        if label:
            fig.add_annotation(x=PROMO_START + days / 2, y=0.98, yref="paper", text="promotion", showarrow=False,
                               font=dict(size=11, color=INK_2), yanchor="top")


days = np.arange(HORIZON)
last_day = int(max(PROMO_START + 150, np.nonzero(np.maximum(res["backlog_mean"], ref["backlog_mean"]))[0].max() + 20
                   if (res["backlog_mean"].max() + ref["backlog_mean"].max()) > 0 else 0))
last_day = min(last_day, HORIZON - 1)

left, right = st.columns([3, 2], gap="large")
with left:
    st.subheader("Dispatch backlog over time")
    st.markdown(f"<div class='section-note'>Mean of {reps} runs; shaded band = 10th–90th percentile.</div>",
                unsafe_allow_html=True)
    if max(res["backlog_p90"].max(), ref["backlog_p90"].max()) == 0:
        st.info("No backlog forms: daily demand never exceeds dispatch capacity, so every order ships "
                "the day it is placed. Raise the promotion size to stress the network.")
    fig = go.Figure()
    for name, data, color in [("No response", ref, MUTED), ("Your scenario", res, BLUE)]:
        fig.add_trace(go.Scatter(x=days, y=data["backlog_p90"], line=dict(width=0), hoverinfo="skip",
                                 showlegend=False))
        fig.add_trace(go.Scatter(x=days, y=data["backlog_p10"], line=dict(width=0), fill="tonexty",
                                 fillcolor=f"rgba{tuple(int(color[i:i+2], 16) for i in (1, 3, 5)) + (0.15,)}",
                                 hoverinfo="skip", showlegend=False))
        fig.add_trace(go.Scatter(x=days, y=data["backlog_mean"], name=name, line=dict(color=color, width=2.5,
                                 dash="dot" if name == "No response" else "solid"),
                                 hovertemplate="%{y:,.0f} orders"))
    promo_band(fig, s.promo_days)
    if s.spread and s.promo_mult > 1:
        fig.add_vrect(x0=PROMO_START + s.promo_days, x1=PROMO_START + promo_days, fillcolor=GRID, opacity=0.3,
                      line_width=0, layer="below")
    base_layout(fig, yaxis_title="Orders waiting", xaxis_title="Simulation day")
    fig.update_xaxes(range=[0, last_day])
    if max(res["backlog_p90"].max(), ref["backlog_p90"].max()) > 0:
        st.plotly_chart(fig, width="stretch", config={"displayModeBar": False})

with right:
    st.subheader("On-time rate by shipping mode")
    st.markdown("<div class='section-note'>Grey = no response. First Class takes 2 days against a 1-day "
                "promise, so it is only on time when extra days are quoted.</div>", unsafe_allow_html=True)
    modes = list(cal.modes)
    fig = go.Figure()
    fig.add_trace(go.Bar(y=modes, x=[100 * c[f"mode::{m}"].mean() for m in modes], name="No response",
                         orientation="h", marker_color="#c9c8c2", hovertemplate="%{x:.1f}%"))
    fig.add_trace(go.Bar(y=modes, x=[100 * r[f"mode::{m}"].mean() for m in modes], name="Your scenario",
                         orientation="h", marker_color=BLUE, hovertemplate="%{x:.1f}%",
                         text=[f"{100 * r[f'mode::{m}'].mean():.0f}%" for m in modes], textposition="outside",
                         textfont=dict(color=INK, size=11), cliponaxis=False))
    base_layout(fig, xaxis_title="On-time rate (%)")
    fig.update_layout(barmode="group", bargap=0.35, bargroupgap=0.08, hovermode="y unified")
    fig.update_xaxes(range=[0, 108], gridcolor=GRID, showgrid=True)
    fig.update_yaxes(autorange="reversed", showgrid=False, ticks="")
    st.plotly_chart(fig, width="stretch", config={"displayModeBar": False})

st.subheader("Demand vs dispatch")
st.markdown("<div class='section-note'>Orders placed and orders shipped per day (mean of runs). "
            "When orders placed exceed capacity, the gap builds the backlog above.</div>", unsafe_allow_html=True)
in_promo = (days >= PROMO_START) & (days < PROMO_START + promo_days)
cap_line = np.where(in_promo, round(s.capacity * (1 + s.surge / 100)), s.capacity)
fig = go.Figure()
fig.add_trace(go.Scatter(x=days, y=res["demand_mean"], name="Orders placed", line=dict(color=ORANGE, width=2),
                         hovertemplate="%{y:.0f}"))
fig.add_trace(go.Scatter(x=days, y=res["dispatched_mean"], name="Orders dispatched",
                         line=dict(color=AQUA, width=2), hovertemplate="%{y:.0f}"))
fig.add_trace(go.Scatter(x=days, y=cap_line, name="Dispatch capacity", line=dict(color=INK_2, width=1.5, dash="dash"),
                         hovertemplate="%{y:.0f}"))
promo_band(fig, promo_days, label=False)
base_layout(fig, height=300, yaxis_title="Orders per day", xaxis_title="Simulation day")
fig.update_xaxes(range=[0, last_day])
st.plotly_chart(fig, width="stretch", config={"displayModeBar": False})

# ------------------------------------------------------------------ details
tab_res, tab_study, tab_model = st.tabs(["Run details", "Saved study (30 runs)", "How the twin works"])

with tab_res:
    table = pd.DataFrame({
        "Metric": ["On-time delivery", "Peak backlog (orders)", "Days to clear backlog", "Average dispatch wait (days)"]
        + [f"On-time: {m}" for m in modes],
        "Your scenario": [fmt_pct(on_time), f"{peak:,.0f}", f"{clear:.1f}" if clear_ok else "> 1 year", f"{wait:.2f}"]
        + [fmt_pct(r[f"mode::{m}"].mean()) for m in modes],
        "No response": [fmt_pct(c["on_time"].mean()), f"{ref_peak:,.0f}",
                        f"{ref_clear:.1f}" if c["clear"].notna().all() else "> 1 year", f"{ref_wait:.2f}"]
        + [fmt_pct(c[f"mode::{m}"].mean()) for m in modes],
    })
    st.dataframe(table, hide_index=True, width="stretch")
    p_txt = "n/a (identical in every run)" if np.isnan(d_p) else f"{d_p:.2g}"
    st.caption(f"Paired t-test on on-time rate across {reps} runs with common random numbers: "
               f"difference {100 * d_on:+.1f} pp ± {100 * d_half:.1f}, p = {p_txt}.")
    out = r.assign(run=range(1, len(r) + 1)).rename(columns=lambda x: x.replace("mode::", "on_time_"))
    st.download_button("Download per-run results (CSV)", out.to_csv(index=False), "twin_runs.csv", "text/csv")

with tab_study:
    st.markdown("Results from `run_experiments.py`: 30 runs per response, 14-day promotion at 64 orders/day.")
    e2 = pd.read_csv(RESULTS / "e2_shock_responses.csv")
    show = e2[["promo_size", "response", "on_time_pct", "vs_no_action_pp", "p_value",
               "peak_backlog_orders", "days_to_clear_backlog"]].rename(columns={
        "promo_size": "Promotion", "response": "Response", "on_time_pct": "On-time %",
        "vs_no_action_pp": "vs no action (pp)", "p_value": "p-value",
        "peak_backlog_orders": "Peak backlog", "days_to_clear_backlog": "Days to clear"})
    st.dataframe(show, hide_index=True, width="stretch")
    a, b = st.columns(2)
    a.image(str(RESULTS / "responses_2x_promo.png"))
    b.image(str(RESULTS / "sensitivity_heatmap.png"))

with tab_model:
    st.markdown(f"""
**Flow per order:** placed → waits in the dispatch backlog → dispatched (up to capacity per day) →
transit (lead time drawn from the real distribution for its shipping mode) → delivered.
An order is **on time** if *wait + lead time ≤ promised days*.

| Input | Value | Source |
|---|---|---|
| Daily demand | resampled from 365 real days (mean 54.6, range 41–64) | `inputs/daily_demand.csv` |
| Mode mix | Same Day {100*cal.mode_mix[0]:.1f}% · First {100*cal.mode_mix[1]:.1f}% · Second {100*cal.mode_mix[2]:.1f}% · Standard {100*cal.mode_mix[3]:.1f}% | `inputs/lead_time_distribution.csv` |
| Current promises | 0 / 1 / 2 / 4 days | same |
| Dispatch capacity | **assumption**: 64/day = busiest observed day | adjustable on the left |

**Validation:** with no promotion the twin reproduces history within 0.25 pp on volume, mode mix and
on-time rate (30 runs). 11 automated tests cover extreme conditions (zero demand, zero or unlimited capacity).

**Limitations:** capacity is not observed in the data; warehouse and carrier are one stage; lead times
don't stretch under load, so promotion results are likely optimistic; customers don't cancel when
delivery slows. Details: `simulation/README.md`.
""")
    st.dataframe(pd.read_csv(RESULTS / "validation.csv"), hide_index=True, width="stretch")
