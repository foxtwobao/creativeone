import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import express from "express";

const database = process.env.TEST_DATABASE_URL;
test("authorization recovery remains durable and single-use across database connections", { skip: !database }, async t => {
    assert.ok(new URL(database!).pathname.endsWith("_test"), "Use an isolated *_test database");
    Object.assign(process.env, { DATABASE_URL: database, APP_ORIGIN: "https://auth.test", APP_ORIGINS: '["https://auth.test"]',
        IDONE_ISSUER: "https://idone.test", IDONE_DISCOVERY_URL: "", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test", ADMIN_SUBJECTS: "admin",
        ENHANCER_BASE_URL: "https://reseller.test", ENHANCER_APP_CREDENTIAL: "original-credential", TOKENONE_BASE_URL: "https://model.test" });
    const { db, initializeDatabase } = await import("./db.js");
    const { env } = await import("./config.js");
    const { resellerRouter, resellerCallbackRouter } = await import("./reseller-auth.js");
    const { requireUser, csrf } = await import("./auth.js");
    await initializeDatabase();
    const user = randomUUID(), session = createHash("sha256").update("auth-test-session").digest("hex");
    await db.query("INSERT INTO users(id,issuer,subject,email,email_verified,username,display_name) VALUES($1,'https://idone.test',$2,'test@example.test',true,$2,$2)", [user, user]);
    await db.query("INSERT INTO sessions(id_hash,user_id,csrf,expires_at,origin) VALUES($1,$2,'csrf',now()+interval '1 hour','https://auth.test')", [session, user]);
    let authorized = false, unavailable = false, lost = false, revokeLost = false, completeCalls = 0;
    let state = "", hold: (() => Promise<void>) | undefined;
    const originalFetch = globalThis.fetch;
    const credentials: string[] = [];
    globalThis.fetch = async (input, init) => {
        const url = String(input), body = JSON.parse(String(init?.body));
        credentials.push(new Headers(init?.headers).get("Authorization")!);
        assert.ok(init?.signal);
        if (url.endsWith("/keys/ensure")) {
            if (unavailable) throw new TypeError("private failure");
            if (!authorized) return Response.json({ error: "APP_USER_AUTHORIZATION_REQUIRED" }, { status: 403 });
            return Response.json({ status: "ready", tokenone_user_id: "1", api_key: { id: "2", key: "private-key", group_id: "3", status: "active" } });
        }
        if (url.endsWith("/authorizations/complete")) {
            completeCalls++;
            await hold?.();
            authorized = true;
            if (lost) { unavailable = true; throw new TypeError("response lost"); }
            return Response.json({ status: "authorized", app_id: "creativeone" });
        }
        if (url.endsWith("/authorizations/revoke")) {
            authorized = false;
            if (revokeLost) throw new TypeError("response lost");
            return Response.json({ status: "revoked" });
        }
        assert.ok(url.endsWith("/authorizations"));
        state = body.state;
        return Response.json({ authorization_url: "https://gateway.test/_channel/start?flow=test", expires_in: 300 });
    };
    const app = express();
    app.use((req, res, next) => { req.headers.host = "auth.test"; res.locals.requestId = "auth-test"; next(); });
    app.use("/api/auth/reseller/callback", resellerCallbackRouter);
    app.use("/api", requireUser, csrf, express.json(), resellerRouter);
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.code }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const call = (path: string, method = "GET", body?: unknown) => originalFetch(base + path, { method, redirect: "manual",
        headers: { Cookie: "__Host-creativeone=auth-test-session", Origin: "https://auth.test", "X-CSRF-Token": "csrf", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const start = async () => {
        authorized = unavailable = lost = false;
        await db.query("DELETE FROM reseller_authorizations WHERE session_hash=$1", [session]);
        assert.equal((await call("/model-authorization", "POST", { returnTo: "/studio", draft: { prompt: "saved" } })).status, 200);
    };
    const callback = () => call(`/auth/reseller/callback?code=once&state=${state}`);
    const read = async () => (await call("/model-authorization")).json();
    try {
        await t.test("returning without a gateway callback restores the editor without consuming the pending flow", async () => {
            await start();
            const before = completeCalls;
            const pending = await read();
            assert.equal(pending.result, "AUTHORIZATION_PENDING");
            assert.equal(pending.draft.prompt, "saved");
            await call("/model-authorization/resume", "DELETE");
            assert.equal(await read(), null);
            const stored = (await db.query("SELECT consumed,verifier FROM reseller_authorizations WHERE session_hash=$1", [session])).rows[0];
            assert.equal(stored.consumed, false);
            assert.ok(stored.verifier);
            assert.equal(completeCalls, before);
        });
        await t.test("lost exchange and ensure preserve editor state; recovery never exchanges again", async () => {
            await start(); lost = true;
            const before = completeCalls;
            assert.equal((await callback()).headers.get("location"), "/studio");
            assert.equal((await read()).recoverable, true);
            assert.equal((await read()).draft.prompt, "saved");
            await call("/model-authorization/resume", "DELETE");
            assert.equal((await read()).recoverable, true);
            assert.equal((await read()).draft, null);
            const blocked = await (await call("/model-authorization", "POST", { returnTo: "/studio", draft: null })).json();
            assert.equal(blocked.recoverable, true);
            unavailable = false;
            const status = await (await call("/model-authorization/recover", "POST")).json();
            assert.equal(status.result, "authorized");
            await callback();
            assert.equal(completeCalls, before + 1);
            assert.doesNotMatch(JSON.stringify(status), /private-key|original-credential|state_hash|verifier/);
        });
        await t.test("a committed processing record survives losing the connection and recovers without a code", async () => {
            await start();
            const client = await db.connect();
            await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`reseller-authorization:${session}`]);
            await client.query("UPDATE reseller_authorizations SET consumed=true,result='processing' WHERE session_hash=$1", [session]);
            client.release(true);
            authorized = true;
            const before = completeCalls;
            assert.equal((await read()).recoverable, true);
            assert.equal((await (await call("/model-authorization/recover", "POST")).json()).result, "authorized");
            assert.equal(completeCalls, before);
        });
        await t.test("concurrent callback and recovery wait for the same connection lock", async () => {
            await start();
            let enter!: () => void, release!: () => void;
            const entered = new Promise<void>(resolve => { enter = resolve; });
            const gate = new Promise<void>(resolve => { release = resolve; });
            hold = async () => { enter(); await gate; };
            const before = completeCalls, first = callback();
            await entered;
            const probe = await db.connect();
            const key = `reseller-authorization:${session}`;
            try {
                assert.equal((await probe.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired", [key])).rows[0].acquired, false);
            } finally { probe.release(); }
            const second = callback(), recovery = call("/model-authorization/recover", "POST");
            release();
            const responses = await Promise.all([first, second, recovery]);
            hold = undefined;
            assert.equal(completeCalls, before + 1);
            assert.equal((await responses[2].json()).result, "authorized");
        });
        await t.test("rotation uses the original configured credential, removed credentials require a new flow", async () => {
            await start();
            env.ENHANCER_APP_CREDENTIAL = "replacement-credential";
            env.ENHANCER_PREVIOUS_APP_CREDENTIALS = ["original-credential"];
            const before = credentials.length;
            await callback();
            assert.deepEqual(credentials.slice(before), ["Bearer original-credential", "Bearer original-credential"]);
            env.ENHANCER_APP_CREDENTIAL = "original-credential";
            await start();
            env.ENHANCER_APP_CREDENTIAL = "replacement-credential";
            env.ENHANCER_PREVIOUS_APP_CREDENTIALS = [];
            const count = completeCalls;
            await callback();
            assert.equal((await read()).result, "AUTHORIZATION_CREDENTIAL_UNAVAILABLE");
            assert.equal(completeCalls, count);
        });
        await t.test("lost revoke responses do not report success and an explicit retry confirms revocation", async () => {
            revokeLost = true;
            const response = await call("/model-authorization/revoke", "POST");
            assert.equal(response.status, 503);
            assert.equal((await response.json()).error, "AUTHORIZATION_REVOKE_UNKNOWN");
            revokeLost = false;
            assert.deepEqual(await (await call("/model-authorization/revoke", "POST")).json(), { status: "revoked" });
        });
    } finally { globalThis.fetch = originalFetch; server.close(); server.closeAllConnections(); await db.end(); }
});
