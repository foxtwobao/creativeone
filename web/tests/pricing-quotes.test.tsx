import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fixture from "../../shared/fixtures/app-pricing-response.json";
import type { ModelPrice } from "../../shared/account-pricing";
import { ModelPriceQuotes } from "@/pages/pricing/model-price-quotes";

function pathsFor(name: string): ModelPrice["paths"] {
    return fixture.models.find(model => model.model === name)!.paths.map(path => ({
        member: path.member, multiplier: path.multiplier, note: path.reason,
        quotes: path.quotes.map(quote => ({ source: quote.source as "base" | "plugin", pluginKey: quote.plugin_key, pluginName: quote.plugin_name,
            note: quote.reason, tiers: quote.tiers.map(tier => ({ condition: tier.condition, metrics: tier.prices.map(price => ({
                metric: price.metric, usageKey: price.usage_key, label: price.label, amount: price.amount, unit: price.unit, unitLabel: price.unit_label,
            })) })),
        })),
    }));
}
const render = (paths: ModelPrice["paths"]) => renderToStaticMarkup(createElement(ModelPriceQuotes, { paths }));

test("WAN fixture renders every plugin, resolution tier and independent path", () => {
    for (const name of ["wan3.0-video", "wan3.0-video-prime"]) {
        const paths = pathsFor(name), html = render(paths);
        for (const plugin of ["Alibaba Bailian", "RollDek", "Zhimeng"]) expect(html.split(plugin)).toHaveLength(paths.length + 1);
        expect(html.match(/<dl /g)).toHaveLength(paths.length * 9);
        for (const path of paths) for (const quote of path.quotes) for (const tier of quote.tiers) expect(html).toContain(tier.metrics[0]!.amount);
        if (paths.length > 1) expect(html).toContain("报价 2");
        expect(html).not.toContain("fixture-member");
    }
});

test("mixed plugin failures keep valid prices and missing identity has a placeholder", () => {
    const paths = pathsFor("fixture-mixed-plugins");
    paths[0]!.quotes.push({ source: "plugin", note: "模型价格配置无效", tiers: [] });
    const html = render(paths);
    for (const text of ["Fast", "Slow", "0.025", "0.05", "unsupported_rule", "未知插件", "模型价格配置无效"]) expect(html).toContain(text);
});

test("multi-usage fixture preserves separate seconds and per-task image prices", () => {
    const html = render(pathsFor("fixture-multi-usage"));
    for (const text of ["生成视频时长", "参考视频时长", "0.125", "0.025", "张图片"]) expect(html).toContain(text);
    expect(html.match(/<dt /g)).toHaveLength(3);
});

test("identical labels stay separate and different count unit labels are never collapsed", () => {
    const paths: ModelPrice["paths"] = [{ member: "hidden", quotes: [{ source: "base", tiers: [{ condition: "", metrics: [
        { metric: "usage", usageKey: "one", label: "用量", amount: "0.000000000000000001", unit: "count", unitLabel: "个计费单位" },
        { metric: "usage", usageKey: "two", label: "用量", amount: "0", unit: "count", unitLabel: "张图片" },
    ] }] }] }];
    const html = render(paths);
    expect(html.match(/<dt /g)).toHaveLength(2);
    for (const text of ["0.000000000000000001", "个计费单位", "张图片"]) expect(html).toContain(text);
});

test("plugin names, conditions and usage labels are escaped as text", () => {
    const paths = pathsFor("fixture-multi-usage"), quote = paths[0]!.quotes[0]!;
    quote.source = "plugin"; quote.pluginKey = "test"; quote.pluginName = "<img src=x onerror=alert(1)>";
    quote.tiers[0]!.condition = "<script>alert(1)</script>";
    quote.tiers[0]!.metrics[0]!.label = "<b>用量</b>";
    const html = render(paths);
    expect(html).not.toContain("<img"); expect(html).not.toContain("<script>"); expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img"); expect(html).toContain("&lt;script&gt;"); expect(html).toContain("&lt;b&gt;");
});
