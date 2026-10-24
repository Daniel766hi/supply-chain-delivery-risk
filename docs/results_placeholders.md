# Where each README number comes from

Every `{{PLACEHOLDER}}` in the README maps to one value in `results/06_analysis_output.txt`. Fill them in after your own run, using the formats shown, and keep this file as your interview crib sheet.

Percentages: multiply the decimal by 100 and round to 1 decimal (0.4321 → 43.2%).
"pp" = percentage points: the spread decimal × 100 (0.0123 → 1.2 pp).
Money: values are in US dollars. Round to $0.1M (12,345,678 → $12.3M).

| Placeholder | Section in 06 output | Row | Column | Format |
|---|---|---|---|---|
| `{{LATE_RATE}}` | Q1 | only row | `late_rate` | % |
| `{{SHIPPED_ORDERS}}` | Q1 | only row | `shipped_orders` | 12,345 |
| `{{NET_SALES_LATE}}` | Q1 | only row | `net_sales_in_late_orders` | $M |
| `{{LATE_SALES_SHARE}}` | Q1 | only row | `share_of_shipped_sales_late` | % |
| `{{MODE_SPREAD_PP}}` | Q2 | Shipping mode | `spread` | pp |
| `{{MARKET_SPREAD_PP}}` | Q2 | Market | `spread` | pp |
| `{{SEGMENT_SPREAD_PP}}` | Q2 | Customer segment | `spread` | pp |
| `{{REGION_SPREAD_PP}}` | Q2 | Region | `spread` | pp |
| `{{FC_ACTUAL_DAYS}}` | Q3 | First Class | `avg_actual_days` | 1 decimal |
| `{{FC_LATE_RATE}}` | Q3 | First Class | `late_rate` | % |
| `{{SC_AVG_DAYS}}` | Q3 | Second Class | `avg_actual_days` | 1 decimal |
| `{{STD_AVG_DAYS}}` | Q3 | Standard Class | `avg_actual_days` | 1 decimal |
| `{{SC_LATE_RATE}}` | Q3 | Second Class | `late_rate` | % |
| `{{STD_LATE_RATE}}` | Q3 | Standard Class | `late_rate` | % |
| `{{FC_SC_SHARE_OF_ORDERS}}` | Q3 | First Class + Second Class | `share_of_orders` (add the two) | % |
| `{{FC_SC_SHARE_OF_LATE}}` | Q3 | First Class + Second Class | `share_of_all_late_orders` (add the two) | % |
| `{{ONTIME_CURRENT}}` | Q4c | Current promises | `network_on_time_rate` | % |
| `{{ONTIME_T75}}` | Q4c | Target 75% | `network_on_time_rate` | % |
| `{{DAYS_ADDED_T75}}` | Q4c | Target 75% | `avg_days_added_per_order` | 1 decimal |
| `{{VOLUME_STEP_UP_PCT}}` | Q5b | both rows | `avg_orders_per_month`: (row 2 ÷ row 1) − 1 | % |
| `{{LATE_RATE_BEFORE}}` | Q5b | 1: Oct-2016 to Sep-2017 | `late_rate` | % |
| `{{LATE_RATE_AFTER}}` | Q5b | 2: Oct-2017 to Jan-2018 | `late_rate` | % |
| `{{REPEAT_LATE}}` | Q6 | First order late | `repeat_rate_180d` | % |
| `{{REPEAT_ONTIME}}` | Q6 | First order on time/early | `repeat_rate_180d` | % |
| `{{LEAKED_SALES}}` | Q7b | only row | `leaked_net_sales` | $M |
| `{{LEAKAGE_SHARE}}` | Q7b | only row | `leakage_share_of_sales` | % |

## Definitions to know by heart

- **Shipped order**: any order whose delivery status is not "Shipping canceled". Cancelled and suspected-fraud orders never shipped and are excluded from delivery KPIs.
- **Late**: actual lead time (days) > promised lead time for the order's shipping mode.
- **Late rate**: late orders ÷ shipped orders, counted per order, not per line.
- **Spread**: highest minus lowest late rate among the members of one dimension (e.g. the five markets).
- **Projected on-time rate**: share of today's shipped orders that would have met a different promise, with actual lead times unchanged.
- **Leakage**: net sales on cancelled or suspected-fraud orders.
