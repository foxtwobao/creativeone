# Reseller 应用模型价格接口方案

状态：Reseller 已交付实现，最终契约以 `/home/hulei/projects/tokenone_reseller/docs/APP_PRICING_API.md` 为准。CreativeOne 已按该契约切换价格读取并删除本地表达式解析，部署与真实联调见待测清单；下文保留原交接方案，不作为最新实施状态。用户明确要求 **TokenONE / New API 不改代码、不新增接口、不构建或部署修改版本**。

## 1. 目标与最小范围

由 Reseller 提供带应用鉴权的价格接口，返回应用默认 Composite 分组下各模型的展示价格，金额已包含最终路径倍率。应用后端只筛选自己启用的模型并展示，不再各自解析计费表达式或计算倍率。

- 增加 `GET /api/apps/pricing` 和应用 scope `pricing:read`。
- 读取 TokenONE 现有 `GET /api/pricing`，参考其模型价格页面的解析逻辑，在 Reseller 转换为稳定的展示数据。
- 首版支持 Composite 默认分组，以及当前 CreativeOne 使用的 token 阶梯价、按请求价、按秒价和任务 token 价。
- 修正新增应用读取 scope 导致已有用户模型授权失效的问题。
- 不做价格编辑、报价锁定、扣费计算、用量查询、历史价格、自动重试、定时同步或新的缓存系统。

这是应用默认组的价格目录，不表示某个用户已取得模型权限，也不保证其余额、订阅或 Key 当前可用。实际调用权限与最终扣费仍由现有模型调用链路决定。

## 2. 已核验的数据来源与页面实现

TokenONE 当前接口的 `composite_groups[].models[]` 已包含模型 `pricing` 和 `paths[]`。路径含 `member`、`composite_ratio`、`member_ratio`、`final_ratio`。必须读取匹配默认组的嵌套模型价格，不能假定顶层 `data` 包含所有 Composite 模型。

页面看起来是结构化的，但 token 阶梯和任务单价主要由前端从 `billing_expr`、`billing_usage_schema` 等字段解析生成；不能假设接口已经直接返回完整的展示表格。

以下路径相对于 `/home/hulei/projects/newapi`，仅供只读参考：

| 源码 | 参考内容 |
| --- | --- |
| `controller/pricing.go`、`controller/composite.go` | 现有价格响应、Composite 模型与路径结构 |
| `web/src/features/pricing/components/composite-pricing.tsx` | 每条路径单独展示；把 `final_ratio` 作为模型展示倍率，并关闭充值价格换算 |
| `web/src/features/pricing/components/model-price-cell.tsx`、`lib/dynamic-price.ts`（同一 pricing 目录） | 模型价格展示入口和动态价格分支 |
| `web/src/features/pricing/lib/billing-expr.ts` | `parseTiersFromExpr`、`parseTaskTiersFromExpr`、`splitBillingExprAndRequestRules` |
| `web/src/features/pricing/lib/billing-expression/parser.ts`、`display.ts` | AST 编译、`readTokenTierChain`、`readTaskTierChain` 等展示适配 |
| `web/src/features/pricing/lib/task-matrix-display.ts` | `getTaskPricingDisplayTiers`：任务条件与兜底档位展示 |
| `web/src/features/pricing/components/dynamic-pricing-breakdown.tsx` | token / task 分流、请求附加规则和不可展示状态 |
| `pkg/billingexpr/expr.md` | 单位、变量、阶梯条件及实际计费语义 |

Reseller 以这些函数的语义和输入输出样例为参考，在现有 Go 服务中实现小范围展示适配。优先复用 Reseller 项目中的 `internal/costs/expression.go` 的 AST 单价提取和精确运算能力，以及 `internal/costs/expression_test.go` 的测试样例；已有 `expr-lang/expr` 解析依赖，无需另写一套解析器。仅对实际共用的纯函数做必要提取，不接入成本采集、快照、历史或调度流程，不扩展为通用计费引擎。应用展示适配仍按第 5 节限制支持形态，不能因为底层能够解析就自动开放复杂规则。不为复用 TS 页面引入 Node 服务，不抓取页面 HTML，不执行上游表达式，不搬入价格编辑器、模拟器或整套前端。

