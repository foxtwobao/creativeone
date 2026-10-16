import { afterAll, beforeEach, expect, test } from "bun:test";
import { initializeCloud } from "@/services/api/cloud";
import { useCloudStore } from "./use-cloud-store";

const originalFetch = globalThis.fetch;
let userId = "first";
let respond: () => Response | Promise<Response>;
beforeEach(async () => {
    userId = "first";
    useCloudStore.getState().clearBalance();
    useCloudStore.setState({ errors: {}, errorCodes: {} });
    globalThis.fetch = (async (input) => {
        const path = String(input);
        if (path.endsWith("/auth/me")) return Response.json({ user: { id: userId }, csrf: "test" });
        if (path.endsWith("/channels")) return Response.json({ channels: [] });
        if (path.endsWith("/model-authorization")) return Response.json(null);
        return respond();
    }) as typeof fetch;
    await initializeCloud();
});
afterAll(() => { useCloudStore.getState().clearBalance(); globalThis.fetch = originalFetch; });

test("balance keeps the exact amount string and failures stay independent of saving", async () => {
    respond = () => Response.json({ amount: "-12.34", unit: "QUOTA" });
    await useCloudStore.getState().loadBalance();
    expect(useCloudStore.getState().balance).toEqual({ amount: "-12.34", unit: "QUOTA" });
    respond = () => Response.json({ error: "SCOPE_FORBIDDEN", message: "应用未获得该接口权限" }, { status: 403 });
    await useCloudStore.getState().loadBalance();
    expect(useCloudStore.getState().balance).toBeNull();
    expect(useCloudStore.getState().balanceError).toBe("应用未获得该接口权限");
    expect(useCloudStore.getState().errors).toEqual({});
    expect(useCloudStore.getState().modelLoginRequired).toBe(false);
});
test("switching accounts discards an old response even if fetch ignores cancellation", async () => {
    let complete!: (value: Response) => void;
    respond = () => new Promise((resolve) => { complete = resolve; });
    const old = useCloudStore.getState().loadBalance();
    userId = "second";
    await initializeCloud();
    expect(useCloudStore.getState().balance).toBeNull();
    respond = () => Response.json({ amount: "5.00", unit: "USD" });
    await useCloudStore.getState().loadBalance();
    complete(Response.json({ amount: "999.00", unit: "USD" }));
    await old;
    expect(useCloudStore.getState().balanceOwner).toBe("second");
    expect(useCloudStore.getState().balance?.amount).toBe("5.00");
});
test("session errors immediately hide balance and block an in-flight result", async () => {
    let complete!: (value: Response) => void;
    respond = () => new Promise((resolve) => { complete = resolve; });
    const pending = useCloudStore.getState().loadBalance();
    useCloudStore.getState().setError("session", "账号已变化");
    useCloudStore.getState().setError("session");
    complete(Response.json({ amount: "999.00", unit: "USD" }));
    await pending;
    expect(useCloudStore.getState().balance).toBeNull();
    expect(useCloudStore.getState().balanceLoading).toBe(false);
});
