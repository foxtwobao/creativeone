import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { features } from "@/constant/features";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import VideoPage from "@/pages/video";
import { lazy, Suspense } from "react";
import { CLOUD_ENABLED } from "@/services/api/cloud";
const ChannelsPage = lazy(() => import("@/pages/admin/channels"));
const TasksPage = lazy(() => import("@/pages/tasks"));

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: features.originalUi ? <HomePage /> : <Navigate to="/studio" replace /> },
            { path: "/image", element: <ImagePage /> },
            { path: "/studio", element: <ImagePage /> },
            { path: "/video", element: features.video ? <VideoPage /> : <Navigate to="/studio" replace /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/canvas", element: features.canvas ? <CanvasPage /> : <Navigate to="/studio" replace /> },
            { path: "/canvas/:id", element: features.canvas ? <CanvasProjectPage /> : <Navigate to="/studio" replace /> },
            { path: "/config", element: <ConfigPage /> },
            ...(CLOUD_ENABLED ? [
                { path: "/admin/channels", element: <Suspense fallback={<div className="p-6">加载中…</div>}><ChannelsPage /></Suspense> },
                { path: "/tasks", element: <Suspense fallback={<div className="p-6">加载中…</div>}><TasksPage /></Suspense> },
            ] : []),
        ],
    },
    { path: "*", element: <NotFound /> },
]);
