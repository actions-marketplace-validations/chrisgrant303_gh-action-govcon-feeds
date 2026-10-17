// Local mock of the Apify API (v2) and the GitHub REST API, for tests only.
import http from 'node:http';

export async function startMock(scenario = {}) {
    const state = { requests: [], runs: {}, issues: [], comments: [], polls: 0 };
    const s = {
        items: [], statuses: ['RUNNING', 'SUCCEEDED'], token: 'apify_api_TESTTOKEN1234567890', statusMessage: null,
        startError: null, githubFail: false, ...scenario,
    };
    const server = http.createServer(async (req, res) => {
        let body = '';
        for await (const c of req) body += c;
        const url = new URL(req.url, 'http://x');
        state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
        const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        // GitHub
        if (url.pathname.startsWith('/repos/')) {
            if (req.headers.authorization !== `Bearer ${s.githubToken || 'ghs_testgithubtoken'}`) return send(401, { message: 'Bad credentials' });
            if (s.githubFail) return send(403, { message: 'Resource not accessible by integration' });
            const m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)\/comments)?$/);
            if (m && req.method === 'POST') {
                const b = JSON.parse(body);
                if (m[2]) { state.comments.push({ issue: Number(m[2]), ...b }); return send(201, { html_url: `https://github.com/${m[1]}/issues/${m[2]}#issuecomment-1` }); }
                state.issues.push(b); return send(201, { number: state.issues.length, html_url: `https://github.com/${m[1]}/issues/${state.issues.length}` });
            }
            return send(404, { message: 'Not Found' });
        }
        // Apify
        if (req.headers.authorization !== `Bearer ${s.token}`) return send(401, { error: { type: 'user-or-token-not-found', message: 'User was not found or authentication token is not valid' } });
        let m;
        if (req.method === 'POST' && (m = url.pathname.match(/^\/v2\/acts\/([^/]+)\/runs$/))) {
            if (s.startError) return send(s.startError.code, { error: { type: s.startError.type, message: s.startError.message } });
            const id = `RUN${Object.keys(state.runs).length + 1}xxxxxxxxxxxx`.slice(0, 17);
            state.runs[id] = { id, actId: decodeURIComponent(m[1]), status: 'READY', defaultDatasetId: `DS${id}`, buildNumber: '0.1.10', input: JSON.parse(body || '{}'), i: 0 };
            return send(201, { data: { ...state.runs[id] } });
        }
        if (req.method === 'GET' && (m = url.pathname.match(/^\/v2\/actor-runs\/([^/]+)$/))) {
            const r = state.runs[m[1]]; if (!r) return send(404, { error: { type: 'record-not-found', message: 'not found' } });
            state.polls++;
            if (s.pollFail) return send(500, { error: { type: 'internal-server-error', message: 'poll failure' } });
            if (s.flaky && state.polls === 1) return send(503, { error: { type: 'internal-server-error', message: 'try again' } });
            if (!r.aborted) { r.status = s.statuses[Math.min(r.i, s.statuses.length - 1)]; r.i++; }
            const out = { ...r, statusMessage: s.statusMessage };
            if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(r.status)) Object.assign(out, { chargedEventCounts: { 'apify-actor-start': 1, 'award-row': s.items.length }, usageTotalUsd: 0.01 + 0.005 * s.items.length });
            return send(200, { data: out });
        }
        if (req.method === 'POST' && (m = url.pathname.match(/^\/v2\/actor-runs\/([^/]+)\/abort$/))) {
            const r = state.runs[m[1]]; r.status = 'ABORTED'; r.aborted = true; state.aborted = { id: r.id, gracefully: url.searchParams.get('gracefully') };
            return send(200, { data: { ...r } });
        }
        if (req.method === 'GET' && (m = url.pathname.match(/^\/v2\/datasets\/([^/]+)\/items$/))) {
            // Like Apify: offset/limit apply to the RAW items; clean/skipEmpty then drop empty items, so a page can come back short.
            const off = Number(url.searchParams.get('offset') || 0); const lim = Number(url.searchParams.get('limit') || 1000);
            let page = s.items.slice(off, off + lim);
            const truthy = (v) => v === '1' || v === 'true';
            if (truthy(url.searchParams.get('clean')) || truthy(url.searchParams.get('skipEmpty'))) page = page.filter((it) => !(it && typeof it === 'object' && !Array.isArray(it) && !Object.keys(it).length));
            const headers = { 'content-type': 'application/json' };
            if (!s.noTotalHeader) Object.assign(headers, { 'x-apify-pagination-total': String(s.items.length), 'x-apify-pagination-offset': String(off), 'x-apify-pagination-limit': String(lim) });
            res.writeHead(200, headers); return res.end(JSON.stringify(page));
        }
        return send(404, { error: { type: 'page-not-found', message: `no route ${req.method} ${url.pathname}` } });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, state, scenario: s, close: () => new Promise((r) => server.close(r)) };
}
