import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("authorization routes bind PKCE to the session, reject replay, and recover lost exchange responses", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        import { createHash } from 'node:crypto';
        import express from 'express';
        const { resellerRouter, resellerCallbackRouter } = await import('./src/reseller-auth.ts');
        const { requireUser, csrf } = await import('./src/auth.ts');
        const { db } = await import('./src/db.ts');
        const user = { id: 'alice', issuer: 'https://idone.test', subject: 'alice-sub', email_verified: true, csrf: 'csrf' };
        const hash = value => createHash('sha256').update(value).digest('hex');
        let flow, startBody, completeCalls = 0, starts = 0, ensureCalls = 0, authorized = false, loseResponse = false, denyGroup = false, signedIn = true, expired = false;
        db.query = async (sql, values = []) => {
            if (sql.startsWith('SELECT u.')) return { rows: signedIn ? [user] : [] };
            if (sql.startsWith('SELECT id_hash')) return { rowCount: 1, rows: [{}] };
            if (sql.startsWith('SELECT authorization_url')) return { rows: flow && !flow.consumed && !expired ? [flow] : [] };
            if (sql.startsWith('INSERT INTO reseller_authorizations')) {
                flow = Object.fromEntries(['session_hash','state_hash','verifier','issuer','subject','provider','credential_hash','authorization_url','return_to','draft','expires_at'].map((key, i) => [key, values[i]]));
                flow.draft = JSON.parse(flow.draft); flow.consumed = false;
            }
            if (sql.startsWith('UPDATE reseller_authorizations SET consumed')) {
                assert.ok(sql.includes("consumed=false RETURNING *,expires_at>now() AS valid"));
                const keys = ['session_hash','state_hash','issuer','subject','provider','credential_hash'];
                if (!flow || flow.consumed || keys.some((key, i) => flow[key] !== values[i])) return { rows: [] };
                flow.consumed = true; return { rows: [{ ...flow, valid: !expired }] };
            }
            if (sql.startsWith('UPDATE reseller_authorizations SET result')) { flow.result = values[1]; flow.verifier = null; }
            if (sql.startsWith('SELECT return_to')) return { rows: flow?.consumed ? [flow] : [] };
            if (sql.startsWith('DELETE FROM reseller_authorizations')) flow = undefined;
            return { rows: [] };
        };
        db.connect = async () => ({ query: db.query, release() {} });
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            assert.equal(init.headers.Authorization, 'Bearer app-secret');
            const body = JSON.parse(init.body);
            if (url.endsWith('/keys/ensure')) {
                ensureCalls++;
                assert.deepEqual(body, { identity: { issuer: user.issuer, subject: user.subject } });
                if (!authorized) return Response.json({ error: 'APP_USER_AUTHORIZATION_REQUIRED' }, { status: 403 });
                if (denyGroup) return Response.json({ error: 'TOKENONE_GROUP_FORBIDDEN' }, { status: 403 });
                return Response.json({ status: 'ready', tokenone_user_id: '1', api_key: { id: '2', key: 'sk-private', group_id: '3', status: 'active' } });
            }
            if (url.endsWith('/authorizations/complete')) {
                completeCalls++; assert.equal(body.code_verifier, flow.verifier); authorized = true;
                if (loseResponse) throw new TypeError('connection reset');
                return Response.json({ status: 'authorized', app_id: 'creativeone' });
            }
            if (url.endsWith('/authorizations/revoke')) { authorized = false; return Response.json({ status: 'revoked' }); }
            starts++; startBody = body;
            assert.equal(body.redirect_uri, 'https://app.test/api/auth/reseller/callback');
            assert.equal(body.state.length, 43);
            assert.equal(body.code_challenge.length, 43);
            assert.equal(body.code_challenge_method, undefined);
            return Response.json({ authorization_url: 'https://gateway.test/_channel/start?flow=opaque', expires_in: 300 });
        };
        const app = express();
        app.use((req, res, next) => { res.locals.requestId = 'test'; next(); });
        app.use('/api/auth/reseller/callback', resellerCallbackRouter);
        app.use('/api', requireUser, csrf, express.json(), resellerRouter);
        app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.code }));
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const base = 'http://127.0.0.1:' + server.address().port;
        const headers = { Cookie: '__Host-creativeone=session', Origin: 'https://app.test', 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' };
        const call = (path, method = 'GET', body, extra = {}) => realFetch(base + '/api' + path, { method, headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
        const start = () => call('/model-authorization', 'POST', { returnTo: '/studio', draft: { prompt: 'retain me' } });
        const callback = (state = startBody.state) => call('/auth/reseller/callback?code=one-time&state=' + state);
        try {
            assert.equal((await call('/model-authorization', 'POST', {}, { 'X-CSRF-Token': 'wrong' })).status, 403);
            const started = await start();
            assert.equal(started.status, 200);
            const payload = await started.text();
            assert.ok(!payload.includes('app-secret') && !payload.includes('alice-sub'));
            assert.equal(createHash('sha256').update(flow.verifier).digest('base64url'), startBody.code_challenge);
            assert.deepEqual(await (await start()).json(), { pending: true }); assert.equal(starts, 1);
            assert.equal((await callback('x'.repeat(43))).headers.get('location'), '/studio?modelAuthorization=invalid');
            assert.equal(completeCalls, 0); assert.equal(flow.consumed, false);
            user.subject = 'other'; await callback(); assert.equal(completeCalls, 0); user.subject = 'alice-sub';
            expired = true; await callback(); assert.equal(completeCalls, 0); assert.equal(flow.result, 'AUTHORIZATION_FLOW_INVALID'); expired = false; await start();
            const completed = await callback();
            assert.equal(completed.headers.get('location'), '/studio');
            assert.equal(completed.headers.get('referrer-policy'), 'no-referrer');
            assert.match(completed.headers.get('cache-control'), /no-store/);
            assert.equal(flow.result, 'authorized'); assert.equal(flow.verifier, null);
            await callback(); assert.equal(completeCalls, 1);
            const resume = await (await call('/model-authorization')).json();
            assert.deepEqual(resume.draft, { prompt: 'retain me' });
            assert.ok(!JSON.stringify(resume).includes('sk-private'));
            await call('/model-authorization/revoke', 'POST'); assert.equal(flow, undefined);
            loseResponse = true; await start(); const before = ensureCalls; await callback();
            assert.equal(flow.result, 'authorized'); assert.equal(ensureCalls, before + 1);
            await call('/model-authorization/revoke', 'POST');
            loseResponse = false; await start(); denyGroup = true; await callback();
            assert.equal(flow.result, 'TOKENONE_GROUP_FORBIDDEN');
            signedIn = false;
            assert.equal((await callback()).headers.get('location'), '/studio?modelAuthorization=invalid');
        } finally { server.close(); server.closeAllConnections(); }
    `], {
        cwd: new URL("../", import.meta.url), encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "postgresql://unused:unused@localhost/unused", APP_ORIGIN: "https://app.test", IDONE_ISSUER: "https://idone.test", IDONE_DISCOVERY_URL: "", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test", ADMIN_SUBJECTS: "admin", ENHANCER_BASE_URL: "https://reseller.test", ENHANCER_APP_CREDENTIAL: "app-secret", TOKENONE_BASE_URL: "https://model.test" },
    });
    assert.equal(result.status, 0, result.stderr);
});
