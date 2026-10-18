export type AccountBalance = { amount: string; unit: "USD" | "CNY" | "QUOTA" };
export type PriceMetric = { metric: string; usageKey?: string; label: string; minAmount: string; maxAmount: string; unit: string; unitLabel: string };
export type PriceTier = { condition: string; metrics: PriceMetric[] };
export type ModelPrice = {
    model: string; capability: "image" | "text" | "video" | "audio"; description: string;
    status: "available" | "partial" | "unavailable"; tiers: PriceTier[]; note?: string;
};
export type ModelPricing = { queriedAt: string; currency: "USD"; models: ModelPrice[] };
