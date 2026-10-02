import { cloudApi } from "./cloud";
import type { Asset } from "@/stores/use-asset-store";

type AssetInput = Omit<Asset, "id" | "createdAt" | "updatedAt">;
export const fetchAssets = () => cloudApi<{ assets: Asset[] }>("/assets");
export const createAsset = (asset: AssetInput) => cloudApi<{ asset: Asset }>("/assets", { method: "POST", body: JSON.stringify(asset) });
export const patchAsset = (id: string, patch: Partial<AssetInput>) => cloudApi<{ asset: Asset }>(`/assets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
export const deleteAsset = (id: string) => cloudApi<void>(`/assets/${encodeURIComponent(id)}`, { method: "DELETE" });
