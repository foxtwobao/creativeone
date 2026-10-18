import { Router } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { enhancer } from "./tokenone.js";
import { HttpError } from "./http.js";
import type { ModelPrice, ModelPricing } from "../../shared/account-pricing.js";

const balanceSchema = z.object({ data: z.object({ balance: z.object({ amount: z.string().regex(/^-?\d+\.\d{2}$/), unit: z.enum(["USD", "CNY", "QUOTA"]) }) }) });
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const reasons = {
    missing_pricing: "此模型价格暂不可用", unsupported_rule: "当前暂不能完整展示该计费规则",
    schema_condition_mismatch: "上游计费条件与用量定义不一致，请联系管理员",
    unconfirmed_zero_price: "上游返回零单价，待管理员确认", invalid_pricing: "模型价格配置无效，请联系管理员",
} as const;
const reasonSchema = z.enum(Object.keys(reasons) as [keyof typeof reasons, ...(keyof typeof reasons)[]]);
const priceSchema = z.object({
    metric: z.enum(["input", "output", "cache_read", "cache_write", "cache_write_1h", "image_input", "image_cache_read", "image_output", "audio_input", "audio_output", "image", "request", "usage"]),
    usage_key: z.string().refine(value => value.trim().length > 0).optional(), label: z.string().min(1), amount: decimal,
    unit: z.enum(["million_tokens", "request", "second", "image", "count"]), unit_label: z.string().min(1),
}).refine(({ metric, usage_key, unit }) => metric === "usage" ? usage_key !== undefined
    : usage_key === undefined && unit === (metric === "request" || metric === "image" ? metric : "million_tokens"));
const quoteSource = { source: z.enum(["base", "plugin"]), plugin_key: z.string().min(1).optional(), plugin_name: z.string().min(1).optional() };
const quoteSchema = z.discriminatedUnion("status", [
    z.object({ ...quoteSource, status: z.literal("available"), reason: z.undefined().optional(),
        tiers: z.array(z.object({ condition: z.string(), prices: z.array(priceSchema).min(1) })).min(1) }),
    z.object({ ...quoteSource, status: z.literal("unavailable"), tiers: z.tuple([]), reason: reasonSchema }),
]).refine((quote) => quote.source === "base" ? quote.plugin_key === undefined && quote.plugin_name === undefined
    : quote.status === "unavailable" || Boolean(quote.plugin_key && quote.plugin_name));
const pricingSchema = z.object({
    app_id: z.string().min(1), group: z.object({ id: z.string().min(1), name: z.string().min(1), multiplier: decimal }),
    currency: z.literal("USD"), queried_at: z.iso.datetime({ offset: true }),
    models: z.array(z.object({ model: z.string().min(1), reason: reasonSchema.optional(), paths: z.array(z.union([
        z.object({ member: z.string().min(1), multiplier: decimal, reason: z.undefined().optional(), quotes: z.array(quoteSchema).min(1) }),
        z.object({ member: z.string(), multiplier: decimal.optional(), reason: reasonSchema, quotes: z.tuple([]) }),
    ])) })),
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
        const result: ModelPricing = { group: pricing.data.group.name, compositeRatio: pricing.data.group.multiplier, queriedAt: pricing.data.queried_at, currency: pricing.data.currency,
            models: channels.rows.flatMap((channel) => channel.models.map((model): ModelPrice => {
                const entry = byModel.get(model);
                return { model, capability: channel.capability, description: channel.model_descriptions[model] || "",
                    note: !entry?.paths.length ? "此模型价格暂不可用" : undefined,
                    paths: entry?.paths.map((path) => ({ member: path.member, multiplier: path.multiplier,
                        note: path.reason ? reasons[path.reason] : undefined,
                        quotes: path.quotes.map((quote) => ({ source: quote.source, pluginKey: quote.plugin_key, pluginName: quote.plugin_name,
                            note: quote.status === "unavailable" ? reasons[quote.reason] : undefined,
                            tiers: quote.status === "available" ? quote.tiers.map((tier) => ({ condition: tier.condition,
                                metrics: tier.prices.map((price) => ({ metric: price.metric, usageKey: price.usage_key, label: price.label,
                                    amount: price.amount, unit: price.unit, unitLabel: price.unit_label })),
                            })) : [],
                        })),
                    })) || [],
                };
            })),
        };
        res.json(result);
    } catch (error) {
        controller.abort();
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, "MODEL_PRICING_UNAVAILABLE");
    } finally { res.off("close", cancel); }
});
