import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function run(script: string) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        const { ensureKey, enhancer, channelRouter, modelProvider } = await import('./src/tokenone.ts');
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
    assert.deepEqual(writes[0][1], ['local-user', group, '9007199254740995', '9007199254740997', modelProvider]);
    assert.match(modelProvider, /^reseller:/);
    assert.ok(writes[0][0].includes('ON CONFLICT (user_id,provider,group_id)'));
    assert.ok(!JSON.stringify(writes).includes('sk-test'));
    group = '9';
    assert.equal((await ensureKey(user, 'trace-test')).group_id, '9');
`));

test("Enhance failures retain safe v2 codes without retries or replacement accounts", () => run(`
    const { modelErrorMessage } = await import('./src/model-errors.ts');
    for (const [status, code] of [[403, 'APP_USER_LOGIN_REQUIRED'], [409, 'APP_KEY_RESULT_AMBIGUOUS'], [503, 'TOKENONE_USER_NOT_FOUND'], [409, 'APP_KEY_UNAVAILABLE'], [409, 'IDENTITY_CONFLICT'], [403, 'SCOPE_FORBIDDEN'], [401, 'UNAUTHORIZED'], [503, 'APP_KEY_RECOVERY_UNAVAILABLE']]) {
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

test("unsupported account and usage routes never call Reseller or fabricate amounts", () => run(`
    const { default: express } = await import('express');
    const app = express();
    app.use(express.json(), (_req, res, next) => { res.locals.user = user; next(); }, channelRouter);
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Must not contact upstream'); };
    try {
        for (const path of ['/account/summary', '/usage/query', '/usage/stats']) {
            const response = await realFetch('http://127.0.0.1:' + server.address().port + '/tokenone' + path, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identity: { subject: 'forged' } }),
            });
            assert.equal(response.status, 501);
            assert.deepEqual(await response.json(), { error: 'TOKENONE_ACCOUNT_USAGE_UNAVAILABLE' });
        }
        assert.equal(calls, 0);
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

test("legacy video tasks never acquire a new provider Key and saved results remain readable", () => run(`
    const { default: express } = await import('express');
    const { aiRouter } = await import('./src/ai.ts');
    const app = express();
    app.use((_req, res, next) => { res.locals.user = user; next(); }, aiRouter);
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code }));
    const task = { provider: 'legacy-enhance', group_id: '8', status: 'unknown' };
    db.query = async () => ({ rows: [task] });
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Must not contact upstream'); };
    const call = () => realFetch('http://127.0.0.1:' + server.address().port + '/ai/11111111-1111-4111-8111-111111111111/v1/contents/generations/tasks/task-old');
    try {
        const response = await call();
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { error: 'TASK_PROVIDER_CHANGED' });
        task.status = 'succeeded';
        task.result = { content: { video_url: '/api/files/saved' } };
        assert.deepEqual(await (await call()).json(), task.result);
        db.query = async () => ({ rows: [task, { ...task, provider: modelProvider }] });
        assert.equal((await call()).status, 409);
        assert.equal(calls, 0);
    } finally { server.close(); server.closeAllConnections(); }
`));
