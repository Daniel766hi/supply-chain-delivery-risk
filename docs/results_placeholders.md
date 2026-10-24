# Where each README number comes from

Every number in the README maps to one value in `results/06_analysis_output.txt`. Keep this file as your interview crib sheet. If you re-run the pipeline, your output should match the Value column exactly (the data and SQL are deterministic).

Percentages: multiply the decimal by 100 and round to 1 decimal (0.4321 → 43.2%).
"pp" = percentage points: the spread decimal × 100 (0.0123 → 1.2 pp).
Money: values are in US dollars. Round to $0.1M (12,345,678 → $12.3M).

| Placeholder | Value | Section in 06 output | Row | Column | Format |
|---|---|---|---|---|---|
| `{{LATE_RATE}}` | 57.3% | Q1 | only row | `late_rate` | % |
| `{{SHIPPED_ORDERS}}` | 62,897 | Q1 | only row | `shipped_orders` | 12,345 |
| `{{NET_SALES_LATE}}` | $18.1M | Q1 | only row | `net_sales_in_late_orders` | $M |
| `{{LATE_SALES_SHARE}}` | 57.1% | Q1 | only row | `share_of_shipped_sales_late` | % |
| `{{MODE_SPREAD_PP}}` | 60.2 | Q2 | Shipping mode | `spread` | pp |
| `{{MARKET_SPREAD_PP}}` | 1.1 | Q2 | Market | `spread` | pp |
| `{{SEGMENT_SPREAD_PP}}` | 0.6 | Q2 | Customer segment | `spread` | pp |
| `{{REGION_SPREAD_PP}}` | 7.5 | Q2 | Region | `spread` | pp |
| `{{FC_ACTUAL_DAYS}}` | 2.0 | Q3 | First Class | `avg_actual_days` | 1 decimal |
| `{{FC_LATE_RATE}}` | 100% | Q3 | First Class | `late_rate` | % |
| `{{SC_AVG_DAYS}}` | 4.0 | Q3 | Second Class | `avg_actual_days` | 1 decimal |
| `{{STD_AVG_DAYS}}` | 4.0 | Q3 | Standard Class | `avg_actual_days` | 1 decimal |
| `{{SC_LATE_RATE}}` | 80.0% | Q3 | Second Class | `late_rate` | % |
| `{{STD_LATE_RATE}}` | 39.9% | Q3 | Standard Class | `late_rate` | % |
| `{{FC_SC_SHARE_OF_ORDERS}}` | 34.8% | Q3 | First Class + Second Class | `share_of_orders` (add the two) | % |
| `{{FC_SC_SHARE_OF_LATE}}` | 53.8% | Q3 | First Class + Second Class | `share_of_all_late_orders` (add the two) | % |
| `{{ONTIME_CURRENT}}` | 42.7% | Q4c | Current promises | `network_on_time_rate` | % |
| `{{ONTIME_T75}}` | 84.1% | Q4c | Target 75% | `network_on_time_rate` | % |
| `{{DAYS_ADDED_T75}}` | 1.4 | Q4c | Target 75% | `avg_days_added_per_order` | 1 decimal |
| `{{VOLUME_STEP_UP_PCT}}` | 21.0% | Q5b | both rows | `avg_orders_per_month`: (row 2 ÷ row 1) − 1 | % |
| `{{LATE_RATE_BEFORE}}` | 57.1% | Q5b | 1: Oct-2016 to Sep-2017 | `late_rate` | % |
| `{{LATE_RATE_AFTER}}` | 57.6% | Q5b | 2: Oct-2017 to Jan-2018 | `late_rate` | % |
| `{{REPEAT_LATE}}` | 56.4% | Q6 | First order late | `repeat_rate_180d` | % |
| `{{REPEAT_ONTIME}}` | 55.1% | Q6 | First order on time/early | `repeat_rate_180d` | % |
| `{{LEAKED_SALES}}` | $1.4M | Q7b | only row | `leaked_net_sales` | $M |
| `{{LEAKAGE_SHARE}}` | 4.3% | Q7b | only row | `leakage_share_of_sales` | % |

## Definitions to know by heart

- **Shipped order**: any order whose delivery status is not "Shipping canceled". Cancelled and suspected-fraud orders never shipped and are excluded from delivery KPIs.
- **Late**: actual lead time (days) > promised lead time for the order's shipping mode.
- **Late rate**: late orders ÷ shipped orders, counted per order, not per line.
- **Spread**: highest minus lowest late rate among the members of one dimension (e.g. the five markets).
- **Projected on-time rate**: share of today's shipped orders that would have met a different promise, with actual lead times unchanged.
- **Leakage**: net sales on cancelled or suspected-fraud orders.
