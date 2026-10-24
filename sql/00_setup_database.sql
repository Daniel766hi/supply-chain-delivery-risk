-- =====================================================================
-- 00_setup_database.sql
-- Creates the project database and its schemas.
--
-- Run from the repository root, connected to the default database:
--   psql -U postgres -v ON_ERROR_STOP=1 -f sql/00_setup_database.sql
--
-- WARNING: drops and recreates the "dataco" database, so re-running this
-- script resets the whole project. It touches nothing else on the server.
-- =====================================================================

DROP DATABASE IF EXISTS dataco;
CREATE DATABASE dataco;

\connect dataco

-- raw  : the CSV exactly as delivered, every column as text
-- stg  : typed and cleaned copy, one row per order line
-- dw   : star schema used by Power BI (dimensions + facts)
-- mart : KPI views that answer the business questions
CREATE SCHEMA raw;
CREATE SCHEMA stg;
CREATE SCHEMA dw;
CREATE SCHEMA mart;
