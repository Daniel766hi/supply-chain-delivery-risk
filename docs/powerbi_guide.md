# Power BI Desktop guide

Build the dashboard on top of the PostgreSQL warehouse. Finish `docs/windows_setup.md` first: all 12 validation checks must PASS.

Time needed: about 3–4 hours the first time. Save often (`Ctrl+S`) to `powerbi/supply_chain_delivery_risk.pbix`.

---

## Part 1. Connect and load

1. Open Power BI Desktop → **Get data** → **More…** → **Database** → **PostgreSQL database** → *Connect*.
2. Server: `localhost` · Database: `dataco` · Data connectivity mode: **Import** → OK.
3. Credentials: choose the **Database** tab (not Windows). User `postgres` plus your password → *Connect*.
   - If it says the connection is not encrypted, click **OK** to connect without encryption. That's fine for a database on your own laptop.
4. In the Navigator, tick these 10 objects:

   | Object | Rename to (Part 2) |
   |---|---|
   | `dw.fact_orders` | Orders |
   | `dw.fact_order_lines` | Order Lines |
   | `dw.dim_date` | Date |
   | `dw.dim_customer` | Customer |
   | `dw.dim_geography` | Geography |
   | `dw.dim_shipping_mode` | Shipping Mode |
   | `dw.dim_product` | Product |
   | `mart.vw_promise_scenarios` | Promise Scenarios |
   | `mart.vw_lead_time_distribution` | Lead Time Distribution |
   | `mart.vw_repeat_after_first_order` | Repeat Purchase |

5. Click **Transform Data** (not Load). This opens Power Query.

## Part 2. Power Query (light touch)

The heavy cleaning is already done in SQL. That's deliberate: one source of truth. In Power Query only:

1. **Rename each query** to the names in the table above (double-click the name in the left pane).
2. **Orders**: check the types. `order_ts` = Date/Time; `is_late`, `is_cancelled`, `is_suspected_fraud` = Whole Number; `net_sales`, `profit`, `gross_sales`, `discount` = Fixed decimal number.
3. **Order Lines**: `net_sales`, `profit`, `gross_sales`, `discount`, `unit_price` = Fixed decimal number.
4. **Date**: `date` = Date.
5. **Home → Close & Apply**.

> Interview point: "I kept transformations in SQL so the logic is versioned, testable and reusable outside Power BI. Power Query only handles types and names."

## Part 3. Data model

Go to **Model view** (third icon on the left).

### 3.1 Relationships

Power BI may auto-detect some. Delete any that don't match this table (right-click → Delete), then drag to create the rest:

| From (many side) | To (one side) | Cardinality | Cross-filter |
|---|---|---|---|
| Orders[order_date_key] | Date[date_key] | Many-to-one | Single |
| Orders[customer_id] | Customer[customer_id] | Many-to-one | Single |
| Orders[geo_id] | Geography[geo_id] | Many-to-one | Single |
| Orders[shipping_mode_id] | Shipping Mode[shipping_mode_id] | Many-to-one | Single |
| Order Lines[order_id] | Orders[order_id] | Many-to-one | Single |
| Order Lines[product_id] | Product[product_id] | Many-to-one | Single |
| Promise Scenarios[shipping_mode] | Shipping Mode[shipping_mode] | Many-to-one | Single |
| Lead Time Distribution[shipping_mode] | Shipping Mode[shipping_mode] | Many-to-one | Single |

Leave **Repeat Purchase** unconnected. It is a small summary table.

```
Date ───────────┐
Customer ───────┤
Geography ──────┼──< Orders >──< Order Lines >── Product
Shipping Mode ──┘
      │
      ├──< Promise Scenarios
      └──< Lead Time Distribution
```

Why Order Lines → Orders and not straight to the dimensions: delivery happens per order, so Orders is the hub. Filters on date, mode or market flow Orders → Order Lines automatically. The one case that needs the other direction (late rate by product category) is handled in DAX with `CROSSFILTER` (measure 21). That's safer than making the relationship bidirectional.

### 3.2 Model housekeeping

1. Select the **Date** table → *Table tools* → **Mark as date table** → column `date`.
2. **Date[month_name]** → *Column tools* → **Sort by column** → `month_number`.
3. **Shipping Mode[shipping_mode]** → Sort by column → `shipping_mode_id` (orders modes by promise: Same Day, First, Second, Standard).
4. Hide the key columns in report view (right-click → *Hide in report view*): every `*_id` and `*_key` column on the fact tables, plus `source_late_flag`.
5. Set default summarisation to **Don't summarize** for `scheduled_days`, `actual_days`, `delay_days`, `promised_days`, `candidate_promise_days`, `current_promise_days`.

