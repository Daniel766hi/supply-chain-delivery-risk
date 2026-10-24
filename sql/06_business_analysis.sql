-- =====================================================================
-- 06_business_analysis.sql
-- Answers the business questions. The output file is the evidence behind
-- every number in the README and CV, so keep it in the repo.
--
--   psql -U postgres -d dataco -f sql/06_business_analysis.sql -o results/06_analysis_output.txt
-- =====================================================================

\pset footer off

\qecho '=== Q1. Headline KPIs (all orders; delivery KPIs on shipped orders) ==='
SELECT * FROM mart.vw_kpi_summary;

\qecho '=== Q2. Hypothesis screen: late-rate spread per candidate driver ==='
SELECT dimension,
       COUNT(*)              AS members,
       MIN(late_rate)        AS lowest_late_rate,
       MAX(late_rate)        AS highest_late_rate,
       MAX(dimension_spread) AS spread
FROM mart.vw_late_rate_by_dimension
GROUP BY dimension
ORDER BY spread DESC;

\qecho '=== Q2b. Late rate by market (detail) ==='
SELECT member AS market, shipped_orders, late_orders, late_rate, rank_in_dimension
FROM mart.vw_late_rate_by_dimension
WHERE dimension = 'Market'
ORDER BY late_rate DESC;

\qecho '=== Q3. Promise vs actual lead time by shipping mode ==='
SELECT * FROM mart.vw_mode_promise_gap ORDER BY promised_days;

\qecho '=== Q4a. Lead-time distribution by mode (cumulative_share = on-time rate at that promise) ==='
SELECT * FROM mart.vw_lead_time_distribution ORDER BY promised_days, actual_days;

\qecho '=== Q4b. Promise scenarios per mode ==='
SELECT * FROM mart.vw_promise_scenarios
ORDER BY current_promise_days, candidate_promise_days;

\qecho '=== Q4c. Network on-time rate if each mode is re-promised to the shortest promise that hits a target ==='
WITH mode_volume AS (
    SELECT shipping_mode, shipped_orders FROM mart.vw_mode_promise_gap
),
targets AS (
    SELECT * FROM (VALUES (0.75), (0.90), (0.95)) AS t(target_on_time_rate)
),
chosen AS (
    -- shortest candidate promise per mode that meets the target
    SELECT DISTINCT ON (t.target_on_time_rate, s.shipping_mode)
           t.target_on_time_rate,
           s.shipping_mode,
           s.current_promise_days,
           s.candidate_promise_days,
           s.projected_on_time_rate
    FROM targets t
    JOIN mart.vw_promise_scenarios s
      ON s.projected_on_time_rate >= t.target_on_time_rate
    ORDER BY t.target_on_time_rate, s.shipping_mode, s.candidate_promise_days
),
current_policy AS (
    SELECT NULL::NUMERIC AS target_on_time_rate, s.shipping_mode, s.current_promise_days,
           s.candidate_promise_days, s.projected_on_time_rate
    FROM mart.vw_promise_scenarios s
    WHERE s.is_current_promise
)
SELECT
    COALESCE('Target ' || ROUND(p.target_on_time_rate * 100) || '%', 'Current promises') AS policy,
    STRING_AGG(p.shipping_mode || ' ' || p.candidate_promise_days || 'd', ', '
               ORDER BY p.current_promise_days)                                         AS promise_per_mode,
    ROUND(SUM(p.projected_on_time_rate * v.shipped_orders) / SUM(v.shipped_orders), 4)  AS network_on_time_rate,
    ROUND(SUM((p.candidate_promise_days - p.current_promise_days) * v.shipped_orders)::NUMERIC
          / SUM(v.shipped_orders), 2)                                                   AS avg_days_added_per_order
FROM (SELECT * FROM current_policy UNION ALL SELECT * FROM chosen) p
JOIN mode_volume v USING (shipping_mode)
GROUP BY p.target_on_time_rate
ORDER BY p.target_on_time_rate NULLS FIRST;

\qecho '=== Q5. Monthly trend ==='
SELECT * FROM mart.vw_monthly_trend ORDER BY order_month;

\qecho '=== Q5b. Volume step-up from Oct-2017: did the late rate move? ==='
WITH monthly AS (
    SELECT order_month,
           COUNT(*)                                 AS orders,
           SUM(is_late)                             AS late_orders,
           COUNT(*) FILTER (WHERE is_cancelled = 0) AS shipped_orders,
           SUM(net_sales)                           AS net_sales
    FROM mart.vw_orders_enriched
    GROUP BY order_month
)
SELECT
    CASE WHEN order_month >= DATE '2017-10-01' THEN '2: Oct-2017 to Jan-2018'
         ELSE '1: Oct-2016 to Sep-2017' END                  AS period,
    COUNT(*)                                                  AS months,
    ROUND(AVG(orders))                                        AS avg_orders_per_month,
    ROUND(SUM(late_orders)::NUMERIC / SUM(shipped_orders), 4) AS late_rate,
    ROUND(SUM(net_sales) / SUM(orders), 2)                    AS avg_order_value
FROM monthly
WHERE order_month >= DATE '2016-10-01'
GROUP BY 1
ORDER BY 1;

\qecho '=== Q6. Repeat purchase within 180 days by first-order delivery outcome ==='
SELECT * FROM mart.vw_repeat_after_first_order ORDER BY first_order_outcome;

\qecho '=== Q7. Revenue leakage (cancelled + suspected fraud) by market ==='
SELECT * FROM mart.vw_revenue_leakage_by_market ORDER BY leakage_rank;

\qecho '=== Q7b. Revenue leakage total ==='
SELECT COUNT(*) FILTER (WHERE is_cancelled = 1)                     AS leaked_orders,
       COUNT(*) FILTER (WHERE is_suspected_fraud = 1)               AS suspected_fraud_orders,
       SUM(net_sales) FILTER (WHERE is_cancelled = 1)               AS leaked_net_sales,
       ROUND(SUM(net_sales) FILTER (WHERE is_cancelled = 1) / SUM(net_sales), 4) AS leakage_share_of_sales
FROM dw.fact_orders;

\qecho '=== Q8. Top 10 categories by net sales in late orders ==='
SELECT * FROM mart.vw_category_late_exposure
WHERE late_sales_rank <= 10
ORDER BY late_sales_rank;
