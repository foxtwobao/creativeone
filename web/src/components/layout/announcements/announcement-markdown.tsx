import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "./announcements.module.css";

function safeUrl(value: string) {
    try { return ["http:", "https:", "mailto:"].includes(new URL(value).protocol) ? value : ""; }
    catch { return ""; }
}
export default function AnnouncementMarkdown({ body }: { body: string }) {
    return <div className={styles.markdown}><Markdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={["img"]} urlTransform={safeUrl}
        components={{ a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span> }}>{body}</Markdown></div>;
}