### 3.3 Measures table

*Home* → **Enter data** → name the table `_Measures` → Load. Put every measure below in it (select the table → *New measure*). After adding the first measure, delete the dummy `Column1`.

## Part 4. DAX measures

Create them in this order, because later ones reference earlier ones. Set the format in *Measure tools* as indicated.

### Volume and sales

```dax
// 1  Format: Whole number, thousands separator
Total Orders = COUNTROWS ( Orders )

// 2
Shipped Orders = CALCULATE ( [Total Orders], Orders[is_cancelled] = 0 )

// 3  Format: Currency, 0 decimals
Net Sales = SUM ( Orders[net_sales] )

// 4
Profit = SUM ( Orders[profit] )

// 5  Format: Percentage, 1 decimal
Profit Margin = DIVIDE ( [Profit], [Net Sales] )
```

### Delivery performance

```dax
// 6
Late Orders = CALCULATE ( [Total Orders], Orders[is_late] = 1 )

// 7  Format: Percentage, 1 decimal
Late Rate = DIVIDE ( [Late Orders], [Shipped Orders] )

// 8  Format: Percentage, 1 decimal
On-Time Rate =
IF ( NOT ISBLANK ( [Late Rate] ), 1 - [Late Rate] )

// 9  Format: Decimal, 2 decimals
Avg Actual Lead Time (days) =
CALCULATE ( AVERAGE ( Orders[actual_days] ), Orders[is_cancelled] = 0 )

// 10
Avg Promised Lead Time (days) =
CALCULATE ( AVERAGE ( Orders[scheduled_days] ), Orders[is_cancelled] = 0 )

// 11  Positive = slower than promised
Promise Gap (days) = [Avg Actual Lead Time (days)] - [Avg Promised Lead Time (days)]

// 12  Format: Decimal, 2 decimals
Avg Delay When Late (days) =
CALCULATE ( AVERAGE ( Orders[delay_days] ), Orders[is_late] = 1 )

// 13  90th percentile of actual lead time
P90 Lead Time (days) =
PERCENTILEX.INC (
    FILTER ( Orders, Orders[is_cancelled] = 0 ),
    Orders[actual_days],
    0.9
)
```

### Commercial exposure

```dax
// 14  Format: Currency, 0 decimals
Net Sales in Late Orders = CALCULATE ( [Net Sales], Orders[is_late] = 1 )

// 15  Format: Percentage, 1 decimal
Late Sales Share =
DIVIDE ( [Net Sales in Late Orders], CALCULATE ( [Net Sales], Orders[is_cancelled] = 0 ) )

// 16  Cancelled + suspected-fraud orders
Leaked Net Sales = CALCULATE ( [Net Sales], Orders[is_cancelled] = 1 )

// 17  Format: Percentage, 1 decimal
Leakage Rate = DIVIDE ( [Leaked Net Sales], [Net Sales] )
```

### Time intelligence

```dax
// 18  Format: Percentage, 1 decimal
Late Rate 3M Rolling =
CALCULATE (
    [Late Rate],
    DATESINPERIOD ( 'Date'[date], MAX ( 'Date'[date] ), -3, MONTH )
)

// 19  Format: Percentage, 1 decimal
Orders MoM % =
VAR PrevMonth =
    CALCULATE ( [Total Orders], DATEADD ( 'Date'[date], -1, MONTH ) )
RETURN
    DIVIDE ( [Total Orders] - PrevMonth, PrevMonth )

// 20  Format: Decimal, 1 decimal (percentage points)
Late Rate YoY Change (pp) =
VAR PrevYear =
    CALCULATE ( [Late Rate], SAMEPERIODLASTYEAR ( 'Date'[date] ) )
RETURN
    IF ( NOT ISBLANK ( PrevYear ), ( [Late Rate] - PrevYear ) * 100 )
```

### Product-level

