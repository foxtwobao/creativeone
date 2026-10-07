import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { features } from "@/constant/features";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
const AssetsPage = lazy(() => import("@/pages/assets"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const ConfigPage = lazy(() => import("@/pages/config"));
const HomePage = lazy(() => import("@/pages/home"));
const ImagePage = lazy(() => import("@/pages/image"));
const NotFound = lazy(() => import("@/pages/not-found"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const VideoPage = lazy(() => import("@/pages/video"));
const ChannelsPage = lazy(() => import("@/pages/admin/channels"));
const AdminTasksPage = lazy(() => import("@/pages/admin/tasks"));

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Suspense fallback={<div className="p-6">加载中…</div>}><Outlet /></Suspense>
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
            { path: "/admin/channels", element: <ChannelsPage /> },
            { path: "/admin/tasks", element: <AdminTasksPage /> },
            { path: "/tasks", element: <Navigate to="/assets?view=tasks" replace /> },
        ],
    },
    { path: "*", element: <Suspense fallback={<div className="p-6">加载中…</div>}><NotFound /></Suspense> },
]);
