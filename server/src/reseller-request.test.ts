import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { request } from "node:http";

Object.assign(process.env, { DATABASE_URL: "postgresql://unused:unused@localhost/unused", APP_ORIGIN: "https://app.test", APP_ORIGINS: '["https://app.test"]',
    IDONE_ISSUER: "https://idone.test", IDONE_DISCOVERY_URL: "", IDONE_CLIENT_ID: "test", IDONE_CLIENT_SECRET: "test", ADMIN_SUBJECTS: "admin",
    ENHANCER_BASE_URL: "https://reseller.test", ENHANCER_APP_CREDENTIAL: "private-credential", TOKENONE_BASE_URL: "https://model.test" });
const { enhancer, ensureKey, channelRouter } = await import("./tokenone.js");

test("Reseller deadlines and disconnect cancellation", async t => {
    const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
    const deadlines: number[] = [];
    let requests = 0;
    AbortSignal.timeout = (duration: number) => { deadlines.push(duration); return new AbortController().signal; };
    globalThis.fetch = async () => { requests++; return Response.json({ ok: true }); };
    try {
        await t.test("new calls use 120 seconds; balance and catalogue limits are preserved", async () => {
            await enhancer("/groups", "test");
            await enhancer("/balance/query", "test", {}, AbortSignal.timeout(7_000));
            await enhancer("/pricing", "test", undefined, AbortSignal.timeout(600_000));
            assert.deepEqual(deadlines, [120_000, 7_000, 600_000]);
            assert.equal(requests, 3);
        });
        await t.test("cancelled ensure reports a service failure without retrying", async () => {
            const parent = new AbortController();
            globalThis.fetch = async (_url, init) => {
                requests++;
                return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }));
            };
            const before = requests;
            const pending = ensureKey({ email_verified: true, issuer: "https://idone.test", subject: "alice" } as any, "test", { signal: parent.signal });
            parent.abort();
            await assert.rejects(pending, (error: any) => error.status === 503 && error.code === "APP_SERVICE_UNAVAILABLE");
            assert.equal(requests, before + 1);
        });
        await t.test("closing an admin read cancels its upstream request", async () => {
            let enter!: () => void, cancelled!: () => void;
            const entered = new Promise<void>(resolve => { enter = resolve; });
            const aborted = new Promise<void>(resolve => { cancelled = resolve; });
            globalThis.fetch = async (_url, init) => {
                enter();
                return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => { cancelled(); reject(init!.signal!.reason); }, { once: true }));
            };
            const app = express();
            app.use((_req, res, next) => { res.locals.user = { subject: "admin" }; res.locals.requestId = "test"; next(); }, channelRouter);
            app.use((_error: any, _req: any, res: any, _next: any) => { if (!res.destroyed) res.sendStatus(503); });
            const server = app.listen(0, "127.0.0.1");
            await new Promise<void>(resolve => server.once("listening", resolve));
            const req = request(`http://127.0.0.1:${(server.address() as { port: number }).port}/admin/groups`);
            req.on("error", () => undefined);
            try { req.end(); await entered; req.destroy(); await aborted; }
            finally { server.close(); server.closeAllConnections(); }
        });
    } finally { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; }
});
