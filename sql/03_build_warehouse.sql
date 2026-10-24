-- =====================================================================
-- 03_build_warehouse.sql
-- Cleans the raw data and builds the star schema used by Power BI.
--
--   psql -U postgres -d dataco -v ON_ERROR_STOP=1 -f sql/03_build_warehouse.sql
--
-- Re-runnable: drops and rebuilds stg, dw and mart (mart views depend on dw).
--
--   dim_date ──────────┐
--   dim_customer ──────┤
--   dim_geography ─────┼──< fact_orders >──< fact_order_lines >── dim_product
--   dim_shipping_mode ─┘
-- =====================================================================

DROP SCHEMA IF EXISTS mart CASCADE;
DROP SCHEMA IF EXISTS dw   CASCADE;
DROP SCHEMA IF EXISTS stg  CASCADE;
CREATE SCHEMA stg;
CREATE SCHEMA dw;
CREATE SCHEMA mart;

-- ---------------------------------------------------------------------
-- 1. Staging: typed, trimmed, redundant and personal columns removed
-- ---------------------------------------------------------------------
-- Dropped: customer email/password/names/street (personal data, not needed),
-- latitude/longitude, product image/description, order_zipcode (86% empty),
-- product_status (always 0) and the duplicate columns found in 02 (P3).
CREATE TABLE stg.order_items AS
WITH typed AS (
    SELECT
        order_item_id::INT                                         AS order_item_id,
        order_id::INT                                              AS order_id,
        order_customer_id::INT                                     AS customer_id,
        product_card_id::INT                                       AS product_id,
        TO_TIMESTAMP(order_date,    'MM/DD/YYYY HH24:MI')::TIMESTAMP AS order_ts,
        TO_TIMESTAMP(shipping_date, 'MM/DD/YYYY HH24:MI')::TIMESTAMP AS shipping_ts,
        TRIM(type)                                                 AS payment_type,
        TRIM(order_status)                                         AS order_status,
        TRIM(delivery_status)                                      AS delivery_status,
        TRIM(shipping_mode)                                        AS shipping_mode,
        days_for_shipment_scheduled::INT                           AS scheduled_days,
        days_for_shipping_real::INT                                AS actual_days,
        late_delivery_risk::INT                                    AS source_late_flag,
        TRIM(market)                                               AS market,
        TRIM(order_region)                                         AS order_region,
        TRIM(order_country)                                        AS order_country,
        TRIM(order_state)                                          AS order_state,
        TRIM(order_city)                                           AS order_city,
        TRIM(customer_segment)                                     AS customer_segment,
        TRIM(customer_country)                                     AS customer_country,
        TRIM(customer_state)                                       AS customer_state,
        TRIM(customer_city)                                        AS customer_city,
        TRIM(product_name)                                         AS product_name,
        category_id::INT                                           AS category_id,
        TRIM(category_name)                                        AS category_name,
        department_id::INT                                         AS department_id,
        TRIM(department_name)                                      AS department_name,
        product_price::NUMERIC(10,2)                               AS list_price,
        order_item_quantity::INT                                   AS quantity,
        sales::NUMERIC(12,2)                                       AS gross_sales,
        order_item_discount::NUMERIC(12,2)                         AS discount,
        order_item_discount_rate::NUMERIC(6,4)                     AS discount_rate,
        order_item_total::NUMERIC(12,2)                            AS net_sales,
        order_profit_per_order::NUMERIC(12,2)                      AS profit,
        -- de-duplication guard: keep one row per order line
        ROW_NUMBER() OVER (PARTITION BY order_item_id ORDER BY order_id) AS rn
    FROM raw.dataco_order_items
)
SELECT *
FROM typed
WHERE rn = 1;

ALTER TABLE stg.order_items DROP COLUMN rn;
ALTER TABLE stg.order_items ADD PRIMARY KEY (order_item_id);

-- ---------------------------------------------------------------------
-- 2. Dimensions
-- ---------------------------------------------------------------------
CREATE TABLE dw.dim_date AS
SELECT
    TO_CHAR(d, 'YYYYMMDD')::INT          AS date_key,
    d::DATE                              AS date,
    EXTRACT(YEAR    FROM d)::INT         AS year,
    EXTRACT(QUARTER FROM d)::INT         AS quarter,
    'Q' || EXTRACT(QUARTER FROM d)       AS quarter_label,
    EXTRACT(MONTH   FROM d)::INT         AS month_number,
    TO_CHAR(d, 'Mon')                    AS month_name,
    TO_CHAR(d, 'YYYY-MM')                AS year_month,
    DATE_TRUNC('month', d)::DATE         AS month_start,
    EXTRACT(ISODOW  FROM d)::INT         AS day_of_week,     -- 1 = Monday
    TO_CHAR(d, 'Dy')                     AS day_name,
    (EXTRACT(ISODOW FROM d) >= 6)        AS is_weekend
FROM GENERATE_SERIES(
        (SELECT MIN(order_ts)::DATE FROM stg.order_items),
        (SELECT MAX(order_ts)::DATE FROM stg.order_items),
        INTERVAL '1 day'
     ) AS d;
ALTER TABLE dw.dim_date ADD PRIMARY KEY (date_key);

-- One promise per mode (verified in 02, P5); ids follow promise length.
CREATE TABLE dw.dim_shipping_mode AS
SELECT
    ROW_NUMBER() OVER (ORDER BY MIN(scheduled_days))::INT AS shipping_mode_id,
    shipping_mode,
    MIN(scheduled_days)                                   AS promised_days
FROM stg.order_items
GROUP BY shipping_mode;
ALTER TABLE dw.dim_shipping_mode ADD PRIMARY KEY (shipping_mode_id);

