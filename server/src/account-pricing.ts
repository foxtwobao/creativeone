import { Router } from "express";
import { z } from "zod";
import { Decimal } from "decimal.js";
import { db } from "./db.js";
import { enhancer } from "./tokenone.js";
import { HttpError } from "./http.js";
import type { ModelPrice, ModelPricing } from "../../shared/account-pricing.js";

const balanceSchema = z.object({ data: z.object({ balance: z.object({ amount: z.string().regex(/^-?\d+\.\d{2}$/), unit: z.enum(["USD", "CNY", "QUOTA"]) }) }) });
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const reasons = {
    incomplete_pricing: "价格信息不完整",
    missing_pricing: "此模型价格暂不可用", unsupported_rule: "当前暂不能完整展示该计费规则",
    schema_condition_mismatch: "上游计费条件与用量定义不一致，请联系管理员",
    unconfirmed_zero_price: "上游返回零单价，待管理员确认", invalid_pricing: "模型价格配置无效，请联系管理员",
} as const;
const reasonSchema = z.enum(Object.keys(reasons) as [keyof typeof reasons, ...(keyof typeof reasons)[]]);
const priceSchema = z.object({
    metric: z.enum(["input", "output", "cache_read", "cache_write", "cache_write_1h", "image_input", "image_cache_read", "image_output", "audio_input", "audio_output", "image", "request", "usage"]),
    usage_key: z.string().refine(value => value.trim().length > 0).optional(), label: z.string().min(1), min_amount: decimal, max_amount: decimal,
    unit: z.enum(["million_tokens", "request", "second", "image", "count"]), unit_label: z.string().min(1),
}).refine(({ metric, usage_key, unit }) => metric === "usage" ? usage_key !== undefined
    : usage_key === undefined && unit === (metric === "request" || metric === "image" ? metric : "million_tokens"))
.refine(({ min_amount, max_amount }) => new Decimal(min_amount).lte(max_amount));
const tiersSchema = z.array(z.object({ condition: z.string(), prices: z.array(priceSchema).min(1) })).min(1);
const pricingSchema = z.object({
    app_id: z.string().min(1), currency: z.literal("USD"), queried_at: z.iso.datetime({ offset: true }),
    models: z.array(z.discriminatedUnion("status", [
        z.object({ model: z.string().min(1), status: z.literal("available"), tiers: tiersSchema, reason: z.undefined().optional() }),
        z.object({ model: z.string().min(1), status: z.literal("partial"), tiers: tiersSchema, reason: z.literal("incomplete_pricing") }),
        z.object({ model: z.string().min(1), status: z.literal("unavailable"), tiers: z.tuple([]), reason: reasonSchema.exclude(["incomplete_pricing"]) }),
    ])),
});

export const accountPricingRouter = Router();
accountPricingRouter.get("/account/balance", async (_req, res) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once("close", cancel);
    try {
        const user = res.locals.user;
        const result = balanceSchema.safeParse(await enhancer("/balance/query", res.locals.requestId, { identity: { issuer: user.issuer, subject: user.subject } }, AbortSignal.any([controller.signal, AbortSignal.timeout(7_000)])));
        if (!result.success) throw new HttpError(502, "ENHANCER_INVALID_RESPONSE");
        res.json(result.data.data.balance);
    } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, "ACCOUNT_BALANCE_UNAVAILABLE");
    } finally { res.off("close", cancel); }
});
accountPricingRouter.get("/model-pricing", async (_req, res) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.once("close", cancel);
    // Retain the existing caller deadline; Reseller owns its upstream request limits.
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]);
    try {
        const [upstream, channels] = await Promise.all([
            enhancer("/pricing", res.locals.requestId, undefined, signal),
            db.query<{ capability: ModelPrice["capability"]; models: string[]; model_descriptions: Record<string, string> }>("SELECT capability,models,model_descriptions FROM channels WHERE enabled ORDER BY capability"),
        ]);
        const pricing = pricingSchema.safeParse(upstream);
        if (!pricing.success) throw new HttpError(503, "MODEL_PRICING_UNAVAILABLE");
        const byModel = new Map(pricing.data.models.map((item) => [item.model, item]));
        const result: ModelPricing = { queriedAt: pricing.data.queried_at, currency: pricing.data.currency,
            models: channels.rows.flatMap((channel) => channel.models.map((model): ModelPrice => {
                const entry = byModel.get(model);
                return { model, capability: channel.capability, description: channel.model_descriptions[model] || "",
                    status: entry?.status || "unavailable",
                    note: entry?.reason ? reasons[entry.reason] : !entry ? reasons.missing_pricing : undefined,
                    tiers: entry?.tiers.map((tier) => ({ condition: tier.condition,
                        metrics: tier.prices.map((price) => ({ metric: price.metric, usageKey: price.usage_key, label: price.label,
                            minAmount: price.min_amount, maxAmount: new Decimal(price.min_amount).eq(price.max_amount) ? price.min_amount : price.max_amount,
                            unit: price.unit, unitLabel: price.unit_label })),
                    })) || [],
                };
            })),
        };
        res.setHeader("Cache-Control", "no-store");
        res.json(result);
    } catch (error) {
        controller.abort();
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, "MODEL_PRICING_UNAVAILABLE");
    } finally { res.off("close", cancel); }
});
