// Regression tests for REVIEW-010 (B1-B3, N1-N8). Written before the fixes; see the evidence for fail-before/pass-after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-server.js';
import { run } from '../src/main.js';

const TOKEN = 'apify_api_TESTTOKEN1234567890';
const GH = 'ghs_testgithubtoken';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function setup(mock, inputs = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghx-r010-'));
    // apiBase is the test-only injection point; the env var is set too so the pre-fix code also reaches the mock.
    const env = { CCE_APIFY_API_BASE_URL: mock.base, GITHUB_API_URL: mock.base, GITHUB_REPOSITORY: 'acme/bids',
        GITHUB_OUTPUT: path.join(dir, 'out.txt'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md') };
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
    return { env, opts, get out() { return out; }, outputs, summary };
}
const award = (i) => ({ id: `CONT_AWD_${i}`, recipientName: `Acme ${i}`, awardAmount: 1000 + i, naicsCode: '541512', changeType: 'new' });
const startReq = (mock) => mock.state.requests.find((q) => q.method === 'POST' && q.path.endsWith('/runs'));
const masks = (out) => out.split('\n').filter((l) => l.startsWith('::add-mask::')).map((l) => l.slice('::add-mask::'.length));

// ---- B1 ----
test('B1: action.yml runs on node24 and the README says Node 24', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
    assert.match(yml, /^\s+using:\s*'node24'\s*$/m);
    assert.doesNotMatch(yml, /node20/);
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.match(readme, /Node 24/);
    assert.doesNotMatch(readme, /Node 20/);
});

// ---- B2 ----
test('B2: SAM keyword "cyber" is NOT masked or redacted', async () => {
    const mock = await startMock({ items: [{ title: 'cyber security services', samUrl: 'https://sam.gov/opp/1' }] });
    const t = setup(mock, { actor: 'sam', 'monitor-name': 'cyber-daily', 'input-json': '{"keywords":"cyber"}' });
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, true, r.error);
        assert.deepEqual(masks(t.out), [TOKEN]);
        assert.match(t.summary(), /cyber security services/);
        assert.doesNotMatch(t.summary(), /REDACTED/);
    } finally { await mock.close(); }
});

test('B2: Form D monitor name (stateKey) is NOT masked or redacted', async () => {
    const mock = await startMock({ items: [] });
    const t = setup(mock, { actor: 'formd', 'monitor-name': 'tech-ca-ny' });
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, true, r.error);
        assert.ok(!masks(t.out).includes('tech-ca-ny'));
        assert.match(t.summary(), /monitor `tech-ca-ny`/);
        assert.match(t.out, /monitor "tech-ca-ny"/);
    } finally { await mock.close(); }
});

test('B2: allowlisted samApiKey and aiApiKey ARE masked and redacted; other *Key/*token-named fields are not', async () => {
    const mock = await startMock({ items: [], startError: { code: 400, type: 'invalid-input', message: 'echo SAMKEY-VALUE-123 and AIKEY-VALUE-456 and stateKey legacy-name' } });
    const t = setup(mock, { actor: 'sam', 'monitor-name': '', 'input-json': '{"samApiKey":"SAMKEY-VALUE-123","aiApiKey":"AIKEY-VALUE-456","stateKey":"legacy-name","keywords":"tokenization"}' });
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, false);
        const m = masks(t.out);
        assert.ok(m.includes('SAMKEY-VALUE-123') && m.includes('AIKEY-VALUE-456'));
        assert.ok(!m.includes('legacy-name') && !m.includes('tokenization'));
        assert.ok(!r.error.includes('SAMKEY-VALUE-123') && !r.error.includes('AIKEY-VALUE-456'));
        assert.match(r.error, /legacy-name/);
    } finally { await mock.close(); }
});

