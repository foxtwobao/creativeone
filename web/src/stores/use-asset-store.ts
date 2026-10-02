import { create } from "zustand";
import { fetchAssets, createAsset, patchAsset, deleteAsset } from "@/services/api/assets";
import { imagePreviewUrl, previewUrlFor, cleanupUnusedImages } from "@/services/image-storage";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetInput = Omit<Asset, "id" | "createdAt" | "updatedAt">;
type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    load: () => Promise<void>;
    addAsset: (asset: AssetInput) => Promise<string>;
    updateAsset: (id: string, patch: Partial<AssetInput>) => Promise<void>;
    removeAsset: (id: string) => Promise<void>;
    cleanupImages: (extra?: unknown) => Promise<void>;
};

// 卡片用缩略图渲染，自定义封面（远程地址或单独上传的封面）保持原样。
export function assetCoverUrl(asset: Asset) {
    const own = asset.kind === "image" ? asset.data.dataUrl : "";
    const cover = asset.coverUrl || own;
    return asset.kind === "image" && cover === own ? previewUrlFor(asset.data.storageKey) || imagePreviewUrl(cover) : imagePreviewUrl(cover);
}

// Serialize this page's reads and writes so a late list response cannot undo a saved operation.
let pending: Promise<unknown> = Promise.resolve();
let loading: Promise<void> | undefined;
function run<T>(action: () => Promise<T>): Promise<T> {
    loading = undefined;
    const result = pending.then(action);
    pending = result.catch(() => undefined);
    return result;
}
export const useAssetStore = create<AssetStore>()((set) => ({
    hydrated: false,
    assets: [],
    load: () => {
        if (loading) return loading;
        const result = run(async () => { const { assets } = await fetchAssets(); set({ assets, hydrated: true }); });
        loading = result;
        const clear = () => { if (loading === result) loading = undefined; };
        void result.then(clear, clear);
        return result;
    },
    addAsset: (input) => run(async () => {
        const { asset } = await createAsset(input);
        set((state) => ({ assets: [asset, ...state.assets] }));
        return asset.id;
    }),
    updateAsset: (id, patch) => run(async () => {
        const { asset } = await patchAsset(id, patch);
        set((state) => ({ assets: state.assets.map((item) => item.id === id ? asset : item) }));
    }),
    removeAsset: (id) => run(async () => {
        await deleteAsset(id);
        set((state) => ({ assets: state.assets.filter((item) => item.id !== id) }));
    }),
    cleanupImages: () => cleanupUnusedImages(),
}));
