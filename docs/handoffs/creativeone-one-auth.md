# CreativeONE 标准统一登录交接

以 HomeONE 总体方案、跨项目契约第 4 节和业务 ONE 标准任务为准。本次仅修改 CreativeONE 仓库；旧 SSO 实现中可用的 PostgreSQL 事务、OIDC 验证、本地会话与登录页继续复用，域名选择 HomeONE 的配置已取消。首次归属以 HomeONE 文档 `2026-10-11-registration-attribution-without-webhook.md` 和最新跨项目契约第 6 节为准：Reseller 主动读取 IDONE 原生注册资料，归属与开通不依赖 webhook；CreativeONE 无需新增接口或渠道上报。本轮 IDONE 源码、账号、组织、权限、客户端、回调、数据库与部署均不修改，仅核对已有能力。

## 产品登记

交给 Reseller 的产品记录如下。`admin/creativeone` 为现有 lab 文档登记值；其他环境须核对实际 owner/name，不能用 Client ID 替代。

```json
{
  "appId": "creativeone",
  "name": "CreativeONE",
  "idoneApp": "admin/creativeone",
  "domainLabel": "creative",
  "launchPath": "/",
  "callbackPaths": ["/api/auth/callback"]
}
```

固定路径沿用本项目现有设计，不改为方案示例中的 `/auth/callback`。Reseller 根据 Site 生成标准访问地址与完整回调，`publicUrl` 取 default Site 的最终地址。当前 lab 的 `https://creative.lab.home.arpa` 与 `https://creativeccpg.lab.home.arpa` 若不符合标准生成规则，分别登记对应 Site 的特殊 origin 覆盖。产品业务 Secret 不提交到目录。

每个 origin 需要同时核对：CreativeONE `APP_ORIGINS`、Reseller `(idoneApp, callbackUrl)` 精确路由、IDONE 同一业务 APP 的精确回调、DNS/TLS 和反向代理。核对完成后再启用，不以域名模板替代精确登记。

## CreativeONE 配置

```dotenv
APP_ORIGIN=https://creative.lab.home.arpa
APP_ORIGINS='["https://creative.lab.home.arpa","https://creativeccpg.lab.home.arpa"]'
HOMEONE_LOGIN_ORIGIN=https://homeone.lab.home.arpa
IDONE_APP=admin/creativeone
```

以上为已部署的 CreativeONE lab 配置；HomeONE 平台配置已启用；默认回调可用，CCPG 回调登记仍需对应项目核对。删除旧 `HOMEONE_SITES`，不保留按域名选 HomeONE 的回退。`APP_ORIGINS` 必须包含 `APP_ORIGIN`，仅接受完整规范 origin，拒绝通配符、路径、凭据、重复和同 Host 不同协议；生产使用 HTTPS，开发仅回环地址允许 HTTP。只读取代理保留的原始 Host（含端口），不信任外来转发头。

所有 origins 使用固定 issuer、现有 IDONE Client ID/Secret、Discovery 和管理员 sub。只有合法当前 Host 决定业务回调 origin，本应用不选择 Site/入口 APP，不读取 HomeONE 私有配置，不获取其他入口 Secret，也不维护渠道归属。

`APP_ORIGIN` 继续用于已有媒体外链与 Reseller 模型授权回调。第二业务域名的模型授权仍存在固定回调限制，见 TODO；本次登录升级不代表第二域名的全部业务能力已通过验收。

## 登录、会话与错误

1. 登录/注册在服务端保存随机 appState、浏览器绑定、origin、期限及合法业务返回路径，再前往固定 HomeONE `/auth/login`，只发送 `app`、精确 `returnTo`、`appState` 和可选 `register`。
2. HomeONE 回跳仅接受 appState 与契约错误，校验独立 host-only Cookie 和一次性事务后启动内部 OIDC；这一步不保存用户或业务会话，也不再次进入 HomeONE。
3. 业务段重新生成 state、nonce 和 S256 PKCE，使用固定客户端；通过 IDONE 签名、issuer、audience、时间和 nonce 校验，并核对 userinfo subject 后，才按原始 issuer/sub 保存用户与本 origin 会话。
4. 返回路径仅从服务端事务恢复，保留合法 query/fragment；管理员角色仍由本应用检查。两段间切换账号，以业务段结果为准，不混用入口身份；同邮箱不同 sub 不合并。
5. 非法、混合、重复、关键空值、未知参数、缺失 Cookie、错误 origin、过期和重放就地拒绝，不重定向任意请求目标。只有已验证并消费的事务允许带统一 `authError=login` 返回原页面；失败后手动恢复，不循环授权、不重放生成或收费操作。

Cookie 保持 HttpOnly、SameSite=Lax、host-only；HTTPS 使用 Secure 与 `__Host-` 前缀。会话继续按 origin 验证，已有业务会话不因 HomeONE 配置故障自动退出。退出只删除当前本地会话，不表示全平台退出。

