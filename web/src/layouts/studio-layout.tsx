import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, AudioLines, Bot, Images, Maximize2, Menu, ListChecks, SlidersHorizontal, PanelLeftClose, PenLine, Settings2, Sparkles, Video, X } from "lucide-react";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { useInterfaceStore } from "@/stores/use-interface-store";
import { useAgentStore } from "@/stores/use-agent-store";
import "./studio.css";
import { features } from "@/constant/features";
import { useOneNavigation } from "@/hooks/use-one-navigation";
import { useServerAgentActions } from "@/hooks/use-server-agent-actions";

const links = [
    { to: "/canvas", label: "全能画布", icon: Maximize2 },
    { to: "/studio", label: "图片创作", icon: PenLine },
    { to: "/video", label: "视频创作", icon: Video },
    { to: "/audio", label: "音频创作", icon: AudioLines },
    { to: "/assets", label: "我的作品", icon: Images },
    { to: "/prompts", label: "灵感广场", icon: Sparkles },
].filter(({ to }) => (to !== "/canvas" || features.canvas) && (to !== "/video" || features.video));

const adminLinks = [
    { to: "/admin/channels", label: "功能模型配置", icon: Settings2 },
    { to: "/admin/image-presets", label: "图片参数预设", icon: Images },
    { to: "/admin/video-presets", label: "视频参数预设", icon: SlidersHorizontal },
    { to: "/admin/agent", label: "全能助手配置", icon: Bot },
    { to: "/admin/tasks", label: "用户任务", icon: ListChecks },
];

export default function StudioLayout({ children }: { children: ReactNode }) {
    useServerAgentActions();
    const { refresh } = useOneNavigation();
    const { pathname } = useLocation();
    const admin = pathname === "/admin" || pathname.startsWith("/admin/");
    const navigate = useNavigate();
    const [collapsed, setCollapsed] = useState(false);
    const [mobileOpen, setMobileOpen] = useState(false);
    const setStudio = useInterfaceStore((state) => state.setStudio);
    const togglePanel = useAgentStore((state) => state.togglePanel);

    useEffect(() => {
        if (!admin) setStudio(true);
    }, [admin, setStudio]);
    useEffect(() => { setMobileOpen(false); }, [pathname]);

    const canvasEditor = /^\/canvas\/[^/]+/.test(pathname);
    return (
        <div className={`studio-shell ${collapsed ? "studio-collapsed" : ""}`}>
            {!canvasEditor ? <>
                <button className="studio-mobile-menu studio-icon" aria-label="打开导航" onClick={() => { refresh(); setMobileOpen(true); }}><Menu size={19} /></button>
                {mobileOpen ? <button className="studio-backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)} /> : null}
                <aside className={`studio-sidebar ${mobileOpen ? "is-open" : ""}`}>
                    <header className="studio-brand-row">
                        <Link to={admin ? "/admin/channels" : "/studio"} className="studio-brand"><img src="/logo.svg" alt="" /><span>{admin ? "管理后台" : "画布ONE"}</span></Link>
                        <button className="studio-icon studio-collapse" title="收起侧栏" aria-label="收起侧栏" onClick={() => setCollapsed(!collapsed)}><PanelLeftClose size={17} /></button>
                        <button className="studio-icon studio-mobile-close" aria-label="关闭导航" onClick={() => setMobileOpen(false)}><X size={18} /></button>
                    </header>
                    <nav className="studio-navigation" aria-label={admin ? "管理员导航" : "主导航"}>
                        {!admin ? <Link to="/" className="studio-nav-item"><span>首页</span></Link> : null}
                        {(admin ? adminLinks : links).map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} title={label} className={({ isActive }) => `studio-nav-item ${isActive || (to === "/studio" && pathname === "/image") ? "is-active" : ""}`}><Icon size={18} /><span>{label}</span></NavLink>)}
                        {!admin && features.assistant && <button className="studio-nav-item" title="全能助手" onClick={togglePanel}><Bot size={18} /><span>全能助手</span></button>}
                    </nav>
                    {!admin ? <div className="studio-sidebar-note"><span>让灵感，自由生长。</span><p>从一个想法，到无限可能。</p></div> : null}
                    <footer className="studio-sidebar-footer">
                        {admin ? <Link to="/studio" title="返回用户界面" className="studio-nav-item"><ArrowLeft size={18} /><span>返回用户界面</span></Link> : <NavLink to="/config" title="设置" className="studio-nav-item"><Settings2 size={18} /><span>设置</span></NavLink>}
                        {!admin && features.originalUi && <button className="studio-nav-item" title="切换原版" onClick={() => { setStudio(false); navigate("/"); }}><ArrowLeft size={18} /><span>切换原版</span></button>}
                        {!admin ? <div className="studio-account"><UserStatusActions /></div> : null}
                    </footer>
                </aside>
            </> : null}
            <div className="studio-content">{children}</div>
            {!admin ? <AppConfigModal /> : null}
        </div>
    );
}
