-- =====================================================================
-- 05_kpi_views.sql
-- KPI views in the "mart" schema. Each view answers one business question;
-- 06_business_analysis.sql reads them, and Power BI imports two of them.
--
--   psql -U postgres -d dataco -v ON_ERROR_STOP=1 -f sql/05_kpi_views.sql
--
-- Convention: delivery KPIs count SHIPPED orders only (is_cancelled = 0);
-- sales KPIs count all orders unless stated otherwise.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper: one row per order with every attribute the analyses slice by
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.vw_orders_enriched AS
SELECT
    f.*,
    d.date        AS order_date,
    d.month_start AS order_month,
    m.shipping_mode,
    m.promised_days,
    g.market,
    g.region,
    g.country,
    c.segment     AS customer_segment
FROM dw.fact_orders f
JOIN dw.dim_date          d ON d.date_key         = f.order_date_key
JOIN dw.dim_shipping_mode m ON m.shipping_mode_id = f.shipping_mode_id
JOIN dw.dim_geography     g ON g.geo_id           = f.geo_id
JOIN dw.dim_customer      c ON c.customer_id      = f.customer_id;

-- ---------------------------------------------------------------------
-- Q1. Headline KPIs: how big is the delivery problem?
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.vw_kpi_summary AS
SELECT
    COUNT(*)                                                    AS total_orders,
    COUNT(*) FILTER (WHERE is_cancelled = 0)                    AS shipped_orders,
    SUM(net_sales)                                              AS net_sales,
    SUM(profit)                                                 AS profit,
    ROUND(SUM(profit) / NULLIF(SUM(net_sales), 0), 4)           AS profit_margin,
    ROUND(AVG(is_late), 4)                                      AS late_rate,
    ROUND(AVG(1 - is_late), 4)                                  AS on_time_rate,  -- on time or early
    ROUND(AVG(delay_days) FILTER (WHERE is_late = 1), 2)        AS avg_delay_days_when_late,
    SUM(net_sales) FILTER (WHERE is_late = 1)                   AS net_sales_in_late_orders,
    ROUND(SUM(net_sales) FILTER (WHERE is_late = 1)
          / NULLIF(SUM(net_sales) FILTER (WHERE is_cancelled = 0), 0), 4) AS share_of_shipped_sales_late
FROM mart.vw_orders_enriched;

-- ---------------------------------------------------------------------
-- Q2. Hypothesis screen: which dimension actually explains lateness?
-- Late rate for every member of six candidate drivers. The spread
-- (max - min late rate within a dimension) shows which driver matters.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.vw_late_rate_by_dimension AS
WITH shipped AS (
    SELECT * FROM mart.vw_orders_enriched WHERE is_cancelled = 0
),
by_member AS (
    SELECT 'Shipping mode' AS dimension, shipping_mode AS member,
           COUNT(*) AS shipped_orders, SUM(is_late) AS late_orders
    FROM shipped GROUP BY shipping_mode
    UNION ALL
    SELECT 'Market', market, COUNT(*), SUM(is_late)
    FROM shipped GROUP BY market
    UNION ALL
    SELECT 'Region', region, COUNT(*), SUM(is_late)
    FROM shipped GROUP BY region
    UNION ALL
    SELECT 'Customer segment', customer_segment, COUNT(*), SUM(is_late)
    FROM shipped GROUP BY customer_segment
    UNION ALL
    SELECT 'Payment type', payment_type, COUNT(*), SUM(is_late)
    FROM shipped GROUP BY payment_type
    UNION ALL
    SELECT 'Order year', EXTRACT(YEAR FROM order_date)::TEXT, COUNT(*), SUM(is_late)
    FROM shipped GROUP BY EXTRACT(YEAR FROM order_date)
),
rated AS (
    SELECT *, ROUND(late_orders::NUMERIC / shipped_orders, 4) AS late_rate
    FROM by_member
)
SELECT
    dimension,
    member,
    shipped_orders,
    late_orders,
    late_rate,
    RANK() OVER (PARTITION BY dimension ORDER BY late_rate DESC)            AS rank_in_dimension,
    MAX(late_rate) OVER (PARTITION BY dimension)
      - MIN(late_rate) OVER (PARTITION BY dimension)                        AS dimension_spread
