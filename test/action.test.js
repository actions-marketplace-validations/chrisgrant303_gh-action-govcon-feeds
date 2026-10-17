import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-server.js';
import { run, toCsv, csvCell, flatten, resolveActor, buildActorInput, makeRedactor, ACTORS, USER_AGENT, pollRun } from '../src/main.js';

const TOKEN = 'apify_api_TESTTOKEN1234567890';
const GH = 'ghs_testgithubtoken';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function setup(mock, inputs = {}, extraEnv = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghx-'));
    const env = { GITHUB_API_URL: mock.base, GITHUB_REPOSITORY: 'acme/bids',
        GITHUB_OUTPUT: path.join(dir, 'out.txt'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'), ...extraEnv };
    const all = { 'apify-token': TOKEN, actor: 'awards', 'monitor-name': 'va-it', 'output-format': 'both', 'output-path': path.join(dir, 'o'), ...inputs };
    for (const [k, v] of Object.entries(all)) env[`INPUT_${k.toUpperCase()}`] = v;
    let out = '';
    const opts = { env, apiBase: mock.base, stdout: (s) => { out += s; }, sleep: async () => {}, pollOpts: { waitForFinishMax: 0 } };
    const outputs = () => {
        const txt = fs.existsSync(env.GITHUB_OUTPUT) ? fs.readFileSync(env.GITHUB_OUTPUT, 'utf8') : '';
        const o = {}; const re = /^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm; let m;
        while ((m = re.exec(txt))) o[m[1]] = m[3];
        return o;
    };
    const summary = () => (fs.existsSync(env.GITHUB_STEP_SUMMARY) ? fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8') : '');
    const allFiles = () => { const res = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : res.push(fs.readFileSync(p, 'utf8')); } }; walk(dir); return res.join('\n'); };
    return { env, dir, opts, get out() { return out; }, outputs, summary, allFiles };
}
const award = (i) => ({ id: `CONT_AWD_${i}`, recipientName: `Acme ${i}, Inc.`, awardAmount: 100000 + i, awardingAgency: 'Department of Veterans Affairs',
    naicsCode: '541512', changeType: 'new', baseObligationDate: '2026-10-01', usaspendingUrl: `https://www.usaspending.gov/award/CONT_AWD_${i}` });

test('success: starts the run with the right options, writes CSV/JSON, outputs and summary', async () => {
    const mock = await startMock({ items: [award(1), award(2), award(3)] });
    const t = setup(mock, { 'max-items': '5', 'memory-mbytes': '512', 'input-json': '{"naicsCodes":["541512"],"resolveParents":false}', 'timeout-secs': '600' });
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, true, r.error);
        const start = mock.state.requests.find((q) => q.method === 'POST' && q.path.endsWith('/runs'));
        assert.equal(start.path, `/v2/acts/${ACTORS.awards.id}/runs`);
        assert.deepEqual(JSON.parse(start.body), { naicsCodes: ['541512'], resolveParents: false, monitorName: 'va-it', maxItems: 5 });
        assert.equal(start.query.build, 'latest'); assert.equal(start.query.memory, '512'); assert.equal(start.query.timeout, '600'); assert.equal(start.query.maxItems, '5');
        assert.equal(start.headers['user-agent'], USER_AGENT);
        assert.ok(!('token' in start.query), 'token never in the URL');
        const o = t.outputs();
        assert.equal(o['item-count'], '3'); assert.equal(o['run-status'], 'SUCCEEDED'); assert.match(o['run-id'], /^RUN1/); assert.equal(o['dataset-id'], `DS${o['run-id']}`);
        assert.equal(JSON.parse(fs.readFileSync(o['json-path'], 'utf8')).length, 3);
        const csv = fs.readFileSync(o['csv-path'], 'utf8').trim().split('\r\n');
        assert.equal(csv.length, 4); assert.match(csv[0], /^baseObligationDate,changeType,recipientName,/);
        assert.match(csv[1], /"Acme 1, Inc\."/);
        const sum = t.summary();
        assert.match(sum, /3 row\(s\)/); assert.match(sum, /\| baseObligationDate \| changeType \|/); assert.match(sum, new RegExp(`console\\.apify\\.com/view/runs/${o['run-id']}`));
        assert.match(sum, /monitor `va-it`/);
        assert.ok(sum.includes('[link](https://www.usaspending.gov/award/CONT_AWD_1)'), 'full URL kept in summary links');
        assert.match(t.out, /::add-mask::apify_api_TESTTOKEN1234567890/);
        assert.equal(mock.state.issues.length, 0, 'open-issue defaults to false');
    } finally { await mock.close(); }
});

