# CreativeONE 统一登录交接

依据 HomeONE 仓库 `docs/one-auth/README.md` 与 `docs/one-auth/appone.md`。CreativeONE 只对接 Reseller 公开导航入口与 IDONE 业务 OIDC；本次仅修改本仓库，已部署到 lab 并通过 HTTPS 协议检查；完整账号登录和真实 SSO 尚待验收。

## 产品登记

向平台交付下列产品配置，以及部署实际支持的访问域名。`idoneApp` 使用 IDONE 中实际 owner/name，只用于平台登记，不作为 CreativeONE 运行时配置；不得交付业务 clientSecret。

```json
{
  "appId": "creativeone",
  "name": "CreativeONE",
  "idoneApp": "admin/creativeone",
  "domainLabel": "creative",
  "launchPath": "/studio",
  "oidcStartPath": "/api/auth/oidc/start",
  "callbackPaths": ["/api/auth/callback"]
}
```

平台根据实际发布域名登记 Reseller 产品访问地址和 IDONE 精确业务回调。`oidcStartPath` 是浏览器可直接访问的启动路由，不是 redirect_uri；平台认证后直接导航到它，不追加身份或认证结果参数。普通业务页面已有会话时直接进入；匿名访问展示登录/注册按钮，用户点击后前往 Reseller。启动入口则自动发起业务 OIDC，即使浏览器已有业务会话，也以本次业务 OIDC 验证的账号为准。

lab 已检查域名为 `https://creative.lab.home.arpa` 和 `https://creativeccpg.lab.home.arpa`。域名与 Site 的关系由 Reseller 管理，CreativeONE 不交付映射表。此前旧协议的默认入口检查、CCPG `APP_RETURN_FORBIDDEN` 和模拟回跳结果不能作为新协议验收证据；新版本需重新核对产品、origin、启动路径和业务回调。

## 配置与可信 origin

```dotenv
APP_ORIGIN=https://creative.lab.home.arpa
APP_ORIGINS='["https://creative.lab.home.arpa","https://creativeccpg.lab.home.arpa"]'
ENHANCER_BASE_URL=https://tokenonereseller.lab.home.arpa
RESELLER_APP_ID=creativeone
```

复用 `ENHANCER_BASE_URL`，不增加第二份 Reseller 地址。它现在也是登录必需配置，必须为浏览器可达的规范 origin，不含路径、尾斜杠、凭据、query 或 fragment。生产使用 HTTPS；开发仅回环允许 HTTP。`RESELLER_APP_ID` 默认 `creativeone`，遵循平台产品标识格式，不使用 IDONE owner/name 或 Client ID。删除旧 `HOMEONE_LOGIN_ORIGIN`、`IDONE_APP`、`LOGIN_SECONDS` 配置。

IDONE issuer、Discovery、Client ID/Secret、管理员 sub 和 `SESSION_SECONDS` 沿用现有配置。仅联调登录与数据同步时可留空 `ENHANCER_APP_CREDENTIAL`、`TOKENONE_BASE_URL`；登录导航不发送任何服务凭据。

继续使用已有 `APP_ORIGIN`、可选 `APP_ORIGINS` 和 `APP_DOMAIN_SUFFIXES` 校验访问域名，不新增 Site 配置、完整 callback 列表或渠道查询。`APP_ORIGINS` 留空默认主 origin；显式列表须包含主地址。可信后缀允许根域及多级子域，动态 origin 仅标准 HTTPS。后端只按原始 Host 匹配合法 origin，不信任客户端转发头；外层网关须保留 Host/端口、拒绝非法域名并使用 HTTPS。不得删掉应用校验后直接拼接任意 Host。仓库 Docker 只发布 Nginx 端口，实际部署仍须核对后端网络暴露。

`APP_ORIGIN` 继续用于媒体外链与 Reseller 模型授权回调。第二业务域名的模型授权仍存在固定回调限制，继续保留 TODO；本次不修改模型授权协议或关联项目。

## 路由与事务

