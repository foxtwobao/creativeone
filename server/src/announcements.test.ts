import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import express from "express";

const database = process.env.TEST_DATABASE_URL;
test("announcement proxy and per-account version receipts", { skip: !database }, async t => {
    assert.ok(new URL(database!).pathname.endsWith("_test"), "Use an isolated *_test database");
    Object.assign(process.env, { DATABASE_URL: database, APP_ORIGIN: "https://app.test", APP_ORIGINS: '["https://app.test"]', IDONE_ISSUER: "https://idone.test", IDONE_DISCOVERY_URL: "", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test", ADMIN_SUBJECTS: "admin", ENHANCER_BASE_URL: "https://reseller.test", ENHANCER_APP_CREDENTIAL: "private-app-key", TOKENONE_BASE_URL: "" });
    const { db, initializeDatabase } = await import("./db.js");
    const { requireUser, csrf } = await import("./auth.js");
    const { announcementsRouter } = await import("./announcements.js");
    const { noCache } = await import("./http.js");
    const { modelErrorMessage } = await import("./model-errors.js");
    const { loginSites } = await import("./config.js");
    await initializeDatabase();
    const alice = randomUUID(), bob = randomUUID();
    for (const [id, name] of [[alice, "alice"], [bob, "bob"]]) {
        await db.query("INSERT INTO users(id,issuer,subject,email,email_verified,username,display_name) VALUES($1,'https://idone.test',$2,'test@example.test',true,$2,$2)", [id, name]);
        await db.query("INSERT INTO sessions(id_hash,user_id,csrf,expires_at,origin) VALUES($1,$2,'test-csrf',now()+interval '1 hour','https://app.test')", [createHash("sha256").update(name).digest("hex"), id]);
    }
    const item = { id: "9007199254740993", title: "新公告", body_markdown: "## 新模型\n\n正文", published_at: "2026-10-16T08:00:00Z", updated_at: "2026-10-16T08:00:00Z" };
    let mode = "normal", calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        calls++;
        assert.equal(init?.headers && new Headers(init.headers).get("Authorization"), "Bearer private-app-key");
        assert.ok(init?.signal);
        assert.equal(init?.body, undefined);
        assert.equal(init?.method, "GET");
        assert.equal(init?.redirect, "error");
        assert.equal(init?.cache, "no-store");
        const target = new URL(String(url));
        assert.equal(target.origin, "https://reseller.test");
        if (mode === "network") throw new Error("private-upstream-error");
        if (mode === "credentials") return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
        if (mode === "authorization") return Response.json({ error: "APP_USER_AUTHORIZATION_REQUIRED" }, { status: 403 });
        if (mode === "gone") return Response.json({ error: "ANNOUNCEMENT_NOT_FOUND" }, { status: 404 });
        if (mode === "html") return new Response("<html>private-upstream</html>", { status: 502 });
        if (target.pathname.endsWith(`/announcements/${item.id}`)) {
            assert.equal(target.search, "");
            return Response.json(item);
        }
        assert.equal(target.pathname, "/api/apps/announcements");
        assert.deepEqual([...target.searchParams.keys()], ["limit", "offset"]);
        return Response.json({ app_id: "creativeone", items: mode === "empty" ? [] : [item], has_more: mode === "empty-more" });
    };
    const app = express();
    app.use((req, res, next) => { res.locals.requestId = "announcement-test"; next(); }, noCache, requireUser, csrf, express.json(), announcementsRouter);
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status || 500).json({ error: error.code, message: modelErrorMessage(error.code) }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address() as { port: number };
    loginSites.set(`127.0.0.1:${address.port}`, { origin: "https://app.test" });
    const get = (path = "/announcements", account = "alice", init: RequestInit = {}) => originalFetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { Cookie: `__Host-creativeone=${account}`, Origin: "https://app.test", "X-CSRF-Token": "test-csrf", "Content-Type": "application/json", ...init.headers } });
    const list = async (account = "alice") => (await get("/announcements", account)).json();
    const mark = (revision: string, account = "alice", extra = {}) => get(`/announcements/${item.id}/read`, account, { method: "PUT", body: JSON.stringify({ revision, ...extra }) });
    try {
        await t.test("authenticated reads validate selectors, preserve large IDs and hide list bodies", async () => {
            const unauthenticated = await originalFetch(`http://127.0.0.1:${address.port}/announcements`);
            assert.equal(unauthenticated.status, 401);
            const before = calls;
            for (const path of ["/announcements?subject=forged", "/announcements?limit=51", "/announcements?offset=-1", "/announcements?limit=1&limit=2", `/announcements/${item.id}?app_id=other`]) assert.equal((await get(path)).status, 400);
            assert.equal(calls, before);
            const response = await get();
            assert.match(response.headers.get("cache-control")!, /no-store/);
            const page = await response.json();
            assert.equal(page.items[0].id, item.id);
            assert.equal(page.items[0].read, false);
            assert.equal(page.items[0].body, undefined);
            assert.equal(page.nextOffset, 20);
            assert.equal((await (await get(`/announcements/${item.id}`)).json()).body, item.body_markdown);
        });
        await t.test("receipts are idempotent, durable and isolated by account", async () => {
            const revision = (await list()).items[0].revision;
            assert.equal((await mark(revision, "alice", { user_id: bob })).status, 400);
            assert.equal((await mark(revision)).status, 204);
            assert.equal((await mark(revision)).status, 204);
            assert.equal((await db.query("SELECT count(*)::int AS count FROM announcement_reads")).rows[0].count, 1);
            assert.equal((await list()).items[0].read, true);
            assert.equal((await list("bob")).items[0].read, false);
            assert.equal((await (await get(`/announcements/${item.id}`)).json()).read, true);
        });
        await t.test("edits and republishing are unread, stale acknowledgements cannot consume new content", async () => {
            item.updated_at = "2026-10-16T08:30:00Z";
            assert.equal((await list()).items[0].read, true);
            const old = (await list()).items[0].revision;
            item.body_markdown = "新的正文";
            item.updated_at = "2026-10-16T09:00:00Z";
            const updated = (await list()).items[0];
            assert.equal(updated.read, false);
            assert.equal((await mark(old)).status, 409);
            assert.equal((await mark(updated.revision)).status, 204);
            item.published_at = "2026-10-16T10:00:00Z";
            assert.equal((await list()).items[0].read, false);
            assert.equal((await db.query("SELECT count(*)::int AS count FROM announcement_reads")).rows[0].count, 2);
        });
        await t.test("CSRF, missing announcements and credential failures cannot write or request model authorization", async () => {
            const revision = (await list()).items[0].revision;
            const badCsrf = await get(`/announcements/${item.id}/read`, "alice", { method: "PUT", headers: { "X-CSRF-Token": "bad" }, body: JSON.stringify({ revision }) });
            assert.equal(badCsrf.status, 403);
            mode = "gone";
            assert.equal((await mark(revision)).status, 404);
            for (const [fixtureMode, status, code] of [["credentials", 502, "UNAUTHORIZED"], ["authorization", 503, "ANNOUNCEMENTS_UNAVAILABLE"], ["html", 503, "ANNOUNCEMENTS_UNAVAILABLE"], ["network", 503, "ANNOUNCEMENTS_UNAVAILABLE"]] as const) {
                mode = fixtureMode;
                const response = await get();
                assert.equal(response.status, status);
                const data = await response.json();
                assert.equal(data.error, code);
                assert.doesNotMatch(JSON.stringify(data), /private-upstream|private-app-key/);
            }
            assert.equal((await db.query("SELECT count(*)::int AS count FROM announcement_reads")).rows[0].count, 2);
            mode = "normal";
            assert.equal((await get()).status, 200);
            mode = "empty";
            assert.deepEqual((await list()).items, []);
        });
    } finally { globalThis.fetch = originalFetch; server.close(); server.closeAllConnections(); await db.end(); }
});