test('pagination: fetches 2+ pages of dataset items', async () => {
    const items = Array.from({ length: 2500 }, (_, i) => award(i));
    const mock = await startMock({ items });
    const t = setup(mock, { 'output-format': 'json' });
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, true, r.error);
        const pages = mock.state.requests.filter((q) => q.path.includes('/items'));
        assert.equal(pages.length, 3);
        assert.deepEqual(pages.map((p) => p.query.offset), ['0', '1000', '2000']);
        assert.equal(t.outputs()['item-count'], '2500');
        const j = JSON.parse(fs.readFileSync(t.outputs()['json-path'], 'utf8'));
        assert.equal(j.length, 2500); assert.equal(j[2499].id, 'CONT_AWD_2499');
        assert.equal(t.outputs()['csv-path'], undefined);
    } finally { await mock.close(); }
});

test('exact multiple of the page size stops at the pagination total (empty page without the header)', async () => {
    const mock = await startMock({ items: Array.from({ length: 2000 }, (_, i) => award(i)) });
    const t = setup(mock, { 'output-format': 'csv' });
    try {
        assert.equal((await run(t.opts)).ok, true);
        assert.equal(mock.state.requests.filter((q) => q.path.includes('/items')).length, 2);
        assert.equal(t.outputs()['item-count'], '2000');
    } finally { await mock.close(); }
});

test('0 rows: succeeds, writes empty files, says so in the summary, no issue even with open-issue', async () => {
    const mock = await startMock({ items: [] });
    const t = setup(mock, { 'open-issue': 'true', 'github-token': GH });
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, true, r.error);
        assert.equal(t.outputs()['item-count'], '0');
        assert.equal(fs.readFileSync(t.outputs()['csv-path'], 'utf8'), '');
        assert.equal(fs.readFileSync(t.outputs()['json-path'], 'utf8').trim(), '[]');
        assert.match(t.summary(), /No new rows since the last run of this monitor/);
        assert.equal(mock.state.issues.length, 0);
        assert.equal(mock.state.requests.filter((q) => q.path.startsWith('/repos')).length, 0);
        assert.match(t.out, /0 rows, no issue created/);
    } finally { await mock.close(); }
});

for (const status of ['FAILED', 'TIMED-OUT', 'ABORTED']) {
    test(`${status} run: fails clearly but still writes the summary, outputs and partial rows`, async () => {
        const mock = await startMock({ items: [award(1)], statuses: ['RUNNING', status], statusMessage: 'USAspending returned 500' });
        const t = setup(mock);
        try {
            const r = await run(t.opts);
            assert.equal(r.ok, false);
            assert.match(r.error, new RegExp(`ended with status ${status}: USAspending returned 500`));
            assert.match(t.out, /::error::The Actor run ended with status/);
            const o = t.outputs();
            assert.equal(o['run-status'], status); assert.equal(o['item-count'], '1'); assert.ok(o['run-id']);
            assert.ok(fs.existsSync(o['csv-path']));
            const sum = t.summary();
            assert.match(sum, new RegExp(`❌ ${status}`)); assert.match(sum, /\*\*Error:\*\*/); assert.match(sum, /console\.apify\.com\/view\/runs\//);
        } finally { await mock.close(); }
    });
}

test('poll timeout: stops waiting at wait-timeout-secs, aborts gracefully, fails, still writes summary', async () => {
    const mock = await startMock({ items: [award(1)], statuses: ['RUNNING'] });
    const t = setup(mock, { 'wait-timeout-secs': '5' });
    let clock = 0;
    t.opts.now = () => clock;
    t.opts.sleep = async (ms) => { clock += Math.max(ms, 1); };
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, false);
        assert.match(r.error, /did not finish within wait-timeout-secs \(5s\)/);
        assert.match(r.error, /graceful abort; status now ABORTED/);
        assert.equal(mock.state.aborted.gracefully, 'true');
        assert.ok(clock >= 5000 && clock < 60000, `virtual clock ${clock}`);
        assert.match(t.summary(), /action wait timeout/);
        assert.equal(t.outputs()['item-count'], '1');
    } finally { await mock.close(); }
});

