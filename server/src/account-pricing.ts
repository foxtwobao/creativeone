import { Router } from "express";
import { z } from "zod";
import { db } from "./db.js";
import { enhancer } from "./tokenone.js";
import { HttpError } from "./http.js";
import type { ModelPrice, ModelPricing } from "../../shared/account-pricing.js";

const balanceSchema = z.object({ data: z.object({ balance: z.object({ amount: z.string().regex(/^-?\d+\.\d{2}$/), unit: z.enum(["USD", "CNY", "QUOTA"]) }) }) });
const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const metrics = {
    input: "输入", output: "输出", cache_read: "缓存读取", cache_write: "缓存写入", image_input: "图片输入",
    image_cache_read: "图片缓存读取", request: "每次成功请求", duration: "生成时长", usage_tokens: "计费用量",
} as const;
const units = { million_tokens: "百万 token", request: "次请求", second: "秒" } as const;
const reasons = {
    missing_pricing: "此模型价格暂不可用", unsupported_rule: "当前计费规则暂不支持展示，请前往 TokenONE 查看",
    unconfirmed_zero_price: "上游返回零单价，待管理员确认", invalid_pricing: "模型价格配置无效，请联系管理员",
} as const;
const reasonSchema = z.enum(Object.keys(reasons) as [keyof typeof reasons, ...(keyof typeof reasons)[]]);
const priceSchema = z.object({
    metric: z.enum(Object.keys(metrics) as [keyof typeof metrics, ...(keyof typeof metrics)[]]), amount: decimal,
    unit: z.enum(["million_tokens", "request", "second"]),
}).refine(({ metric, unit }) => unit === (metric === "request" ? "request" : metric === "duration" ? "second" : "million_tokens"));
const pricingSchema = z.object({
    app_id: z.string().min(1), group: z.object({ id: z.string().min(1), name: z.string().min(1), multiplier: decimal }),
    currency: z.literal("USD"), queried_at: z.iso.datetime({ offset: true }),
    models: z.array(z.object({ model: z.string().min(1), reason: reasonSchema.optional(), paths: z.array(z.discriminatedUnion("status", [
        z.object({ member: z.string().min(1), multiplier: decimal, status: z.literal("available"),
            tiers: z.array(z.object({ condition: z.string(), prices: z.array(priceSchema).min(1) })).min(1) }),
        z.object({ member: z.string().min(1), multiplier: decimal.optional(), status: z.literal("unavailable"), tiers: z.tuple([]), reason: reasonSchema }),
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
                        note: path.status === "unavailable" ? reasons[path.reason] : undefined,
                        tiers: path.status === "available" ? path.tiers.map((tier) => ({ condition: tier.condition,
                            metrics: tier.prices.map((price) => ({ label: metrics[price.metric], amount: price.amount, unit: units[price.unit] })),
                        })) : [],
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
