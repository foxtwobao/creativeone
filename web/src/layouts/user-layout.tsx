import { Suspense, type ReactNode } from "react";
import { lazyWithReload } from "@/lib/lazy-with-reload";

import { Navigate, useLocation } from "react-router-dom";
import { useInterfaceStore } from "@/stores/use-interface-store";
import StudioLayout from "@/layouts/studio-layout";
import { CloudAccountBar } from "@/components/layout/cloud-account-bar";
import { features } from "@/constant/features";
import { cloudSession } from "@/services/api/cloud";
import { ClientRootInit } from "@/components/layout/client-root-init";

const AgentPanel = lazyWithReload(() => import("@/components/agent/agent-panel").then((module) => ({ default: module.AgentPanel })));
const AppTopNav = lazyWithReload(() => import("@/components/layout/app-top-nav").then((module) => ({ default: module.AppTopNav })));

export default function UserLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const admin = pathname === "/admin" || pathname.startsWith("/admin/");
    const studioMode = useInterfaceStore((state) => state.studio);
    const studio = admin || studioMode || !features.originalUi || pathname === "/studio";
    if (admin && !cloudSession?.user.admin) return <Navigate to="/studio" replace />;
    return (
        <ClientRootInit><div className="flex h-dvh overflow-hidden bg-background text-foreground">
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <CloudAccountBar />
                {studio ? <StudioLayout>{children}</StudioLayout> : <><Suspense fallback={null}><AppTopNav /></Suspense><div className="min-h-0 flex-1 overflow-hidden">{children}</div></>}
            </div>
            {!admin && features.assistant && <Suspense fallback={null}><AgentPanel /></Suspense>}
        </div></ClientRootInit>
    );
}
