import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AnnouncementMarkdown from "./announcement-markdown";

test("announcement Markdown supports tables and literal code without loading active content", () => {
    const html = renderToStaticMarkup(<AnnouncementMarkdown body={'| 功能 | 状态 |\n| --- | --- |\n| 图片 | 可用 |\n\n```js\nalert("text only")\n```\n\n<script>alert(1)</script>\n\n<img src="https://bad.test/pixel">\n\n![tracking](https://bad.test/pixel)\n\n[bad](javascript:alert) [data](data:text/html,evil) [relative](/private) [safe](https://example.test) [mail](mailto:test@example.test)'} />);
    expect(html).toContain("<table>");
    expect(html).toContain("<pre>");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="mailto:test@example.test"');
    expect(html).not.toMatch(/<script|<img|javascript:|data:text|href="\/private"/);
});
