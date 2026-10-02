import { lazy, Suspense, type ReactNode } from "react";

import { useLocation } from "react-router-dom";
import { useInterfaceStore } from "@/stores/use-interface-store";
import StudioLayout from "@/layouts/studio-layout";
import { CloudAccountBar } from "@/components/layout/cloud-account-bar";
import { features } from "@/constant/features";
import { ClientRootInit } from "@/components/layout/client-root-init";

const AgentPanel = lazy(() => import("@/components/agent/agent-panel").then((module) => ({ default: module.AgentPanel })));
const AppTopNav = lazy(() => import("@/components/layout/app-top-nav").then((module) => ({ default: module.AppTopNav })));

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const studio = useInterfaceStore((state) => state.studio) || !features.originalUi || pathname === "/studio";
    return (
        <ClientRootInit><div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <CloudAccountBar />
                {studio ? <StudioLayout>{children}</StudioLayout> : <><Suspense fallback={null}><AppTopNav /></Suspense><div className="min-h-0 flex-1 overflow-hidden">{children}</div></>}
            </div>
            {features.assistant && <Suspense fallback={null}><AgentPanel /></Suspense>}
        </div></ClientRootInit>
    );
}
