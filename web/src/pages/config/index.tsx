import { CloudConfigPanel } from "@/components/layout/cloud-config-panel";

export default function ConfigPage() {
    return <main className="h-full overflow-y-auto bg-background">
        <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-12">
            <div className="mb-8">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">创作偏好</h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">选择顺手的模型，让每次创作从这里开始。</p>
            </div>
            <CloudConfigPanel />
        </div>
    </main>;
}
