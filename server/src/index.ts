import express, { type ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { env } from "./config.js";
import { db, initializeDatabase } from "./db.js";
import { authRouter, requireUser, csrf } from "./auth.js";
import { resellerRouter, resellerCallbackRouter } from "./reseller-auth.js";
import { channelRouter } from "./tokenone.js";
import { publicMediaRouter, storageRouter } from "./storage.js";
import { promptsRouter, startPromptWorker } from "./prompts.js";
import { historyRouter } from "./task-history.js";
import { businessRouter } from "./business.js";
import { aiRouter } from "./ai.js";
import { HttpError, noCache } from "./http.js";
import { modelErrorMessage } from "./model-errors.js";
import { startGenerationWorker } from "./generation-executor.js";
import { startVideoWorker } from "./video-tasks.js";
import { adminTasksRouter } from "./admin-tasks.js";

await initializeDatabase();
// Task recovery is performed by the worker only after acquiring its session lock.
export const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => { res.locals.requestId = randomUUID(); res.setHeader("X-Request-Id", res.locals.requestId); next(); });
app.get("/healthz", async (_req, res) => { await db.query("SELECT 1"); res.json({ ok: true }); });
app.use("/api", noCache);
app.use("/api", publicMediaRouter);
app.use("/api/auth/reseller/callback", resellerCallbackRouter);
app.use("/api/auth", authRouter);
app.use("/api", requireUser, csrf);
app.use("/api", (req, res, next) => req.method === "PUT" && req.path.startsWith("/files/") ? next() : express.json({ limit: env.MAX_JSON_BYTES })(req, res, next));
app.use("/api", resellerRouter, channelRouter, adminTasksRouter, promptsRouter, historyRouter, businessRouter, storageRouter, aiRouter);
app.use("/api", (_req, _res) => { throw new HttpError(404, "NOT_FOUND"); });
const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error instanceof HttpError ? error.status : error instanceof ZodError || error.type === "entity.parse.failed" ? 400 : error.type === "entity.too.large" || error.code === "LIMIT_FILE_SIZE" ? 413 : 500;
    const code = error instanceof HttpError ? error.code : status === 400 ? "INVALID_REQUEST" : status === 413 ? "FILE_TOO_LARGE" : "INTERNAL_ERROR";
    // Do not log request bodies, provider responses, cookies, tokens, or error objects.
    console.error(JSON.stringify({ requestId: res.locals.requestId, status, code }));
    if (!res.headersSent) res.status(status).json({ error: code, message: modelErrorMessage(code), retryable: error instanceof HttpError && error.retryable, requestId: res.locals.requestId });
    else res.end();
};
app.use(errors);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    app.listen(env.PORT, "0.0.0.0", () => console.log(`CreativeOne API listening on ${env.PORT}`));
    startGenerationWorker();
    startVideoWorker();
    startPromptWorker();
}