-- Destination of the order (where it is delivered)
CREATE TABLE dw.dim_geography AS
SELECT
    ROW_NUMBER() OVER (ORDER BY market, order_region, order_country, order_state, order_city)::INT AS geo_id,
    market,
    order_region  AS region,
    order_country AS country,
    order_state   AS state,
    order_city    AS city
FROM (
    SELECT DISTINCT market, order_region, order_country, order_state, order_city
    FROM stg.order_items
) g;
ALTER TABLE dw.dim_geography ADD PRIMARY KEY (geo_id);

-- Customer attributes as of their most recent order
CREATE TABLE dw.dim_customer AS
SELECT DISTINCT ON (customer_id)
    customer_id,
    customer_segment AS segment,
    customer_country,
    customer_state,
    customer_city
FROM stg.order_items
ORDER BY customer_id, order_ts DESC;
ALTER TABLE dw.dim_customer ADD PRIMARY KEY (customer_id);

CREATE TABLE dw.dim_product AS
SELECT DISTINCT ON (product_id)
    product_id,
    product_name,
    category_id,
    category_name,
    department_id,
    department_name,
    list_price
FROM stg.order_items
ORDER BY product_id, order_ts DESC;
ALTER TABLE dw.dim_product ADD PRIMARY KEY (product_id);

-- ---------------------------------------------------------------------
-- 3. Facts
-- ---------------------------------------------------------------------
-- fact_orders: one row per order. Delivery happens per order (02, P4), so all
-- delivery KPIs use this table. The PRIMARY KEY fails the build if any
-- order-level attribute ever varies within an order.
CREATE TABLE dw.fact_orders AS
SELECT
    s.order_id,
    TO_CHAR(s.order_ts, 'YYYYMMDD')::INT                  AS order_date_key,
    s.order_ts,
    s.customer_id,
    g.geo_id,
    m.shipping_mode_id,
    s.payment_type,
    s.order_status,
    s.delivery_status,
    s.scheduled_days,
    s.actual_days,
    -- delivery outcome, only defined for orders that actually shipped
    CASE WHEN s.delivery_status = 'Shipping canceled' THEN NULL
         ELSE s.actual_days - s.scheduled_days END        AS delay_days,
    CASE WHEN s.delivery_status = 'Shipping canceled' THEN NULL
         WHEN s.actual_days > s.scheduled_days THEN 1 ELSE 0 END AS is_late,
    (s.delivery_status = 'Shipping canceled')::INT        AS is_cancelled,
    (s.order_status    = 'SUSPECTED_FRAUD')::INT          AS is_suspected_fraud,
    s.source_late_flag,
    COUNT(*)                                              AS line_count,
    SUM(s.quantity)                                       AS units,
    SUM(s.gross_sales)                                    AS gross_sales,
    SUM(s.discount)                                       AS discount,
    SUM(s.net_sales)                                      AS net_sales,
    SUM(s.profit)                                         AS profit
FROM stg.order_items s
JOIN dw.dim_shipping_mode m
  ON m.shipping_mode = s.shipping_mode
JOIN dw.dim_geography g
  ON  g.market  = s.market
  AND g.region  = s.order_region
  AND g.country = s.order_country
  AND g.state   = s.order_state
  AND g.city    = s.order_city
GROUP BY
    s.order_id, s.order_ts, s.customer_id, g.geo_id, m.shipping_mode_id,
    s.payment_type, s.order_status, s.delivery_status,
    s.scheduled_days, s.actual_days, s.source_late_flag;

ALTER TABLE dw.fact_orders ADD PRIMARY KEY (order_id);
ALTER TABLE dw.fact_orders ADD FOREIGN KEY (order_date_key)   REFERENCES dw.dim_date (date_key);
ALTER TABLE dw.fact_orders ADD FOREIGN KEY (customer_id)      REFERENCES dw.dim_customer (customer_id);
ALTER TABLE dw.fact_orders ADD FOREIGN KEY (geo_id)           REFERENCES dw.dim_geography (geo_id);
ALTER TABLE dw.fact_orders ADD FOREIGN KEY (shipping_mode_id) REFERENCES dw.dim_shipping_mode (shipping_mode_id);

-- fact_order_lines: one row per order line, for product-level sales and profit
CREATE TABLE dw.fact_order_lines AS
SELECT
    order_item_id,
    order_id,
    product_id,
    quantity,
    list_price AS unit_price,
    gross_sales,
    discount,
    discount_rate,
    net_sales,
    profit
FROM stg.order_items;

ALTER TABLE dw.fact_order_lines ADD PRIMARY KEY (order_item_id);
ALTER TABLE dw.fact_order_lines ADD FOREIGN KEY (order_id)   REFERENCES dw.fact_orders (order_id);
ALTER TABLE dw.fact_order_lines ADD FOREIGN KEY (product_id) REFERENCES dw.dim_product (product_id);

CREATE INDEX ON dw.fact_orders (order_date_key);
CREATE INDEX ON dw.fact_orders (customer_id, order_ts);
CREATE INDEX ON dw.fact_order_lines (order_id);

\echo 'Warehouse built. Row counts:'
SELECT 'dim_date' AS table_name, COUNT(*) AS row_count FROM dw.dim_date
UNION ALL SELECT 'dim_shipping_mode', COUNT(*) FROM dw.dim_shipping_mode
UNION ALL SELECT 'dim_geography',     COUNT(*) FROM dw.dim_geography
UNION ALL SELECT 'dim_customer',      COUNT(*) FROM dw.dim_customer
UNION ALL SELECT 'dim_product',       COUNT(*) FROM dw.dim_product
UNION ALL SELECT 'fact_orders',       COUNT(*) FROM dw.fact_orders
UNION ALL SELECT 'fact_order_lines',  COUNT(*) FROM dw.fact_order_lines;