尤其不能仅拆出基础表达式后丢掉请求附加倍率、时间条件或插件差异，仍把基础价格标成最终价格。首版未支持的完整规则返回 `unavailable`。

## 3. 应用鉴权与分组选择

```http
GET /api/apps/pricing
Authorization: Bearer <应用接入凭证>
X-Request-ID: <可选，沿用现有约束>
```

- 沿用现有应用凭证校验：应用启用、凭证有效且 scope 包含 `pricing:read`。
- scope 配置在应用权限中；同步补齐后台可选项、服务端白名单和 API 文档。
- `pricing:read` 要求配置默认分组，但不隐含要求 `groups:read` 或 `keys:ensure`。
- 默认分组从已鉴权应用的配置中取得，并按既有分组映射定位 TokenONE Composite；禁止调用方指定 `app_id`、分组、用户身份或上游地址。
- 不接收 `issuer/subject`，不读取用户模型 Key，不调用 ensure，不创建授权或 Key，不依赖用户模型授权。
- 只返回该应用默认组的数据，不返回其他组、渠道凭据或完整上游响应。
- Reseller 后端使用其已有 TokenONE 地址和 HTTP 客户端读取 `/api/pricing`。不得将 Reseller 应用 Bearer 转发给 TokenONE。

当前 lab 的 `/api/pricing` 可无凭据读取，但该路径受 TokenONE 现有导航访问配置影响。实施时先核验目标环境；若受保护，只能采用现有受支持的服务端访问方式。无可用方式时明确返回服务不可用，不要求修改 TokenONE、不借用用户浏览器会话。

## 4. 建议成功响应契约

HTTP 200，`Cache-Control: no-store`。顶层结构沿用应用 API 的直接字段风格。以下为单个模型的示例，金额是字符串：

