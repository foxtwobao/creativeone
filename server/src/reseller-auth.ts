import { Router, type ErrorRequestHandler } from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { env } from "./config.js";
import { requireUser } from "./auth.js";
import { enhancer, ensureKey, modelProvider } from "./tokenone.js";
import { HttpError, noCache } from "./http.js";
import { modelErrorMessage } from "./model-errors.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const credentialHash = () => digest(env.ENHANCER_APP_CREDENTIAL || "");
const callbackUrl = `${env.APP_ORIGIN}/api/auth/reseller/callback`;
const returnPath = z.string().refine((path) => path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") && !/[\r\n]/.test(path) && new URL(path, env.APP_ORIGIN).origin === env.APP_ORIGIN && !new URL(path, env.APP_ORIGIN).pathname.startsWith("/api/"));
const startSchema = z.object({ returnTo: returnPath, draft: z.unknown() }).strict();
export const resellerRouter = Router();
resellerRouter.use("/model-authorization", noCache, (_req, res, next) => { res.setHeader("Referrer-Policy", "no-referrer"); next(); });
resellerRouter.post("/model-authorization", async (req, res) => {
    const input = startSchema.parse(req.body);
    const user = res.locals.user;
    if (!user.email_verified) throw new HttpError(403, "EMAIL_NOT_VERIFIED");
    if (!callbackUrl.startsWith("https://")) throw new HttpError(503, "REDIRECT_URI_FORBIDDEN");
    const result = await transaction(async (client) => {
        // Lock the session, including across processes, to merge concurrent starts.
        const session = await client.query("SELECT id_hash FROM sessions WHERE id_hash=$1 AND expires_at>now() FOR UPDATE", [res.locals.sessionHash]);
        if (!session.rowCount) throw new HttpError(401, "SESSION_EXPIRED");
        const existing = (await client.query("SELECT authorization_url FROM reseller_authorizations WHERE session_hash=$1 AND (consumed=false OR result='processing') AND expires_at>now() AND provider=$2 AND credential_hash=$3", [res.locals.sessionHash, modelProvider, credentialHash()])).rows[0];
        if (existing) return { pending: true };
        try {
            await ensureKey(user, res.locals.requestId);
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
            [res.locals.sessionHash, digest(state), verifier, user.issuer, user.subject, modelProvider, credentialHash(), url.href, input.returnTo, JSON.stringify(input.draft ?? null), new Date(started + 300_000)]);
        return { authorizationUrl: url.href };
    });
    res.json(result);
});
resellerRouter.get("/model-authorization", async (_req, res) => {
    const flow = (await db.query("SELECT return_to,draft,result FROM reseller_authorizations WHERE session_hash=$1 AND consumed=true AND result<>'processing'", [res.locals.sessionHash])).rows[0];
    res.json(flow ? { returnTo: flow.return_to, draft: flow.draft, result: flow.result, message: flow.result === "authorized" ? "授权完成，已恢复编辑内容；请检查云端任务后手动重试未完成操作。" : modelErrorMessage(flow.result) || "授权未完成，请重新发起。" } : null);
});
resellerRouter.delete("/model-authorization/resume", async (_req, res) => {
    await db.query("DELETE FROM reseller_authorizations WHERE session_hash=$1 AND consumed=true AND result<>'processing'", [res.locals.sessionHash]);
    res.json({ ok: true });
});
resellerRouter.post("/model-authorization/revoke", async (_req, res) => {
    const user = res.locals.user;
    const result = await enhancer("/authorizations/revoke", res.locals.requestId, { identity: { issuer: user.issuer, subject: user.subject } });
    if (result.status !== "revoked") throw new HttpError(502, "ENHANCER_INVALID_RESPONSE");
    await db.query("DELETE FROM reseller_authorizations WHERE session_hash IN (SELECT id_hash FROM sessions WHERE user_id=$1)", [user.id]);
    // Keys are never cached. Every subsequent model request must pass ensure again.
    res.json({ status: "revoked" });
});

export const resellerCallbackRouter = Router();
resellerCallbackRouter.use(noCache, (_req, res, next) => { res.setHeader("Referrer-Policy", "no-referrer"); next(); });
resellerCallbackRouter.get("/", requireUser, async (req, res) => {
    const query = z.object({ code: z.string().min(1), state: z.string().min(32).max(256) }).safeParse(req.query);
    if (!query.success) return res.redirect("/studio?modelAuthorization=invalid");
    const user = res.locals.user;
    // Consume before exchange; wrong state, changed identity or replay never reaches Reseller.
    const flow = (await db.query(`UPDATE reseller_authorizations SET consumed=true,result='processing'
        WHERE session_hash=$1 AND state_hash=$2 AND issuer=$3 AND subject=$4 AND provider=$5 AND credential_hash=$6 AND consumed=false RETURNING *,expires_at>now() AS valid`,
        [res.locals.sessionHash, digest(query.data.state), user.issuer, user.subject, modelProvider, credentialHash()])).rows[0];
    if (!flow) return res.redirect("/studio?modelAuthorization=invalid");
    let result = "authorized";
    try {
        if (!flow.valid) throw new HttpError(400, "AUTHORIZATION_FLOW_INVALID");
        try {
            const response = await enhancer("/authorizations/complete", res.locals.requestId, { code: query.data.code, code_verifier: flow.verifier });
            if (response.status !== "authorized") throw new HttpError(502, "ENHANCER_INVALID_RESPONSE");
        } catch (error) {
            // An exchange response may be lost after authorization succeeded. Never replay the code.
            if (error instanceof HttpError && error.status < 500) throw error;
        }
        await ensureKey(user, res.locals.requestId);
    } catch (error) { result = error instanceof HttpError ? error.code : "APP_SERVICE_UNAVAILABLE"; }
    await db.query("UPDATE reseller_authorizations SET result=$2,verifier=NULL,authorization_url=NULL WHERE session_hash=$1 AND state_hash=$3", [res.locals.sessionHash, result, digest(query.data.state)]);
    res.redirect(flow.return_to);
});

// Even an expired login must leave the callback URL without code/state in the address bar.
const callbackError: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.redirect("/studio?modelAuthorization=invalid");
};
resellerCallbackRouter.use(callbackError);
