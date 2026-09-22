import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function run(script: string) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        const { ensureKey, enhancer, channelRouter } = await import('./src/tokenone.ts');
        const { db } = await import('./src/db.ts');
        const user = { id: 'local-user', email_verified: true, issuer: 'https://idone.test', subject: 'verified-sub', email: 'private@example.test', username: 'private' };
        ${script}
    `], {
        cwd: new URL("../", import.meta.url), encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test",
            DATABASE_URL: "postgresql://unused:unused@localhost/unused", APP_ORIGIN: "https://app.test",
            IDONE_ISSUER: "https://idone.test", IDONE_DISCOVERY_URL: "", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test",
            ADMIN_SUBJECTS: "admin", ENHANCER_BASE_URL: "https://enhancer.test", ENHANCER_APP_CREDENTIAL: "app-test", TOKENONE_BASE_URL: "https://tokenone.test" },
    });
    assert.equal(result.status, 0, result.stderr);
}

test("v2 ensure sends only verified identity and preserves decimal IDs and the current default group", () => run(`
    const writes = [];
    db.query = async (...args) => { writes.push(args); return { rows: [] }; };
    let group = '9007199254740993';
    globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://enhancer.test/api/apps/keys/ensure');
        assert.equal(init.headers.Authorization, 'Bearer app-test');
        assert.equal(init.headers['X-Request-Id'], 'trace-test');
        assert.equal(init.cache, 'no-store');
        assert.deepEqual(JSON.parse(init.body), { identity: { issuer: user.issuer, subject: user.subject } });
        return Response.json({ status: 'ready', tokenone_user_id: '9007199254740995', api_key: { id: '9007199254740997', key: 'sk-test', group_id: group, status: 'active' } });
    };
    assert.equal((await ensureKey(user, 'trace-test')).group_id, group);
    assert.deepEqual(writes[0][1], ['local-user', group, '9007199254740995', '9007199254740997']);
    assert.ok(!JSON.stringify(writes).includes('sk-test'));
    group = '9';
    assert.equal((await ensureKey(user, 'trace-test')).group_id, '9');
`));

test("Enhance failures retain safe v2 codes without retries or replacement accounts", () => run(`
    const { modelErrorMessage } = await import('./src/model-errors.ts');
    for (const [status, code] of [[503, 'TOKENONE_USER_NOT_FOUND'], [409, 'APP_KEY_UNAVAILABLE'], [409, 'IDENTITY_CONFLICT'], [403, 'SCOPE_FORBIDDEN'], [401, 'UNAUTHORIZED'], [503, 'APP_KEY_RECOVERY_UNAVAILABLE']]) {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return Response.json({ error: code, retryable: true, detail: 'sk-private' }, { status }); };
        await assert.rejects(ensureKey(user, 'trace'), { code, status: status === 401 ? 502 : status });
        assert.equal(calls, 1);
        assert.ok(modelErrorMessage(code));
    }
    globalThis.fetch = async () => Response.json({ error: 'sk-private' }, { status: 503 });
    await assert.rejects(ensureKey(user, 'trace'), { code: 'ENHANCER_FAILED' });
`));

test("malformed upstream Key IDs are upstream errors and unverified users never request a Key", () => run(`
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({ status: 'ready', tokenone_user_id: '42', api_key: { id: '701', key: 'sk-test', group_id: 8, status: 'active' } }); };
    await assert.rejects(ensureKey(user, 'trace'), { code: 'ENHANCER_INVALID_RESPONSE', status: 502 });
    await assert.rejects(ensureKey({ ...user, email_verified: false }, 'trace'), { code: 'EMAIL_NOT_VERIFIED' });
    assert.equal(calls, 1);
