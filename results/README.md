# Results

Outputs written by the SQL scripts (see `docs/windows_setup.md`, step 4):

| File | Written by | What it is |
|---|---|---|
| `02_profile_output.txt` | `sql/02_profile_raw.sql` | Profiling evidence behind the cleaning decisions |
| `04_validation_output.txt` | `sql/04_validate_warehouse.sql` | 12 reconciliation checks, all must read PASS |
| `06_analysis_output.txt` | `sql/06_business_analysis.sql` | Answers to Q1–Q8; source of every number in the README |

Commit these files. They let anyone check the findings without rerunning the pipeline.
