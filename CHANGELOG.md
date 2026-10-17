# Changelog

## 0.1.0 (2026-10-16)

First release. Runs on the `node24` runtime.

- Runs any of the four CCE Partners Actors by alias (`sam`, `recompete`, `formd`, `awards`) or any Actor by full id.
- Starts the run with the Apify API and polls it with backoff until it finishes or `wait-timeout-secs` passes. It then aborts the run gracefully, and does the same if polling keeps failing, unless `abort-on-timeout: false`.
- Optional `max-total-charge-usd` (a dollar cap per run). `memory-mbytes` defaults to the Actor's own default.
- Downloads every dataset item, 1,000 per page and including empty items, and writes CSV (nested fields flattened), JSON, or both.
- Outputs: `run-id`, `run-status`, `run-url`, `dataset-id`, `item-count`, `csv-path`, `json-path`, `usage-usd`, `issue-url`.
- Job summary with run status, cost, charged events and a table of the first rows.
- Optional (default off): one GitHub issue per run listing the rows, or a comment on an existing issue. Skipped when there are 0 rows.
- `monitor-name` sets the right field for each Actor (`monitorName`, or `stateKey` for Form D), and `max-items` does the same (`maxItems`, or `maxFilings` for Form D).
- Security: the Apify token, the GitHub token and the secret input fields `samApiKey` and `aiApiKey` are masked. Tokens go out only in the Authorization header, only to the fixed `https://api.apify.com`, and are redacted from errors. Log lines from Apify are flattened to one line, and @mentions in issues are neutralized. No dependencies and no telemetry.
