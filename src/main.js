// CCE GovCon Feeds GitHub Action: run a CCE Partners Apify Actor and deliver its dataset as CSV/JSON,
// a job summary and (opt-in) one GitHub issue per run. Dependency-free (Node 20 global fetch).
// Security: the Apify token is masked (::add-mask::), sent only in the Authorization header, never logged,
// never written to files, and redacted from every error message. No telemetry; nothing is sent anywhere
// except api.apify.com (and api.github.com when open-issue is true).
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0';
export const USER_AGENT = `cce-gh-action/${VERSION}`;
export const DEFAULT_APIFY_API = 'https://api.apify.com';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);
const FAILED_STATUSES = new Set(['FAILED', 'ABORTED', 'TIMED-OUT']);

// Known Actors. monitorField / maxItemsField differ: Form D uses stateKey + maxFilings.
export const ACTORS = Object.freeze({
    sam: { id: 'jHWTaoToruEWHuUJX', name: 'cce_partners/samgov-opportunity-radar', title: 'SAM.gov Opportunity Radar',
        monitorField: 'monitorName', maxItemsField: 'maxItems',
        columns: ['changeType', 'title', 'noticeType', 'department', 'naicsCode', 'setAside', 'postedDate', 'responseDeadline', 'samUrl'] },
    recompete: { id: 'wAzHi4V19oFQrEhUp', name: 'cce_partners/govcon-recompete-radar', title: 'GovCon Recompete Radar',
        monitorField: 'monitorName', maxItemsField: 'maxItems',
        columns: ['endDate', 'piid', 'incumbent', 'awardAmount', 'awardingSubAgency', 'naicsCode', 'onSam', 'samUrl', 'changeType'] },
    formd: { id: 'tIyCut9UDaU8hgkHf', name: 'cce_partners/sec-form-d-new-raises-feed', title: 'SEC Form D New Raises Feed',
        monitorField: 'stateKey', maxItemsField: 'maxFilings',
        columns: ['issuerName', 'state', 'industryGroup', 'totalOfferingAmount', 'totalAmountSold', 'filingDate', 'filingUrl'] },
    awards: { id: 'rimNmG6SdE5W90q6N', name: 'cce_partners/federal-contract-award-winners-feed', title: 'Federal Contract Award Winners Feed',
        monitorField: 'monitorName', maxItemsField: 'maxItems',
        columns: ['baseObligationDate', 'changeType', 'recipientName', 'awardAmount', 'awardingAgency', 'naicsCode', 'setAsideType', 'usaspendingUrl'] },
});

export class ActionError extends Error {}

// ---------- secrets ----------
export function makeRedactor(secrets = []) {
    const list = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))].sort((a, b) => b.length - a.length);
    return (value) => {
        let s = value instanceof Error ? (value.stack || value.message) : String(value ?? '');
        for (const sec of list) s = s.split(sec).join('<REDACTED>');
        s = s.replace(/(api_key|token|apify_api_[A-Za-z0-9]*)=([^&\s"']+)/gi, (m, k) => `${k}=<REDACTED>`);
        s = s.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, '$1<REDACTED>');
        s = s.replace(/apify_api_[A-Za-z0-9]{10,}/g, 'apify_api_<REDACTED>');
        s = s.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_<REDACTED>');
        return s;
    };
}
const escapeCmd = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

// Input fields that are masked: an explicit allowlist = the fields our Actors' input schemas mark isSecret
// (SAM: samApiKey, aiApiKey; Recompete: samApiKey; Award Feed and Form D: none). No name-pattern matching:
// patterns hit real filters such as `keywords` and the monitor field `stateKey` (REVIEW-010 B2).
export const SECRET_INPUT_FIELDS = Object.freeze(['samApiKey', 'aiApiKey']);
export function secretValuesIn(input, fields = SECRET_INPUT_FIELDS) {
    if (!input || typeof input !== 'object') return [];
    return fields.map((f) => input[f]).filter((v) => typeof v === 'string' && v.trim().length >= 4);
}

// ---------- inputs ----------
export function getInput(env, name) {
    const v = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
    return v == null ? '' : String(v).trim();
}
const parseBool = (v, def = false) => (v === '' ? def : /^(true|1|yes|on)$/i.test(v));
function parseIntIn(v, name, { min = 0, def = null } = {}) {
    if (v === '') return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) throw new ActionError(`Input ${name} must be an integer >= ${min} (got "${v}").`);
    return n;
}

