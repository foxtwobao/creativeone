import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runRoutes(checks: string) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import express from 'express';
        import { readFileSync } from 'node:fs';
        const { accountPricingRouter } = await import('./src/account-pricing.ts');
        const { db } = await import('./src/db.ts');
        const user = { issuer: 'https://idone.test', subject: 'verified-sub' };
        db.query = async () => ({ rows: [{ capability: 'video', models: [...catalogue.models.map(model => model.model), 'missing'], model_descriptions: { 'wan3.0-video': '配置描述' } }] });
        const app = express();
        app.use((_req, res, next) => { res.locals.user = user; res.locals.requestId = 'trace'; next(); }, accountPricingRouter);
        app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code }));
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const realFetch = globalThis.fetch;
        let mode = 'balance';
        const calls = [];
        const catalogue = JSON.parse(readFileSync('../shared/fixtures/app-pricing-response.json', 'utf8'));
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
            const model = payload.models[0], price = model?.tiers[0]?.prices[0];
            const corruptions = {
                'invalid-amount': () => { price.min_amount = 'NaN'; },
                'negative-amount': () => { price.min_amount = '-1'; },
                'number-amount': () => { price.min_amount = 0.1; },
                'exponent-amount': () => { price.min_amount = '1e-10'; },
                'inverted-range': () => { price.min_amount = '0.012500000000000001'; },
                'invalid-unit': () => { price.unit = 'credit'; },
                'invalid-standard-unit': () => { price.metric = 'input'; delete price.usage_key; },
                'unexpected-usage-key': () => { price.metric = 'input'; price.unit = 'million_tokens'; },
                'missing-usage-key': () => { delete price.usage_key; },
                'empty-usage-key': () => { price.usage_key = ' '; },
                'old-metric': () => { price.metric = 'duration'; },
                'invalid-tier': () => { model.tiers = []; },
                'empty-prices': () => { model.tiers[0].prices = []; },
                'invalid-unavailable': () => { model.status = 'unavailable'; model.reason = 'unsupported_rule'; },
                'partial-no-reason': () => { model.status = 'partial'; },
                'invalid-reason': () => { model.status = 'unavailable'; model.tiers = []; model.reason = 'private-provider-error'; },
                'old-path': () => { model.paths = []; delete model.tiers; },
            };
            corruptions[mode]?.();
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

test("public fixture preserves model summaries, status, independent usage and exact ranges without routing fields", () => runRoutes(`
    const response = await get('/model-pricing');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(calls.length, 1);
    const pricing = await response.json();
    assert.equal(pricing.currency, 'USD');
    assert.equal(pricing.queriedAt, catalogue.queried_at);
    assert.equal(pricing.models[0].description, '配置描述');
    for (const source of catalogue.models) {
        const model = pricing.models.find(item => item.model === source.model);
        assert.equal(model.status, source.status);
        assert.equal(model.capability, 'video');
        assert.deepEqual(model.tiers, source.tiers.map(tier => ({ condition: tier.condition,
            metrics: tier.prices.map(price => ({ metric: price.metric, ...(price.usage_key ? { usageKey: price.usage_key } : {}),
                label: price.label, minAmount: price.min_amount, maxAmount: price.max_amount, unit: price.unit, unitLabel: price.unit_label })),
        })));
        assert.equal(Boolean(model.note), source.status !== 'available');
    }
    const forbidden = new Set(['group', 'paths', 'quotes', 'source', 'plugin_key', 'plugin_name', 'pluginKey', 'pluginName', 'member', 'multiplier', 'compositeRatio']);
    function inspect(value) {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value)) { assert.ok(!forbidden.has(key), key); inspect(child); }
    }
    inspect(pricing);
    const find = name => pricing.models.find(model => model.model === name);
    assert.equal(find('wan3.0-video').tiers.length, 3);
    assert.ok(find('wan3.0-video').tiers.every(tier => tier.metrics.length === 1));
    assert.match(find('fixture-mixed-plugins').note, /价格信息不完整/);
    assert.match(find('fixture-enum-conflict').note, /条件与用量定义不一致/);
    assert.match(find('fixture-zero-pending').note, /零单价/);
    assert.equal(find('missing').status, 'unavailable');
    assert.ok(!JSON.stringify(pricing).includes('private-app-key'));
    db.query = async () => ({ rows: [{ capability: 'image', models: ['fixture-image-count'], model_descriptions: {} }] });
    assert.deepEqual((await (await get('/model-pricing')).json()).models.map(model => [model.model, model.capability]), [['fixture-image-count', 'image']]);
    mode = 'empty';
    assert.ok((await (await get('/model-pricing')).json()).models.every(model => !model.tiers.length && model.status === 'unavailable'));
    db.query = async () => ({ rows: [] });
    assert.deepEqual((await (await get('/model-pricing')).json()).models, []);
`));

