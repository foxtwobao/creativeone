import type { ReactNode } from "react";

import { AgentPanel } from "@/components/agent/agent-panel";
import { AppTopNav } from "@/components/layout/app-top-nav";
import { useLocation } from "react-router-dom";
import { useInterfaceStore } from "@/stores/use-interface-store";
import StudioLayout from "@/layouts/studio-layout";
import { CLOUD_ENABLED } from "@/services/api/cloud";
import { CloudAccountBar } from "@/components/layout/cloud-account-bar";
import { features } from "@/constant/features";

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const studio = useInterfaceStore((state) => state.studio) || !features.originalUi || pathname === "/studio";
    return (
        <div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {CLOUD_ENABLED ? <CloudAccountBar /> : null}
                {studio ? <StudioLayout>{children}</StudioLayout> : <><AppTopNav /><div className="min-h-0 flex-1 overflow-hidden">{children}</div></>}
            </div>
            {features.assistant && <AgentPanel />}
        </div>
    );
}
