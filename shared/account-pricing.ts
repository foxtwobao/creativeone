export type AccountBalance = { amount: string; unit: "USD" | "CNY" | "QUOTA" };
export type PriceMetric = { label: string; amount: string; unit: string };
export type PriceTier = { condition: string; metrics: PriceMetric[] };
export type ModelPrice = {
    model: string; capability: "image" | "text" | "video" | "audio"; description: string;
    paths: { member: string; multiplier?: string; tiers: PriceTier[]; note?: string }[];
    note?: string;
};
export type ModelPricing = { group: string; compositeRatio: string; queriedAt: string; currency: "USD"; models: ModelPrice[] };