test("unknown extra routing fields never reach the browser; equal decimal endpoints are normalized exactly", () => runRoutes(`
    catalogue.group = { name: 'PRIVATE' };
    catalogue.models[0].paths = [{ member: 'PRIVATE', plugin_name: 'PRIVATE' }];
    const price = catalogue.models[0].tiers[0].prices[0];
    price.min_amount = '0.000000000000000001'; price.max_amount = '0.0000000000000000010';
    price.plugin_key = 'PRIVATE';
    const response = await get('/model-pricing');
    assert.equal(response.status, 200);
    const pricing = await response.json();
    assert.ok(!JSON.stringify(pricing).includes('PRIVATE'));
    assert.equal(pricing.models[0].tiers[0].metrics[0].minAmount, '0.000000000000000001');
    assert.equal(pricing.models[0].tiers[0].metrics[0].maxAmount, '0.000000000000000001');
`));

test("same-priced usage keys remain independent across all supported units", () => runRoutes(`
    const prices = catalogue.models[0].tiers[0].prices;
    prices.splice(0, prices.length, ...['second', 'count', 'image', 'request', 'million_tokens'].map((unit, index) => ({
        metric: 'usage', usage_key: 'field_' + index, label: '相同标签', unit, unit_label: unit === 'count' ? '个计费单位' : unit,
        min_amount: '0.000000000000000001', max_amount: '0.000000000000000002',
    })));
    const response = await get('/model-pricing');
    assert.equal(response.status, 200);
    const metrics = (await response.json()).models[0].tiers[0].metrics;
    assert.equal(metrics.length, 5);
    assert.equal(new Set(metrics.map(metric => metric.usageKey)).size, 5);
    assert.equal(metrics[1].unitLabel, '个计费单位');
    assert.ok(metrics.every(metric => metric.maxAmount === '0.000000000000000002'));
`));

test("upstream errors and invalid summary contracts never return cached or fabricated prices", () => runRoutes(`
    assert.equal((await get('/model-pricing')).status, 200);
    for (const [fixtureMode, status, error] of [
        ['unauthorized', 502, 'UNAUTHORIZED'], ['scope', 403, 'SCOPE_FORBIDDEN'],
        ['group', 409, 'APP_PRICING_GROUP_UNAVAILABLE'], ['unavailable', 503, 'APP_PRICING_UNAVAILABLE'],
        ['network', 503, 'MODEL_PRICING_UNAVAILABLE'], ['html', 502, 'ENHANCER_FAILED'],
        ...['malformed', 'invalid-amount', 'negative-amount', 'number-amount', 'exponent-amount', 'inverted-range', 'invalid-unit',
            'invalid-standard-unit', 'unexpected-usage-key', 'missing-usage-key', 'empty-usage-key', 'old-metric',
            'invalid-tier', 'empty-prices', 'invalid-unavailable', 'partial-no-reason', 'invalid-reason', 'old-path'].map(value => [value, 503, 'MODEL_PRICING_UNAVAILABLE']),
    ]) {
        mode = fixtureMode;
        const before = calls.length;
        const response = await get('/model-pricing');
        assert.equal(response.status, status, mode);
        assert.deepEqual(await response.json(), { error }, mode);
        assert.equal(calls.length, before + 1, mode);
    }
`));
