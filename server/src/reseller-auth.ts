import { Router, type ErrorRequestHandler, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { db } from "./db.js";
import { env } from "./config.js";
import { requireUser } from "./auth.js";
import { applicationCredential, enhancer, ensureKey, modelProvider } from "./tokenone.js";
import { HttpError, noCache } from "./http.js";
import { modelErrorMessage } from "./model-errors.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const callbackUrl = `${env.APP_ORIGIN}/api/auth/reseller/callback`;
const returnPath = z.string().refine((path) => path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") && !/[\r\n]/.test(path) && new URL(path, env.APP_ORIGIN).origin === env.APP_ORIGIN && !new URL(path, env.APP_ORIGIN).pathname.startsWith("/api/"));
const startSchema = z.object({ returnTo: returnPath, draft: z.unknown() }).strict();
type Flow = { state_hash: string; verifier: string | null; credential_hash: string; return_to: string; draft: unknown; consumed: boolean; result: string | null; valid: boolean };
const uncertain = (flow: Flow) => flow.consumed && (flow.result === "processing" || flow.result === "unknown");
const definitive = (error: unknown) => error instanceof HttpError && (error.status < 500 || ["UNAUTHORIZED", "AUTHORIZATION_CREDENTIAL_UNAVAILABLE", "ENHANCER_NOT_CONFIGURED"].includes(error.code));

// Keep the consume committed before exchange. A connection lock serializes recovery and
// revocation across processes, and is released by PostgreSQL if the process disappears.
async function locked<T>(res: Response, run: (client: PoolClient) => Promise<T>) {
    const client = await db.connect();
    const key = `reseller-authorization:${res.locals.sessionHash}`;
    let unlocked = false;
    try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
        const session = await client.query("SELECT id_hash FROM sessions WHERE id_hash=$1 AND expires_at>now()", [res.locals.sessionHash]);
        if (!session.rowCount) throw new HttpError(401, "SESSION_EXPIRED");
        return await run(client);
    } finally {
        try { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]); unlocked = true; }
        finally { client.release(!unlocked); }
    }
}
async function readFlow(client: Pick<PoolClient, "query">, res: Response) {
    return (await client.query<Flow>(`SELECT *,expires_at>now() AS valid FROM reseller_authorizations
        WHERE session_hash=$1 AND issuer=$2 AND subject=$3 AND provider=$4`,
        [res.locals.sessionHash, res.locals.user.issuer, res.locals.user.subject, modelProvider])).rows[0];
}
function resume(flow: Flow | undefined) {
    if (!flow || (!flow.consumed && flow.draft == null)) return null;
    const recoverable = uncertain(flow);
    const result = recoverable ? "AUTHORIZATION_RESULT_UNKNOWN" : !flow.consumed && flow.valid ? "AUTHORIZATION_PENDING" : flow.result || "AUTHORIZATION_FLOW_INVALID";
    return { returnTo: flow.return_to, draft: flow.draft, result, recoverable,
        message: result === "authorized" ? "模型服务已授权" : modelErrorMessage(result) || "授权未完成，请重新发起。" };
}
async function finish(client: PoolClient, res: Response, flow: Flow, result: string) {
    await client.query(`UPDATE reseller_authorizations SET result=$2,verifier=NULL,authorization_url=NULL
        WHERE session_hash=$1 AND state_hash=$3 AND consumed=true`, [res.locals.sessionHash, result, flow.state_hash]);
    flow.result = result;
    return resume(flow);
}
async function recover(client: PoolClient, res: Response, flow: Flow) {
    let result = "authorized";
    try {
        const credential = applicationCredential(flow.credential_hash);
        if (!credential) throw new HttpError(503, "AUTHORIZATION_CREDENTIAL_UNAVAILABLE");
        await ensureKey(res.locals.user, res.locals.requestId, { credential, client });
    } catch (error) { result = definitive(error) ? (error as HttpError).code : "unknown"; }
    return finish(client, res, flow, result);
}