// ---- B3 ----
test('B3: 2,500 items with one empty item: all 2,500 returned, offset steps by the page limit', async () => {
    const items = Array.from({ length: 2500 }, (_, i) => (i === 10 ? {} : award(i)));
    const mock = await startMock({ items });
    const t = setup(mock, { 'output-format': 'json' });
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, true, r.error);
        assert.equal(t.outputs()['item-count'], '2500');
        const pages = mock.state.requests.filter((q) => q.path.includes('/items'));
        assert.deepEqual(pages.map((p) => p.query.offset), ['0', '1000', '2000']);
        for (const p of pages) { assert.ok(!['1', 'true'].includes(p.query.clean)); assert.ok(!['1', 'true'].includes(p.query.skipEmpty)); }
        const j = JSON.parse(fs.readFileSync(t.outputs()['json-path'], 'utf8'));
        assert.equal(j.length, 2500); assert.deepEqual(j[10], {}); assert.equal(j[2499].id, 'CONT_AWD_2499');
    } finally { await mock.close(); }
});

test('B3: without a total header, paging stops on the first empty page', async () => {
    const mock = await startMock({ items: Array.from({ length: 1500 }, (_, i) => award(i)), noTotalHeader: true });
    const t = setup(mock, { 'output-format': 'json' });
    try {
        assert.equal((await run(t.opts)).ok, true);
        assert.equal(t.outputs()['item-count'], '1500');
        assert.deepEqual(mock.state.requests.filter((q) => q.path.includes('/items')).map((p) => p.query.offset), ['0', '1000', '2000']);
    } finally { await mock.close(); }
});

// ---- N1 ----
test('N1: CR/LF in Apify status messages cannot inject workflow commands', async () => {
    const mock = await startMock({ items: [], statuses: ['RUNNING', 'SUCCEEDED'], statusMessage: 'working\r\n::warning::INJECTED\n::stop-commands::x' });
    const t = setup(mock);
    try {
        assert.equal((await run(t.opts)).ok, true);
        const lines = t.out.split('\n');
        assert.ok(!lines.some((l) => l.startsWith('::warning::INJECTED') || l.startsWith('::stop-commands::')), t.out);
        assert.ok(!t.out.includes('\r'));
        assert.match(t.out, /working ::warning::INJECTED ::stop-commands::x/);
    } finally { await mock.close(); }
});

// ---- N2 ----
test('N2: invalid input-json gives a generic message without echoing the input', async () => {
    const mock = await startMock();
    const t = setup(mock, { 'input-json': '{"samApiKey":SAMSECRETVALUE123}' });
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, false);
        assert.match(r.error, /input-json is not valid JSON/);
        assert.ok(!r.error.includes('SAMSECRET') && !t.out.includes('SAMSECRET') && !t.summary().includes('SAMSECRET'));
        assert.doesNotMatch(r.error, /Unexpected token/);
        assert.equal(mock.state.requests.length, 0);
    } finally { await mock.close(); }
});

// ---- N3 ----
test('N3: the production path always calls https://api.apify.com, even if CCE_APIFY_API_BASE_URL is set', async () => {
    const realFetch = globalThis.fetch; const urls = [];
    globalThis.fetch = async (url, init) => { urls.push({ url: String(url), auth: init?.headers?.Authorization }); return new Response(JSON.stringify({ error: { type: 'x', message: 'stubbed' } }), { status: 401 }); };
    try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghx-n3-'));
        const env = { CCE_APIFY_API_BASE_URL: 'https://evil.example.com', APIFY_API_BASE_URL: 'https://evil2.example.com', GITHUB_STEP_SUMMARY: path.join(dir, 's.md'),
            'INPUT_APIFY-TOKEN': TOKEN, INPUT_ACTOR: 'awards', 'INPUT_MONITOR-NAME': 'x-mon', 'INPUT_OUTPUT-PATH': path.join(dir, 'o') };
        const r = await run({ env, stdout: () => {}, sleep: async () => {} }); // no apiBase: production defaults
        assert.equal(r.ok, false);
        assert.ok(urls.length >= 1);
        for (const u of urls) assert.equal(new URL(u.url).origin, 'https://api.apify.com', u.url);
    } finally { globalThis.fetch = realFetch; }
});