```dax
// 21  Late rate when sliced by Product (category, department).
// Product filters only reach Order Lines (single-direction relationship),
// so [Late Rate] on its own ignores product. CROSSFILTER lets the filter
// continue from Order Lines to Orders, for this measure only.
Late Rate (by Product) =
CALCULATE (
    [Late Rate],
    CROSSFILTER ( 'Order Lines'[order_id], Orders[order_id], BOTH )
)

// 22  Format: Currency, 0 decimals
Line Net Sales = SUM ( 'Order Lines'[net_sales] )

// 23  Orders filters flow to Order Lines naturally, so no CROSSFILTER needed
Late Line Net Sales = CALCULATE ( [Line Net Sales], Orders[is_late] = 1 )
```

### Promise scenario (what-if)

First create the parameter: *Modeling* → **New parameter** → *Numeric range*.
Name `Target On-Time Rate`, Data type Decimal number, Minimum `0.5`, Maximum `1`, Increment `0.05`, Default `0.9`, tick *Add slicer to this page*. Power BI creates the table and the measure `Target On-Time Rate Value`.

```dax
// 24  Shortest promise (days) that reaches the target, per mode
Promise Needed (days) =
VAR Target = [Target On-Time Rate Value]
RETURN
    CALCULATE (
        MIN ( 'Promise Scenarios'[candidate_promise_days] ),
        'Promise Scenarios'[projected_on_time_rate] >= Target
    )

// 25  Format: Percentage, 1 decimal
Projected On-Time Rate at Target =
VAR Days = [Promise Needed (days)]
RETURN
    CALCULATE (
        MAX ( 'Promise Scenarios'[projected_on_time_rate] ),
        'Promise Scenarios'[candidate_promise_days] = Days
    )

// 26  Current promise per mode
Current Promise (days) = MIN ( 'Shipping Mode'[promised_days] )

// 27  Format: Percentage, 1 decimal
//     Network on-time rate if every mode moves to its "Promise Needed",
//     weighted by each mode's shipped orders
Network On-Time Rate at Target =
VAR ByMode =
    ADDCOLUMNS (
        VALUES ( 'Shipping Mode'[shipping_mode] ),
        "@orders", [Shipped Orders],
        "@rate", [Projected On-Time Rate at Target]
    )
RETURN
    DIVIDE ( SUMX ( ByMode, [@orders] * [@rate] ), SUMX ( ByMode, [@orders] ) )

// 28  Format: Decimal, 2 decimals
Avg Days Added per Order at Target =
VAR ByMode =
    ADDCOLUMNS (
        VALUES ( 'Shipping Mode'[shipping_mode] ),
        "@orders", [Shipped Orders],
        "@added", [Promise Needed (days)] - [Current Promise (days)]
    )
RETURN
    DIVIDE ( SUMX ( ByMode, [@orders] * [@added] ), SUMX ( ByMode, [@orders] ) )
```

### Reconcile before you design

Put these on a blank page as cards and compare with `results/06_analysis_output.txt`:

| Measure | Must equal (06 output) |
|---|---|
| Total Orders | Q1 `total_orders` |
| Net Sales | Q1 `net_sales` |
| Late Rate | Q1 `late_rate` |
| Net Sales in Late Orders | Q1 `net_sales_in_late_orders` |
| Leakage Rate | Q7b `leakage_share_of_sales` |
| Network On-Time Rate at Target (slider at 0.75) | Q4c `Target 75%` row, `network_on_time_rate` |

If one doesn't match, fix it before building visuals. Being able to say "my dashboard reconciles to SQL" is worth a lot in an interview. Delete the page afterwards.

## Part 5. Report pages

General setup:
- *View* → **Themes** → pick a simple one (e.g. *Executive*), or keep the default.
- Canvas 16:9. Put a title text box at the top of every page saying what the page answers.
- Use the same three slicers on pages 1, 2 and 4: **Date[year]**, **Geography[market]**, **Customer[segment]**. To keep them in sync: *View* → **Sync slicers**.

### Page 1: "Executive overview": how big is the problem?

| Visual | Fields |
|---|---|
| 5 cards (top row) | Total Orders · Net Sales · Late Rate · Net Sales in Late Orders · Leakage Rate |
| Line and clustered column chart | X: Date[month_start] (hierarchy off) · Columns: Total Orders · Line: Late Rate 3M Rolling |
| Clustered bar chart | Y: Shipping Mode[shipping_mode] · X: Late Rate · Data labels on |
| Donut chart | Legend: Orders[delivery_status] · Values: Total Orders |

Title suggestion: *"More than half of shipped orders arrive later than promised"*. Edit it to match your Late Rate number.

