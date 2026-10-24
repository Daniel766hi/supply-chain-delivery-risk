-- =====================================================================
-- 07_simulation_inputs.sql
-- Exports the calibration inputs for the fulfilment digital twin
-- (simulation/) as small CSV files.
--
--   psql -U postgres -d dataco -v ON_ERROR_STOP=1 -f sql/07_simulation_inputs.sql
--
-- Calibration window: Oct-2016 to Sep-2017, the latest 12 stable months.
-- The months after it show a volume step-up with a halved average order
-- value (06_business_analysis, Q5b), so they are left out of calibration.
-- Only shipped orders are used (cancelled orders never enter fulfilment).
-- =====================================================================

-- Shipped orders per calendar day (days with no orders count as 0)
CREATE OR REPLACE VIEW mart.vw_sim_daily_demand AS
SELECT d.date,
       COUNT(f.order_id) FILTER (WHERE f.is_cancelled = 0) AS shipped_orders
FROM dw.dim_date d
LEFT JOIN dw.fact_orders f ON f.order_date_key = d.date_key
WHERE d.date BETWEEN DATE '2016-10-01' AND DATE '2017-09-30'
GROUP BY d.date;

-- Lead-time distribution per shipping mode (also gives the mode mix)
CREATE OR REPLACE VIEW mart.vw_sim_lead_time AS
SELECT m.shipping_mode,
       m.promised_days,
       f.actual_days,
       COUNT(*) AS orders
FROM dw.fact_orders f
JOIN dw.dim_shipping_mode m USING (shipping_mode_id)
WHERE f.is_cancelled = 0
  AND f.order_ts >= TIMESTAMP '2016-10-01'
  AND f.order_ts <  TIMESTAMP '2017-10-01'
GROUP BY m.shipping_mode, m.promised_days, f.actual_days;

-- Units per shipped order (sizes the inventory the DC must hold)
CREATE OR REPLACE VIEW mart.vw_sim_units_per_order AS
SELECT units, COUNT(*) AS orders
FROM dw.fact_orders
WHERE is_cancelled = 0
  AND order_ts >= TIMESTAMP '2016-10-01'
  AND order_ts <  TIMESTAMP '2017-10-01'
GROUP BY units;

\copy (SELECT * FROM mart.vw_sim_units_per_order ORDER BY units) TO 'simulation/inputs/units_per_order.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT * FROM mart.vw_sim_daily_demand ORDER BY date) TO 'simulation/inputs/daily_demand.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT * FROM mart.vw_sim_lead_time ORDER BY promised_days, actual_days) TO 'simulation/inputs/lead_time_distribution.csv' WITH (FORMAT csv, HEADER true)

SELECT COUNT(*) AS calibration_days, SUM(shipped_orders) AS calibration_orders
FROM mart.vw_sim_daily_demand;
