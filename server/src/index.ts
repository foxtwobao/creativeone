import express, { type ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { env } from "./config.js";
import { db, initializeDatabase } from "./db.js";
import { authRouter, requireUser, csrf } from "./auth.js";
import { channelRouter } from "./tokenone.js";
import { storageRouter } from "./storage.js";
import { aiRouter } from "./ai.js";
import { HttpError, noCache } from "./http.js";
import { modelErrorMessage } from "./model-errors.js";

await initializeDatabase();
// Never resubmit calls whose outcome became uncertain after an application restart.
await db.query("UPDATE generation_tasks SET status='unknown',error='SERVER_RESTARTED',updated_at=now() WHERE status='running'");
export const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => { res.locals.requestId = randomUUID(); res.setHeader("X-Request-Id", res.locals.requestId); next(); });
app.get("/healthz", async (_req, res) => { await db.query("SELECT 1"); res.json({ ok: true }); });
app.use("/api", noCache);
app.use("/api/auth", authRouter);
app.use("/api", requireUser, csrf);
app.use("/api", (req, res, next) => req.path.startsWith("/files/") ? next() : express.json({ limit: env.MAX_JSON_BYTES })(req, res, next));
app.use("/api", channelRouter, storageRouter, aiRouter);
app.use("/api", (_req, _res) => { throw new HttpError(404, "NOT_FOUND"); });
const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : error instanceof ZodError || error.type === "entity.parse.failed" ? 400 : error.type === "entity.too.large" || error.code === "LIMIT_FILE_SIZE" ? 413 : 500;
    const code = error instanceof HttpError ? error.code : status === 400 ? "INVALID_REQUEST" : status === 413 ? "FILE_TOO_LARGE" : "INTERNAL_ERROR";
    // Do not log request bodies, provider responses, cookies, tokens, or error objects.
    console.error(JSON.stringify({ requestId: res.locals.requestId, status, code }));
    if (!res.headersSent) res.status(status).json({ error: code, message: modelErrorMessage(code), requestId: res.locals.requestId });
    else res.end();
};
app.use(errors);
if (process.argv[1] === fileURLToPath(import.meta.url)) app.listen(env.PORT, "0.0.0.0", () => console.log(`CreativeOne API listening on ${env.PORT}`));
