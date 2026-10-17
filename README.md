# CCE GovCon Feeds: GitHub Action for Apify

Run the CCE Partners government-contracting and funding Actors on Apify from a GitHub workflow. You get the results as CSV/JSON files, a job summary table and, if you turn it on, a GitHub issue listing the new rows.

| Alias | Actor | What you get | Store page |
|---|---|---|---|
| `sam` | `cce_partners/samgov-opportunity-radar` | New and amended SAM.gov contract opportunities | https://apify.com/cce_partners/samgov-opportunity-radar |
| `recompete` | `cce_partners/govcon-recompete-radar` | Federal contracts ending soon (recompete pipeline), matched to SAM.gov notices | https://apify.com/cce_partners/govcon-recompete-radar |
| `formd` | `cce_partners/sec-form-d-new-raises-feed` | New SEC Form D filings (private funding raises) | https://apify.com/cce_partners/sec-form-d-new-raises-feed |
| `awards` | `cce_partners/federal-contract-award-winners-feed` | New federal contract awards and their winners (USAspending) | https://apify.com/cce_partners/federal-contract-award-winners-feed |

## What it does

1. Starts the Actor run with the Apify API, using your token, build, memory, timeout and item cap.
2. Polls the run with backoff until it finishes. If it isn't done within `wait-timeout-secs`, or polling keeps failing after retries, the action stops waiting and aborts the run gracefully. Set `abort-on-timeout: false` to let it keep running.
3. Downloads every item from the run's default dataset, 1,000 per page, including empty items.
4. Writes CSV (nested fields are flattened to `a.b` columns, lists are joined with `; `, lists of objects are kept as JSON), JSON, or both.
5. Sets outputs and writes a job summary with the status, a link to the run, the cost reported by Apify and a table of the first rows.
6. Optional: creates **one issue per run** listing the rows, or adds a comment to an existing issue. Skipped when there are 0 rows.

If the run ends with `FAILED`, `ABORTED` or `TIMED-OUT`, the step fails with a clear message. The summary, outputs and files are still written, including any rows the run delivered before it stopped. A monitor has already saved those rows as delivered, so they won't come again on the next run.

## Quick start

1. Create an Apify account and copy your API token (Apify Console > Settings > API & Integrations).
2. In your GitHub repo, add it as a secret: Settings > Secrets and variables > Actions > New repository secret, named `APIFY_TOKEN`.
3. Add a workflow such as `.github/workflows/sam-daily.yml`:

```yaml
name: "SAM.gov IT opportunities (daily)"
on:
  schedule:
    - cron: '15 11 * * 1-5'
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - id: feed
        uses: chrisgrant303/gh-action-govcon-feeds@v1
        with:
          apify-token: ${{ secrets.APIFY_TOKEN }}
          actor: sam
          monitor-name: it-8a-daily      # new-only delivery
          input-json: '{"naicsCodes":["541512","541519"],"setAside":"8A","noticeTypes":["o","p","k","r"]}'
          max-items: '200'
      - uses: actions/upload-artifact@v4
        if: steps.feed.outputs.item-count != '0'
        with:
          name: sam-${{ steps.feed.outputs.run-id }}
          path: apify-output/
```

More examples, one per Actor and each with a monitor name, are in [`.github/workflows/examples/`](.github/workflows/examples/). Copy one into `.github/workflows/` to use it.

### Monitor names (new-only delivery)

With `monitor-name`, each scheduled run returns only rows that are **new since the last run of that monitor**. The Actor keeps the state in a key-value store in **your** Apify account. Without a monitor name the run is stateless: it returns the latest rows, which can repeat on every run, and you pay for them again. The action warns about this. Use one monitor name per filter set.