test('poll timeout with abort-on-timeout false leaves the run alone', async () => {
    const mock = await startMock({ statuses: ['RUNNING'] });
    const t = setup(mock, { 'wait-timeout-secs': '3', 'abort-on-timeout': 'false' });
    let clock = 0; t.opts.now = () => clock; t.opts.sleep = async (ms) => { clock += Math.max(ms, 1); };
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, false); assert.equal(mock.state.aborted, undefined); assert.match(r.error, /keeps running on Apify/);
    } finally { await mock.close(); }
});

test('poll backoff grows and is capped; transient 503 is retried', async () => {
    const mock = await startMock({ statuses: ['READY', 'RUNNING', 'RUNNING', 'RUNNING', 'RUNNING', 'RUNNING', 'SUCCEEDED'], flaky: true });
    const t = setup(mock);
    const sleeps = []; t.opts.sleep = async (ms) => { sleeps.push(ms); };
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, true, r.error);
        const backoff = sleeps.filter((ms) => ms !== 2000); // 2000 = the 503 retry
        assert.ok(backoff.length >= 4);
        for (let i = 1; i < backoff.length; i++) assert.ok(backoff[i] >= backoff[i - 1]);
        assert.ok(Math.max(...backoff) <= 15000);
    } finally { await mock.close(); }
});

test('CSV escaping: commas, quotes, newlines, nested objects and arrays', () => {
    const csv = toCsv([
        { a: 'plain', b: 'x,y', c: 'say "hi"', d: 'line1\nline2', e: { f: 1, g: { h: 'deep' } }, arr: ['VA', 'MD'], objs: [{ k: 1 }], n: null, t: true, sp: ' lead' },
        { a: 'second', z: 'only here', e: {} },
    ]);
    const lines = csv.split('\r\n');
    assert.equal(lines[0], 'a,b,c,d,e.f,e.g.h,arr,objs,n,t,sp,z');
    assert.equal(csv.split('\r\n')[1], 'plain,"x,y","say ""hi""","line1\nline2",1,deep,VA; MD,"[{""k"":1}]",,true," lead",'.split('\r\n')[0]);
    assert.ok(csv.startsWith('a,b,c,d,e.f,e.g.h,arr,objs,n,t,sp,z\r\nplain,"x,y","say ""hi""","line1\nline2",1,deep,VA; MD,"[{""k"":1}]",,true," lead",\r\n'));
    assert.ok(csv.endsWith('second,,,,,,,,,,,only here\r\n'));
    assert.equal(csvCell('a\r\nb'), '"a\r\nb"');
    assert.equal(csvCell(0), '0');
    assert.deepEqual(flatten({ a: { b: { c: { d: { e: 1 } } } } }), { 'a.b.c.d': '{"e":1}' });
    assert.equal(toCsv([]), '');
});

