import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";
import { request } from "node:http";
import { SignJWT, generateKeyPair, exportJWK } from "jose";

Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: "postgresql://unused:unused@localhost/unused",
    APP_ORIGIN: "https://app.test", APP_ORIGINS: '["https://app.test","https://ccpg.test"]', ENHANCER_BASE_URL: "https://reseller.test", RESELLER_APP_ID: "creativeone", LOGIN_SECONDS: "900",
    IDONE_ISSUER: "https://idone.test", IDONE_DISCOVERY_URL: "",
    IDONE_CLIENT_ID: "creativeone", IDONE_CLIENT_SECRET: "private", ADMIN_SUBJECTS: "admin",
});
const { authRouter } = await import("./auth.js");
const { db } = await import("./db.js");

test("Reseller navigation and independent OIDC keep business identity and sessions isolated", async (t) => {
    type Flow = { id_hash: string; origin: string; return_to: string; expired?: boolean };
    const flows = new Map<string, Flow>();
    let oidcFlow: any, grantFlow: any, discoveryCalls = 0, userWrites = 0;
    let identity = "alice", invalid = "", tokenCalls = 0;
    const key = await generateKeyPair("RS256"), wrongKey = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(key.publicKey), kid: "test", alg: "RS256", use: "sig" };
    const users = new Map<string, any>(), sessions = new Map<string, any>();
    sessions.set(createHash("sha256").update("session").digest("hex"), { id: "alice", subject: "alice", csrf: "csrf", origin: "https://app.test" });
    const realQuery = db.query, realFetch = globalThis.fetch;
    db.query = (async (sql: string, values: any[] = []) => {
        if (sql.startsWith("INSERT INTO login_returns")) {
            const [id_hash, origin, return_to, lifetime] = values;
            assert.equal(lifetime, 600);
            flows.set(id_hash, { id_hash, origin, return_to });
        } else if (sql.startsWith("DELETE FROM login_returns WHERE expires_at")) {
            for (const [id, flow] of flows) if (flow.expired || (id === values[0] && flow.origin === values[1])) flows.delete(id);
        } else if (sql.startsWith("DELETE FROM login_returns")) {
            const flow = flows.get(values[0]);
            if (flow?.origin === values[1]) {
                flows.delete(values[0]);
                return { rows: [{ ...flow, valid: !flow.expired }] };
            }
        } else if (sql.startsWith("INSERT INTO login_flows")) {
            assert.equal(values[4], 300);
            grantFlow = oidcFlow = { id_hash: values[0], state: values[1], nonce: values[2], verifier: values[3], origin: values[5], return_to: values[6], client_id: values[7], redirect_uri: values[8], issuer: values[9], valid: true };
        } else if (sql.startsWith("DELETE FROM login_flows WHERE expires_at")) {
            if (oidcFlow && (!oidcFlow.valid || (oidcFlow.id_hash === values[0] && oidcFlow.origin === values[1]))) oidcFlow = undefined;
        } else if (sql.startsWith("DELETE FROM login_flows WHERE id_hash")) {
            if (oidcFlow && oidcFlow.id_hash === values[0] && oidcFlow.origin === values[1] && (values.length === 2 || oidcFlow.state === values[2])) {
                const flow = oidcFlow; oidcFlow = undefined;
                return { rows: [flow] };
            }
        } else if (sql.startsWith("INSERT INTO users")) {
            userWrites++;
            const [id, issuer, subject, email, email_verified, username, display_name, avatar_url] = values;
            const user = users.get(issuer + subject) || { id, issuer, subject };
            Object.assign(user, { email, email_verified, username, display_name, avatar_url });
            users.set(issuer + subject, user);
            return { rows: [user] };
        } else if (sql.startsWith("INSERT INTO sessions")) {
            const user = [...users.values()].find((user) => user.id === values[1]);
            sessions.set(values[0], { ...user, csrf: values[2], origin: values[4] });
        } else if (sql.startsWith("DELETE FROM sessions WHERE id_hash")) {
            sessions.delete(values[0]);
        } else if (sql.startsWith("SELECT u.")) {
            assert.match(sql, /s\.origin=\$2/);
            const session = sessions.get(values[0]);
            return { rows: session?.origin === values[1] ? [session] : [] };
        } else if (!sql.startsWith("DELETE FROM login_flows") && !sql.startsWith("DELETE FROM sessions")) assert.fail(`Unexpected database query: ${sql}`);
        return { rows: [] };
    }) as typeof db.query;
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/.well-known/openid-configuration")) {
            discoveryCalls++;
            return Response.json({ issuer: "https://idone.test", authorization_endpoint: "https://idone.test/authorize", token_endpoint: "https://idone.test/token", userinfo_endpoint: "https://idone.test/userinfo", jwks_uri: "https://idone.test/jwks", response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
        }
        if (url === "https://idone.test/jwks") return Response.json({ keys: [jwk] });
        if (url === "https://idone.test/userinfo") return Response.json({ sub: invalid === "userinfo" ? "other" : identity, email: "same@example.test", email_verified: true, name: identity });
        assert.equal(url, "https://idone.test/token");
        tokenCalls++;
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("client_id"), "creativeone");
        assert.equal(body.get("client_secret"), "private");
        assert.equal(body.get("redirect_uri"), grantFlow.origin + "/api/auth/callback");
        assert.equal(body.get("code_verifier"), grantFlow.verifier);
        const id_token = await new SignJWT({ nonce: invalid === "nonce" ? "wrong" : grantFlow.nonce })
            .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuedAt()
            .setIssuer(invalid === "issuer" ? "https://evil.test" : "https://idone.test")
            .setAudience(invalid === "audience" ? "another-app" : "creativeone").setSubject(identity)
            .setExpirationTime(invalid === "expiry" ? Math.floor(Date.now() / 1000) - 3600 : "5m")
            .sign(invalid === "signature" ? wrongKey.privateKey : key.privateKey);
        return Response.json({ access_token: "private-access-token", token_type: "Bearer", id_token });
    };
    const app = express();
    app.use("/api/auth", authRouter);
    app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status || 500).json({ error: error.code }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/auth`;
    const call = (path: string, headers: Record<string, string> = {}, method = "GET") => new Promise<Response>((resolve, reject) => {
        const req = request(base + path, { method, headers: { Host: "app.test", ...headers } }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const resultHeaders = new Headers();
                for (const [key, value] of Object.entries(res.headers)) for (const item of Array.isArray(value) ? value : value ? [value] : []) resultHeaders.append(key, item);
                resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: resultHeaders }));
            });
        });
        req.on("error", reject); req.end();
    });
    const start = async (host = "app.test", browserCookie = "", returnTo = "/canvas/project?view=nodes#focus") => {
        const response = await call("/login?register=true&returnTo=" + encodeURIComponent(returnTo), { Host: host, Cookie: browserCookie });
        assert.equal(response.status, 302);
        const target = new URL(response.headers.get("location")!);
        assert.equal(target.origin, "https://reseller.test");
        assert.equal(target.pathname, "/auth/enter");
        assert.deepEqual(Object.fromEntries(target.searchParams), { appId: "creativeone", sourceOrigin: `https://${host}`, register: "true" });
        const cookie = response.headers.get("set-cookie")!;
        assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/); assert.doesNotMatch(cookie, /Domain=/);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("referrer-policy"), "no-referrer");
        return cookie.match(/__Host-creativeone-return=[^;,]+/)![0];
    };
    const rejected = (response: Response) => {
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("location"), null);
    };
    const direct = async (host = "app.test", cookie = "") => {
        const response = await call("/oidc/start", { Host: host, Cookie: cookie });
        assert.equal(response.status, 302);
        const authorize = new URL(response.headers.get("location")!);
        assert.equal(authorize.origin, "https://idone.test");
        assert.equal(authorize.searchParams.get("client_id"), "creativeone");
        assert.equal(authorize.searchParams.get("redirect_uri"), `https://${host}/api/auth/callback`);
        assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
        assert.equal(authorize.searchParams.get("code_challenge"), createHash("sha256").update(oidcFlow.verifier).digest("base64url"));
        assert.match(response.headers.get("set-cookie")!, /Max-Age=300/);
        assert.ok(!response.headers.get("set-cookie")!.includes("__Host-creativeone="));
        return { path: `/callback?state=${grantFlow.state}&code=valid`, cookie: response.headers.get("set-cookie")!.match(/__Host-creativeone-login=[^;,]+/)![0] };
    };
    const begin = async (host = "app.test", returnTo = "/canvas/project?view=nodes#focus") => direct(host, await start(host, "", returnTo));
    const complete = async (host = "app.test", returnTo = "/canvas/project?view=nodes#focus") => {
        const flow = await begin(host, returnTo);
        const response = await call(flow.path, { Host: host, Cookie: flow.cookie });
        assert.equal(response.headers.get("location"), returnTo);
        const cookie = response.headers.get("set-cookie")!.match(/__Host-creativeone=[^;,]+/)![0];
        rejected(await call(flow.path, { Host: host, Cookie: flow.cookie }));
        const me = await (await call("/me", { Host: host, Cookie: cookie })).json();
        return { cookie, ...me };
    };
    try {
        await t.test("navigation sends only public parameters and preserves validated paths locally", async () => {
            for (const Host of ["evil.test", "app.test:443", "app.test:444"]) rejected(await call("/login", { Host, "X-Forwarded-Host": "app.test" }));
            for (const path of ["/login?returnTo=//evil.test", "/login?returnTo=/api/auth/login", "/login?returnTo=/studio&returnTo=/canvas", "/login?register=yes", "/login?returnOrigin=https://app.test", "/login?client_id=other", "/login?siteId=other"]) rejected(await call(path));
            assert.equal(flows.size, 0);
            for (const path of ["/login", "/login?register=false"]) {
                const target = new URL((await call(path)).headers.get("location")!);
                assert.deepEqual(Object.fromEntries(target.searchParams), { appId: "creativeone", sourceOrigin: "https://app.test" });
            }
            flows.clear();
            const cookie = await start();
            assert.equal(discoveryCalls, 0);
            await direct("app.test", cookie);
            assert.equal(oidcFlow.return_to, "/canvas/project?view=nodes#focus");
            assert.equal(flows.size, 0);
            await direct("app.test", cookie);
            assert.equal(oidcFlow.return_to, "/studio");
        });
        await t.test("direct entry needs no navigation proof; missing, expired and foreign records fall back", async () => {
            await direct();
            assert.equal(oidcFlow.return_to, "/studio");
            const cookie = await start();
            for (const flow of flows.values()) flow.expired = true;
            await direct("app.test", cookie);
            assert.equal(oidcFlow.return_to, "/studio");
            assert.equal(flows.size, 0);
            const foreign = await start();
            await direct("ccpg.test", foreign);
            assert.equal(oidcFlow.return_to, "/studio");
            assert.equal(flows.size, 1);
            await direct("app.test", foreign);
            assert.equal(oidcFlow.return_to, "/canvas/project?view=nodes#focus");
            rejected(await call("/oidc/start?appState=old"));
        });
        await t.test("callback rejects malformed responses without creating an identity", async () => {
            const writes = userWrites;
            for (const path of [
                "/callback?appState=old", "/callback?appState=old&error=homeone_login_failed",
                "/callback", "/callback?code=code", "/callback?error=denied", "/callback?state=oidc",
                "/callback?state=&code=code", "/callback?state=oidc&code=", "/callback?state=oidc&error=",
                "/callback?state=oidc&code=code&error=denied", "/callback?state=oidc&state=other&code=code",
                "/callback?state=oidc&code=a&code=b", "/callback?state=oidc&error=a&error=b",
                "/callback?state=oidc&code=code&iss=", "/callback?state=oidc&code=code&role=admin",
            ]) rejected(await call(path));
            const flow = await begin();
            rejected(await call(flow.path));
            rejected(await call(flow.path, { Cookie: "__Host-creativeone-login=wrong" }));
            rejected(await call(flow.path, { Host: "ccpg.test", Cookie: flow.cookie }));
            assert.ok(oidcFlow);
            const wrong = await call("/callback?state=wrong&code=valid", { Cookie: flow.cookie });
            rejected(wrong);
            assert.match(await wrong.text(), /返回登录页/);
            assert.equal(oidcFlow, undefined);
            assert.equal(userWrites, writes);
            assert.equal(tokenCalls, 0);
        });
        await t.test("expired or changed client transactions are consumed without exchanging a code", async () => {
            for (const patch of [{ valid: false }, { client_id: "another" }, { issuer: "https://other.test" }, { redirect_uri: "https://other.test/api/auth/callback" }]) {
                const flow = await begin();
                Object.assign(oidcFlow, patch);
                rejected(await call(flow.path, { Cookie: flow.cookie }));
                assert.equal(oidcFlow, undefined);
            }
            const flow = await begin();
            rejected(await call(flow.path.replace("/callback?", "/callback/?"), { Cookie: flow.cookie }));
            assert.equal(oidcFlow, undefined);
            assert.equal(tokenCalls, 0);
        });
        await t.test("provider cancellation consumes the transaction and offers manual retry", async () => {
            const flow = await begin();
            const path = flow.path.replace("code=valid", "error=access_denied&error_description=private-details");
            const response = await call(path, { Cookie: flow.cookie });
            assert.equal(response.headers.get("location"), "/canvas/project?view=nodes&authError=login#focus");
            assert.equal(oidcFlow, undefined);
            rejected(await call(path, { Cookie: flow.cookie }));
        });
        await t.test("one issuer/sub across origins, final account switch and administrator checks", async () => {
            const alice = await complete(), aliceCcpg = await complete("ccpg.test");
            assert.equal(alice.user.id, aliceCcpg.user.id);
            assert.equal(alice.user.admin, false);
            assert.equal((await call("/me", { Host: "ccpg.test", Cookie: alice.cookie })).status, 401);
            identity = "bob";
            const bob = await complete();
            assert.notEqual(bob.user.id, alice.user.id); // Same email never claims Alice's account.
            assert.equal(bob.user.displayName, "bob");
            assert.equal(bob.user.admin, false);
            identity = "admin";
            const admin = await complete("app.test", "/admin/tasks?status=failed#task");
            assert.equal(admin.user.admin, true);
            assert.equal(users.size, 3);
            assert.ok(!admin.cookie.includes("private-access-token"));
            identity = "alice";
        });
        for (const reason of ["signature", "issuer", "audience", "expiry", "nonce", "userinfo"]) await t.test(`reject invalid ${reason} before persisting identity/session`, async () => {
            invalid = reason;
            const writes = userWrites, sessionCount = sessions.size;
            const flow = await begin();
            const response = await call(flow.path, { Cookie: flow.cookie });
            assert.equal(response.headers.get("location"), "/canvas/project?view=nodes&authError=login#focus");
            assert.equal(userWrites, writes); assert.equal(sessions.size, sessionCount);
            assert.ok(!response.headers.get("set-cookie")!.includes("__Host-creativeone="));
            rejected(await call(flow.path, { Cookie: flow.cookie }));
            invalid = "";
        });
        await t.test("starting again replaces navigation and invalidates the previous OIDC transaction", async () => {
            const older = await start();
            const newer = await start("app.test", older, "/video");
            await direct("app.test", older);
            assert.equal(oidcFlow.return_to, "/studio");
            const oldFlow = await direct("app.test", newer);
            assert.equal(oidcFlow.return_to, "/video");
            const newFlow = await direct("app.test", oldFlow.cookie);
            rejected(await call(oldFlow.path, { Cookie: oldFlow.cookie }));
            assert.ok(oidcFlow);
            await start("app.test", newFlow.cookie);
            assert.equal(oidcFlow, undefined);
            rejected(await call(newFlow.path, { Cookie: newFlow.cookie }));
        });
        await t.test("valid sessions bypass navigation but platform entry still verifies the final OIDC account", async () => {
            const alice = await complete();
            const count = flows.size;
            const response = await call("/login?returnTo=/video", { Cookie: alice.cookie });
            assert.equal(response.headers.get("location"), "/video");
            assert.equal(flows.size, count);
            identity = "bob";
            const flow = await direct("app.test", alice.cookie);
            const result = await call(flow.path, { Cookie: `${alice.cookie}; ${flow.cookie}` });
            assert.equal(result.headers.get("location"), "/studio");
            assert.equal((await call("/me", { Cookie: alice.cookie })).status, 401);
            identity = "alice";
        });
        await t.test("logout clears current-origin session and unfinished flows with CSRF protection", async () => {
            const alice = await complete(), ccpg = await complete("ccpg.test");
            const flow = await direct();
            const navigation = await start();
            const cookies = `${alice.cookie}; ${flow.cookie}; ${navigation}`;
            assert.equal((await call("/logout", { Cookie: cookies }, "POST")).status, 403);
            const response = await call("/logout", { Cookie: cookies, Origin: "https://app.test", "X-CSRF-Token": alice.csrf }, "POST");
            assert.equal(response.status, 200);
            for (const name of ["creativeone", "creativeone-login", "creativeone-return"]) assert.ok(response.headers.get("set-cookie")!.includes(`__Host-${name}=; Max-Age=0`));
            assert.equal(oidcFlow, undefined);
            rejected(await call(flow.path, { Cookie: flow.cookie }));
            await direct("app.test", navigation);
            assert.equal(oidcFlow.return_to, "/studio");
            assert.equal((await call("/me", { Cookie: alice.cookie })).status, 401);
            assert.equal((await call("/me", { Host: "ccpg.test", Cookie: ccpg.cookie })).status, 200);
        });
    } finally {
        globalThis.fetch = realFetch; db.query = realQuery;
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await db.end();
    }
});
