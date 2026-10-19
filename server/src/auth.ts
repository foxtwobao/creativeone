import { Router, type Request, type ErrorRequestHandler, type RequestHandler } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parse, serialize } from "cookie";
import * as oidc from "openid-client";
import { db } from "./db.js";
import { env, adminSubjects, localOidc, resolveLoginSite } from "./config.js";
import { HttpError } from "./http.js";

export type User = { id: string; issuer: string; subject: string; email: string; email_verified: boolean; username: string; display_name: string; avatar_url: string };
declare global { namespace Express { interface Locals { user: User; csrf: string; sessionHash: string; requestId: string; loginReturnTo?: string; } } }
const loginSeconds = 300, navigationSeconds = 600;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function site(req: Request) {
    const configured = resolveLoginSite(req.get("Host") || "");
    if (!configured) throw new HttpError(400, "UNKNOWN_SITE");
    return configured;
}
function cookies(req: Request) {
    const secure = site(req).origin.startsWith("https:");
    const name = (suffix = "") => `${secure ? "__Host-" : ""}creativeone${suffix}`;
    return {
        session: name(), flow: name("-login"), navigation: name("-return"),
        set: (key: string, value: string, maxAge: number) => serialize(key, value, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge }),
    };
}
function query(req: Request) {
    const params = new URL(req.originalUrl, site(req).origin).searchParams;
    if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) throw new HttpError(400, "INVALID_LOGIN_REQUEST");
    return params;
}
function returnPath(value: string, origin: string) {
    if (!value.startsWith("/") || value.startsWith("//") || /[\\\s]/.test(value)) throw new HttpError(400, "INVALID_RETURN_PATH");
    const url = new URL(value, origin);
    if (url.origin !== origin || !/^\/(?:$|studio$|image$|video$|assets$|prompts$|canvas(?:\/[^/]+)?$|config$|admin\/(?:channels|tasks)$|tasks$)/.test(url.pathname)) {
        throw new HttpError(400, "INVALID_RETURN_PATH");
    }
    url.searchParams.delete("authError");
    return url.pathname + url.search + url.hash;
}
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
async function session(req: Request) {
    const sid = parse(req.headers.cookie || "")[cookies(req).session];
    if (!sid) return;
    const { rows } = await db.query("SELECT u.*, s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=$1 AND s.expires_at>now() AND s.origin=$2", [hash(sid), site(req).origin]);
    return rows[0] && { user: rows[0], hash: hash(sid) };
}
export const requireUser: RequestHandler = async (req, res, next) => {
    const current = await session(req);
    if (!current) throw new HttpError(401, parse(req.headers.cookie || "")[cookies(req).session] ? "SESSION_EXPIRED" : "LOGIN_REQUIRED");
    res.locals.user = current.user;
    res.locals.csrf = current.user.csrf;
    res.locals.sessionHash = current.hash;
    if (req.get("X-Expected-User") && req.get("X-Expected-User") !== current.user.id) throw new HttpError(409, "ACCOUNT_CHANGED");
    next();
};
export const csrf: RequestHandler = (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const token = req.get("X-CSRF-Token") || req.get("Authorization")?.replace(/^Bearer /, "");
    if (req.get("Origin") !== site(req).origin || token !== res.locals.csrf) throw new HttpError(403, "CSRF_FAILED");
    next();
};
export const requireAdmin: RequestHandler = (_req, res, next) => {
    if (!adminSubjects.has(res.locals.user.subject)) throw new HttpError(403, "ADMIN_REQUIRED");
    next();
};
export const authRouter = Router();
authRouter.use((req, res, next) => {
    site(req);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
});
authRouter.get("/login", async (req, res) => {
    const { origin } = site(req), jar = cookies(req);
    const params = query(req);
    if ([...params.keys()].some((key) => !["returnTo", "register"].includes(key)) ||
        (params.has("register") && !["true", "false"].includes(params.get("register")!))) throw new HttpError(400, "INVALID_LOGIN_REQUEST");
    const returnTo = returnPath(params.get("returnTo") ?? "/studio", origin);
    res.locals.loginReturnTo = returnTo;
    if (await session(req)) { res.redirect(returnTo); return; }
    const sid = randomBytes(32).toString("base64url");
    const previous = parse(req.headers.cookie || "")[jar.navigation];
    await db.query("DELETE FROM login_returns WHERE expires_at<=now() OR (id_hash=$1 AND origin=$2)", [hash(previous || ""), origin]);
    await db.query("INSERT INTO login_returns (id_hash,origin,return_to,expires_at) VALUES ($1,$2,$3,now()+$4*interval '1 second')", [hash(sid), origin, returnTo, navigationSeconds]);
    const target = new URL("/auth/enter", env.ENHANCER_BASE_URL);
    target.searchParams.set("appId", env.RESELLER_APP_ID);
    target.searchParams.set("sourceOrigin", origin);
    if (params.get("register") === "true") target.searchParams.set("register", "true");
    const oldFlow = parse(req.headers.cookie || "")[jar.flow];
    if (oldFlow) await db.query("DELETE FROM login_flows WHERE id_hash=$1 AND origin=$2", [hash(oldFlow), origin]);
    res.setHeader("Set-Cookie", [jar.set(jar.navigation, sid, navigationSeconds), jar.set(jar.flow, "", 0)]);
    res.redirect(target.href);
});
authRouter.get("/oidc/start", async (req, res) => {
    const { origin } = site(req), jar = cookies(req);
    if (query(req).size) throw new HttpError(400, "INVALID_LOGIN_REQUEST");
    const previous = parse(req.headers.cookie || "");
    const { rows } = await db.query("DELETE FROM login_returns WHERE id_hash=$1 AND origin=$2 RETURNING return_to, expires_at>now() AS valid", [hash(previous[jar.navigation] || ""), origin]);
    const returnTo = rows[0]?.valid ? returnPath(rows[0].return_to, origin) : "/studio";
    res.locals.loginReturnTo = returnTo;
    res.append("Set-Cookie", jar.set(jar.navigation, "", 0));
    await db.query("DELETE FROM login_flows WHERE expires_at<=now() OR (id_hash=$1 AND origin=$2)", [hash(previous[jar.flow] || ""), origin]);
    const config = await getProvider();
    const flowId = randomBytes(32).toString("base64url");
    const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const redirectUri = `${origin}/api/auth/callback`;
    const target = oidc.buildAuthorizationUrl(config, { redirect_uri: redirectUri, scope: "openid profile email", state, nonce, code_challenge: challenge, code_challenge_method: "S256" });
    await db.query("INSERT INTO login_flows (id_hash,state,nonce,verifier,expires_at,origin,return_to,client_id,redirect_uri,issuer) VALUES ($1,$2,$3,$4,now()+$5*interval '1 second',$6,$7,$8,$9,$10)", [hash(flowId), state, nonce, verifier, loginSeconds, origin, returnTo, env.IDONE_CLIENT_ID, redirectUri, env.IDONE_ISSUER]);
    res.append("Set-Cookie", jar.set(jar.flow, flowId, loginSeconds));
    res.redirect(target.href);
});
authRouter.get("/callback", async (req, res) => {
    const { origin } = site(req), jar = cookies(req);
    const params = query(req);
    const state = params.get("state"), code = params.get("code"), error = params.get("error");
    const allowed = ["state", "code", "error", "error_description", "error_uri", "iss", "session_state"];
    if (!state || (code === null) === (error === null) ||
        ["state", "code", "error"].some((key) => params.has(key) && !params.get(key)) ||
        [...params.keys()].some((key) => !allowed.includes(key)) ||
        (params.has("iss") && params.get("iss") !== env.IDONE_ISSUER)) throw new HttpError(400, "INVALID_LOGIN_REQUEST");
    const sid = parse(req.headers.cookie || "")[jar.flow];
    if (!sid) throw new HttpError(400, "LOGIN_FLOW_MISSING");
    const { rows } = await db.query("DELETE FROM login_flows WHERE id_hash=$1 AND origin=$2 AND state=$3 RETURNING *, expires_at>now() AS valid", [hash(sid), origin, params.get("state")]);
    const flow = rows[0];
    if (!flow?.valid) throw new HttpError(400, "LOGIN_FLOW_EXPIRED");
    if (flow.client_id !== env.IDONE_CLIENT_ID || flow.issuer !== env.IDONE_ISSUER || flow.redirect_uri !== `${origin}/api/auth/callback`) throw new HttpError(400, "INVALID_LOGIN_REQUEST");
    const callback = new URL(req.originalUrl, origin);
    if (`${callback.origin}${callback.pathname}` !== flow.redirect_uri) throw new HttpError(400, "INVALID_LOGIN_REQUEST");
    res.locals.loginReturnTo = flow.return_to;
    res.append("Set-Cookie", jar.set(jar.flow, "", 0));
    const config = await getProvider();
    const tokens = await oidc.authorizationCodeGrant(config, callback, { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true });
    const claims = tokens.claims();
    if (!claims || claims.iss !== env.IDONE_ISSUER) throw new HttpError(403, "INVALID_IDENTITY");
    const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
    if (typeof info.email !== "string" || !info.email) throw new HttpError(403, "EMAIL_REQUIRED");
    const user = await db.query(`INSERT INTO users (id,issuer,subject,email,email_verified,username,display_name,avatar_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (issuer,subject) DO UPDATE SET email=EXCLUDED.email,email_verified=EXCLUDED.email_verified,username=EXCLUDED.username,display_name=EXCLUDED.display_name,avatar_url=EXCLUDED.avatar_url RETURNING id`,
        [randomUUID(), claims.iss, claims.sub, info.email, info.email_verified === true, info.preferred_username || claims.sub, info.name || info.preferred_username || info.email, typeof info.picture === "string" && info.picture.startsWith("https://") ? info.picture : ""]);
    const sessionId = randomBytes(32).toString("base64url");
    const oldSid = parse(req.headers.cookie || "")[jar.session];
    if (oldSid) await db.query("DELETE FROM sessions WHERE id_hash=$1 AND origin=$2", [hash(oldSid), origin]);
    await db.query("DELETE FROM sessions WHERE expires_at <= now()");
    await db.query("INSERT INTO sessions (id_hash,user_id,csrf,expires_at,origin) VALUES ($1,$2,$3,now()+$4*interval '1 second',$5)", [hash(sessionId), user.rows[0].id, randomBytes(32).toString("base64url"), env.SESSION_SECONDS, origin]);
    res.append("Set-Cookie", jar.set(jar.session, sessionId, env.SESSION_SECONDS));
    res.redirect(flow.return_to);
});
authRouter.get("/me", requireUser, (_req, res) => {
    const user = res.locals.user;
    res.json({ user: { id: user.id, username: user.username, displayName: user.display_name, avatarUrl: user.avatar_url, email: user.email, emailVerified: user.email_verified, admin: adminSubjects.has(user.subject) }, csrf: res.locals.csrf, maxReferenceImageBytes: env.MAX_REFERENCE_IMAGE_BYTES, modelServiceUrl: env.TOKENONE_BASE_URL?.replace(/\/+$/, "").replace(/\/v1$/, ""), navigation: env.ONE_NAVIGATION_CONFIG });
});
authRouter.post("/logout", requireUser, csrf, async (req, res) => {
    await db.query("DELETE FROM sessions WHERE id_hash=$1", [res.locals.sessionHash]);
    const jar = cookies(req);
    const previous = parse(req.headers.cookie || ""), { origin } = site(req);
    await db.query("DELETE FROM login_flows WHERE id_hash=$1 AND origin=$2", [hash(previous[jar.flow] || ""), origin]);
    await db.query("DELETE FROM login_returns WHERE id_hash=$1 AND origin=$2", [hash(previous[jar.navigation] || ""), origin]);
    res.setHeader("Set-Cookie", [jar.set(jar.session, "", 0), jar.set(jar.flow, "", 0), jar.set(jar.navigation, "", 0)]);
    res.json({ ok: true });
});

const loginError: ErrorRequestHandler = async (error, req, res, next) => {
    if (!["/login", "/oidc/start", "/callback"].includes(req.path) || !resolveLoginSite(req.get("Host") || "")) return next(error);
    const jar = cookies(req), { origin } = site(req);
    if (req.path !== "/login") {
        const sid = parse(req.headers.cookie || "")[jar.flow];
        await db.query("DELETE FROM login_flows WHERE id_hash=$1 AND origin=$2", [hash(sid || ""), origin]);
        res.append("Set-Cookie", jar.set(jar.flow, "", 0));
    }
    if (!res.locals.loginReturnTo) {
        res.status(error instanceof HttpError ? error.status : 500).type("html").send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>登录未完成</title><body><p>登录未完成或已过期，请重新登录。</p><a href="/studio?authError=login">返回登录页</a></body></html>');
        return;
    }
    const target = new URL(res.locals.loginReturnTo, origin);
    target.searchParams.set("authError", "login");
    res.redirect(target.pathname + target.search + target.hash);
};
authRouter.use(loginError);
