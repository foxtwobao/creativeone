export type AccountBalance = { amount: string; unit: "USD" | "CNY" | "QUOTA" };
export type PriceMetric = { metric: string; usageKey?: string; label: string; amount: string; unit: string; unitLabel: string };
export type PriceTier = { condition: string; metrics: PriceMetric[] };
export type PriceQuote = { source: "base" | "plugin"; pluginKey?: string; pluginName?: string; tiers: PriceTier[]; note?: string };
export type ModelPrice = {
    model: string; capability: "image" | "text" | "video" | "audio"; description: string;
    paths: { member: string; multiplier?: string; quotes: PriceQuote[]; note?: string }[];
    note?: string;
};
export type ModelPricing = { group: string; compositeRatio: string; queriedAt: string; currency: "USD"; models: ModelPrice[] };