test('token redaction: Apify error echoing the token never leaks it (logs, summary, outputs, files)', async () => {
    const mock = await startMock({ startError: { code: 400, type: 'invalid-input', message: `Bad input for token ${TOKEN} (Authorization: Bearer ${TOKEN}) ?token=${TOKEN}` } });
    const t = setup(mock, { 'open-issue': 'true', 'github-token': GH, 'input-json': '{"samApiKey":"SAM-SECRET-KEY-123"}' });
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, false);
        assert.match(r.error, /<REDACTED>/);
        const everything = [t.out.replace(/::add-mask::.*\n/g, ''), t.summary(), t.allFiles(), r.error].join('\n');
        assert.ok(!everything.includes(TOKEN), 'apify token leaked');
        assert.ok(!everything.includes(GH), 'github token leaked');
        assert.ok(!everything.includes('SAM-SECRET-KEY-123'), 'secret-looking input leaked');
        assert.match(t.out, /::add-mask::SAM-SECRET-KEY-123/);
        assert.match(t.out, /::add-mask::ghs_testgithubtoken/);
    } finally { await mock.close(); }
});

test('token redaction: invalid token error (401) is clear and redacted', async () => {
    const mock = await startMock({ token: 'apify_api_SOMETHINGELSE00000' });
    const t = setup(mock);
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, false);
        assert.match(r.error, /Starting the Actor run failed: HTTP 401 \(user-or-token-not-found\)/);
        assert.ok(!(t.out + t.summary()).replace(/::add-mask::.*\n/g, '').includes(TOKEN));
    } finally { await mock.close(); }
});

test('redactor covers bearer, query params and apify_api_ patterns', () => {
    const red = makeRedactor(['s3cr3tvalue']);
    assert.equal(red('x s3cr3tvalue y'), 'x <REDACTED> y');
    assert.equal(red('Bearer abc.def'), 'Bearer <REDACTED>');
    assert.equal(red('u?token=abc&x=1'), 'u?token=<REDACTED>&x=1');
    assert.equal(red('key apify_api_ABCDEFGHIJKLMN'), 'key apify_api_<REDACTED>');
});

test('missing apify-token fails clearly without starting a run', async () => {
    const mock = await startMock();
    const t = setup(mock, { 'apify-token': '' });
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, false); assert.match(r.error, /apify-token is required/);
        assert.equal(mock.state.requests.length, 0);
        assert.match(t.summary(), /NOT STARTED/);
    } finally { await mock.close(); }
});

test('issue creation on: one issue per run listing the rows, with labels and a run link', async () => {
    const mock = await startMock({ items: [award(1), { ...award(2), recipientName: 'Pipe | Co' }] });
    const t = setup(mock, { 'open-issue': 'true', 'github-token': GH, 'issue-labels': 'govcon, awards' });
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, true, r.error);
        assert.equal(mock.state.issues.length, 1);
        const is = mock.state.issues[0];
        assert.match(is.title, /^Federal Contract Award Winners Feed: 2 new row\(s\) \d{4}-\d{2}-\d{2} \(run RUN1/);
        assert.deepEqual(is.labels, ['govcon', 'awards']);
        assert.match(is.body, /Acme 1, Inc\./); assert.match(is.body, /Pipe \\\| Co/); assert.match(is.body, /console\.apify\.com\/view\/runs\//);
        assert.equal(t.outputs()['issue-url'], 'https://github.com/acme/bids/issues/1');
        const req = mock.state.requests.find((q) => q.path === '/repos/acme/bids/issues');
        assert.equal(req.headers.authorization, `Bearer ${GH}`);
        assert.ok(!req.body.includes(TOKEN));
    } finally { await mock.close(); }
});

test('issue append: issue-number adds a comment instead of a new issue', async () => {
    const mock = await startMock({ items: [award(1)] });
    const t = setup(mock, { 'open-issue': 'true', 'github-token': GH, 'issue-number': '7' });
    try {
        assert.equal((await run(t.opts)).ok, true);
        assert.equal(mock.state.issues.length, 0); assert.equal(mock.state.comments.length, 1); assert.equal(mock.state.comments[0].issue, 7);
    } finally { await mock.close(); }
});

