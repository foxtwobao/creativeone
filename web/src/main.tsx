import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { appLocaleReady } from "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { initializeCloud, CloudError } from "@/services/api/cloud";
import LoginPage from "@/pages/login";

initAnalytics();

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

const root = createRoot(document.getElementById("root")!);
async function start() {
    if (new URLSearchParams(window.location.search).has("authError")) {
        root.render(<LoginPage error="登录未完成或已过期，请重试；若在多个标签页登录，请使用最后发起的页面。" />);
        return;
    }
    try {
        await Promise.all([initializeCloud(), appLocaleReady]);
        const [{ AppProviders }, { router }] = await Promise.all([import("@/components/layout/app-providers"), import("@/router")]);
        root.render(
            <React.StrictMode>
                <AppProviders>
                    <RouterProvider router={router} />
                </AppProviders>
            </React.StrictMode>,
        );
    } catch (error) {
        root.render(<LoginPage error={error instanceof CloudError && error.status === 401 ? undefined : error instanceof Error ? error.message : "无法连接云端服务"} />);
    }
}
void start();
