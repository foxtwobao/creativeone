import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { fetchPrompts, type Prompt } from "@/services/api/prompts";

export function StudioInspiration({ onSelect, onUpload }: { onSelect: (prompt: string) => void; onUpload: () => void }) {
    const [items, setItems] = useState<Prompt[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [revision, setRevision] = useState(0);
    const strip = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let active = true;
        setLoading(true);
        setError(false);
        void fetchPrompts({ pageSize: 12 }).then((data) => { if (active) setItems(data.items); }).catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [revision]);
    return <section className="studio-inspiration">
        <header><h2>浏览灵感</h2><div><button className="studio-icon" aria-label="上一组灵感" onClick={() => strip.current?.scrollBy({ left: -320, behavior: "smooth" })}><ChevronLeft size={17} /></button><button className="studio-icon" aria-label="下一组灵感" onClick={() => strip.current?.scrollBy({ left: 320, behavior: "smooth" })}><ChevronRight size={17} /></button><Link to="/prompts" className="studio-chip">灵感广场 <ChevronRight size={13} /></Link></div></header>
        <div className="studio-inspiration-strip" ref={strip}>
            <button className="studio-upload-card" onClick={onUpload}><Plus size={30} strokeWidth={1} /><span>上传参考图</span></button>
            {loading ? Array.from({ length: 5 }, (_, index) => <div key={index} className="studio-card-skeleton" aria-label="正在加载灵感" />) : items.map((item) => <button key={`${item.sourceId}-${item.id}`} className="studio-inspiration-card" onClick={() => onSelect(item.prompt)} title={item.title}><img src={item.coverUrl} alt={item.title} loading="lazy" /><span>{item.title}</span></button>)}
            {!loading && (error || !items.length) ? <div className="studio-inspiration-empty"><p>{error ? "灵感暂时未能加载" : "还没有灵感内容"}</p><button className="studio-chip" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} />重新加载</button><Link to="/prompts">管理提示词来源</Link></div> : null}
        </div>
    </section>;
}