```json
{
  "app_id": "creativeone",
  "group": { "id": "366", "name": "1-Creative-Composite", "multiplier": "1.25" },
  "currency": "USD",
  "queried_at": "2026-10-16T00:00:00Z",
  "models": [
    {
      "model": "gpt-image-2",
      "paths": [
        {
          "member": "生图/视频分组",
          "multiplier": "1.25",
          "status": "available",
          "tiers": [
            {
              "condition": "",
              "prices": [
                { "metric": "input", "amount": "6.25", "unit": "million_tokens" },
                { "metric": "cache_read", "amount": "1.5625", "unit": "million_tokens" },
                { "metric": "output", "amount": "37.5", "unit": "million_tokens" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

- `group.multiplier` 是 Composite 本身倍率；路径 `multiplier` 是上游 `final_ratio`，仅用于说明，调用方不得再次相乘。
- `amount` 为已应用路径倍率的十进制定点字符串，保留小额价格精度，不统一四舍五入到两位。首版固定 USD，不跟随余额单位或充值汇率换算。
- `metric` 首版取 `input`、`output`、`cache_read`、`cache_write`、`image_input`、`image_cache_read`、`request`、`duration`、`usage_tokens`；`unit` 取 `million_tokens`、`request`、`second`。显示中文由应用映射。
- `condition` 是可直接展示的中文条件，例如“输入上下文 ≤ 272000 token”；空字符串表示没有附加条件。不交给应用执行或据此计费。
- 一条路径不可展示时返回 `status: "unavailable"`、`tiers: []` 和 `reason`。`reason` 首版取 `missing_pricing`、`unsupported_rule`、`unconfirmed_zero_price`、`invalid_pricing`。
- 仅当上游模型的路径数组为空时，返回 `paths: []` 和模型级 `reason: "missing_pricing"`。上游存在路径但价格缺失或规则不可展示时，保留每条路径及其 `status: "unavailable"`、`tiers: []` 和具体 `reason`；即使全部路径都不可展示，也不能清空路径数组或统一改成 `missing_pricing`。不可伪造路径或零价格。
- 保留上游路径顺序，每条路径独立定价；不能只选最低价、取平均值或合并不同倍率。
- `queried_at` 是本次成功读取时间，不是价格生效时间或配置版本。首版不构造虚假的全局版本号。
- 不返回原始表达式；不在 Reseller 维护 CreativeOne 的能力分类、模型启用开关或描述。调用方用原始模型 ID 与本地配置取交集；本地启用但目录缺失的模型显示价格暂不可用。

示例中的时间仅说明 RFC 3339 格式，实际由请求生成。字段名可在实施前按 Reseller 规范统一，交付时须给出最终契约，调用方据此接入。

## 5. 首版价格转换规则

使用十进制运算。每个单价只乘一次上游 `final_ratio`；不再乘 Composite、成员或用户专属倍率，不回退旧式 ratio 价格换算。

| 上游形态 | 展示语义与验收示例 |
| --- | --- |
| `tier("standard", p * 5 + cr * 1.25 + c * 30)` | token 系数本身为 USD / 百万 token；路径 1.25 得到 6.25、1.5625、37.5 |
| `img`、`img_cr` 等独立 token 项 | 分别展示图片输入、图片缓存读取；不能把图片 token 单价说成每张图片价格 |
| `len <= 272000 ? tier(...) : tier(...)` | 保留两个档位；`len` 为完整输入上下文，不能用扣除缓存后的 `p` 判断档位 |
| `tier("base", fixed(0.01))` | 按成功请求计费；路径 1.25 得到 0.0125 USD / 次请求，不得推断为每张图片 |
| `tier("base", u("seconds") * 0.01)` | 结合 usage schema 确认字段类型和单位；路径 1.25 得到 0.0125 USD / 秒 |
| `tier("base", u("tokens") * 8 / 1000000)` | 结合 schema 确认 token 单位；路径 1.25 得到 10 USD / 百万 token，不能再除一次百万 |

只完整识别支持的形态，未知变量、单位、运算、插件专属定价和未实现的条件规则均返回 `unsupported_rule`，不能只展示其中可识别的部分。非法数值或负价格返回 `invalid_pricing`。

当前 lab 两个 Seedance 模型的任务表达式为零 token 系数，CreativeOne 暂按待确认处理。首版保留这一展示策略：任务计价的基础系数全部为零且最终倍率非零时返回 `unconfirmed_zero_price`，不宣称免费；明确 `fixed(0)` 或合法最终倍率为零，不被这条规则误伤。这是展示策略，不是 TokenONE 计费规则发生改变，也不要求为此修改 TokenONE。

## 6. scope 与用户模型授权解耦

当前 Reseller `internal/server/application_keys.go` 使用 `g.authorized_scopes @> a.scopes`；`application_authorization.go` 的授权发起、完成及 grant 写入也使用应用完整 scopes。因此只增加 `balance:read` 或 `pricing:read`，也可能让已有模型授权要求重新确认。

本次要求：这两个 scope 由管理员授予可信应用，不作为用户模型调用授权的新增同意项。只添加或移除它们，应保持原有 ready 模型授权有效，也不应使正在进行的模型授权回调失效。

最小实现可在既有 scope 比较中统一排除明确的 `balance:read`、`pricing:read`，授权快照写入遵循相同规则；不要直接取消 scope 校验或泛化为忽略所有 `*:read`。其他 scopes 的原有语义保持不变。无需为了这项修正新增权限表或批量重写已有 grant。

必须保留：应用停用、凭证撤销、用户撤销、默认组改变以及需要用户同意的模型权限改变时，原来的拒绝或重新授权逻辑仍然有效。路由上的 `balance:read` / `pricing:read` 权限检查始终生效，不能因为用户模型授权有效就绕过应用 scope。

lab 已给 creativeone 增加 `balance:read`，可能遇到此比较问题；不得通过手工补齐所有用户的 `authorized_scopes` 代替规则修正。

## 7. 错误与请求行为

- 凭证、scope、应用状态等错误沿用既有错误码和 HTTP 语义，缺 scope 返回现有 `SCOPE_FORBIDDEN`。
- 默认组未配置或映射无效：建议 HTTP 409 / `APP_PRICING_GROUP_UNAVAILABLE`；非 Composite 组首版同样明确不支持。
- 上游请求失败、非 JSON、顶层结构无效或目标 Composite 报错：建议 HTTP 503 / `APP_PRICING_UNAVAILABLE`。
- 个别模型/路径缺价格或不支持规则：其余结果正常返回 HTTP 200，失败项使用上述 `reason`，不得让一个复杂规则拖垮整个目录。
- 错误体沿用 `{"error":"错误码","retryable":false}`；首版调用方手动刷新，不新增自动重试。不得透传上游 HTML、错误原文、密钥或堆栈。
- HTTP 客户端超时和取消沿用 Reseller 现有已确认配置；交付注明实际值。若需要新增或调整超时、大小、并发等边界值，先说明默认值与失败行为并确认，本方案不隐含新增数值。
- 价格是查询时的展示信息，实际结算以 TokenONE 为准。失败不能拿旧数据冒充本次成功，不能返回伪造的零价格。

## 8. 实施与交付

1. 在 Reseller 核验目标环境的 `/api/pricing`、应用默认组映射和现有客户端配置，采集脱敏 fixture。
2. 补齐 scope、后台配置选项、默认组约束和模型授权比较修正。
3. 增加只读接口，复用现有 AST 单价提取与精确运算，补充应用展示适配；参考 New API 页面展示语义，保持小范围实现。
4. 完成下列验收，并更新 Reseller 应用 API 文档及 AppONE 对接契约；交付最终响应样例、错误码和实际超时配置。
5. Reseller 验收完成后，在 CreativeOne 单独将价格来源切换到该接口，删除本地表达式解析及仅为此引入的依赖，保留本地模型筛选、描述和页面。余额继续走既有接口。

本交接不授权修改任何 TokenONE 源码或部署配置，也不在本文档任务中修改 Reseller 源码。

## 9. 验收清单

- 无凭证、失效凭证、应用停用和缺少 `pricing:read` 均正确拒绝；只有该 scope 且有默认组、无用户授权时可查价格。
- 应用 A 无法通过请求参数读取应用 B 或其他默认组；响应只含自身默认组，无任何 Key。
- 对当前 CreativeOne 的 20 个启用模型核对：18 个可展示报价、2 个 Seedance 待确认；这是当前 fixture 预期，不能硬编码模型数量或名称。
- token、缓存、图片 token、上下文两档、fixed、秒和任务 token 的金额及单位与 New API 页面语义一致；页面显示货币不为 USD 时，以原始 USD 口径核对。
- Composite 1.25、成员 0.4 的最终倍率为 0.5；基础输入单价 2 得到 1 USD / 百万 token。小额价格不变成零，多路径不合并。
- 非法表达式、附加请求倍率、未知单位、插件差异及价格缺失有明确不可展示结果，不返回部分价格冒充最终价格。
- 上游故障整体失败，单模型不可展示只影响该项；真实空目录与读取失败可区分。
- 上游路径数组为空时返回模型级 `missing_pricing`；路径存在但全部不可展示时，仍按原顺序保留各路径及具体失败原因。
- 添加/移除 `balance:read`、`pricing:read` 后，已有模型 ensure 和进行中的授权回调正常；撤销、默认组变化及模型权限变化仍按原规则处理。
- 全程使用价格读取和测试 fixture，不需要发起付费模型调用。最终交付列出尚未支持的规则，不承诺任意表达式均可结构化。
