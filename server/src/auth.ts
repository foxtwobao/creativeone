import { Router, type RequestHandler } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parse, serialize } from "cookie";
import * as oidc from "openid-client";
import { db } from "./db.js";
import { env, adminSubjects, localOidc } from "./config.js";
import { HttpError } from "./http.js";

export type User = { id: string; issuer: string; subject: string; email: string; email_verified: boolean; username: string; display_name: string; avatar_url: string };
declare global { namespace Express { interface Locals { user: User; csrf: string; sessionHash: string; requestId: string; } } }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secure = new URL(env.APP_ORIGIN).protocol === "https:";
const cookieName = secure ? "__Host-creativeone" : "creativeone";
const flowCookie = secure ? "__Host-creativeone-login" : "creativeone-login";
const cookie = (name: string, value: string, maxAge: number) => serialize(name, value, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge });
let provider: Promise<oidc.Configuration> | undefined;
function getProvider() {
    return provider ??= oidc.discovery(new URL(env.IDONE_DISCOVERY_URL || env.IDONE_ISSUER), env.IDONE_CLIENT_ID, env.IDONE_CLIENT_SECRET, oidc.ClientSecretPost(env.IDONE_CLIENT_SECRET), { execute: localOidc ? [oidc.allowInsecureRequests] : [] })
        .then((config) => {
            const metadata = config.serverMetadata();
            // Explicit discovery URLs bypass the SDK's initial issuer comparison.
            if (metadata.issuer !== env.IDONE_ISSUER) throw new HttpError(502, "OIDC_ISSUER_MISMATCH");
            for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.userinfo_endpoint, metadata.jwks_uri]) {
                if (!endpoint) throw new HttpError(502, "OIDC_ENDPOINT_MISSING");
                const url = new URL(endpoint);
                if (url.username || url.password || (url.protocol !== "https:" && !(localOidc && url.origin === new URL(env.IDONE_ISSUER).origin))) throw new HttpError(502, "OIDC_ENDPOINT_UNSAFE");
            }
            oidc.enableNonRepudiationChecks(config);
            return config;
        })
        .catch((error) => { provider = undefined; throw error; });
}
export const requireUser: RequestHandler = async (req, res, next) => {
    const sid = parse(req.headers.cookie || "")[cookieName];
    if (!sid) throw new HttpError(401, "LOGIN_REQUIRED");
    const { rows } = await db.query("SELECT u.*, s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=$1 AND s.expires_at>now()", [hash(sid)]);
    if (!rows[0]) throw new HttpError(401, "SESSION_EXPIRED");
    res.locals.user = rows[0];
    res.locals.csrf = rows[0].csrf;
    res.locals.sessionHash = hash(sid);
    if (req.get("X-Expected-User") && req.get("X-Expected-User") !== rows[0].id) throw new HttpError(409, "ACCOUNT_CHANGED");
    next();
};
export const csrf: RequestHandler = (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const token = req.get("X-CSRF-Token") || req.get("Authorization")?.replace(/^Bearer /, "");
    if (req.get("Origin") !== env.APP_ORIGIN || token !== res.locals.csrf) throw new HttpError(403, "CSRF_FAILED");
    next();
};
export const requireAdmin: RequestHandler = (_req, res, next) => {
    if (!adminSubjects.has(res.locals.user.subject)) throw new HttpError(403, "ADMIN_REQUIRED");
    next();
};
export const authRouter = Router();
authRouter.get("/login", async (_req, res) => {
    const config = await getProvider();
    const sid = randomBytes(32).toString("base64url");
    const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
    await db.query("DELETE FROM login_flows WHERE expires_at <= now()");
    await db.query("INSERT INTO login_flows VALUES ($1,$2,$3,$4,now()+$5*interval '1 second')", [hash(sid), state, nonce, verifier, env.LOGIN_SECONDS]);
    res.setHeader("Set-Cookie", cookie(flowCookie, sid, env.LOGIN_SECONDS));
    res.redirect(oidc.buildAuthorizationUrl(config, { redirect_uri: `${env.APP_ORIGIN}/api/auth/callback`, scope: "openid profile email", state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256" }).href);
});
authRouter.get("/callback", async (req, res) => {
    const sid = parse(req.headers.cookie || "")[flowCookie];
    if (!sid) throw new HttpError(400, "LOGIN_FLOW_MISSING");
    const { rows } = await db.query("DELETE FROM login_flows WHERE id_hash=$1 AND expires_at>now() RETURNING *", [hash(sid)]);
    const flow = rows[0];
    if (!flow) throw new HttpError(400, "LOGIN_FLOW_EXPIRED");
    const config = await getProvider();
    const tokens = await oidc.authorizationCodeGrant(config, new URL(req.originalUrl, env.APP_ORIGIN), { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
    const claims = tokens.claims();
    if (!claims || claims.iss !== env.IDONE_ISSUER) throw new HttpError(403, "INVALID_IDENTITY");
    const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
    if (typeof info.email !== "string" || !info.email) throw new HttpError(403, "EMAIL_REQUIRED");
    const user = await db.query(`INSERT INTO users (id,issuer,subject,email,email_verified,username,display_name,avatar_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (issuer,subject) DO UPDATE SET email=EXCLUDED.email,email_verified=EXCLUDED.email_verified,username=EXCLUDED.username,display_name=EXCLUDED.display_name,avatar_url=EXCLUDED.avatar_url RETURNING id`,
        [randomUUID(), claims.iss, claims.sub, info.email, info.email_verified === true, info.preferred_username || claims.sub, info.name || info.preferred_username || info.email, typeof info.picture === "string" && info.picture.startsWith("https://") ? info.picture : ""]);
    const sessionId = randomBytes(32).toString("base64url");
    const oldSid = parse(req.headers.cookie || "")[cookieName];
    if (oldSid) await db.query("DELETE FROM sessions WHERE id_hash=$1", [hash(oldSid)]);
    await db.query("DELETE FROM sessions WHERE expires_at <= now()");
    await db.query("INSERT INTO sessions VALUES ($1,$2,$3,now()+$4*interval '1 second')", [hash(sessionId), user.rows[0].id, randomBytes(32).toString("base64url"), env.SESSION_SECONDS]);
    res.setHeader("Set-Cookie", [cookie(cookieName, sessionId, env.SESSION_SECONDS), cookie(flowCookie, "", 0)]);
    res.redirect("/studio");
});
authRouter.get("/me", requireUser, (_req, res) => {
    const user = res.locals.user;
    res.json({ user: { id: user.id, username: user.username, displayName: user.display_name, avatarUrl: user.avatar_url, email: user.email, emailVerified: user.email_verified, admin: adminSubjects.has(user.subject) }, csrf: res.locals.csrf });
});
authRouter.post("/logout", requireUser, csrf, async (_req, res) => {
    await db.query("DELETE FROM sessions WHERE id_hash=$1", [res.locals.sessionHash]);
    res.setHeader("Set-Cookie", cookie(cookieName, "", 0));
    res.json({ ok: true });
});