多标签页共享同 origin 的流程 Cookie。重新发起会废弃请求 Cookie 所绑定的旧 HomeONE/业务事务并更新 Cookie；并发发起或回跳导致 Cookie 不匹配时拒绝，回原页面手动重试，不承诺并行登录。不同 origins 各自建立会话。

期限沿用现有值：业务 OIDC 使用 `LOGIN_SECONDS`（默认 600 秒），HomeONE 前置事务使用 `min(LOGIN_SECONDS, 600)`，业务会话使用 `SESSION_SECONDS`（默认 604800 秒）；本次未调整超时、重试或并发边界。代理须保留 Host/端口，并禁用认证 URL 的 query/body 日志；仓库 Nginx 已关闭认证访问和错误日志，部署方仍需核对外层网关。

## 验证结果与待联调

模拟协议验证使用真实 `openid-client` 校验逻辑、隔离签名 JWT/JWKS 和模拟 PostgreSQL 查询，不访问真实身份服务或模型。签名校验沿用 SDK 的 [enableNonRepudiationChecks](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md)。

- 协议与身份测试：固定入口/客户端、独立 state/nonce/PKCE、Host/端口/转发头、深链接、参数拒绝、HomeONE/业务错误、过期/重放、跨域同一身份、同邮箱不同账号、最终账号切换、管理员判定、多标签页失效和本地退出。
- 无效签名、issuer、audience、过期令牌、nonce 与 userinfo subject 均在创建身份/会话前被拒绝。
- 21 项测试（含子测试）全部通过：`auth.test.ts` 10 项、`auth-config.test.ts` 3 项、`reseller-auth.test.ts` 1 项、`tokenone-user-policy.test.ts` 7 项。配置与既有模型授权/用户策略回归使用隔离模拟环境；未执行构建、语法检查、真实 PostgreSQL 集成测试、数据库迁移或付费模型调用。

真实 SSO 尚未完成：需分别验证默认/CCPG/独立域名的入口选择、相同业务客户端与 subject、匿名深链接、已有会话、注册、取消、IDONE/HomeONE 会话失效、浏览器 Cookie、管理员权限与账号切换；lab 真实 PostgreSQL 并发消费已确认只有一次成功。跨 APP 免重复输入依赖 IDONE 原生 SSO 配置，mock 成功不能替代此验证。首次归属、原生用户发现/核验、独立开通和延迟计佣由 Reseller 项目实现与验收，不要求产品上报渠道，不配置或修复 IDONE webhook。

## 部署与回滚

CreativeONE 已部署到现有 lab Caddy → Vite 3002 → API 4013 链路：配置改用固定中央地址和两个合法业务 origins，原 API 重启，业务客户端与数据归属保持原样；未部署应用容器或修改关联项目。备份包含配置、当前代码、PostgreSQL 自定义归档与媒体，归档目录校验通过；路径、进程及日志记录在本机忽略文件 `server/data/homeone-deployment.json`。

两站点页面 200、匿名 401、固定中央地址、独立业务 PKCE、错误深链接返回、参数拒绝、跨 origin、过期、重放与真实数据库并发一次消费均通过；验证结果在 `server/data/one-auth-lab-validation.json`，测试事务已清理。继续授权通知由独立测试客户端模拟，没有完成真实用户登录。

此前 HomeONE 平台配置关闭时，两域名登录曾返回 `503 APP_LOGIN_UNAVAILABLE`；最新只读复核已确认 `HOMEONE_PLATFORM_CONFIG_ENABLED=true`。默认业务回调返回 303，进入 IDONE 并使用 S256；CCPG 地址 `https://creativeccpg.lab.home.arpa/api/auth/callback` 返回 `403 APP_RETURN_FORBIDDEN`，尚未被当前运行路由接受。由 HomeONE/Reseller 对应项目核对该特殊域名覆盖及 `(admin/creativeone, 完整回调)` 精确登记；仅只读核对 IDONE 已有回调，缺项时报告，不修改 IDONE。以上仅验证入口协议，没有完成真实身份登录或首次归属/开通/返佣验收，本应用不回退旧映射。

部署前备份代码/镜像版本、配置、PostgreSQL 和媒体；先完成 Reseller/HomeONE 精确路由并只读核对 IDONE 已有原生回调，再替换 CreativeONE 配置并按原方式重启。本轮不修改 IDONE；已有回调不满足时报告缺项并停止相关入口启用。检查健康、默认与渠道登录、深链接和权限后再开放。站点绑定缺失的旧会话/事务需重新登录；不改写 issuer/sub、不自动认领历史数据。

回滚时配套恢复原代码/镜像与配置；已有用户、素材和任务保持原归属，不因登录配置回退重算身份。若数据库需要恢复，先单独保存备份后的新增业务数据，再执行经授权的恢复；不能直接覆盖新增数据。渠道来源登记及对外入口的回滚由对应项目协同处理。