export const resellerRouter = Router();
resellerRouter.use("/model-authorization", noCache, (_req, res, next) => { res.setHeader("Referrer-Policy", "no-referrer"); next(); });
resellerRouter.post("/model-authorization", async (req, res) => {
    const input = startSchema.parse(req.body);
    const user = res.locals.user;
    if (!user.email_verified) throw new HttpError(403, "EMAIL_NOT_VERIFIED");
    if (!callbackUrl.startsWith("https://")) throw new HttpError(503, "REDIRECT_URI_FORBIDDEN");
    const result = await locked(res, async client => {
        const existing = await readFlow(client, res);
        if (existing && uncertain(existing)) {
            const status = await recover(client, res, existing);
            if (status?.recoverable) return { pending: true, recoverable: true };
            if (status?.result === "authorized") return { authorized: true };
        } else if (existing && !existing.consumed && existing.valid && applicationCredential(existing.credential_hash)) return { pending: true };
        try {
            await ensureKey(user, res.locals.requestId, { client });
            return { authorized: true };
        } catch (error) {
            if (!(error instanceof HttpError) || error.status !== 403 || error.code !== "APP_USER_AUTHORIZATION_REQUIRED") throw error;
        }
        const state = randomBytes(32).toString("base64url"), verifier = randomBytes(32).toString("base64url");
        const started = Date.now();
        const response = await enhancer("/authorizations", res.locals.requestId, {
            identity: { issuer: user.issuer, subject: user.subject }, redirect_uri: callbackUrl, state,
            code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        });
        const parsed = z.object({ authorization_url: z.url(), expires_in: z.literal(300) }).safeParse(response);
        if (!parsed.success) throw new HttpError(502, "ENHANCER_INVALID_RESPONSE");
        const url = new URL(parsed.data.authorization_url);
        if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new HttpError(502, "ENHANCER_INVALID_RESPONSE");
        await client.query(`INSERT INTO reseller_authorizations (session_hash,state_hash,verifier,issuer,subject,provider,credential_hash,authorization_url,return_to,draft,expires_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (session_hash) DO UPDATE SET state_hash=EXCLUDED.state_hash,verifier=EXCLUDED.verifier,issuer=EXCLUDED.issuer,subject=EXCLUDED.subject,provider=EXCLUDED.provider,credential_hash=EXCLUDED.credential_hash,authorization_url=EXCLUDED.authorization_url,return_to=EXCLUDED.return_to,draft=EXCLUDED.draft,expires_at=EXCLUDED.expires_at,consumed=false,result=NULL`,
            [res.locals.sessionHash, digest(state), verifier, user.issuer, user.subject, modelProvider, digest(env.ENHANCER_APP_CREDENTIAL!), url.href, input.returnTo, JSON.stringify(input.draft ?? null), new Date(started + 300_000)]);
        return { authorizationUrl: url.href };
    });
    res.json(result);
});
resellerRouter.get("/model-authorization", async (_req, res) => res.json(resume(await readFlow(db, res))));
resellerRouter.post("/model-authorization/recover", async (_req, res) => {
    res.json(await locked(res, async client => {
        const flow = await readFlow(client, res);
        return flow && uncertain(flow) ? recover(client, res, flow) : resume(flow);
    }));
});
resellerRouter.delete("/model-authorization/resume", async (_req, res) => {
    await locked(res, async client => {
        // Restoring the editor must not erase an authorization whose result is unknown.
        await client.query("UPDATE reseller_authorizations SET draft=NULL WHERE session_hash=$1", [res.locals.sessionHash]);
        await client.query("DELETE FROM reseller_authorizations WHERE session_hash=$1 AND consumed=true AND result NOT IN ('processing','unknown')", [res.locals.sessionHash]);
    });
    res.json({ ok: true });
});
resellerRouter.post("/model-authorization/revoke", async (_req, res) => {
    await locked(res, async client => {
        const user = res.locals.user;
        try {
            const result = await enhancer("/authorizations/revoke", res.locals.requestId, { identity: { issuer: user.issuer, subject: user.subject } });
            if (result.status !== "revoked") throw new HttpError(502, "ENHANCER_INVALID_RESPONSE");
        } catch (error) {
            if (definitive(error)) throw error;
            throw new HttpError(503, "AUTHORIZATION_REVOKE_UNKNOWN");
        }
        await client.query("DELETE FROM reseller_authorizations WHERE session_hash IN (SELECT id_hash FROM sessions WHERE user_id=$1)", [user.id]);
    });
    res.json({ status: "revoked" });
});

export const resellerCallbackRouter = Router();
resellerCallbackRouter.use(noCache, (_req, res, next) => { res.setHeader("Referrer-Policy", "no-referrer"); next(); });
resellerCallbackRouter.get("/", requireUser, async (req, res) => {
    const query = z.object({ code: z.string().min(1), state: z.string().min(32).max(256) }).strict().safeParse(req.query);
    if (!query.success) return res.redirect("/studio?modelAuthorization=invalid");
    const returnTo = await locked(res, async client => {
        const flow = await readFlow(client, res);
        if (!flow || flow.consumed || flow.state_hash !== digest(query.data.state)) return;
        const claimed = await client.query(`UPDATE reseller_authorizations SET consumed=true,result='processing'
            WHERE session_hash=$1 AND state_hash=$2 AND consumed=false RETURNING state_hash`, [res.locals.sessionHash, flow.state_hash]);
        if (!claimed.rowCount) return;
        flow.consumed = true;
        if (!flow.valid) await finish(client, res, flow, "AUTHORIZATION_FLOW_INVALID");
        else {
            try {
                const credential = applicationCredential(flow.credential_hash);
                if (!credential) throw new HttpError(503, "AUTHORIZATION_CREDENTIAL_UNAVAILABLE");
                const response = await enhancer("/authorizations/complete", res.locals.requestId, { code: query.data.code, code_verifier: flow.verifier }, undefined, credential);
                if (response.status !== "authorized") throw new HttpError(502, "ENHANCER_INVALID_RESPONSE");
                await recover(client, res, flow);
            } catch (error) {
                if (definitive(error)) await finish(client, res, flow, (error as HttpError).code);
                else await recover(client, res, flow); // Check only; a code is never exchanged twice.
            }
        }
        return flow.return_to;
    });
    res.redirect(returnTo || "/studio?modelAuthorization=invalid");
});

const callbackError: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.redirect("/studio?modelAuthorization=invalid");
};
resellerCallbackRouter.use(callbackError);
