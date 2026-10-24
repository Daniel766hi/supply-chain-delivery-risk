# Windows setup: database and SQL pipeline

Time needed: about 30–45 minutes the first time. Everything is free.

## 1. Install the tools

| Tool | Where | Notes |
|---|---|---|
| PostgreSQL 16 | https://www.postgresql.org/download/windows/ → "Download the installer" (EDB) | Keep the default components: **PostgreSQL Server, pgAdmin 4, Command Line Tools**. Stack Builder is not needed. |
| Git for Windows | https://git-scm.com/download/win | Default options are fine. |
| Power BI Desktop | Microsoft Store → "Power BI Desktop" | The Store version updates itself and includes the PostgreSQL driver. |

During the PostgreSQL install:
- Set a password for the `postgres` user and **write it down**. You will type it every time you run a script.
- Keep port **5432** and the default locale.

## 2. Make `psql` available in PowerShell

Open **PowerShell** and check:

```powershell
psql --version
```

If you get "psql is not recognized", add PostgreSQL to your PATH permanently:

1. Press Start, type **environment variables**, open *Edit the system environment variables*.
2. Click *Environment Variables…* → under *User variables* select **Path** → *Edit* → *New*.
3. Paste `C:\Program Files\PostgreSQL\16\bin` → OK → OK.
4. Close and reopen PowerShell. `psql --version` should now print `psql (PostgreSQL) 16.x`.

## 3. Get the project and the data

```powershell
cd $HOME\Documents
git clone https://github.com/Daniel766hi/supply-chain-delivery-risk.git
cd supply-chain-delivery-risk
```

Download the dataset (free Kaggle account needed):

1. Go to https://www.kaggle.com/datasets/shashwatwork/dataco-smart-supply-chain-for-big-data-analysis
2. Click **Download** and unzip the archive.
3. Copy **`DataCoSupplyChainDataset.csv`** (about 96 MB) into the project's `data\` folder.
   You don't need the other two files.

The CSV is git-ignored, so it won't be pushed to GitHub.

## 4. Run the pipeline

Run every command **from the project root** (the folder that contains `sql\`). The load script uses a relative path to `data\`.

Optional: set the password once for this PowerShell window so you don't have to type it six times:

```powershell
$env:PGPASSWORD = "your-postgres-password"
```

Then run the scripts in order:

```powershell
psql -U postgres -v ON_ERROR_STOP=1 -f sql/00_setup_database.sql
psql -U postgres -d dataco -v ON_ERROR_STOP=1 -f sql/01_load_raw.sql
psql -U postgres -d dataco -f sql/02_profile_raw.sql        -o results/02_profile_output.txt
psql -U postgres -d dataco -v ON_ERROR_STOP=1 -f sql/03_build_warehouse.sql
psql -U postgres -d dataco -f sql/04_validate_warehouse.sql -o results/04_validation_output.txt
psql -U postgres -d dataco -v ON_ERROR_STOP=1 -f sql/05_kpi_views.sql
psql -U postgres -d dataco -f sql/06_business_analysis.sql  -o results/06_analysis_output.txt
```

Or run everything at once:

```powershell
powershell -ExecutionPolicy Bypass -File .\run_all.ps1
```

### What to expect

| Step | Expected result |
|---|---|
| 01 | `COPY 180519` and `raw_rows_loaded = 180519` |
| 03 | Row counts: fact_order_lines 180,519 · fact_orders 65,752 · dim_customer 20,652 · dim_product 118 · dim_shipping_mode 4 |
| 04 | **All 12 checks show PASS** in `results/04_validation_output.txt`. If any shows FAIL, stop and fix it before building the dashboard. |
| 06 | `results/06_analysis_output.txt` holds sections Q1–Q8. This file is the evidence for the README and your CV. |

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `psql: error: connection ... failed: FATAL: password authentication failed` | Wrong password. Re-type it, or reset `$env:PGPASSWORD`. |
| `could not open file "data/DataCoSupplyChainDataset.csv"` | You are not in the project root, or the CSV is not in `data\`. Run `ls data` to check. |
| `invalid byte sequence for encoding "UTF8"` | You edited the `\copy` line and removed `ENCODING 'LATIN1'`. Put it back. |
| `WARNING: Console code page (437) differs from Windows code page (1252)` | Harmless. Run `chcp 1252` first to silence it. |
| Accented city names look odd in the console | Display issue only. The data in the database is correct; check in pgAdmin. |

## 6. Optional: look around in pgAdmin

Open pgAdmin 4 → Servers → PostgreSQL 16 → Databases → **dataco** → Schemas. You will see `raw`, `stg`, `dw` (tables) and `mart` (views). Right-click a view → *View/Edit Data* → *First 100 Rows*.
