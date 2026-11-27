---
"omnesis": patch
---

A slow `omnesis sql --db sqlite` query (or `POST /sql`) can no longer freeze the gateway. It used to run on the thread every request waits on, so a full-table scan of a large store stalled `/health` and every collector sync for a minute or more. It now runs on its own thread with a deadline of 15 seconds (`OMNESIS_SQL_TIMEOUT_MS`, 1 to 60 seconds); past it the query is cancelled and the answer is a 504 that suggests filtering on an exact `source_id =` and an indexed time range. `omnesis sql` waits for that answer instead of hanging, and takes `--timeout`. `omnesis status --json` now prints the status as JSON instead of the table.
