import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";
import { request } from "node:http";
import { SignJWT, generateKeyPair, exportJWK } from "jose";

Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: "postgresql://unused:unused@localhost/unused",
    APP_ORIGIN: "https://app.test", APP_ORIGINS: '["https://app.test","https://ccpg.test"]', HOMEONE_LOGIN_ORIGIN: "https://home.test",
    IDONE_APP: "admin/creativeone", IDONE_ISSUER: "https://idone.test", IDONE_DISCOVERY_URL: "",
    IDONE_CLIENT_ID: "creativeone", IDONE_CLIENT_SECRET: "private", ADMIN_SUBJECTS: "admin",
});
const { authRouter } = await import("./auth.js");
const { db } = await import("./db.js");

test("standard HomeONE flow keeps business identity and sessions independent", async (t) => {
    type Flow = { id_hash: string; state: string; origin: string; return_to: string; expired?: boolean };
    const flows = new Map<string, Flow>();
    let oidcFlow: any, grantFlow: any, discoveryCalls = 0, userWrites = 0;
    let identity = "alice", invalid = "", tokenCalls = 0;
    const key = await generateKeyPair("RS256"), wrongKey = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(key.publicKey), kid: "test", alg: "RS256", use: "sig" };
    const users = new Map<string, any>(), sessions = new Map<string, any>();
    sessions.set(createHash("sha256").update("session").digest("hex"), { id: "alice", subject: "alice", csrf: "csrf", origin: "https://app.test" });
    const realQuery = db.query, realFetch = globalThis.fetch;
    db.query = (async (sql: string, values: any[] = []) => {
        if (sql.startsWith("INSERT INTO homeone_flows")) {
            const [id_hash, state, origin, return_to] = values;
            flows.set(id_hash, { id_hash, state, origin, return_to });
        } else if (sql.startsWith("DELETE FROM homeone_flows WHERE expires_at")) {
            for (const [id, flow] of flows) if (flow.expired || (id === values[0] && flow.origin === values[1])) flows.delete(id);
        } else if (sql.startsWith("DELETE FROM homeone_flows")) {
            const flow = flows.get(values[0]);
            if (flow && flow.state === values[1] && flow.origin === values[2] && !flow.expired) {
                flows.delete(values[0]);
                return { rows: [flow] };
            }
        } else if (sql.startsWith("INSERT INTO login_flows")) {
            grantFlow = oidcFlow = { id_hash: values[0], state: values[1], nonce: values[2], verifier: values[3], origin: values[5], return_to: values[6] };
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
        assert.equal(target.origin, "https://home.test");
        assert.equal(target.searchParams.get("app"), "admin/creativeone");
        assert.equal(target.searchParams.get("returnTo"), `https://${host}/api/auth/callback`);
        assert.equal(target.searchParams.get("register"), "true");
        assert.equal(target.searchParams.has("returnOrigin"), false);
        const cookie = response.headers.get("set-cookie")!;
        assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/); assert.doesNotMatch(cookie, /Domain=/);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("referrer-policy"), "no-referrer");
        const state = target.searchParams.get("appState")!;
        assert.match(state, /^[\w-]{43}$/); assert.ok(!cookie.includes(state));
        return { path: `/callback?appState=${state}`, state, cookie: cookie.split(";")[0] };
    };
    const rejected = (response: Response) => {
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("location"), null);
    };
    try {
        for (const Host of ["evil.test", "app.test:443", "app.test:444"]) assert.equal((await call("/login", { Host, "X-Forwarded-Host": "app.test" })).status, 400);
        for (const path of ["/login?returnTo=//evil.test", "/login?returnTo=/api/auth/login", "/login?returnTo=/studio&returnTo=/canvas", "/login?register=yes", "/login?returnOrigin=https://app.test", "/login?client_id=other", "/login?channel_id=other"]) rejected(await call(path));
        assert.equal(flows.size, 0);
        for (const path of ["/login", "/login?register=false"]) {
            const response = await call(path);
            const target = new URL(response.headers.get("location")!);
            assert.equal(target.origin, "https://home.test");
            assert.equal(target.searchParams.get("register"), path.includes("register") ? "false" : null);
            assert.equal([...flows.values()].at(-1)!.return_to, "/studio");
        }
        flows.clear();
        const first = await start();
        rejected(await call(first.path));
        rejected(await call(first.path, { Cookie: "__Host-creativeone-homeone=wrong" }));
        rejected(await call(first.path, { Cookie: first.cookie, Host: "ccpg.test" }));
        const malformed = [
            first.path + "&appState=" + first.state, first.path + "&returnTo=/admin/tasks",
            first.path + "&iss=https%3A%2F%2Fidone.test", first.path + "&userId=admin", first.path + "&error=denied",
            first.path + "&state=oidc", first.path + "&code=code", first.path + "&error=",
            "/callback", "/callback?code=code", "/callback?error=denied", "/callback?state=oidc",
            "/callback?appState=", "/callback?state=&code=code", "/callback?state=oidc&code=",
            "/callback?state=oidc&error=", "/callback?state=oidc&code=code&error=denied",
            "/callback?state=oidc&state=other&code=code", "/callback?state=oidc&code=a&code=b",
            "/callback?state=oidc&error=a&error=b", "/callback?state=oidc&code=code&iss=",
            "/callback?state=oidc&code=code&role=admin",
        ];
        for (const path of malformed) {
            const response = await call(path, { Cookie: first.cookie });
            assert.equal(response.status, 400, path);
            assert.equal(response.headers.get("location"), null);
        }
        assert.equal(flows.size, 1);
        assert.equal(discoveryCalls, 0);
        const success = await call(first.path, { Cookie: first.cookie });
        const authorize = new URL(success.headers.get("location")!);
        assert.equal(authorize.origin, "https://idone.test");
        assert.equal(authorize.searchParams.get("client_id"), "creativeone");
        assert.equal(authorize.searchParams.get("redirect_uri"), "https://app.test/api/auth/callback");
        assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
        assert.equal(authorize.searchParams.get("code_challenge"), createHash("sha256").update(oidcFlow.verifier).digest("base64url"));
        assert.notEqual(oidcFlow.state, first.state);
        assert.equal(oidcFlow.return_to, "/canvas/project?view=nodes#focus");
        assert.equal(flows.size, 0);
        rejected(await call(first.path, { Cookie: first.cookie }));
        const oidcCookie = success.headers.get("set-cookie")!.match(/__Host-creativeone-login=[^;,]+/)![0];
        assert.ok(!success.headers.get("set-cookie")!.includes("__Host-creativeone="));
        rejected(await call("/callback?state=wrong&code=valid", { Cookie: oidcCookie }));
        rejected(await call(`/callback?state=${oidcFlow.state}&code=valid`, { Host: "ccpg.test", Cookie: oidcCookie }));
        assert.equal(tokenCalls, 0);
        const oidcErrorPath = `/callback?state=${oidcFlow.state}&error=access_denied&error_description=private-details&iss=https%3A%2F%2Fidone.test`;
        const oidcError = await call(oidcErrorPath, { Cookie: oidcCookie });
        assert.equal(oidcError.headers.get("location"), "/canvas/project?view=nodes&authError=login#focus");
        assert.ok(!oidcError.headers.get("location")!.includes("private-details"));
        assert.equal(oidcFlow, undefined);
        rejected(await call(oidcErrorPath, { Cookie: oidcCookie }));
        assert.equal(discoveryCalls, 1);
        const second = await start("ccpg.test");
        const failure = await call(second.path + "&error=homeone_login_failed", { Host: "ccpg.test", Cookie: second.cookie });
        assert.equal(failure.status, 302);
        assert.equal(failure.headers.get("location"), "/canvas/project?view=nodes&authError=login#focus");
        assert.equal(flows.size, 0); assert.equal(discoveryCalls, 1);
        const expired = await start();
        for (const flow of flows.values()) flow.expired = true;
        rejected(await call(expired.path, { Cookie: expired.cookie }));
        rejected(await call("/callback?code=fake&state=fake"));
        assert.equal((await call("/me", { Cookie: "__Host-creativeone=session" })).status, 200);
        assert.equal((await call("/me", { Cookie: "__Host-creativeone=session", Host: "ccpg.test" })).status, 401);

        const begin = async (host = "app.test", returnTo = "/canvas/project?view=nodes#focus") => {
            const flow = await start(host, "", returnTo);
            const response = await call(flow.path, { Host: host, Cookie: flow.cookie });
            assert.equal(response.status, 302);
            assert.equal(new URL(response.headers.get("location")!).searchParams.get("client_id"), "creativeone");
            return { path: `/callback?state=${grantFlow.state}&code=valid`, cookie: response.headers.get("set-cookie")!.match(/__Host-creativeone-login=[^;,]+/)![0] };
        };
        const complete = async (host = "app.test", returnTo?: string) => {
            const flow = await begin(host, returnTo);
            const response = await call(flow.path, { Host: host, Cookie: flow.cookie });
            assert.equal(response.status, 302);
            assert.equal(response.headers.get("location"), returnTo || "/canvas/project?view=nodes#focus");
            const cookie = response.headers.get("set-cookie")!.match(/__Host-creativeone=[^;,]+/)![0];
            rejected(await call(flow.path, { Host: host, Cookie: flow.cookie }));
            const me = await (await call("/me", { Host: host, Cookie: cookie })).json();
            return { cookie, ...me };
        };
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
        await t.test("starting again invalidates the previous HomeONE and business flows", async () => {
            const older = await start();
            const newer = await start("app.test", older.cookie);
            rejected(await call(older.path, { Cookie: newer.cookie }));
            rejected(await call(older.path, { Cookie: older.cookie }));
            const response = await call(newer.path, { Cookie: newer.cookie });
            const oldOidcCookie = response.headers.get("set-cookie")!.match(/__Host-creativeone-login=[^;,]+/)![0];
            const oldOidcPath = `/callback?state=${oidcFlow.state}&code=old`;
            await start("app.test", oldOidcCookie);
            const calls = tokenCalls;
            rejected(await call(oldOidcPath, { Cookie: oldOidcCookie }));
            assert.equal(tokenCalls, calls);
        });
        await t.test("logout clears only the current site's session with CSRF protection", async () => {
            const alice = await complete(), ccpg = await complete("ccpg.test");
            assert.equal((await call("/logout", { Cookie: alice.cookie }, "POST")).status, 403);
            const response = await call("/logout", { Cookie: alice.cookie, Origin: "https://app.test", "X-CSRF-Token": alice.csrf }, "POST");
            assert.equal(response.status, 200);
            assert.match(response.headers.get("set-cookie")!, /Max-Age=0/);
            assert.equal((await call("/me", { Cookie: alice.cookie })).status, 401);
            assert.equal((await call("/me", { Host: "ccpg.test", Cookie: ccpg.cookie })).status, 200);
        });
    } finally {
        globalThis.fetch = realFetch; db.query = realQuery;
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await db.end();
    }
});
