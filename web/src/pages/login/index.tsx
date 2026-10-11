import { useEffect, useState } from "react";

export default function LoginPage({ error }: { error?: string }) {
    const [starting, setStarting] = useState(false);
    useEffect(() => {
        const reset = () => setStarting(false);
        window.addEventListener("pageshow", reset);
        return () => window.removeEventListener("pageshow", reset);
    }, []);
    const start = (register: boolean) => {
        if (starting) return;
        setStarting(true);
        const current = new URL(window.location.href);
        current.searchParams.delete("authError");
        const params = new URLSearchParams({ returnTo: current.pathname + current.search + current.hash, register: String(register) });
        window.location.assign(`/api/auth/login?${params}`);
    };
    return <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
        <section className="flex w-full max-w-sm flex-col gap-6 text-center">
            <img src="/logo.svg" alt="" className="mx-auto size-12" />
            <h1 className="text-2xl font-semibold">登录画布ONE</h1>
            <p className="text-sm text-muted-foreground">登录账号，在不同设备继续你的创作。</p>
            {error ? <p role="alert" className="text-sm text-red-500">{error}</p> : null}
            <button disabled={starting} onClick={() => start(false)} className="block w-full rounded-xl bg-foreground px-5 py-3 text-background! disabled:opacity-50">{starting ? "正在登录…" : "登录"}</button>
            <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
                <button disabled={starting} onClick={() => start(true)} className="text-sm! text-muted-foreground! disabled:opacity-50">注册账号</button>
                <button className="text-sm! text-muted-foreground!" onClick={() => {
                    const url = new URL(window.location.href);
                    url.searchParams.delete("authError");
                    window.location.assign(url.href);
                }}>重新连接服务</button>
            </div>
        </section>
    </main>;
}
