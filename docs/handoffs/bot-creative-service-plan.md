# CreativeOne 公共创作服务方案

CreativeOne 将图片、视频、歌曲和纯音乐能力作为登录用户可调用的公共接口。BotONE 与其他客户端使用相同接口，无需登记受信调用方、公私钥、grant 或授权反查服务。交付仅限 CreativeOne，关联项目由其实施者负责。

## 用户鉴权

公共接口接收当前用户的 IDONE Access Token（Authorization: Bearer），复用现有 Discovery 与 UserInfo 由原 IDONE 验证精确令牌及有效期；核对返回的 issuer，以 `(issuer, sub)` 查找本地账号，不接收请求体指定用户。不新增服务凭据、令牌签发或委托授权协议。IDONE 的 aud 是签发客户端标识，不把 BotONE 用户 Token 当成面向 CreativeOne 浏览器客户端的 ID Token 去验签。

Bearer 调用不依赖 Cookie、Origin 或 CSRF；每次请求都验证，错误 Token 不回退 Cookie。没有 Authorization 时仍复用原 Cookie 会话与写请求 CSRF。认证失败为 401 authentication_required，身份服务故障为 503 authentication_unavailable，缺本地账号/创作资格为 403 authorization_required。当前 IDONE 可能返回相同的 ID Token 和 Access Token 字符串，以 UserInfo 是否认可为有效 Access Token 为准。完整协议、样例和 BotONE 实施清单见[对接文档](./bot-creative-service-integration.md)。

创作资格复用现有 Reseller 授权和 `ensureKey`；费用使用用户 Key，绝不使用调用方 Key。本站退出登录使 Cookie 会话失效，Bearer 有效性由 IDONE 判断；已经受理的后台任务继续处理，执行前仍核验用户创作资格与原分组。仅计费授权失效不阻止用户登录后读取先前作品。

## 接口 v1

图片、视频和音频参考素材先通过 `POST /references` 上传原始字节，再以返回的 UUID 填入 references；`DELETE /references/{id}` 仅清理本接口上传的临时参考文件。沿用现有图片与媒体大小、模型数量和总时长限制，校验用户/文件归属，禁止 URL、文件路径或其他用户附件引用。图片及视频提交复用原转换与 worker；视频开放 mode 选择首尾帧或全能参考，是否接受各类素材以型号 inputs 和组合约束为准，音乐仍只接受文字。

根路径 `/api/integrations/v1`。接口均使用用户鉴权，不依赖浏览器页面或画布在线；身份、渠道、供应商协议与凭据不得由请求体指定。

| 方法和路径 | 请求或响应 |
|---|---|
| GET /capabilities | `{models:[{id,name,description?,kind,parameters,constraints,inputs,presets:[{id,parameters}],defaultPreset}],defaults:{},submission:{presetOnly:false,referenceMedia:true,referenceKinds:["image","video","audio"],maxReferenceImageBytes:配置值,maxReferenceMediaBytes:配置值}}` |
| PUT /jobs/{operationId} | `{kind,model,preset?,prompt,parameters?:{},references?:UUID[]}`；首次受理 202，等价重放 200/202，不同请求 409 |
| GET /jobs/{operationId} | `{operationId,status,outputs:[{id,mimeType,name}],errorCode?}` |
| GET /jobs/{operationId}/outputs/{id} | 当前用户所属任务的已保存文件流，真实 Content-Type |

`kind` 为 image、video 或 music。图片与视频仅发布一个可直接执行的默认组合；音乐按现有支持模式分别发布 song/instrumental 固定组合。预设只从已有模型配置和校验逻辑导出，不新增管理表或穷举组合；公开参数从实际组装请求提取，隐藏渠道、分组、倍率、上游路径和凭据。目录另返回完整参数 JSON Schema 和像素、分辨率/时长、素材组合约束；名称与可选描述沿用后台配置。模型完整能力与公共提交范围分别声明。客户端回传模型/预设 ID，可提交目录允许的 parameters 覆盖并经过同一套组装与组合校验；选择不存在返回 422 `selection_unavailable`。

模型 ID 由稳定渠道和型号身份确定性生成；预设 ID 包含实际有效请求语义，参数换序不改变 ID。只读目录只查已有本地绑定，不获取 Key、不写绑定，也不承诺远端计费授权有效。

## 去重与执行

- 操作 ID 为客户端在首次提交前保存的 UUID。按用户 + operationId 唯一，与具体客户端及登录会话无关。同用户其他会话可读取、重放自己的任务；不同用户的相同 ID 分别受理。
- 先查询已有记录，再比较首次受理的公开请求；等价重放不检查新预设或获取新 Key。隐藏任务保留去重记录并返回 404，不因重放复活。新任务才检查当前目录、真实参数和计费资格，再原子保存任务、参数规则及实际请求快照。重放时按保存规则规范化参数，以实际请求比较，不受最新配置影响。
- 后台复用现有生成 worker，不依赖站内 Agent、画布或客户端轮询。持久发送标记提交前可重新认领，提交后无回执则保守进入 unknown，最多发起一次计费 POST；已有上游任务 ID 只查询，已有结果只恢复保存，不重新生成。
- 暂时无法获取计费资格且尚未发送的任务，沿用现有扫描机制等待恢复；明确失去创作授权则 failed/authorization_required。不得静默换模型或分组。
- PUT 响应丢失后先查同一 operationId；必要时仍重放同一请求、同一 ID。unknown 不自动发起新计费任务。

## 状态与输出

pending 未提交为 queued，有上游任务 ID 且尚未完成为 running；running/succeeded/failed/unknown 按实际任务状态返回，cancelled/expired 映射 failed。错误码区分 authorization_required、generation_failed、cancelled、expired、submission_uncertain、task_query_failed、output_incomplete、output_unavailable。授权错误优先保留；视频查询故障不冒充输出保存失败。

输出 ID 固定绑定已保存的文件，音乐允许多文件。外人、跨任务文件、隐藏任务、删除或丢失的文件均返回 404 `not_found`。删除部分输出不影响其他文件，全部消失时任务仍为 succeeded，但 outputs 为空且返回 output_unavailable，不触发重新生成。

错误体 `{error:{code}}`；还包括 409 operation_conflict、422 invalid_parameters、429 rate_limited 和 service_unavailable。内部请求快照和上游原始错误不对外返回。

## 验收

使用两个独立登录用户验证匿名/过期会话、CSRF、跨用户及跨任务文件隔离；同用户不同会话复用同一任务，不同用户相同 ID 分别受理。模拟并发提交、配置变化、发送标记前后崩溃、响应丢失、计费授权失效和输出保存失败，确认不重复计费。覆盖图片、视频、歌曲/纯音乐和多文件 MIME。

测试使用隔离数据库与假服务。真实付费创作、两端用户认证接入和供应商账单须另行联调；不以静态测试或部署成功代替真实验收。