test('issue creation off: no GitHub call even with a token', async () => {
    const mock = await startMock({ items: [award(1)] });
    const t = setup(mock, { 'open-issue': 'false', 'github-token': GH });
    try {
        assert.equal((await run(t.opts)).ok, true);
        assert.equal(mock.state.requests.filter((q) => q.path.startsWith('/repos')).length, 0);
        assert.equal(t.outputs()['issue-url'], undefined);
    } finally { await mock.close(); }
});

test('issue errors: missing github-token or 403 fail the step after writing files; failed run rows still get an issue', async () => {
    let mock = await startMock({ items: [award(1)] });
    let t = setup(mock, { 'open-issue': 'true' });
    try { const r = await run(t.opts); assert.equal(r.ok, false); assert.match(r.error, /github-token is empty/); assert.ok(fs.existsSync(t.outputs()['csv-path'])); } finally { await mock.close(); }
    mock = await startMock({ items: [award(1)], githubFail: true });
    t = setup(mock, { 'open-issue': 'true', 'github-token': GH });
    try { const r = await run(t.opts); assert.equal(r.ok, false); assert.match(r.error, /Creating the issue failed: HTTP 403/); } finally { await mock.close(); }
    mock = await startMock({ items: [award(1)], statuses: ['FAILED'] });
    t = setup(mock, { 'open-issue': 'true', 'github-token': GH });
    try { const r = await run(t.opts); assert.equal(r.ok, false); assert.equal(mock.state.issues.length, 1); assert.match(mock.state.issues[0].body, /ended with status FAILED/); } finally { await mock.close(); }
});

test('alias resolution and monitor/max-items field mapping', () => {
    for (const [alias, cfg] of Object.entries(ACTORS)) {
        assert.equal(resolveActor(alias).apiId, cfg.id);
        assert.equal(resolveActor(alias.toUpperCase()).apiId, cfg.id);
        assert.equal(resolveActor(cfg.id).alias, alias);
        assert.equal(resolveActor(cfg.name).alias, alias);
        assert.equal(resolveActor(cfg.name.replace('/', '~')).alias, alias);
    }
    assert.equal(resolveActor('someone/other-actor').apiId, 'someone~other-actor');
    assert.equal(resolveActor('ABCDEFGHIJKLMNOPQ').alias, null);
    assert.throws(() => resolveActor('nope'), /Unknown actor/);
    assert.throws(() => resolveActor(''), /actor is required/);
    const fd = buildActorInput(resolveActor('formd'), '{"states":["CA"]}', { monitorName: 'tech-ca', maxItems: 10 });
    assert.deepEqual(fd.input, { states: ['CA'], stateKey: 'tech-ca', maxFilings: 10 }); assert.equal(fd.stateful, true);
    const sam = buildActorInput(resolveActor('sam'), '{"naicsCodes":["541512"]}', { monitorName: '8a-it' });
    assert.deepEqual(sam.input, { naicsCodes: ['541512'], monitorName: '8a-it' });
    assert.equal(buildActorInput(resolveActor('recompete'), '{"stateKey":"legacy"}').stateful, true);
    assert.equal(buildActorInput(resolveActor('awards'), '{}').stateful, false);
    assert.equal(buildActorInput(resolveActor('awards'), '{"monitorName":"  "}').stateful, false);
    const warns = []; buildActorInput(resolveActor('awards'), '{"monitorName":"a"}', { monitorName: 'b' }, (w) => warns.push(w));
    assert.match(warns[0], /overrides monitorName "a"/);
    assert.throws(() => buildActorInput(resolveActor('awards'), '[1]'), /must be a JSON object/);
    assert.throws(() => buildActorInput(resolveActor('awards'), '{bad'), /not valid JSON/);
});