FROM rated;

-- ---------------------------------------------------------------------
-- Q3. Promise vs reality by shipping mode
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.vw_mode_promise_gap AS
SELECT
    shipping_mode,
    promised_days,
    COUNT(*)                                                         AS shipped_orders,
    ROUND(COUNT(*)::NUMERIC / SUM(COUNT(*)) OVER (), 4)              AS share_of_orders,
    ROUND(AVG(actual_days), 2)                                       AS avg_actual_days,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY actual_days)         AS median_actual_days,
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY actual_days)         AS p90_actual_days,
    MIN(actual_days)                                                 AS min_actual_days,
    MAX(actual_days)                                                 AS max_actual_days,
    ROUND(AVG(is_late), 4)                                           AS late_rate,
    SUM(is_late)                                                     AS late_orders,
    ROUND(SUM(is_late)::NUMERIC / SUM(SUM(is_late)) OVER (), 4)      AS share_of_all_late_orders,
    ROUND(AVG(delay_days) FILTER (WHERE is_late = 1), 2)             AS avg_delay_days_when_late
FROM mart.vw_orders_enriched
WHERE is_cancelled = 0
GROUP BY shipping_mode, promised_days;

-- ---------------------------------------------------------------------
-- Q4a. Lead-time distribution (cumulative share = on-time rate if the
-- promise were set at that many days)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.vw_lead_time_distribution AS
WITH counts AS (
    SELECT shipping_mode, promised_days, actual_days, COUNT(*) AS orders
    FROM mart.vw_orders_enriched
    WHERE is_cancelled = 0
    GROUP BY shipping_mode, promised_days, actual_days
)
SELECT
    shipping_mode,
    promised_days,
    actual_days,
    orders,
    ROUND(orders::NUMERIC / SUM(orders) OVER (PARTITION BY shipping_mode), 4) AS share_of_mode,
    ROUND(SUM(orders) OVER (PARTITION BY shipping_mode ORDER BY actual_days)::NUMERIC
          / SUM(orders) OVER (PARTITION BY shipping_mode), 4)                 AS cumulative_share
FROM counts;

-- ---------------------------------------------------------------------
-- Q4b. Promise-setting scenarios: on-time rate for each candidate promise
-- (0-7 days) per mode, holding today's actual lead times fixed.
-- Imported into Power BI for the what-if page.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.vw_promise_scenarios AS
WITH modes AS (
    SELECT DISTINCT shipping_mode, promised_days FROM mart.vw_lead_time_distribution
),
grid AS (
    SELECT m.shipping_mode, m.promised_days AS current_promise_days, p.candidate_promise_days
    FROM modes m
    CROSS JOIN GENERATE_SERIES(0, 7) AS p(candidate_promise_days)
)
SELECT
    g.shipping_mode,
    g.current_promise_days,
    g.candidate_promise_days,
    g.candidate_promise_days - g.current_promise_days                 AS days_added,
    COALESCE(MAX(l.cumulative_share), 0)                              AS projected_on_time_rate,
    (g.candidate_promise_days = g.current_promise_days)               AS is_current_promise
FROM grid g
LEFT JOIN mart.vw_lead_time_distribution l
       ON l.shipping_mode = g.shipping_mode
      AND l.actual_days  <= g.candidate_promise_days
GROUP BY g.shipping_mode, g.current_promise_days, g.candidate_promise_days;

-- ---------------------------------------------------------------------
-- Q5. Monthly trend: volume, late rate, month-over-month change and a
-- 3-month rolling late rate (weighted by orders)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.vw_monthly_trend AS
WITH monthly AS (
    SELECT
        order_month,
        COUNT(*)                                 AS orders,
        COUNT(*) FILTER (WHERE is_cancelled = 0) AS shipped_orders,
        SUM(is_late)                             AS late_orders,
        SUM(net_sales)                           AS net_sales
    FROM mart.vw_orders_enriched
    GROUP BY order_month
)
SELECT
    order_month,
    orders,
    net_sales,
    ROUND(late_orders::NUMERIC / shipped_orders, 4)                       AS late_rate,
    ROUND(orders::NUMERIC / LAG(orders) OVER (ORDER BY order_month) - 1, 4) AS mom_order_growth,
    ROUND(SUM(late_orders)    OVER w3::NUMERIC
          / SUM(shipped_orders) OVER w3, 4)                                AS late_rate_rolling_3m