// ---- N4 ----
test('N4: max-total-charge-usd passes through as maxTotalChargeUsd; absent by default', async () => {
    let mock = await startMock({ items: [] });
    let t = setup(mock, { 'max-total-charge-usd': '2.5' });
    try { assert.equal((await run(t.opts)).ok, true); assert.equal(startReq(mock).query.maxTotalChargeUsd, '2.5'); } finally { await mock.close(); }
    mock = await startMock({ items: [] });
    t = setup(mock, {});
    try { assert.equal((await run(t.opts)).ok, true); assert.equal(startReq(mock).query.maxTotalChargeUsd, undefined); } finally { await mock.close(); }
    mock = await startMock({ items: [] });
    t = setup(mock, { 'max-total-charge-usd': '-1' });
    try { const r = await run(t.opts); assert.equal(r.ok, false); assert.match(r.error, /max-total-charge-usd/); assert.equal(mock.state.requests.length, 0); } finally { await mock.close(); }
});

// ---- N5 ----
test('N5: memory defaults to empty (the Actor default applies); an explicit value is still sent', async () => {
    const yml = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
    assert.match(yml, /memory-mbytes:\n(?:\s+.*\n)*?\s+default: ''/);
    let mock = await startMock({ items: [] });
    let t = setup(mock, { actor: 'sam', 'monitor-name': 'm1' });
    try { assert.equal((await run(t.opts)).ok, true); assert.equal(startReq(mock).query.memory, undefined); } finally { await mock.close(); }
    mock = await startMock({ items: [] });
    t = setup(mock, { 'memory-mbytes': '1024' });
    try { assert.equal((await run(t.opts)).ok, true); assert.equal(startReq(mock).query.memory, '1024'); } finally { await mock.close(); }
});

// ---- N6 ----
test('N6: when polling fails after retries, the run is aborted (best effort, logged) before the step fails', async () => {
    const mock = await startMock({ items: [], pollFail: true });
    const t = setup(mock);
    try {
        const r = await run(t.opts);
        assert.equal(r.ok, false);
        assert.match(r.error, /Reading the run status failed: HTTP 500/);
        assert.ok(mock.state.aborted, 'abort was requested');
        assert.equal(mock.state.aborted.gracefully, 'true');
        assert.match(t.out, /graceful abort/i);
        assert.match(t.outputs()['run-id'], /^RUN1/);
    } finally { await mock.close(); }
});

test('N6: abort-on-timeout false also skips the abort after a polling error', async () => {
    const mock = await startMock({ items: [], pollFail: true });
    const t = setup(mock, { 'abort-on-timeout': 'false' });
    try { const r = await run(t.opts); assert.equal(r.ok, false); assert.equal(mock.state.aborted, undefined); } finally { await mock.close(); }
});

// ---- N7 ----
test('N7: @mentions from dataset values are neutralized in the issue body', async () => {
    const mock = await startMock({ items: [{ ...award(1), recipientName: '@acme/team and @bob', awardingAgency: 'x@y.gov' }] });
    const t = setup(mock, { 'open-issue': 'true', 'github-token': GH });
    try {
        assert.equal((await run(t.opts)).ok, true);
        const body = mock.state.issues[0].body;
        assert.ok(body.includes('@\u200dacme/team and @\u200dbob'));
        assert.doesNotMatch(body, /@(?!\u200d)/);
    } finally { await mock.close(); }
});

// ---- N8 ----
test('N8: no example sends joinSam:true without a samApiKey', () => {
    const dir = path.join(ROOT, '.github/workflows/examples');
    for (const f of fs.readdirSync(dir)) {
        const y = fs.readFileSync(path.join(dir, f), 'utf8');
        if (/"joinSam"\s*:\s*true/.test(y)) assert.match(y, /samApiKey/, f);
    }
});
