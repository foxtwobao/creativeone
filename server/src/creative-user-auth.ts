import type { RequestHandler } from "express";
import * as oidc from "openid-client";
import { getProvider, requireUser, csrf } from "./auth.js";
import { db } from "./db.js";
import { env } from "./config.js";
import { HttpError } from "./http.js";

// Only public creation routes accept a user Access Token; browser routes keep Cookie + CSRF.
export const requireCreativeUser: RequestHandler = async (req, res, next) => {
    const authorization = req.get("Authorization");
    if (authorization === undefined) return requireUser(req, res, error => error ? next(error) : csrf(req, res, next));
    const token = /^Bearer ([^\s]+)$/i.exec(authorization)?.[1];
    if (!token) throw new HttpError(401, "authentication_required");
    let config: oidc.Configuration;
    try { config = await getProvider(); }
    catch { throw new HttpError(503, "authentication_unavailable"); }
    let info: Awaited<ReturnType<typeof oidc.fetchUserInfo>>;
    try {
        // IDONE authenticates the exact access token (including expiry/revocation) in UserInfo.
        // There is no caller-supplied subject to compare; identity comes only from this response.
        info = await oidc.fetchUserInfo(config, token, oidc.skipSubjectCheck);
    } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        const status = error instanceof oidc.WWWAuthenticateChallengeError || error instanceof oidc.ResponseBodyError ? error.status : cause instanceof Response ? cause.status : undefined;
        // Native IDONE also returns HTTP 200 {status:"error",...} for invalid/expired tokens.
        const nativeRejection = cause && typeof cause === "object" && "cause" in cause && (cause.cause as { body?: { status?: string } })?.body?.status === "error";
        const rejected = nativeRejection || status === 400 || status === 401 || status === 403;
        throw new HttpError(rejected ? 401 : 503, rejected ? "authentication_required" : "authentication_unavailable");
    }
    if (info.iss !== env.IDONE_ISSUER) throw new HttpError(401, "authentication_required");
    const user = (await db.query("SELECT * FROM users WHERE issuer=$1 AND subject=$2", [env.IDONE_ISSUER, info.sub])).rows[0];
    if (!user) throw new HttpError(403, "authorization_required");
    if (req.get("X-Expected-User") && req.get("X-Expected-User") !== user.id) throw new HttpError(409, "account_changed");
    res.locals.user = user;
    next();
};
