import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fixture from "../../shared/fixtures/app-pricing-response.json";
import type { ModelPrice } from "../../shared/account-pricing";
import { ModelPriceTable } from "@/pages/pricing/model-price-table";

function modelFor(name: string): ModelPrice {
    const model = fixture.models.find(model => model.model === name)!;
    return { model: name, capability: "video", description: "", status: model.status as ModelPrice["status"],
        tiers: model.tiers.map(tier => ({ condition: tier.condition, metrics: tier.prices.map(price => ({
            metric: price.metric, usageKey: 'usage_key' in price ? price.usage_key : undefined, label: price.label,
            minAmount: price.min_amount, maxAmount: price.max_amount, unit: price.unit, unitLabel: price.unit_label,
        })) })),
    };
}
const render = (model: ModelPrice) => renderToStaticMarkup(createElement(ModelPriceTable, { model, currency: "USD" }));

test("WAN renders each condition once, with ranges or a single exact price in USD", () => {
    for (const name of ["wan3.0-video", "wan3.0-video-prime"]) {
        const model = modelFor(name), html = render(model);
        expect(html.match(/<dl /g)).toHaveLength(3);
        expect(html.match(/<dt /g)).toHaveLength(3);
        for (const forbidden of ["报价 1", "价格方案", "渠道", "RollDek", "Zhimeng", "CNY"]) expect(html).not.toContain(forbidden);
        expect(html).toContain("USD / 秒");
        for (const tier of model.tiers) {
            const price = tier.metrics[0]!;
            expect(html).toContain(price.minAmount === price.maxAmount ? price.minAmount : `${price.minAmount}–${price.maxAmount}`);
        }
    }
    expect(render(modelFor("wan3.0-video-prime"))).not.toContain("0.025–0.025");
});

test("partial prices are explicitly incomplete and unavailable models do not render a price table", () => {
    const html = render(modelFor("fixture-mixed-plugins"));
    expect(html).toContain("价格信息不完整");
    expect(html).toContain("0.025–0.05");
    const model = modelFor("fixture-enum-conflict");
    model.note = "上游计费条件与用量定义不一致，请联系管理员";
    const unavailable = render(model);
    expect(unavailable).toContain("价格暂不可用");
    expect(unavailable).toContain(model.note);
    expect(unavailable).not.toContain("<dl");
});

test("multi-usage rows remain separate, including equal-priced input and additional images", () => {
    const model = modelFor("fixture-multi-usage");
    model.tiers[0]!.metrics.push(
        { metric: "usage", usageKey: "input_images", label: "输入图片", minAmount: "0.01", maxAmount: "0.01", unit: "count", unitLabel: "张图片" },
        { metric: "usage", usageKey: "extra_image_count", label: "额外参考图片", minAmount: "0.01", maxAmount: "0.01", unit: "count", unitLabel: "张图片" },
    );
    const html = render(model);
    for (const text of ["生成视频时长", "参考视频时长", "输入图片", "额外参考图片", "0.125", "0.025", "张图片"]) expect(html).toContain(text);
    expect(html.match(/<dt /g)).toHaveLength(5);
    expect(html.split('>0.01<')).toHaveLength(3);
});

test("same labels with distinct usage and units retain tiny prices and explicit zero", () => {
    const model = modelFor("fixture-multi-usage");
    model.tiers[0]!.metrics = [
        { metric: "usage", usageKey: "one", label: "用量", minAmount: "0.000000000000000001", maxAmount: "0.000000000000000002", unit: "count", unitLabel: "个计费单位" },
        { metric: "usage", usageKey: "one", label: "用量", minAmount: "0", maxAmount: "0", unit: "image", unitLabel: "张图片" },
    ];
    const html = render(model);
    expect(html.match(/<dt /g)).toHaveLength(2);
    for (const text of ["0.000000000000000001–0.000000000000000002", "个计费单位", "张图片"]) expect(html).toContain(text);
    expect(html).not.toContain("0–0");
    expect(render(modelFor("fixture-explicit-free"))).toContain('>0<');
});

test("conditions, labels and unit labels remain escaped text", () => {
    const model = modelFor("fixture-multi-usage"), tier = model.tiers[0]!;
    tier.condition = "<script>alert(1)</script>";
    tier.metrics[0]!.label = "<b>用量</b>";
    tier.metrics[0]!.unitLabel = "<img src=x>";
    const html = render(model);
    for (const tag of ["<img", "<script>", "<b>"]) expect(html).not.toContain(tag);
    for (const escaped of ["&lt;img", "&lt;script&gt;", "&lt;b&gt;"]) expect(html).toContain(escaped);
});