`monitor-name` is written to the right input field for each Actor: `monitorName`, or `stateKey` for `formd`. It overrides a name set in `input-json`.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `apify-token` | yes | | Your Apify API token, from a secret. Runs bill to this account. |
| `actor` | yes | | `sam`, `recompete`, `formd`, `awards`, or a full Actor id (`user/name` or the 17-character id). |
| `input-json` | no | `{}` | Actor input as a JSON object. See each Actor's input tab in the Store. |
| `monitor-name` | no | | Monitor name for new-only delivery, merged into the input. |
| `build` | no | `latest` | Actor build tag or number. |
| `memory-mbytes` | no | Actor default | Run memory in MB (power of 2). Empty uses the Actor's own default: SAM 1024 MB, the others 512 MB. The start fee is charged per GB. |
| `timeout-secs` | no | Actor default | Run timeout on Apify. |
| `max-items` | no | Actor default | Row cap (cost cap). Merged into the input (`maxItems`, or `maxFilings` for `formd`) and also sent as the run's `maxItems` option. |
| `wait-timeout-secs` | no | `timeout-secs`+300, or 3600 | How long the action waits for the run. |
| `max-total-charge-usd` | no | Apify default | Hard spend cap for the run in USD, sent as Apify's `maxTotalChargeUsd` run option. The run stops charging once the cap is reached. |
| `abort-on-timeout` | no | `true` | Gracefully abort the run when the action stops waiting, or when polling keeps failing. |
| `output-format` | no | `csv` | `csv`, `json` or `both`. |
| `output-path` | no | `apify-output` | Directory for the files (`<alias>-<runId>.csv/.json`). |
| `summary-rows` | no | `10` | Rows in the job summary table (0 = none). |
| `open-issue` | no | `false` | Create one issue per run listing the rows. Opt-in. |
| `github-token` | with `open-issue` | | E.g. `${{ github.token }}`. The job needs `permissions: issues: write`. |
| `issue-number` | no | | Add a comment to this issue instead of creating a new one. |
| `issue-labels` | no | | Comma-separated labels for new issues. They must already exist. |
| `issue-rows` | no | `50` | Maximum rows listed in the issue. |

## Outputs

| Output | Description |
|---|---|
| `run-id` | Apify run id |
| `run-status` | `SUCCEEDED`, `FAILED`, `ABORTED`, `TIMED-OUT`, ... |
| `run-url` | Link to the run in Apify Console |
| `dataset-id` | The run's default dataset id |
| `item-count` | Number of rows |
| `csv-path` / `json-path` | Paths of the written files |
| `usage-usd` | The run's cost as reported by Apify for your account, if available |
| `issue-url` | URL of the created issue or comment |

## Cost

The action is free. **Runs bill to your own Apify account** under each Actor's pay-per-event pricing: an Actor start event plus one event per row returned. Prices as listed on the Actors on 2026-10-16 (check the Store page for the current price before you schedule):

| Actor | Actor start | Per row |
|---|---|---|
| SAM.gov Opportunity Radar | $0.01 | $0.004 per opportunity (+ $0.002 per AI tag, only if AI tagging is on) |
| GovCon Recompete Radar | $0.01 | $0.01 per pipeline row |
| SEC Form D New Raises Feed | $0.01 | $0.005 per filing |
| Federal Contract Award Winners Feed | $0.01 | $0.005 per award row |

The start event is charged per GB of run memory (minimum 1). Use `max-items` to cap the number of rows and `max-total-charge-usd` to set a hard dollar cap per run (it also covers extra events such as SAM AI tags). A monitor name keeps you from paying twice for the same row. The job summary shows the charged events and the run cost reported by Apify.

## Privacy and security

- **We store no data.** The action talks only to `api.apify.com`, and to the GitHub API only when `open-issue` is on. The results go into your Apify account and your workflow workspace. Nothing is sent to CCE Partners, and the action has no telemetry.
- Your Apify token is masked in the log (`::add-mask::`), sent only in the `Authorization` header (never in a URL), never written to files, and redacted from error messages. The GitHub token is masked too, and so are the input fields the Actors mark as secret: `samApiKey` and `aiApiKey`. Other input values, such as keywords or monitor names, are not masked, so the log stays readable. Keep such keys in secrets, for example `input-json: '{"samApiKey":"${{ secrets.SAM_API_KEY }}"}'`.
- The Apify API address is fixed to `https://api.apify.com`. No input or environment variable can send your token anywhere else.
- Status messages from the Actor are printed on one line, so they can't trigger workflow commands. In issues, `@` gets a zero-width joiner added after it, so dataset text can't mention people.
- To pin an exact version, reference a full commit SHA instead of `@v1`.
- The action sends the HTTP User-Agent `cce-gh-action/0.1.0`. Apify records it in the run's metadata in **your** account only.
- Issues in a public repository are public. Leave `open-issue` off there if the rows shouldn't be visible.

## Development

```bash
npm test     # node:test with a local mock Apify API and a mock GitHub API; no network calls
```

The action has no dependencies: `src/main.js` uses Node 24's global `fetch` (the action runs on `node24`), so there's no `dist/` bundle.

## License

MIT © 2026 CCE Partners LLC
