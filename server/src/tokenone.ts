import { Router, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { env } from "./config.js";
import { requireAdmin, type User } from "./auth.js";
import { HttpError, requireUuid } from "./http.js";

export const channelSchema = z.object({
    id: z.uuid(), name: z.string().trim().min(1), capability: z.enum(["image", "text", "video", "audio"]),
    group_id: z.number().int().positive(), models: z.array(z.string().trim().min(1)).min(1),
    enabled: z.boolean(), is_default: z.boolean(),
}).strict();
export type Channel = z.infer<typeof channelSchema>;
const keySchema = z.object({ status: z.literal("ready"), tokenone_user_id: z.string(), api_key: z.object({ id: z.string(), key: z.string().min(1), group_id: z.number(), status: z.literal("active") }) });
export async function enhancer(path: string, requestId: string, body?: unknown) {
    if (!env.ENHANCER_BASE_URL || !env.ENHANCER_INTERNAL_SECRET) throw new HttpError(503, "ENHANCER_NOT_CONFIGURED");
    const response = await fetch(`${env.ENHANCER_BASE_URL.replace(/\/$/, "")}${path}`, {
        method: body ? "POST" : "GET", redirect: "error",
        headers: { Authorization: `Bearer ${env.ENHANCER_INTERNAL_SECRET}`, "Content-Type": "application/json", "X-Request-Id": requestId },
        body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
        const code = typeof result?.error === "string" && /^(TOKENONE_[A-Z_]+|PROVISIONING_[A-Z_]+|INVALID_ISSUER|INVALID_KEY_REQUEST|UNAUTHORIZED)$/.test(result.error) ? result.error : "ENHANCER_FAILED";
        throw new HttpError(response.status === 401 ? 502 : response.status, code);
    }
    return result;
}
export async function ensureKey(user: User, groupId: number, requestId: string) {
    if (!env.TOKENONE_BASE_URL) throw new HttpError(503, "TOKENONE_NOT_CONFIGURED");
    if (!user.email_verified) throw new HttpError(403, "EMAIL_NOT_VERIFIED");
    const result = keySchema.parse(await enhancer("/internal/tokenone/api-key/ensure", requestId, {
        identity: { issuer: user.issuer, subject: user.subject, email: user.email, username: user.username, email_verified: user.email_verified },
        group_id: groupId, key_name: env.TOKENONE_KEY_NAME,
    }));
    if (result.api_key.group_id !== groupId) throw new HttpError(502, "KEY_GROUP_MISMATCH");
    await db.query(`INSERT INTO key_bindings VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,group_id) DO UPDATE SET tokenone_user_id=EXCLUDED.tokenone_user_id,key_id=EXCLUDED.key_id`, [user.id, groupId, result.tokenone_user_id, result.api_key.id]);
    return result.api_key.key;
}
export function upstreamUrl(path: string) {
    if (!env.TOKENONE_BASE_URL) throw new HttpError(503, "TOKENONE_NOT_CONFIGURED");
    const base = env.TOKENONE_BASE_URL.replace(/\/+$/, "").replace(/\/v1$/, "");
    return `${base}/v1/${path}`;
}
export const channelRouter = Router();
channelRouter.get("/channels", async (_req, res) => {
    const { rows } = await db.query("SELECT id,name,capability,models,is_default FROM channels WHERE enabled ORDER BY is_default DESC,name,id");
    res.json({ channels: rows });
});
channelRouter.get("/admin/groups", requireAdmin, async (_req, res) => res.json(await enhancer("/internal/tokenone/groups", res.locals.requestId)));
channelRouter.get("/admin/channels", requireAdmin, async (_req, res) => res.json({ channels: (await db.query("SELECT * FROM channels ORDER BY capability,name,id")).rows }));
const saveChannel: RequestHandler = async (req, res) => {
    const channel = channelSchema.parse({ ...req.body, id: req.method === "POST" ? randomUUID() : requireUuid(req.params.id) });
    const groups = z.object({ groups: z.array(z.object({ id: z.number(), status: z.string() })) }).parse(await enhancer("/internal/tokenone/groups", res.locals.requestId));
    const group = groups.groups.find((item) => item.id === channel.group_id);
    if (!group || (channel.enabled && group.status !== "active")) throw new HttpError(409, "TOKENONE_GROUP_UNAVAILABLE");
    await transaction(async (client) => {
        await client.query("LOCK TABLE channels IN SHARE ROW EXCLUSIVE MODE");
        if (channel.is_default && channel.enabled) await client.query("UPDATE channels SET is_default=false WHERE capability=$1", [channel.capability]);
        await client.query(`INSERT INTO channels VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,capability=EXCLUDED.capability,group_id=EXCLUDED.group_id,models=EXCLUDED.models,enabled=EXCLUDED.enabled,is_default=EXCLUDED.is_default`,
            [channel.id, channel.name, channel.capability, channel.group_id, JSON.stringify([...new Set(channel.models)]), channel.enabled, channel.is_default]);
    });
    res.json({ channel });
};
channelRouter.post("/admin/channels", requireAdmin, saveChannel);
channelRouter.put("/admin/channels/:id", requireAdmin, saveChannel);