export function resolveActor(actor) {
    const a = String(actor || '').trim();
    if (!a) throw new ActionError('Input actor is required: sam | recompete | formd | awards, or a full Actor id (user/name or 17-char id).');
    const key = a.toLowerCase();
    if (ACTORS[key]) return { alias: key, ...ACTORS[key], apiId: ACTORS[key].id };
    const norm = a.replace('~', '/');
    for (const [alias, cfg] of Object.entries(ACTORS)) {
        if (norm === cfg.id || norm.toLowerCase() === cfg.name) return { alias, ...cfg, apiId: cfg.id };
    }
    if (/^[A-Za-z0-9]{17}$/.test(a)) return { alias: null, id: a, name: a, title: a, apiId: a, monitorField: 'monitorName', maxItemsField: 'maxItems', columns: null };
    if (/^[\w.-]+\/[\w.-]+$/.test(norm)) return { alias: null, id: norm, name: norm, title: norm, apiId: norm.replace('/', '~'), monitorField: 'monitorName', maxItemsField: 'maxItems', columns: null };
    throw new ActionError(`Unknown actor "${a}". Use sam | recompete | formd | awards, or a full Actor id (user/name or 17-char id).`);
}

export function buildActorInput(actorCfg, inputJson, { monitorName = '', maxItems = null } = {}, warn = () => {}) {
    let input = {};
    if (inputJson) {
        // Generic message only: Node's JSON error quotes a snippet of the input, which could contain a secret (REVIEW-010 N2).
        try { input = JSON.parse(inputJson); } catch { throw new ActionError('input-json is not valid JSON. Check quotes, commas and brackets; it must be one JSON object such as {"naicsCodes":["541512"]}.'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ActionError('input-json must be a JSON object, e.g. {"naicsCodes":["541512"]}.');
    }
    if (monitorName) {
        const f = actorCfg.monitorField;
        if (input[f] && input[f] !== monitorName) warn(`monitor-name "${monitorName}" overrides ${f} "${input[f]}" from input-json.`);
        input[f] = monitorName;
    }
    if (maxItems != null) input[actorCfg.maxItemsField] = maxItems;
    const name = input[actorCfg.monitorField] ?? (actorCfg.monitorField === 'monitorName' ? input.stateKey : input.monitorName);
    const stateful = typeof name === 'string' && name.trim() !== '';
    return { input, stateful, monitor: stateful ? name : null };
}

export function readConfig(env) {
    const token = getInput(env, 'apify-token');
    if (!token) throw new ActionError('Input apify-token is required. Store your Apify API token as a repository secret (e.g. APIFY_TOKEN) and pass ${{ secrets.APIFY_TOKEN }}.');
    const fmt = (getInput(env, 'output-format') || 'csv').toLowerCase();
    if (!['csv', 'json', 'both'].includes(fmt)) throw new ActionError(`output-format must be csv, json or both (got "${fmt}").`);
    // Empty = the Actor's own default memory (SAM 1024 MB, the others 512 MB) (REVIEW-010 N5).
    const memory = parseIntIn(getInput(env, 'memory-mbytes'), 'memory-mbytes', { min: 128, def: null });
    if (memory != null && (memory & (memory - 1)) !== 0) throw new ActionError(`memory-mbytes must be a power of 2 (128, 256, 512, 1024, ...), got ${memory}.`);
    const mtc = getInput(env, 'max-total-charge-usd');
    const maxTotalChargeUsd = mtc === '' ? null : Number(mtc);
    if (maxTotalChargeUsd !== null && !(Number.isFinite(maxTotalChargeUsd) && maxTotalChargeUsd > 0)) throw new ActionError(`max-total-charge-usd must be a positive number of US dollars, e.g. 2.50 (got "${mtc}").`);
    const timeoutSecs = parseIntIn(getInput(env, 'timeout-secs'), 'timeout-secs', { min: 1 });
    return {
        token,
        actor: resolveActor(getInput(env, 'actor')),
        inputJson: getInput(env, 'input-json'),
        monitorName: getInput(env, 'monitor-name'),
        build: getInput(env, 'build') || 'latest',
        memory,
        timeoutSecs,
        maxItems: parseIntIn(getInput(env, 'max-items'), 'max-items', { min: 1 }),
        maxTotalChargeUsd,
        waitTimeoutSecs: parseIntIn(getInput(env, 'wait-timeout-secs'), 'wait-timeout-secs', { min: 1, def: timeoutSecs ? timeoutSecs + 300 : 3600 }),
        abortOnTimeout: parseBool(getInput(env, 'abort-on-timeout'), true),
        outputFormat: fmt,
        outputPath: getInput(env, 'output-path') || 'apify-output',
        summaryRows: parseIntIn(getInput(env, 'summary-rows'), 'summary-rows', { min: 0, def: 10 }),
        openIssue: parseBool(getInput(env, 'open-issue'), false),
        githubToken: getInput(env, 'github-token'),
        issueNumber: parseIntIn(getInput(env, 'issue-number'), 'issue-number', { min: 1 }),
        issueLabels: getInput(env, 'issue-labels').split(',').map((s) => s.trim()).filter(Boolean),
        issueRows: parseIntIn(getInput(env, 'issue-rows'), 'issue-rows', { min: 1, def: 50 }),
    };
}

// ---------- HTTP ----------
export async function httpJson(url, { method = 'GET', headers = {}, body, retries = 4, sleep, redact, what = 'request', withHeaders = false } = {}) {
    let attempt = 0;
    for (;;) {
        let res; let text = '';
        try {
            res = await fetch(url, { method, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
                body: body !== undefined ? JSON.stringify(body) : undefined });
            text = await res.text();
        } catch (e) {
            if (attempt++ < retries) { await sleep(Math.min(1000 * 2 ** attempt, 15000)); continue; }
            throw new ActionError(`${what} failed (network): ${redact(e.message)}`);
        }
        if ((res.status === 429 || res.status >= 500) && attempt++ < retries) {
            const ra = Number(res.headers.get('retry-after'));
            await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : Math.min(1000 * 2 ** attempt, 15000));
            continue;
        }
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        if (!res.ok) {
            const msg = json?.error?.message || json?.message || text.slice(0, 300);
            throw new ActionError(redact(`${what} failed: HTTP ${res.status}${json?.error?.type ? ` (${json.error.type})` : ''}: ${msg}`));
        }
        return withHeaders ? { json, headers: res.headers } : json;
    }
}

export function createApify({ token, base = DEFAULT_APIFY_API, sleep, redact }) {
    const auth = { Authorization: `Bearer ${token}` };
    const u = (p, q = {}) => {
        const url = new URL(`/v2${p}`, base);
        for (const [k, v] of Object.entries(q)) if (v != null && v !== '') url.searchParams.set(k, String(v));
        return url.toString();
    };
    return {
        startRun: (actorId, input, q) => httpJson(u(`/acts/${encodeURIComponent(actorId)}/runs`, q), { method: 'POST', headers: auth, body: input, sleep, redact, what: 'Starting the Actor run', retries: 0 }).then((j) => j.data),
        getRun: (runId, waitForFinish) => httpJson(u(`/actor-runs/${runId}`, { waitForFinish }), { headers: auth, sleep, redact, what: 'Reading the run status' }).then((j) => j.data),
        abortRun: (runId) => httpJson(u(`/actor-runs/${runId}/abort`, { gracefully: 'true' }), { method: 'POST', headers: auth, sleep, redact, what: 'Aborting the run' }).then((j) => j.data),
        // No clean/skipEmpty: those drop empty items AFTER offset/limit, so pages come back short (REVIEW-010 B3).
        // skipHidden only removes '#'-prefixed fields, never whole items.
        getItems: async (datasetId, offset, limit) => {
            const { json, headers } = await httpJson(u(`/datasets/${datasetId}/items`, { format: 'json', skipHidden: 'true', offset, limit }), { headers: auth, sleep, redact, what: 'Reading the dataset', withHeaders: true });
            const total = Number(headers.get('x-apify-pagination-total'));
            return { items: json, total: headers.get('x-apify-pagination-total') != null && Number.isFinite(total) ? total : null };
        },
    };
}

export async function pollRun(apify, run, { waitTimeoutSecs, now, sleep, log, waitForFinishMax = 30, minDelayMs = 1000, maxDelayMs = 15000 }) {
    const deadline = now() + waitTimeoutSecs * 1000;
    let delay = minDelayMs; let last = run;
    while (!TERMINAL.has(last.status)) {
        const remaining = deadline - now();
        if (remaining <= 0) return { run: last, timedOut: true };
        const wff = Math.max(0, Math.min(waitForFinishMax, Math.floor(remaining / 1000)));
        const t0 = now();
        last = await apify.getRun(last.id, wff);
        if (TERMINAL.has(last.status)) break;
        log(`Run ${last.id}: ${last.status}${last.statusMessage ? ` (${String(last.statusMessage).slice(0, 160)})` : ''}`);
        // Backoff only when the server answered early (long-poll not honored); never sleep past the deadline.
        if (now() - t0 < 1000) {
            await sleep(Math.max(0, Math.min(delay, deadline - now())));
            delay = Math.min(Math.round(delay * 1.6), maxDelayMs);
        }
    }
    return { run: last, timedOut: false };
}

// Step the offset by the page LIMIT (not by the rows received) and stop on an empty page or once offset >= total.
export async function fetchAllItems(apify, datasetId, { pageSize = 1000, maxTotal = 1_000_000 } = {}) {
    const items = [];
    for (let offset = 0; offset < maxTotal; offset += pageSize) {
        const { items: page, total } = await apify.getItems(datasetId, offset, pageSize);
        if (!Array.isArray(page)) throw new ActionError('Reading the dataset failed: unexpected response (not a JSON array).');
        if (!page.length) break;
        items.push(...page);
        if (total != null && offset + pageSize >= total) break;
    }
    return items;
}

// ---------- CSV / flatten ----------
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function flatten(obj, prefix = '', out = {}, depth = 0) {
    for (const [k, v] of Object.entries(obj ?? {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (isPlainObject(v) && depth < 3 && Object.keys(v).length) flatten(v, key, out, depth + 1);
        else if (Array.isArray(v)) out[key] = v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x)) ? v.join('; ') : JSON.stringify(v);
        else if (isPlainObject(v)) { if (Object.keys(v).length) out[key] = JSON.stringify(v); } // empty object: no column
        else out[key] = v;
    }
    return out;
}
export function csvCell(v) {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(items, preferred = null) {
    const rows = items.map((it) => (isPlainObject(it) ? flatten(it) : { value: it }));
    const cols = [];
    const seen = new Set();
    for (const c of preferred || []) if (rows.some((r) => c in r) && !seen.has(c)) { seen.add(c); cols.push(c); }
    for (const r of rows) for (const c of Object.keys(r)) if (!seen.has(c)) { seen.add(c); cols.push(c); }
    if (!cols.length) return '';
    return [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

// ---------- markdown ----------
const mdCell = (v, max = 80) => {
    let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    s = s.replace(/\s+/g, ' ').trim();
    // Links keep their full URL (truncating it would break the link).
    if (/^https?:\/\/[^\s<>"]+$/.test(s)) return `[link](${s.replace(/[()]/g, encodeURIComponent)})`;
    if (s.length > max) s = `${s.slice(0, max - 1)}…`;
    // '@' + zero-width joiner: dataset text can't @mention people or teams (REVIEW-010 N7).
    return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '@\u200d');
};
export function markdownTable(items, preferred, maxRows, maxCols = 8) {
    const rows = items.slice(0, maxRows).map((it) => (isPlainObject(it) ? flatten(it) : { value: it }));
    if (!rows.length) return '';
    let cols = (preferred || []).filter((c) => rows.some((r) => c in r));
    if (!cols.length) cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    cols = cols.slice(0, maxCols);
    return [`| ${cols.map((c) => mdCell(c)).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${cols.map((c) => mdCell(r[c])).join(' | ')} |`)].join('\n');
}
export const runUrl = (runId) => `https://console.apify.com/view/runs/${runId}`;

export function buildSummary({ actor, run, items, cfg, stateful, monitor, error, files, timedOut }) {
    const status = timedOut ? `${run?.status || 'UNKNOWN'} (action wait timeout)` : (run?.status || 'NOT STARTED');
    const lines = [`## ${actor ? actor.title : 'Apify Actor'}: ${items ? items.length : 0} row(s)`, ''];
    lines.push('| | |', '|---|---|');
    lines.push(`| Actor | \`${actor?.name ?? '?'}\` |`);
    lines.push(`| Status | ${error || timedOut || FAILED_STATUSES.has(run?.status) ? '❌' : '✅'} ${status} |`);
    if (run?.id) lines.push(`| Run | [${run.id}](${runUrl(run.id)}) |`);
    if (run?.buildNumber) lines.push(`| Build | ${run.buildNumber} |`);
    lines.push(`| Mode | ${stateful ? `monitor \`${mdCell(monitor, 60)}\` (new rows only)` : 'stateless (no monitor name: latest rows, may repeat across runs)'} |`);
    if (run?.chargedEventCounts && Object.keys(run.chargedEventCounts).length) lines.push(`| Charged events | ${Object.entries(run.chargedEventCounts).map(([k, v]) => `${mdCell(k)}: ${v}`).join(', ')} |`);
    if (typeof run?.usageTotalUsd === 'number') lines.push(`| Cost (your Apify account) | $${run.usageTotalUsd.toFixed(4)} |`);
    for (const f of files || []) lines.push(`| File | \`${f}\` |`);
    if (error) lines.push('', `> **Error:** ${mdCell(error, 600)}`);
    if (items?.length && cfg.summaryRows > 0) {
        lines.push('', `### First ${Math.min(cfg.summaryRows, items.length)} of ${items.length} row(s)`, '', markdownTable(items, actor?.columns, cfg.summaryRows));
    } else if (items && !items.length && !error) lines.push('', stateful ? '_No new rows since the last run of this monitor._' : '_No rows returned._');
    lines.push('', `<sub>${USER_AGENT} · runs bill to your own Apify account · no data is sent to or stored by CCE Partners</sub>`, '');
    return lines.join('\n');
}

// ---------- GitHub issue ----------
export async function postIssue({ cfg, env, actor, run, items, sleep, redact }) {
    const repo = env.GITHUB_REPOSITORY;
    if (!cfg.githubToken) throw new ActionError('open-issue is true but github-token is empty. Pass github-token: ${{ github.token }} and grant "issues: write".');
    if (!repo) throw new ActionError('open-issue is true but GITHUB_REPOSITORY is not set.');
    const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${cfg.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const shown = items.slice(0, cfg.issueRows);
    const date = new Date().toISOString().slice(0, 10);
    let body = [`**${items.length} new row(s)** from \`${actor.name}\` · run [${run.id}](${runUrl(run.id)}) · status ${run.status}`,
        FAILED_STATUSES.has(run.status) ? `\n> ⚠️ The run ended with status ${run.status}; these are the rows it delivered before stopping.` : '',
        '', markdownTable(shown, actor.columns, cfg.issueRows),
        items.length > shown.length ? `\n_…and ${items.length - shown.length} more; see the CSV/JSON artifact or the Apify run._` : '',
        '', `<sub>${USER_AGENT}</sub>`].join('\n');
    if (body.length > 60000) body = `${body.slice(0, 60000)}\n\n_(truncated)_`;
    if (cfg.issueNumber) {
        const j = await httpJson(`${api}/repos/${repo}/issues/${cfg.issueNumber}/comments`, { method: 'POST', headers, body: { body }, sleep, redact, what: 'Adding the issue comment', retries: 1 });
        return j.html_url;
    }
    const title = `${actor.title}: ${items.length} new row(s) ${date} (run ${run.id})`;
    const j = await httpJson(`${api}/repos/${repo}/issues`, { method: 'POST', headers, body: { title, body, ...(cfg.issueLabels.length ? { labels: cfg.issueLabels } : {}) }, sleep, redact, what: 'Creating the issue', retries: 1 });
    return j.html_url;
}

// ---------- outputs ----------
function setOutput(env, name, value) {
    const v = String(value ?? '');
    if (env.GITHUB_OUTPUT) {
        const delim = `ghadelim_${Math.random().toString(36).slice(2)}`;
        fs.appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delim}\n${v}\n${delim}\n`);
    }
}

// ---------- main ----------
// apiBase exists only so the test suite can point at a local mock; src/index.js never passes it and no
// environment variable can change it, so the Apify token only ever goes to https://api.apify.com (REVIEW-010 N3).
export async function run({ env = process.env, stdout = (s) => process.stdout.write(s), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), pollOpts = {}, apiBase = DEFAULT_APIFY_API } = {}) {
    const secrets = [];
    let redact = makeRedactor(secrets);
    // CR/LF stripped so Apify-sourced text (status messages etc.) can't start a ::workflow command:: line (REVIEW-010 N1).
    const oneLine = (m) => String(m).replace(/[\r\n]+/g, ' ');
    const log = (m) => stdout(`${oneLine(redact(m))}\n`);
    const warn = (m) => stdout(`::warning::${escapeCmd(redact(m))}\n`);
    const mask = (s) => { if (s && s.length >= 4 && !secrets.includes(s)) { secrets.push(s); stdout(`::add-mask::${escapeCmd(s)}\n`); redact = makeRedactor(secrets); } };
    // Mask before anything else can fail and echo it.
    mask(getInput(env, 'apify-token'));
    mask(getInput(env, 'github-token'));

    let cfg; let actor; let apifyRun = null; let items = null; let files = []; let errorMsg = null; let timedOut = false; let stateful = false; let monitor = null;
    const outputs = {};
    try {
        cfg = readConfig(env);
        actor = cfg.actor;
        const built = buildActorInput(actor, cfg.inputJson, { monitorName: cfg.monitorName, maxItems: cfg.maxItems }, warn);
        ({ stateful, monitor } = built);
        for (const s of secretValuesIn(built.input)) mask(s);
        if (!stateful) warn(`No monitor name: this run is stateless and returns the latest rows, which can repeat (and be charged again) on every scheduled run. Set monitor-name for new-only delivery.`);
        const apify = createApify({ token: cfg.token, base: apiBase, sleep, redact });
        log(`Starting ${actor.name} (build ${cfg.build}, ${cfg.memory ? `${cfg.memory} MB` : 'Actor default memory'}${cfg.timeoutSecs ? `, timeout ${cfg.timeoutSecs}s` : ''}${cfg.maxTotalChargeUsd ? `, max charge $${cfg.maxTotalChargeUsd}` : ''}, ${stateful ? `monitor "${monitor}"` : 'stateless'})`);
        apifyRun = await apify.startRun(actor.apiId, built.input, { build: cfg.build, memory: cfg.memory, timeout: cfg.timeoutSecs, maxItems: cfg.maxItems, maxTotalChargeUsd: cfg.maxTotalChargeUsd });
        outputs['run-id'] = apifyRun.id; outputs['dataset-id'] = apifyRun.defaultDatasetId; outputs['run-url'] = runUrl(apifyRun.id);
        log(`Run ${apifyRun.id} started: ${runUrl(apifyRun.id)}`);
        let polled;
        try {
            polled = await pollRun(apify, apifyRun, { waitTimeoutSecs: cfg.waitTimeoutSecs, now, sleep, log, ...pollOpts });
        } catch (e) {
            // Polling failed after its retries: don't leave the run going unattended (best effort, REVIEW-010 N6).
            let note = '';
            if (cfg.abortOnTimeout) {
                try { const a = await apify.abortRun(apifyRun.id); note = ` Requested a graceful abort of run ${apifyRun.id} (status ${a?.status ?? 'unknown'}).`; }
                catch (e2) { note = ` Abort request for run ${apifyRun.id} also failed: ${redact(e2.message)}`; }
            } else note = ` Run ${apifyRun.id} was not aborted (abort-on-timeout is false).`;
            log(note.trim());
            throw new ActionError(`${redact(e.message)}${note}`);
        }
        apifyRun = polled.run; timedOut = polled.timedOut;
        if (timedOut) {
            errorMsg = `The run did not finish within wait-timeout-secs (${cfg.waitTimeoutSecs}s); last status ${apifyRun.status}.`;
            if (cfg.abortOnTimeout) {
                try {
                    apifyRun = await apify.abortRun(apifyRun.id);
                    const after = await pollRun(apify, apifyRun, { waitTimeoutSecs: 45, now, sleep, log, ...pollOpts });
                    apifyRun = after.run;
                    errorMsg += ` Requested a graceful abort; status now ${apifyRun.status}.`;
                } catch (e) { errorMsg += ` Abort request failed: ${redact(e.message)}`; }
            } else errorMsg += ' The run keeps running on Apify (abort-on-timeout is false).';
        } else if (FAILED_STATUSES.has(apifyRun.status)) {
            errorMsg = `The Actor run ended with status ${apifyRun.status}${apifyRun.statusMessage ? `: ${apifyRun.statusMessage}` : ''}. See ${runUrl(apifyRun.id)}`;
        }
        // Rows a failed/aborted monitor run already delivered are saved in its state and won't be re-sent, so always collect them.
        items = await fetchAllItems(apify, apifyRun.defaultDatasetId);
        log(`Dataset ${apifyRun.defaultDatasetId}: ${items.length} item(s)`);
        fs.mkdirSync(cfg.outputPath, { recursive: true });
        const base = path.join(cfg.outputPath, `${actor.alias || 'actor'}-${apifyRun.id}`);
        if (cfg.outputFormat !== 'json') { fs.writeFileSync(`${base}.csv`, toCsv(items, actor.columns)); outputs['csv-path'] = `${base}.csv`; files.push(`${base}.csv`); }
        if (cfg.outputFormat !== 'csv') { fs.writeFileSync(`${base}.json`, `${JSON.stringify(items, null, 2)}\n`); outputs['json-path'] = `${base}.json`; files.push(`${base}.json`); }
        outputs['item-count'] = items.length;
        outputs['run-status'] = apifyRun.status;
        if (typeof apifyRun.usageTotalUsd === 'number') outputs['usage-usd'] = apifyRun.usageTotalUsd;
        if (cfg.openIssue) {
            if (!items.length) log('open-issue: 0 rows, no issue created.');
            else {
                try { outputs['issue-url'] = await postIssue({ cfg, env, actor, run: apifyRun, items, sleep, redact }); log(`Issue: ${outputs['issue-url']}`); }
                catch (e) { const m = redact(e.message); errorMsg = errorMsg ? `${errorMsg} Also: ${m}` : m; }
            }
        }
    } catch (e) {
        const m = redact(e instanceof ActionError ? e.message : (e?.stack || e));
        errorMsg = errorMsg ? `${errorMsg} Also: ${m}` : m;
        if (items === null && apifyRun?.status) outputs['run-status'] = apifyRun.status;
    }
    outputs['item-count'] ??= items ? items.length : 0;
    for (const [k, v] of Object.entries(outputs)) setOutput(env, k, redact(v));
    if (env.GITHUB_STEP_SUMMARY) {
        try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, redact(buildSummary({ actor, run: apifyRun, items, cfg: cfg || { summaryRows: 0 }, stateful, monitor, error: errorMsg, files, timedOut }))); }
        catch (e) { warn(`Could not write the job summary: ${e.message}`); }
    }
    if (errorMsg) { stdout(`::error::${escapeCmd(redact(errorMsg))}\n`); return { ok: false, outputs, error: redact(errorMsg) }; }
    return { ok: true, outputs };
}
