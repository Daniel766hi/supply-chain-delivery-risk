-- =====================================================================
-- 01_load_raw.sql
-- Loads DataCoSupplyChainDataset.csv into raw.dataco_order_items.
--
-- Run from the repository root (the CSV path below is relative to it):
--   psql -U postgres -d dataco -v ON_ERROR_STOP=1 -f sql/01_load_raw.sql
--
-- Everything lands as TEXT on purpose: the raw layer never rejects a row,
-- and type conversion happens in one visible place (03_build_warehouse).
-- Column order must match the CSV header exactly.
-- =====================================================================

DROP TABLE IF EXISTS raw.dataco_order_items;

CREATE TABLE raw.dataco_order_items (
    type                         TEXT,
    days_for_shipping_real       TEXT,
    days_for_shipment_scheduled  TEXT,
    benefit_per_order            TEXT,
    sales_per_customer           TEXT,
    delivery_status              TEXT,
    late_delivery_risk           TEXT,
    category_id                  TEXT,
    category_name                TEXT,
    customer_city                TEXT,
    customer_country             TEXT,
    customer_email               TEXT,
    customer_fname               TEXT,
    customer_id                  TEXT,
    customer_lname               TEXT,
    customer_password            TEXT,
    customer_segment             TEXT,
    customer_state               TEXT,
    customer_street              TEXT,
    customer_zipcode             TEXT,
    department_id                TEXT,
    department_name              TEXT,
    latitude                     TEXT,
    longitude                    TEXT,
    market                       TEXT,
    order_city                   TEXT,
    order_country                TEXT,
    order_customer_id            TEXT,
    order_date                   TEXT,
    order_id                     TEXT,
    order_item_cardprod_id       TEXT,
    order_item_discount          TEXT,
    order_item_discount_rate     TEXT,
    order_item_id                TEXT,
    order_item_product_price     TEXT,
    order_item_profit_ratio      TEXT,
    order_item_quantity          TEXT,
    sales                        TEXT,
    order_item_total             TEXT,
    order_profit_per_order       TEXT,
    order_region                 TEXT,
    order_state                  TEXT,
    order_status                 TEXT,
    order_zipcode                TEXT,
    product_card_id              TEXT,
    product_category_id          TEXT,
    product_description          TEXT,
    product_image                TEXT,
    product_name                 TEXT,
    product_price                TEXT,
    product_status               TEXT,
    shipping_date                TEXT,
    shipping_mode                TEXT
);

-- The file is Latin-1 encoded (accented city and country names).
\copy raw.dataco_order_items FROM 'data/DataCoSupplyChainDataset.csv' WITH (FORMAT csv, HEADER true, ENCODING 'LATIN1')

SELECT COUNT(*) AS raw_rows_loaded FROM raw.dataco_order_items;  -- expected: 180519
