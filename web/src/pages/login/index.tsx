export default function LoginPage({ error }: { error?: string }) {
    return <main className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-sm space-y-6 text-center">
            <img src="/logo.svg" alt="" className="mx-auto size-12" />
            <h1 className="text-2xl font-semibold">登录画布ONE</h1>
            <p className="text-sm text-muted-foreground">使用 IDONE 账号登录，在不同设备继续你的创作。</p>
            {error ? <p role="alert" className="text-sm text-red-500">{error}</p> : null}
            <a href="/api/auth/login" className="block rounded-xl bg-foreground px-5 py-3 text-background">使用 IDONE 登录</a>
            <button className="text-sm text-muted-foreground" onClick={() => window.location.reload()}>重新连接服务</button>
        </section>
    </main>;
}
