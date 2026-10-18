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
            const path = payload.models[0]?.paths[0], quote = path?.quotes[0], price = quote?.tiers[0].prices[0];
            const corruptions = {
                'invalid-amount': () => { price.amount = 'NaN'; },
                'negative-amount': () => { price.amount = '-1'; },
                'number-amount': () => { price.amount = 0.1; },
                'exponent-amount': () => { price.amount = '1e-10'; },
                'invalid-unit': () => { price.unit = 'credit'; },
                'invalid-standard-unit': () => { price.metric = 'input'; delete price.usage_key; },
                'unexpected-usage-key': () => { price.metric = 'input'; price.unit = 'million_tokens'; },
                'missing-usage-key': () => { delete price.usage_key; },
                'empty-usage-key': () => { price.usage_key = ' '; },
                'old-metric': () => { price.metric = 'duration'; },
                'invalid-tier': () => { quote.tiers = []; },
                'empty-prices': () => { quote.tiers[0].prices = []; },
                'invalid-plugin': () => { delete quote.plugin_key; },
                'invalid-base': () => { quote.source = 'base'; },
                'invalid-unavailable': () => { quote.status = 'unavailable'; quote.reason = 'unsupported_rule'; },
                'invalid-path': () => { path.reason = 'invalid_pricing'; },
                'empty-quotes': () => { path.quotes = []; },
                'old-path': () => { delete path.quotes; path.status = 'available'; path.tiers = quote.tiers; },
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

test("shared fixture preserves every path, plugin, tier, usage identity and exact amount", () => runRoutes(`
    const response = await get('/model-pricing?group_id=other');
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    const pricing = await response.json();
    assert.equal(pricing.group, catalogue.group.name);
    assert.equal(pricing.currency, 'USD');
    assert.equal(pricing.compositeRatio, '1.25');
    assert.equal(pricing.queriedAt, catalogue.queried_at);
    assert.equal(pricing.models[0].description, '配置描述');
    for (const source of catalogue.models) {
        const model = pricing.models.find(item => item.model === source.model);
        assert.equal(model.capability, 'video');
        assert.equal(model.paths.length, source.paths.length);
        source.paths.forEach((path, index) => {
            const target = model.paths[index];
            assert.equal(target.member, path.member);
            assert.equal(target.multiplier, path.multiplier);
            assert.equal(target.quotes.length, path.quotes.length);
            if (path.reason) assert.ok(target.note);
            path.quotes.forEach((quote, quoteIndex) => {
                const result = target.quotes[quoteIndex];
                assert.equal(result.source, quote.source);
                assert.equal(result.pluginKey, quote.plugin_key);
                assert.equal(result.pluginName, quote.plugin_name);
                assert.deepEqual(result.tiers, quote.tiers.map(tier => ({ condition: tier.condition,
                    metrics: tier.prices.map(price => ({ metric: price.metric, ...(price.usage_key ? { usageKey: price.usage_key } : {}),
                        label: price.label, amount: price.amount, unit: price.unit, unitLabel: price.unit_label })),
                })));
                assert.equal(Boolean(result.note), quote.status === 'unavailable');
            });
        });
    }
    const find = name => pricing.models.find(model => model.model === name);
    assert.equal(find('wan3.0-video').paths.length, 2);
    assert.equal(find('wan3.0-video-prime').paths[0].quotes.length, 3);
    assert.equal(find('fixture-multi-usage').paths[0].quotes[0].tiers[0].metrics.length, 3);
    assert.match(find('fixture-enum-conflict').paths[0].quotes[0].note, /条件与用量定义不一致/);
    assert.match(find('fixture-zero-pending').paths[0].quotes[0].note, /零单价/);
    assert.match(find('fixture-mixed-plugins').paths[0].quotes[2].note, /不能完整展示/);
    assert.match(find('fixture-invalid-ratio').paths[0].note, /配置无效/);
    assert.match(find('fixture-no-path').note, /不可用/);
    assert.match(find('missing').note, /不可用/);
    assert.ok(!JSON.stringify(pricing).includes('private-app-key'));
    db.query = async () => ({ rows: [{ capability: 'image', models: ['fixture-image-count'], model_descriptions: {} }] });
    assert.deepEqual((await (await get('/model-pricing')).json()).models.map(model => [model.model, model.capability]), [['fixture-image-count', 'image']]);
    mode = 'empty';
    assert.ok((await (await get('/model-pricing')).json()).models.every(model => !model.paths.length && model.note));
    db.query = async () => ({ rows: [] });
    assert.deepEqual((await (await get('/model-pricing')).json()).models, []);
`));

test("missing plugin identity and invalid path member remain local failures", () => runRoutes(`
    catalogue.models[0].paths[0].quotes.push({ source: 'plugin', status: 'unavailable', tiers: [], reason: 'invalid_pricing' });
    catalogue.models[0].paths.push({ member: '', quotes: [], reason: 'invalid_pricing' });
    const response = await get('/model-pricing');
    assert.equal(response.status, 200);
    const { paths } = (await response.json()).models[0];
    assert.equal(paths[0].quotes.length, 4);
    assert.match(paths[0].quotes[3].note, /配置无效/);
    assert.equal(paths[0].quotes[3].pluginName, undefined);
    assert.match(paths.at(-1).note, /配置无效/);
`));

test("all usage units retain labels and precision without guessing image semantics", () => runRoutes(`
    const prices = catalogue.models[0].paths[0].quotes[0].tiers[0].prices;
    prices.splice(0, prices.length, ...['second', 'count', 'image', 'request', 'million_tokens'].map((unit, index) => ({
        metric: 'usage', usage_key: 'field_' + index, label: '相同标签', unit, unit_label: unit === 'count' ? '个计费单位' : unit, amount: '0.000000000000000001',
    })));
    const response = await get('/model-pricing');
    assert.equal(response.status, 200);
    const metrics = (await response.json()).models[0].paths[0].quotes[0].tiers[0].metrics;
    assert.equal(metrics.length, 5);
    assert.equal(new Set(metrics.map(metric => metric.usageKey)).size, 5);
    assert.equal(metrics[1].unitLabel, '个计费单位');
    assert.ok(metrics.every(metric => metric.amount === '0.000000000000000001'));
`));

test("pricing errors and malformed new contracts remain errors without fallback or credential leakage", () => runRoutes(`
    for (const [fixtureMode, status, error] of [
        ['unauthorized', 502, 'UNAUTHORIZED'], ['scope', 403, 'SCOPE_FORBIDDEN'],
        ['group', 409, 'APP_PRICING_GROUP_UNAVAILABLE'], ['unavailable', 503, 'APP_PRICING_UNAVAILABLE'],
        ['network', 503, 'MODEL_PRICING_UNAVAILABLE'], ['html', 502, 'ENHANCER_FAILED'],
        ...['malformed', 'invalid-amount', 'negative-amount', 'number-amount', 'exponent-amount', 'invalid-unit',
            'invalid-standard-unit', 'unexpected-usage-key', 'missing-usage-key', 'empty-usage-key', 'old-metric',
            'invalid-tier', 'empty-prices', 'invalid-plugin', 'invalid-base', 'invalid-unavailable', 'invalid-path',
            'empty-quotes', 'old-path'].map(value => [value, 503, 'MODEL_PRICING_UNAVAILABLE']),
    ]) {
        mode = fixtureMode;
        const before = calls.length;
        const response = await get('/model-pricing');
        assert.equal(response.status, status, mode);
        assert.deepEqual(await response.json(), { error }, mode);
        assert.equal(calls.length, before + 1, mode);
    }
`));