1. `/api/auth/login` 校验可选合法相对 `returnTo` 与注册标记。有有效本地会话时直接返回业务页面；否则在 PostgreSQL `login_returns` 保存浏览器 Cookie 绑定的导航记录，然后导航到 `ENHANCER_BASE_URL/auth/enter?appId=creativeone&sourceOrigin=<当前可信 origin>`，注册追加 `register=true`。原页面和 Cookie 不传给平台。
2. `/api/auth/oidc/start` 无需前置证明，也不接受认证结果参数。消费同 origin 导航记录；缺失、过期或被其他标签替换时使用 `/studio`。清理当前浏览器旧业务事务，生成新的 state、nonce、S256 PKCE，绑定 origin、固定客户端、issuer、精确 redirect_uri 和返回路径，直接导航 IDONE。
3. `/api/auth/callback` 仅处理业务 OIDC，拒绝旧 appState、重复参数、关键空值、code/error 混合、错误 issuer、缺少浏览器 Cookie、错误 origin、过期及重放。匹配的事务通过数据库 DELETE RETURNING 一次性消费；固定客户端/issuer/redirect_uri 不符时拒绝。使用原事务 redirect_uri 换码，验证签名、issuer、audience、时效、nonce 及 userinfo subject 后，按 `(issuer, sub)` 保存用户并轮换本 origin 会话。
4. 有效事务失败时返回保存的业务路径并显示手动重试；无可信返回路径时就地显示错误页及返回登录页链接，不自动跳 Reseller。当前浏览器的失败事务会清理。其他 origin 的事务和会话不受影响。
5. `/api/auth/logout` 继续要求会话与 CSRF，清除当前 origin 会话、当前浏览器的未完成 OIDC 和导航记录及对应 Cookie。退出后停留登录页，不自动登录，不代表 IDONE 或其他应用退出。切换账号先主动退出，再登录。

业务 OIDC 事务固定 **300 秒**，不受旧 `LOGIN_SECONDS` 影响；过期后清理并手动重试。导航偏好记录保留现有默认 **600 秒**，缺失或失效仅丢失原页面恢复；会话仍默认 **604800 秒**。Cookie 使用 HttpOnly、SameSite=Lax、host-only，HTTPS 下启用 Secure 与 `__Host-` 前缀。不同 origins 会话独立；同 origin 多标签共享 Cookie，不保证各标签独立恢复深链接。

不再创建或访问 `homeone_flows`。已有数据库中的旧表不迁移、不作为登录凭证，本次不执行旧表删除或业务数据迁移。启动时沿用现有 schema 初始化机制，为业务事务补充绑定字段并建立导航表；旧的未完成事务需要重新发起，用户身份和业务数据不重写。

## 验证与发布前检查

28 项认证、配置和既有模型授权/用户策略测试通过，使用模拟 PostgreSQL 查询、隔离提供方及真实 `openid-client`、JWT/JWKS 验签。覆盖公开参数、独立启动、导航降级、300 秒固定值、客户端绑定、签名/issuer/audience/过期/nonce/userinfo 拒绝、重放、跨 origin 同一身份、账号切换、已有会话和退出清理。

未执行语法检查、构建、真实浏览器或真实 SSO 联调，未修改关联项目。lab 部署已完成配置更新和 API 重启，由既有 schema 初始化机制补齐登录表结构。后续发布与验收需要：

- 核对 Reseller `/auth/enter`、产品 appId、全部访问 origins 与 `/api/auth/oidc/start` 登记；平台按实际域名核对 IDONE 精确回调。
- 备份 CreativeONE 配置、PostgreSQL 和媒体，再部署配套代码与配置；旧 HomeONE 协议的已部署状态不等于新版本已上线。
- 验收默认与渠道入口、注册、公共地址回落、真实 IDONE SSO 自动授权/需要交互两种情况，以及取消、失败、超时、重放、非法 Host/转发头和后端直连边界。
- 验收同一身份跨 origin 不重复建用户、Cookie 隔离、管理员权限、原页面恢复、账号切换和退出不循环；模型调用、余额与模型授权另行验收。

回滚须配套恢复代码与配置，保留新增业务数据，不按邮箱认领身份，也不直接覆盖当前数据库。生产静态资源部署仍按 TODO 单独验收。

## lab 部署结果

已备份原配置、Git HEAD、工作区补丁、PostgreSQL 自定义归档及媒体，数据库归档目录校验通过。备份路径、代码版本、工作区状态、进程和日志记录在本机忽略文件 `server/data/appone-deployment.json`。保留 Vite 3002、API 4013、专用数据库 `127.0.0.1:5433/creativeone` 和既有 Caddy 链路，只重启 CreativeONE API；现有 Reseller 地址与 IDONE 业务客户端保持原值，配置删除旧 HomeONE 项并设置产品 `creativeone`。

两个业务域名均通过页面 200、匿名 401、Reseller 新入口 302、平台导航 302、独立 OIDC 302、精确回调与 S256、300 秒安全 Cookie、取消恢复深链接、无导航记录回默认页面、重放 400；伪造 Host 与转发头被后端 400 拒绝。检查使用独立 HTTP Cookie 容器，未进入用户浏览器或创建业务会话。结果保存在 `server/data/appone-lab-validation.json`。完整用户授权、IDONE 回调换码、平台返回启动入口及真实跨应用 SSO 仍需登录验收，以上协议检查不替代这些结果。
