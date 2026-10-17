// TEST-ONLY preload (node --import): keeps the entrypoint subprocess offline by rewriting requests for
// https://api.apify.com to the local mock in TEST_MOCK_BASE. Any other origin is refused. Never shipped in a code path.
const mock = process.env.TEST_MOCK_BASE;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
    const u = new URL(String(url));
    if (u.origin !== 'https://api.apify.com') return Promise.reject(new Error(`test preload refused non-Apify origin ${u.origin}`));
    process.stderr.write(`[test-preload] origin ${u.origin}\n`);
    return realFetch(`${mock}${u.pathname}${u.search}`, init);
};