### Page 2: "Root cause": what actually drives lateness?

The page shows the hypothesis test: four flat charts and one chart that isn't flat.

| Visual | Fields |
|---|---|
| 4 small clustered bar charts in a 2×2 grid | Late Rate by Geography[market] · by Customer[segment] · by Orders[payment_type] · by Date[year]. **Set every X-axis to the same range 0–100%** (*Format* → *X-axis* → Range min 0, max 1) so the flatness is visible |
| Clustered bar chart (large, right side) | Late Rate by Shipping Mode[shipping_mode], same 0–100% axis |
| Table | Shipping Mode[shipping_mode] · Current Promise (days) · Avg Actual Lead Time (days) · P90 Lead Time (days) · Promise Gap (days) · Late Rate · Shipped Orders |
| Clustered column chart | X: Lead Time Distribution[actual_days] · Y: Sum of Lead Time Distribution[share_of_mode] · Legend: Lead Time Distribution[shipping_mode] |

Conditional formatting: in the table, *Late Rate* → Background color → gradient (white → red).

### Page 3: "Promise scenario": what if we set realistic promises?

| Visual | Fields |
|---|---|
| Slicer (created with the parameter) | Target On-Time Rate |
| 3 cards | On-Time Rate (rename the visual title to "Current on-time rate") · Network On-Time Rate at Target · Avg Days Added per Order at Target |
| Table | Shipping Mode[shipping_mode] · Current Promise (days) · On-Time Rate · Promise Needed (days) · Projected On-Time Rate at Target |
| Line chart | X: Promise Scenarios[candidate_promise_days] · Y: Max of Promise Scenarios[projected_on_time_rate] · Legend: Promise Scenarios[shipping_mode] |
| Text box | One-sentence caveat: "Projection holds today's actual lead times fixed and changes only the promise." |

Add a constant line to the line chart: *Analytics* pane → *Y-axis constant line* → value `fx` → field `Target On-Time Rate Value`. The line then moves with the slider.

### Page 4: "Commercial exposure": where is revenue at risk?

| Visual | Fields |
|---|---|
| Clustered bar chart | Y: Product[category_name] · X: Late Line Net Sales · *Filters pane* → Top N = 10 by Late Line Net Sales |
| Table | Product[category_name] · Line Net Sales · Late Line Net Sales · Late Rate (by Product) |
| Clustered column chart | X: Geography[market] · Y: Leaked Net Sales · Tooltip: Leakage Rate |
| Filled map *(optional)* | Location: Geography[country] · Color saturation: Late Rate. Country names are in Spanish (e.g. "Estados Unidos"). If the map misplaces some, set *Column tools* → *Data category* → **Country/Region** on Geography[country], or skip the map. |
| Table | Repeat Purchase[first_order_outcome] · customers · repeat_rate_180d · avg_days_to_reorder (*Don't summarize*) |

## Part 6. Finish and publish to GitHub

1. Save the file as `powerbi/supply_chain_delivery_risk.pbix`. With Import mode it stays well under GitHub's 100 MB file limit (check: if it's over ~90 MB, don't commit it, just share screenshots).
2. Take a screenshot of each page (*Windows + Shift + S*) and save them as:
   `docs/images/01_overview.png`, `02_root_cause.png`, `03_promise_scenario.png`, `04_commercial_exposure.png`.
   The README already links to these paths.
3. *Optional:* *File* → *Export* → *PDF* → save as `docs/dashboard.pdf`. That gives reviewers without Power BI a way to read it.
4. Commit and push:

```powershell
git add powerbi docs results
git commit -m "Add Power BI dashboard, screenshots and analysis results"
git push
```

## What to be ready to explain

| Question | Your answer covers |
|---|---|
| Why two fact tables? | Delivery is an order-level event (verified: no order has mixed modes or delivery outcomes, profiling P4). Sales and products are line-level. |
| Why not bidirectional relationships? | They create ambiguity and slow models. CROSSFILTER turns it on for one measure only. |
| How do you know the numbers are right? | 12 automated SQL reconciliation checks plus card-level reconciliation of Power BI to SQL. |
| Why is `is_late` blank for cancelled orders? | They never shipped, so counting them as on time would flatter the KPI. The source flag counted them as 0, which is the mismatch found in profiling P6. |
| What does the scenario page assume? | Lead times stay as they are and only the promise changes. It measures how much of the problem is promise-setting, not a forecast. |
