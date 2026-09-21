import { useTranslation } from "react-i18next";

import { AppConfigPanel } from "@/components/layout/app-config-modal";
import { CloudConfigPanel } from "@/components/layout/cloud-config-panel";
import { CLOUD_ENABLED } from "@/services/api/cloud";

export default function ConfigPage() {
    const { t } = useTranslation();

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className={CLOUD_ENABLED ? "mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-12" : "mx-auto max-w-6xl px-6 py-6"}>
                <div className="mb-8">
                    <h1 className="text-2xl font-semibold tracking-tight text-foreground">{CLOUD_ENABLED ? "创作偏好" : t("config.title")}</h1>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{CLOUD_ENABLED ? "选择顺手的模型，让每次创作从这里开始。" : t("config.description")}</p>
                </div>
                {CLOUD_ENABLED ? <CloudConfigPanel /> : <AppConfigPanel />}
            </div>
        </main>
    );
}
