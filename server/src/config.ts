import { z } from "zod";

const positive = z.coerce.number().int().positive();
const emptyAsUndefined = (value: unknown) => value === "" ? undefined : value;
export const env = z.object({
    DATABASE_URL: z.string().min(1),
    APP_ORIGIN: z.url(),
    APP_ORIGINS: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
    APP_DOMAIN_SUFFIXES: z.string().default(""),
    HOMEONE_LOGIN_ORIGIN: z.url(),
    IDONE_APP: z.string().regex(/^[A-Za-z0-9_-]{1,100}\/[A-Za-z0-9_-]{1,100}$/),
    IDONE_ISSUER: z.url(),
    IDONE_DISCOVERY_URL: z.preprocess(emptyAsUndefined, z.url().optional()),
    IDONE_ALLOW_HTTP: z.enum(["true", "false"]).default("false"),
    IDONE_CLIENT_ID: z.string().min(1),
    IDONE_CLIENT_SECRET: z.string().min(1),
    ADMIN_SUBJECTS: z.string().min(1),
    ENHANCER_BASE_URL: z.preprocess(emptyAsUndefined, z.url().optional()),
    ENHANCER_APP_CREDENTIAL: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
    TOKENONE_BASE_URL: z.preprocess(emptyAsUndefined, z.url().optional()),
    SESSION_SECONDS: positive.default(604800),
    LOGIN_SECONDS: positive.default(600),
    MAX_REFERENCE_IMAGE_BYTES: positive.default(10485760),
    MAX_MEDIA_BYTES: positive.default(104857600),
    MAX_JSON_BYTES: positive.default(20971520),
    MEDIA_DIR: z.string().min(1).default("./data/media"),
    PROMPT_GITHUB_PROXY_BASE: z.string().default("https://gh-proxy.com/").refine(value => {
        if (!value) return true;
        try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
    }, "PROMPT_GITHUB_PROXY_BASE must be an HTTPS URL without credentials, query or fragment"),
    MEDIA_DOWNLOAD_HOSTS: z.string().default(""),
    PORT: positive.default(4011),
}).parse(process.env);

for (const name of ["APP_ORIGIN", "IDONE_ISSUER", "ENHANCER_BASE_URL", "TOKENONE_BASE_URL"] as const) {
    if (!env[name]) continue;
    const url = new URL(env[name]);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`Invalid ${name}`);
}
if (new URL(env.APP_ORIGIN).origin !== env.APP_ORIGIN) throw new Error("APP_ORIGIN must be an origin without a trailing slash");
const loopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
const issuer = new URL(env.IDONE_ISSUER);
const appOrigin = new URL(env.APP_ORIGIN);
export const localOidc = issuer.protocol === "http:" && process.env.NODE_ENV !== "production" &&
    ((loopback(issuer) && loopback(appOrigin)) || (env.IDONE_ALLOW_HTTP === "true" && issuer.hostname === appOrigin.hostname));
if (issuer.protocol !== "https:" && !localOidc) throw new Error("IDONE HTTP requires explicitly enabled same-host development or loopback development");
if (env.IDONE_DISCOVERY_URL) {
    const discovery = new URL(env.IDONE_DISCOVERY_URL);
    if (discovery.origin !== issuer.origin || discovery.username || discovery.password || discovery.search || discovery.hash) throw new Error("IDONE discovery must use the configured issuer origin");
}
export const adminSubjects = new Set(env.ADMIN_SUBJECTS.split(",").map((value) => value.trim()).filter(Boolean));

// Match the original Host (including port); never derive origins from forwarded headers.
export const loginSites = new Map<string, { origin: string }>();
const origins = env.APP_ORIGINS ? z.array(z.string()).nonempty().parse(JSON.parse(env.APP_ORIGINS)) : [env.APP_ORIGIN];
const domainSuffixes = env.APP_DOMAIN_SUFFIXES.split(",").map(value => value.trim()).filter(Boolean);
for (const suffix of domainSuffixes) {
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(suffix) || new URL(`https://${suffix}`).hostname !== suffix) {
        throw new Error("APP_DOMAIN_SUFFIXES requires lowercase domain names without protocol, port or wildcard");
    }
}
for (const value of [...origins, env.HOMEONE_LOGIN_ORIGIN]) {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.hostname.includes("*") ||
        (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url) && process.env.NODE_ENV !== "production"))) {
        throw new Error("APP_ORIGINS and HOMEONE_LOGIN_ORIGIN require exact HTTPS origins (HTTP loopback in development only)");
    }
}
for (const origin of origins) {
    const host = new URL(origin).host;
    if (loginSites.has(host)) throw new Error("APP_ORIGINS has duplicate or ambiguous hosts");
    loginSites.set(host, { origin });
}
if (!origins.includes(env.APP_ORIGIN)) throw new Error("APP_ORIGINS must include APP_ORIGIN");

export function resolveLoginSite(host: string) {
    const configured = loginSites.get(host);
    if (configured) return configured;
    try {
        const url = new URL(`https://${host}`);
        if (url.host !== host || url.origin !== `https://${host}` || url.port ||
            !domainSuffixes.some(suffix => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`))) return;
        return { origin: url.origin };
    } catch { return; }
}
