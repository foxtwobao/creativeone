import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runRoutes(checks: string) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import express from 'express';
        const { accountPricingRouter } = await import('./src/account-pricing.ts');
        const { db } = await import('./src/db.ts');
        const user = { issuer: 'https://idone.test', subject: 'verified-sub' };
        db.query = async () => ({ rows: [{ capability: 'image', models: ['configured', 'missing', 'empty'], model_descriptions: { configured: '配置描述' } }] });
        const app = express();
        app.use((_req, res, next) => { res.locals.user = user; res.locals.requestId = 'trace'; next(); }, accountPricingRouter);
        app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code }));
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const realFetch = globalThis.fetch;
        let mode = 'balance';
        const calls = [];
        const catalogue = {
            app_id: 'creativeone', group: { id: '366', name: 'app-composite', multiplier: '1.25' }, currency: 'USD', queried_at: '2026-10-16T00:00:00Z',
            models: [
                { model: 'configured', paths: [
                    { member: 'member-first', multiplier: '0.5', status: 'available', tiers: [
                        { condition: '上下文 ≤ 272000 token', prices: [
                            { metric: 'output', amount: '6', unit: 'million_tokens' },
                            { metric: 'input', amount: '1', unit: 'million_tokens' },
                            { metric: 'cache_read', amount: '0.000000000000000001', unit: 'million_tokens' },
                        ] },
                        { condition: '上下文 > 272000 token', prices: [{ metric: 'input', amount: '2', unit: 'million_tokens' }] },
                    ] },
                    { member: 'member-second', multiplier: '1.25', status: 'available', tiers: [{ condition: '', prices: [
                        { metric: 'request', amount: '0.0125', unit: 'request' },
                        { metric: 'duration', amount: '0.0125', unit: 'second' },
                        { metric: 'usage_tokens', amount: '10', unit: 'million_tokens' },
                        { metric: 'image_input', amount: '0', unit: 'million_tokens' },
                        { metric: 'image_cache_read', amount: '2.5', unit: 'million_tokens' },
                        { metric: 'cache_write', amount: '1.25', unit: 'million_tokens' },
                    ] }] },
                    ...['missing_pricing', 'unsupported_rule', 'unconfirmed_zero_price', 'invalid_pricing'].map(reason => ({
                        member: reason, status: 'unavailable', tiers: [], reason,
                    })),
                ] },
                { model: 'empty', paths: [], reason: 'missing_pricing' },
                { model: 'unconfigured', paths: [] },
            ],
        };
        globalThis.fetch = async (url, init) => {
            calls.push(String(url));
            assert.equal(init.headers.Authorization, 'Bearer private-app-key');
            assert.equal(init.headers['X-Request-Id'], 'trace');
            assert.equal(init.redirect, 'error');
            assert.equal(init.cache, 'no-store');
            assert.ok(init.signal);
            if (String(url).endsWith('/balance/query')) {
                assert.deepEqual(JSON.parse(init.body), { identity: user });
                if (mode === 'unauthorized') return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
                if (mode === 'malformed') return Response.json({ data: { balance: { amount: 0, unit: 'USD' } } });
                if (mode === 'network') throw new Error('private-upstream-detail');
                return Response.json({ data: { balance: { amount: '-12.34', unit: 'CNY' } }, secret: 'private' });
            }
            assert.equal(String(url), 'https://reseller.test/api/apps/pricing');
            assert.equal(init.method, 'GET');
            assert.equal(init.body, undefined);
            if (mode === 'network') throw new Error('private-upstream-detail');
            if (mode === 'html') return new Response('<html>private upstream</html>', { status: 502 });
            if (mode === 'unauthorized') return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
            if (mode === 'scope') return Response.json({ error: 'SCOPE_FORBIDDEN' }, { status: 403 });
            if (mode === 'group') return Response.json({ error: 'APP_PRICING_GROUP_UNAVAILABLE' }, { status: 409 });
            if (mode === 'unavailable') return Response.json({ error: 'APP_PRICING_UNAVAILABLE' }, { status: 503 });
            if (mode === 'malformed') return Response.json({ data: catalogue });
            const payload = structuredClone(catalogue);
            if (mode === 'empty') payload.models = [];
            if (mode === 'invalid-amount') payload.models[0].paths[0].tiers[0].prices[0].amount = 'NaN';
            if (mode === 'invalid-unit') payload.models[0].paths[0].tiers[0].prices[0].unit = 'request';
            if (mode === 'invalid-tier') payload.models[0].paths[0].tiers = [];
            return Response.json(payload);
        };
        const get = path => realFetch('http://127.0.0.1:' + server.address().port + path);
        try {
            ${checks}
        } finally { server.close(); server.closeAllConnections(); }
    `], { cwd: new URL("../", import.meta.url), encoding: "utf8", env: { ...process.env,
        DATABASE_URL: "postgresql://unused:unused@localhost/unused", APP_ORIGIN: "https://app.test", APP_ORIGINS: '["https://app.test"]',
        IDONE_ISSUER: "https://idone.test", IDONE_DISCOVERY_URL: "", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test", ADMIN_SUBJECTS: "admin",
        ENHANCER_BASE_URL: "https://reseller.test", ENHANCER_APP_CREDENTIAL: "private-app-key", TOKENONE_BASE_URL: "",
    } });
    assert.equal(result.status, 0, result.stderr);
}

test("balance uses only verified identity and maps upstream credential failures without invalidating login", () => runRoutes(`
    assert.deepEqual(await (await get('/account/balance?subject=forged')).json(), { amount: '-12.34', unit: 'CNY' });
    assert.equal(calls.length, 1);
    mode = 'unauthorized';
    assert.equal((await get('/account/balance')).status, 502);
    mode = 'malformed';
    assert.equal((await get('/account/balance')).status, 502);
    mode = 'network';
    const failed = await get('/account/balance');
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'ACCOUNT_BALANCE_UNAVAILABLE' });
`));

test("pricing reads Reseller once, preserves final amounts and paths, and returns only locally enabled models", () => runRoutes(`
    const response = await get('/model-pricing?subject=forged&group_id=other');
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    const pricing = await response.json();
    assert.equal(pricing.group, 'app-composite');
    assert.equal(pricing.compositeRatio, '1.25');
    assert.equal(pricing.queriedAt, catalogue.queried_at);
    assert.equal(pricing.currency, 'USD');
    assert.deepEqual(pricing.models.map(model => model.model), ['configured', 'missing', 'empty']);
    assert.equal(pricing.models[0].description, '配置描述');
    const paths = pricing.models[0].paths;
    assert.equal(paths[0].member, 'member-first');
    assert.equal(paths[1].member, 'member-second');
    assert.equal(paths[0].multiplier, '0.5');
    assert.deepEqual(paths[0].tiers[0].metrics, [
        { label: '输出', amount: '6', unit: '百万 token' },
        { label: '输入', amount: '1', unit: '百万 token' },
        { label: '缓存读取', amount: '0.000000000000000001', unit: '百万 token' },
    ]);
    assert.equal(paths[0].tiers[1].condition, '上下文 > 272000 token');
    assert.deepEqual(paths[1].tiers[0].metrics.map(metric => [metric.label, metric.amount, metric.unit]), [
        ['每次成功请求', '0.0125', '次请求'], ['生成时长', '0.0125', '秒'], ['计费用量', '10', '百万 token'],
        ['图片输入', '0', '百万 token'], ['图片缓存读取', '2.5', '百万 token'], ['缓存写入', '1.25', '百万 token'],
    ]);
    assert.deepEqual(paths.slice(2).map(path => path.tiers), [[], [], [], []]);
    assert.ok(paths.slice(2).every(path => !Object.hasOwn(path, 'multiplier')));
    assert.match(paths[3].note, /不支持/);
    assert.match(paths[4].note, /零单价/);
    assert.match(paths[5].note, /配置无效/);
    assert.match(pricing.models[1].note, /不可用/);
    assert.match(pricing.models[2].note, /不可用/);
    assert.ok(!JSON.stringify(pricing).includes('private-app-key'));
    mode = 'empty';
    const empty = await (await get('/model-pricing')).json();
    assert.ok(empty.models.every(model => model.paths.length === 0 && model.note));
    db.query = async () => ({ rows: [] });
    assert.deepEqual((await (await get('/model-pricing')).json()).models, []);
`));

test("pricing errors and invalid contracts remain errors without fallback or credential leakage", () => runRoutes(`
    for (const [fixtureMode, status, error] of [
        ['unauthorized', 502, 'UNAUTHORIZED'], ['scope', 403, 'SCOPE_FORBIDDEN'],
        ['group', 409, 'APP_PRICING_GROUP_UNAVAILABLE'], ['unavailable', 503, 'APP_PRICING_UNAVAILABLE'],
        ['network', 503, 'MODEL_PRICING_UNAVAILABLE'], ['html', 502, 'ENHANCER_FAILED'],
        ...['malformed', 'invalid-amount', 'invalid-unit', 'invalid-tier'].map(value => [value, 503, 'MODEL_PRICING_UNAVAILABLE']),
    ]) {
        mode = fixtureMode;
        const before = calls.length;
        const response = await get('/model-pricing');
        assert.equal(response.status, status, mode);
        assert.deepEqual(await response.json(), { error }, mode);
        assert.equal(calls.length, before + 1, mode);
    }
`));