test('alias formd end to end sends stateKey/maxFilings to the Form D Actor id; stateless run warns', async () => {
    const mock = await startMock({ items: [] });
    const t = setup(mock, { actor: 'formd', 'monitor-name': 'tech-ca-ny', 'max-items': '20' });
    try {
        assert.equal((await run(t.opts)).ok, true);
        const start = mock.state.requests.find((q) => q.path.endsWith('/runs'));
        assert.equal(start.path, `/v2/acts/${ACTORS.formd.id}/runs`);
        assert.deepEqual(JSON.parse(start.body), { stateKey: 'tech-ca-ny', maxFilings: 20 });
    } finally { await mock.close(); }
    const mock2 = await startMock({ items: [] });
    const t2 = setup(mock2, { actor: 'cce_partners/govcon-recompete-radar', 'monitor-name': '' });
    try {
        assert.equal((await run(t2.opts)).ok, true);
        assert.equal(mock2.state.requests.find((q) => q.path.endsWith('/runs')).path, `/v2/acts/${ACTORS.recompete.id}/runs`);
        assert.match(t2.out, /::warning::No monitor name/);
        assert.match(t2.summary(), /stateless/);
    } finally { await mock2.close(); }
});

test('input validation: bad output-format and memory fail before any request', async () => {
    const mock = await startMock();
    try {
        let t = setup(mock, { 'output-format': 'xml' }); let r = await run(t.opts); assert.match(r.error, /output-format must be csv, json or both/);
        t = setup(mock, { 'memory-mbytes': '500' }); r = await run(t.opts); assert.match(r.error, /power of 2/);
        assert.equal(mock.state.requests.length, 0);
    } finally { await mock.close(); }
});

test('markdown table: long URLs are not truncated, pipes and HTML are escaped', async () => {
    const { markdownTable } = await import('../src/main.js');
    const long = `https://www.usaspending.gov/award/${'X'.repeat(120)}`;
    const md = markdownTable([{ u: long, t: 'a|b <script>', n: 'y'.repeat(200) }], ['u', 't', 'n'], 5);
    assert.ok(md.includes(`[link](${long})`));
    assert.ok(md.includes('a\\|b &lt;script&gt;'));
    assert.ok(md.includes('…'));
});

test('pollRun never sleeps past the deadline', async () => {
    let clock = 0; const sleeps = [];
    const apify = { getRun: async (id) => ({ id, status: 'RUNNING' }) };
    const r = await pollRun(apify, { id: 'x', status: 'READY' }, { waitTimeoutSecs: 10, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, log: () => {}, waitForFinishMax: 0 });
    assert.equal(r.timedOut, true); assert.equal(clock, 10000);
});

test('entrypoint (subprocess): exit code 1 on failure, masks token, never prints it otherwise', async () => {
    const mock = await startMock({ items: [award(1)], statuses: ['FAILED'], statusMessage: `oops ${TOKEN}` });
    const t = setup(mock);
    try {
        const env = { PATH: process.env.PATH, ...t.env, TEST_MOCK_BASE: mock.base };
        const { code, out } = await new Promise((resolve) => {
            const c = spawn(process.execPath, ['--import', path.join(ROOT, 'test/helpers/redirect-fetch.mjs'), path.join(ROOT, 'src/index.js')], { env });
            let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; });
            c.on('close', (code) => resolve({ code, out: o }));
        });
        assert.equal(code, 1);
        assert.match(out, /\[test-preload\] origin https:\/\/api\.apify\.com/, 'entrypoint targets api.apify.com');
        assert.doesNotMatch(out, /refused non-Apify origin/);
        const lines = out.split('\n');
        assert.equal(lines[0], `::add-mask::${TOKEN}`, 'mask is the first thing printed');
        assert.ok(!lines.slice(1).join('\n').includes(TOKEN), 'token printed after masking');
        assert.match(out, /::error::The Actor run ended with status FAILED: oops <REDACTED>/);
        assert.ok(!t.summary().includes(TOKEN) && !t.allFiles().includes(TOKEN));
    } finally { await mock.close(); }
});