`));

test("account and usage routes enforce session identity and preserve amounts, pagination and query errors", () => run(`
    const { default: express } = await import('express');
    const app = express();
    app.use(express.json(), (_req, res, next) => { res.locals.user = user; res.locals.requestId = 'trace'; next(); }, channelRouter);
    app.use((error, _req, res, _next) => res.status(error.status || 400).json({ error: error.code || 'INVALID_REQUEST' }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const realFetch = globalThis.fetch;
    let calls = 0, fail = false;
    globalThis.fetch = async (url, init) => {
        calls++;
        assert.ok(["account/summary", "usage/query", "usage/stats"].some(path => url === "https://enhancer.test/api/apps/" + path));
        const body = JSON.parse(init.body);
        assert.deepEqual(body.identity, { issuer: user.issuer, subject: user.subject });
        if (fail) return Response.json({ error: 'INVALID_OR_EXPIRED_CURSOR' }, { status: 400 });
        if (url.endsWith('/summary')) return Response.json({ wallet: { balance: '1.0000000001' }, keys: [] });
        assert.equal(body.cursor, 'opaque-cursor');
        return Response.json({ items: [{ id: '9007199254740993' }], has_more: true, next_cursor: 'next', snapshot_cursor: 'snapshot', totals: { metered_cost: '0.1000000001' } });
    };
    const call = (path, body) => realFetch('http://127.0.0.1:' + server.address().port + '/tokenone' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
        assert.equal((await call('/account/summary', { identity: { subject: 'forged' } })).status, 400);
        assert.equal(calls, 0);
        assert.equal((await (await call('/account/summary', {})).json()).wallet.balance, '1.0000000001');
        const query = { from: '2026-09-01T00:00:00+08:00', to: '2026-09-02T00:00:00+08:00', cursor: 'opaque-cursor' };
        const page = await (await call('/usage/query', query)).json();
        assert.equal(page.items[0].id, '9007199254740993');
        assert.equal(page.next_cursor, 'next');
        assert.equal((await (await call('/usage/stats', query)).json()).totals.metered_cost, '0.1000000001');
        fail = true;
        assert.equal((await (await call('/usage/query', query)).json()).error, 'INVALID_OR_EXPIRED_CURSOR');
    } finally { server.close(); server.closeAllConnections(); }
`));

test("admin model discovery protects access and returns only unique model IDs", () => run(`
    const { default: express } = await import('express');
    const app = express();
    app.use((_req, res, next) => { res.locals.user = user; res.locals.requestId = 'trace'; next(); }, channelRouter);
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const realFetch = globalThis.fetch;
    let calls = 0, failure = false;
    db.query = async () => ({ rows: [] });
    globalThis.fetch = async (url, init) => {
        calls++;
        if (url.endsWith('/keys/ensure')) return Response.json({ status: 'ready', tokenone_user_id: '42', api_key: { id: '701', key: 'sk-private', group_id: '5', status: 'active' } });
        assert.equal(url, 'https://tokenone.test/v1/models');
        assert.equal(init.headers.Authorization, 'Bearer sk-private');
        if (failure) return Response.json({ code: 'INSUFFICIENT_BALANCE', message: 'private details' }, { status: 403 });
        return Response.json({ data: [{ id: 'image-model', private: 'sk-private' }, { id: 'text-model' }, { id: 'image-model' }] });
    };
    const call = () => realFetch('http://127.0.0.1:' + server.address().port + '/admin/models');
    try {
        assert.equal((await call()).status, 403);
        assert.equal(calls, 0);
        user.subject = 'admin';
        const response = await call();
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { models: ['image-model', 'text-model'] });
        failure = true;
        const failed = await call();
        assert.equal(failed.status, 403);
        assert.deepEqual(await failed.json(), { error: 'INSUFFICIENT_BALANCE' });
        assert.equal(calls, 4);
    } finally { server.close(); server.closeAllConnections(); }
`));

test("feature configuration requires a listed default model and permits empty disabled features", () => run(`
    const { featureModelsSchema } = await import('./src/tokenone.ts');
    assert.equal(featureModelsSchema.safeParse({ models: [], default_model: '', enabled: false }).success, true);
    assert.equal(featureModelsSchema.safeParse({ models: [], default_model: '', enabled: true }).success, false);
    assert.equal(featureModelsSchema.safeParse({ models: ['image-a'], default_model: 'image-b', enabled: true }).success, false);
    assert.equal(featureModelsSchema.safeParse({ models: ['image-a'], default_model: 'image-a', enabled: true, name: 'extra' }).success, false);
    assert.equal(featureModelsSchema.safeParse({ models: ['image-a', 'image-b'], default_model: 'image-b', enabled: true }).success, true);
`));
