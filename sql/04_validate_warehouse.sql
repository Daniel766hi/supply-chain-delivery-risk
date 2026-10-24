-- =====================================================================
-- 04_validate_warehouse.sql
-- Automated checks that the warehouse reconciles to the raw file.
-- Every row should read PASS before you trust any KPI.
--
--   psql -U postgres -d dataco -f sql/04_validate_warehouse.sql -o results/04_validation_output.txt
-- =====================================================================

WITH checks AS (
    SELECT 1 AS check_no,
           'Every raw row reaches staging' AS check_name,
           (SELECT COUNT(*) FROM raw.dataco_order_items)::NUMERIC AS expected,
           (SELECT COUNT(*) FROM stg.order_items)::NUMERIC        AS actual
    UNION ALL
    SELECT 2, 'Every order line reaches fact_order_lines',
           (SELECT COUNT(*) FROM stg.order_items),
           (SELECT COUNT(*) FROM dw.fact_order_lines)
    UNION ALL
    SELECT 3, 'One fact_orders row per distinct order',
           (SELECT COUNT(DISTINCT order_id) FROM raw.dataco_order_items),
           (SELECT COUNT(*) FROM dw.fact_orders)
    UNION ALL
    SELECT 4, 'Net sales: raw total = order-line total',
           (SELECT ROUND(SUM(order_item_total::NUMERIC), 0) FROM raw.dataco_order_items),
           (SELECT ROUND(SUM(net_sales), 0) FROM dw.fact_order_lines)
    UNION ALL
    SELECT 5, 'Net sales: order-line total = order total',
           (SELECT SUM(net_sales) FROM dw.fact_order_lines),
           (SELECT SUM(net_sales) FROM dw.fact_orders)
    UNION ALL
    SELECT 6, 'Profit: order-line total = order total',
           (SELECT SUM(profit) FROM dw.fact_order_lines),
           (SELECT SUM(profit) FROM dw.fact_orders)
    UNION ALL
    SELECT 7, 'Recomputed is_late matches source flag (shipped orders)',
           0,
           (SELECT COUNT(*) FROM dw.fact_orders
            WHERE is_cancelled = 0 AND is_late <> source_late_flag)
    UNION ALL
    SELECT 8, 'Cancelled orders have no delivery outcome',
           0,
           (SELECT COUNT(*) FROM dw.fact_orders
            WHERE is_cancelled = 1 AND (is_late IS NOT NULL OR delay_days IS NOT NULL))
    UNION ALL
    SELECT 9, 'Orders scheduled with the promise of their mode',
           0,
           (SELECT COUNT(*) FROM dw.fact_orders f
            JOIN dw.dim_shipping_mode m USING (shipping_mode_id)
            WHERE f.scheduled_days <> m.promised_days)
    UNION ALL
    SELECT 10, 'No order without a date in dim_date',
           0,
           (SELECT COUNT(*) FROM dw.fact_orders f
            LEFT JOIN dw.dim_date d ON d.date_key = f.order_date_key
            WHERE d.date_key IS NULL)
    UNION ALL
    SELECT 11, 'No negative quantities or net sales',
           0,
           (SELECT COUNT(*) FROM dw.fact_order_lines WHERE quantity <= 0 OR net_sales < 0)
    UNION ALL
    SELECT 12, 'Net sales = gross sales - discount (within 1 cent)',
           0,
           (SELECT COUNT(*) FROM dw.fact_order_lines
            WHERE ABS(gross_sales - discount - net_sales) > 0.01)
)
SELECT check_no,
       check_name,
       expected,
       actual,
       CASE WHEN expected = actual THEN 'PASS' ELSE 'FAIL' END AS status
FROM checks
ORDER BY check_no;
