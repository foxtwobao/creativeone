import { Alert } from "antd";
import { ArrowUpRight, Cloud, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { ModelPicker } from "@/components/model-picker";
import { cloudSession } from "@/services/api/cloud";
import { selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { features } from "@/constant/features";

export function CloudConfigPanel() {
    const config = useConfigStore((state) => state.config);
    const update = useConfigStore((state) => state.updateConfig);
    return <div className="flex flex-col gap-8">
        <div className="flex items-start gap-3 rounded-2xl border border-border/60 bg-muted/40 p-5">
            <Cloud size={20} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">已使用云端模型服务</h2>
                <p className="mt-1.5 text-sm leading-6 text-muted-foreground">无需填写 API Key，系统会使用你账号对应的密钥。默认模型和创作参数按账号同步。</p>
            </div>
        </div>
        {!cloudSession?.user.emailVerified ? <Alert type="warning" title="请先在 IDONE 完成邮箱验证，再重新登录以启用模型服务。" /> : null}
        <section aria-labelledby="cloud-default-models">
            <h2 id="cloud-default-models" className="text-base font-semibold text-foreground">默认模型</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">按创作类型选择，修改后自动保存。</p>
            <div className="mt-2 divide-y divide-border/60">
                {([["imageModel", "image", "图片生成 / 编辑", "生成新图片，或基于参考图修改"], ["textModel", "text", "聊天 / 文本生成", "文本对话与提示词创作"], ["videoModel", "video", "视频生成", "用于视频创作"], ["audioModel", "audio", "音频生成", "用于音频创作"]] as const)
                    .filter(([, capability]) => capability !== "video" || features.video)
                    .filter(([, capability]) => capability !== "audio" || selectableModelsByCapability(config, "audio").length > 0)
                    .map(([key, capability, label, description]) => <div key={key} className="grid items-center gap-3 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] sm:gap-8">
                        <div><h3 className="text-sm font-medium text-foreground">{label}</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>
                        <ModelPicker config={config} capability={capability} value={config[key]} onChange={(value) => update(key, value)} fullWidth className="h-11 rounded-xl border-border bg-background px-3 shadow-none" placeholder="管理员尚未配置该功能模型" />
                    </div>)}
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">各项功能的可用模型由管理员统一配置。</p>
        </section>
        {cloudSession?.user.admin ? <section className="flex flex-wrap items-center justify-between gap-4 border-t border-border/60 pt-6">
            <div className="flex items-start gap-3">
                <ShieldCheck size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div><h2 className="text-sm font-medium text-foreground">管理员设置</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">按功能维护可用模型、默认模型和启用状态，仅管理员可见。</p></div>
            </div>
            <Link to="/admin/channels" className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" onClick={() => useConfigStore.getState().setConfigDialogOpen(false)}>功能模型配置<ArrowUpRight size={15} aria-hidden="true" /></Link>
        </section> : null}
        <p className="text-xs leading-5 text-muted-foreground">分组授权、订阅和余额由 TokenONE 管理。</p>
    </div>;
}
