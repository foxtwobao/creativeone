import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Bot, Images, Maximize2, Menu, PanelLeftClose, PenLine, Settings2, Sparkles, Video, X } from "lucide-react";
import { AppConfigModal } from "@/components/layout/app-config-modal";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { useInterfaceStore } from "@/stores/use-interface-store";
import { useAgentStore } from "@/stores/use-agent-store";
import "./studio.css";
import { features } from "@/constant/features";

const links = [
    { to: "/studio", label: "图片创作", icon: PenLine },
    { to: "/prompts", label: "灵感广场", icon: Sparkles },
    { to: "/canvas", label: "画布ONE", icon: Maximize2 },
    { to: "/video", label: "视频创作", icon: Video },
    { to: "/assets", label: "我的素材", icon: Images },
].filter(({ to }) => (to !== "/canvas" || features.canvas) && (to !== "/video" || features.video));

export default function StudioLayout({ children }: { children: ReactNode }) {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const [collapsed, setCollapsed] = useState(false);
    const [mobileOpen, setMobileOpen] = useState(false);
    const setStudio = useInterfaceStore((state) => state.setStudio);
    const togglePanel = useAgentStore((state) => state.togglePanel);

    useEffect(() => {
        setStudio(true);
    }, [setStudio]);
    useEffect(() => { setMobileOpen(false); }, [pathname]);

    const canvasEditor = /^\/canvas\/[^/]+/.test(pathname);
    return (
        <div className={`studio-shell ${collapsed ? "studio-collapsed" : ""}`}>
            {!canvasEditor ? <>
                <button className="studio-mobile-menu studio-icon" aria-label="打开导航" onClick={() => setMobileOpen(true)}><Menu size={19} /></button>
                {mobileOpen ? <button className="studio-backdrop" aria-label="关闭导航" onClick={() => setMobileOpen(false)} /> : null}
                <aside className={`studio-sidebar ${mobileOpen ? "is-open" : ""}`}>
                    <header className="studio-brand-row">
                        <Link to="/studio" className="studio-brand"><img src="/logo.svg" alt="" /><span>画布ONE</span></Link>
                        <button className="studio-icon studio-collapse" title="收起侧栏" aria-label="收起侧栏" onClick={() => setCollapsed(!collapsed)}><PanelLeftClose size={17} /></button>
                        <button className="studio-icon studio-mobile-close" aria-label="关闭导航" onClick={() => setMobileOpen(false)}><X size={18} /></button>
                    </header>
                    <nav className="studio-navigation" aria-label="主导航">
                        {links.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} title={label} className={({ isActive }) => `studio-nav-item ${isActive || (to === "/studio" && pathname === "/image") ? "is-active" : ""}`}><Icon size={18} /><span>{label}</span></NavLink>)}
                        {features.assistant && <button className="studio-nav-item" title="创作助手" onClick={togglePanel}><Bot size={18} /><span>创作助手</span></button>}
                    </nav>
                    <div className="studio-sidebar-note"><span>让灵感，自由生长。</span><p>从一个想法，到无限可能。</p></div>
                    <footer className="studio-sidebar-footer">
                        <NavLink to="/config" title="设置" className="studio-nav-item"><Settings2 size={18} /><span>设置</span></NavLink>
                        {features.originalUi && <button className="studio-nav-item" title="切换原版" onClick={() => { setStudio(false); navigate("/"); }}><ArrowLeft size={18} /><span>切换原版</span></button>}
                        <div className="studio-account"><UserStatusActions /></div>
                    </footer>
                </aside>
            </> : null}
            <div className="studio-content">{children}</div>
            <AppConfigModal />
        </div>
    );
}
