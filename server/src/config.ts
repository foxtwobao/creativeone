import { z } from "zod";

const positive = z.coerce.number().int().positive();
const emptyAsUndefined = (value: unknown) => value === "" ? undefined : value;
export const env = z.object({
    DATABASE_URL: z.string().min(1),
    APP_ORIGIN: z.url(),
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
    MAX_MEDIA_BYTES: positive.default(104857600),
    MAX_JSON_BYTES: positive.default(20971520),
    MEDIA_DIR: z.string().min(1).default("./data/media"),
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
