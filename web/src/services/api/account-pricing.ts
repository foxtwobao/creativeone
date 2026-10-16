import { cloudApi } from "./cloud";
import type { AccountBalance, ModelPricing } from "../../../../shared/account-pricing";

export const fetchAccountBalance = (signal: AbortSignal) => cloudApi<AccountBalance>("/account/balance", { signal });
export const fetchModelPricing = (signal: AbortSignal) => cloudApi<ModelPricing>("/model-pricing", { signal });