FROM monthly
WINDOW w3 AS (ORDER BY order_month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW);

-- ---------------------------------------------------------------------
-- Q6. Customer impact: do customers whose FIRST order arrived late come
-- back less? Only first orders placed >= 180 days before the data ends
-- are used, so every customer has a full 180-day window to reorder.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.vw_repeat_after_first_order AS
WITH sequenced AS (
    SELECT
        customer_id,
        order_ts,
        is_cancelled,
        is_late,
        ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY order_ts, order_id) AS order_seq,
        LEAD(order_ts) OVER (PARTITION BY customer_id ORDER BY order_ts, order_id) AS next_order_ts
    FROM dw.fact_orders
),
first_orders AS (
    SELECT *
    FROM sequenced
    WHERE order_seq = 1
      AND is_cancelled = 0
      AND order_ts <= (SELECT MAX(order_ts) FROM dw.fact_orders) - INTERVAL '180 days'
)
SELECT
    CASE WHEN is_late = 1 THEN 'First order late' ELSE 'First order on time/early' END AS first_order_outcome,
    COUNT(*)                                                               AS customers,
    COUNT(*) FILTER (WHERE next_order_ts <= order_ts + INTERVAL '180 days') AS reordered_within_180d,
    ROUND(COUNT(*) FILTER (WHERE next_order_ts <= order_ts + INTERVAL '180 days')::NUMERIC
          / COUNT(*), 4)                                                   AS repeat_rate_180d,
    ROUND(AVG(EXTRACT(EPOCH FROM next_order_ts - order_ts) / 86400)
          FILTER (WHERE next_order_ts <= order_ts + INTERVAL '180 days'), 1) AS avg_days_to_reorder
FROM first_orders
GROUP BY 1;

-- ---------------------------------------------------------------------
-- Q7. Revenue leakage: cancelled and suspected-fraud orders by market
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.vw_revenue_leakage_by_market AS
SELECT
    market,
    COUNT(*)                                                         AS orders,
    COUNT(*) FILTER (WHERE is_suspected_fraud = 1)                   AS suspected_fraud_orders,
    COUNT(*) FILTER (WHERE is_cancelled = 1 AND is_suspected_fraud = 0) AS cancelled_orders,
    SUM(net_sales) FILTER (WHERE is_cancelled = 1)                   AS leaked_net_sales,
    ROUND(SUM(net_sales) FILTER (WHERE is_cancelled = 1)
          / SUM(net_sales), 4)                                       AS leakage_share_of_sales,
    RANK() OVER (ORDER BY SUM(net_sales) FILTER (WHERE is_cancelled = 1) DESC) AS leakage_rank
FROM mart.vw_orders_enriched
GROUP BY market;

-- ---------------------------------------------------------------------
-- Q8. Category exposure: where does late delivery touch the most sales?
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW mart.vw_category_late_exposure AS
WITH lines AS (
    SELECT p.category_name, p.department_name, l.order_id, l.net_sales, o.is_late
    FROM dw.fact_order_lines l
    JOIN dw.fact_orders o ON o.order_id   = l.order_id
    JOIN dw.dim_product p ON p.product_id = l.product_id
    WHERE o.is_cancelled = 0
)
SELECT
    category_name,
    department_name,
    COUNT(DISTINCT order_id)                                 AS shipped_orders,
    ROUND(COUNT(DISTINCT order_id) FILTER (WHERE is_late = 1)::NUMERIC
          / COUNT(DISTINCT order_id), 4)                     AS late_rate,
    SUM(net_sales)                                           AS net_sales,
    SUM(net_sales) FILTER (WHERE is_late = 1)                AS late_net_sales,
    ROUND(SUM(net_sales) FILTER (WHERE is_late = 1)
          / SUM(SUM(net_sales) FILTER (WHERE is_late = 1)) OVER (), 4) AS share_of_late_sales,
    RANK() OVER (ORDER BY SUM(net_sales) FILTER (WHERE is_late = 1) DESC) AS late_sales_rank
FROM lines
GROUP BY category_name, department_name;
