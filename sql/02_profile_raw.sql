-- =====================================================================
-- 02_profile_raw.sql
-- Read-only profiling of the raw data. Each query backs a cleaning or
-- modelling decision made in 03_build_warehouse.sql.
--
--   psql -U postgres -d dataco -f sql/02_profile_raw.sql -o results/02_profile_output.txt
-- =====================================================================

\qecho '--- P1. Volume and grain: one row per order line? ---'
SELECT COUNT(*)                          AS rows_total,
       COUNT(DISTINCT order_item_id)     AS distinct_order_items,
       COUNT(DISTINCT order_id)          AS distinct_orders,
       COUNT(DISTINCT order_customer_id) AS distinct_customers,
       COUNT(DISTINCT product_card_id)   AS distinct_products
FROM raw.dataco_order_items;

\qecho '--- P2. Empty values per column (only columns that have any) ---'
SELECT column_name, empty_values
FROM (
    SELECT 'customer_lname'      AS column_name, COUNT(*) FILTER (WHERE NULLIF(TRIM(customer_lname), '') IS NULL)      AS empty_values FROM raw.dataco_order_items
    UNION ALL
    SELECT 'customer_zipcode',    COUNT(*) FILTER (WHERE NULLIF(TRIM(customer_zipcode), '') IS NULL)    FROM raw.dataco_order_items
    UNION ALL
    SELECT 'order_zipcode',       COUNT(*) FILTER (WHERE NULLIF(TRIM(order_zipcode), '') IS NULL)       FROM raw.dataco_order_items
    UNION ALL
    SELECT 'product_description', COUNT(*) FILTER (WHERE NULLIF(TRIM(product_description), '') IS NULL) FROM raw.dataco_order_items
) t
WHERE empty_values > 0;
-- Decision: drop order_zipcode and product_description (mostly/fully empty).

\qecho '--- P3. Redundant columns: pairs that always hold the same value ---'
SELECT
    COUNT(*) FILTER (WHERE benefit_per_order  <> order_profit_per_order)   AS profit_cols_differ,
    COUNT(*) FILTER (WHERE sales_per_customer <> order_item_total)         AS net_sales_cols_differ,
    COUNT(*) FILTER (WHERE customer_id        <> order_customer_id)        AS customer_cols_differ,
    COUNT(*) FILTER (WHERE product_card_id    <> order_item_cardprod_id)   AS product_cols_differ,
    COUNT(*) FILTER (WHERE category_id        <> product_category_id)      AS category_cols_differ,
    COUNT(*) FILTER (WHERE product_price      <> order_item_product_price) AS price_cols_differ
FROM raw.dataco_order_items;
-- Decision: keep one column from each pair.

\qecho '--- P4. Shipping attributes: constant within an order? ---'
SELECT MAX(n_modes) AS max_modes_per_order,
       MAX(n_real)  AS max_actual_days_per_order,
       MAX(n_sched) AS max_scheduled_days_per_order,
       MAX(n_dstat) AS max_delivery_status_per_order,
       MAX(n_mkt)   AS max_markets_per_order
FROM (
    SELECT order_id,
           COUNT(DISTINCT shipping_mode)               AS n_modes,
           COUNT(DISTINCT days_for_shipping_real)      AS n_real,
           COUNT(DISTINCT days_for_shipment_scheduled) AS n_sched,
           COUNT(DISTINCT delivery_status)             AS n_dstat,
           COUNT(DISTINCT market)                      AS n_mkt
    FROM raw.dataco_order_items
    GROUP BY order_id
) per_order;
-- Decision: all 1 -> delivery is an order-level event. Delivery KPIs are
-- measured per order (fact_orders), sales and profit per line (fact_order_lines).

\qecho '--- P5. Promised (scheduled) days by shipping mode ---'
SELECT shipping_mode,
       days_for_shipment_scheduled AS scheduled_days,
       COUNT(*)                    AS order_lines
FROM raw.dataco_order_items
GROUP BY shipping_mode, days_for_shipment_scheduled
ORDER BY days_for_shipment_scheduled::INT;
-- Decision: each mode has exactly one promise -> store it on dim_shipping_mode.

\qecho '--- P6. Does the source late flag equal actual > scheduled? ---'
SELECT delivery_status,
       COUNT(*) AS order_lines,
       COUNT(*) FILTER (
           WHERE late_delivery_risk::INT
              <> (days_for_shipping_real::INT > days_for_shipment_scheduled::INT)::INT
       ) AS flag_mismatches
FROM raw.dataco_order_items
GROUP BY delivery_status
ORDER BY delivery_status;
-- Decision: mismatches only occur on cancelled shipments, which never shipped.
-- Recompute is_late ourselves and leave it NULL for cancelled orders.

\qecho '--- P7. Order status vs delivery status ---'
SELECT order_status, delivery_status, COUNT(DISTINCT order_id) AS orders
FROM raw.dataco_order_items
GROUP BY order_status, delivery_status
ORDER BY order_status, delivery_status;
-- Decision: "Shipping canceled" = CANCELED + SUSPECTED_FRAUD orders. These are
-- excluded from delivery KPIs and analysed separately as revenue leakage.

\qecho '--- P8. Date coverage ---'
SELECT MIN(TO_TIMESTAMP(order_date, 'MM/DD/YYYY HH24:MI')::TIMESTAMP) AS first_order,
       MAX(TO_TIMESTAMP(order_date, 'MM/DD/YYYY HH24:MI')::TIMESTAMP) AS last_order
FROM raw.dataco_order_items;

\qecho '--- P9. Shipping-date minus order-date vs the actual-days column ---'
SELECT shipping_mode,
       (TO_TIMESTAMP(shipping_date, 'MM/DD/YYYY HH24:MI')::DATE
        - TO_TIMESTAMP(order_date, 'MM/DD/YYYY HH24:MI')::DATE)
       - days_for_shipping_real::INT AS gap_days,
       COUNT(*) AS order_lines
FROM raw.dataco_order_items
GROUP BY 1, 2
ORDER BY 1, 2;
-- Result: gap is 0 everywhere at date level, so "shipping date" is in effect the
-- date the order reached the customer. Lead time = the days columns, which also
-- match the source's own delivery status.

\qecho '--- P10. Text needing trimming (trailing spaces) ---'
SELECT COUNT(*) FILTER (WHERE product_name  <> TRIM(product_name))  AS product_name_untrimmed,
       COUNT(*) FILTER (WHERE category_name <> TRIM(category_name)) AS category_name_untrimmed
FROM raw.dataco_order_items;
