# BotONE 对接 CreativeOne 公共创作接口

本文为 BotONE 实施者的接入合同。CreativeOne 提供图片、视频、歌曲与纯音乐创作、异步任务查询及作品下载。BotONE 负责当前用户的 IDONE Access Token、创作审批、操作 ID、任务查询和附件交付。

不需要 BotONE 专属签名、公私钥、grant、反查端点或 `BOT_CREATIVE_CONFIG`。接口按用户鉴权和计费，普通客户端与 BotONE 使用同一协议。

## 1. 地址与首版范围

lab 主入口：`https://creative.lab.home.arpa`。同一服务另有 `https://creativeccpg.lab.home.arpa`，接入时固定使用选定地址。根路径为 `/api/integrations/v1`。生产地址由部署方交付。

支持文生图、带参考图的图片编辑，以及纯文本或参考素材生成视频、歌曲或纯音乐；音乐一次任务可能返回多个文件。图片、视频和音频均可上传，视频任务按型号能力引用这些素材；音乐仍只接受文字描述。暂不支持配音、剪辑、批量任务或画布操作。图片和视频每个型号仅公开一个合法默认组合，音乐按实际支持模式公开歌曲/纯音乐固定组合。可通过 parameters 提交目录允许的参数覆盖，默认预设继续可用。

## 2. 现有 IDONE 协议及用户鉴权

### BotONE 发送什么

每次请求由 BotONE 后端发送当前操作用户的有效 IDONE Access Token：

```http
Authorization: Bearer <当前用户的 IDONE access_token>
```

PUT 同时使用 `Content-Type: application/json`。Bearer 调用不需要 CreativeOne Cookie、Origin 或 CSRF Token。不存在客户端指定用户 ID 的参数；不能以 BotONE 会话 Token、Refresh Token、模型 Key 或单独的 subject 替代 IDONE Access Token。

令牌由 BotONE 现有 OIDC/OAuth 账户链路取得并按已有机制刷新，不让用户手填，不全站共用一个用户令牌，也不交给模型生成请求 Header。只在后端使用；不能写进对话、附件、URL、任务快照或日志。

### CreativeOne 如何验证

CreativeOne 复用现有 `IDONE_ISSUER`、`IDONE_DISCOVERY_URL` 及 OIDC 客户端配置，通过 Discovery 指定的 UserInfo 接口验证令牌。每次外部请求都会验证，不保存令牌或缓存用户认证成功结果。

IDONE 当前合同已核对：

- Discovery 提供 `/api/userinfo`，subject 类型为 public；返回的 `sub` 为 IDONE 用户的统一 ID。
- UserInfo 只接收原 IDONE Access Token；IDONE 根据精确令牌的数据库记录和有效期判断是否接受，不是 CreativeOne 解码未验签的 JWT 后取身份。
- UserInfo 返回 `iss`、`sub` 和签发客户端标识 `aud`。CreativeOne 检查 issuer 与部署一致，以 `(issuer, sub)` 映射既有本地用户。这里 `aud` 是令牌签发客户端（例如 BotONE），不要求它等于 CreativeOne 的浏览器 OIDC Client ID。
- 当前 IDONE 原生令牌响应中 `id_token` 可能与 `access_token` 是同一个字符串。BotONE 仍应使用协议的 `access_token` 字段；CreativeOne 以 IDONE UserInfo 是否认可该值为准，不能承诺仅凭字段名就拒绝同值的 ID Token。
- IDONE 对错误、过期令牌可能返回 HTTP 200、正文 `{status:"error",...}`。CreativeOne 将它映射成 401，不把 HTTP 200 当作鉴权成功。

核对依据：IDONE `object/wellknown_oidc_discovery.go`、`routers/auto_signin_filter.go`、`controllers/account.go`、`object/user.go`、`object/token_oauth.go`；BotONE `packages/auth/src/oidc.ts`、`packages/auth/src/token-storage.ts` 及现有 `/get-access-token`、`/refresh-token` 处理。上述文件只作只读协议核对，本任务不修改关联项目。

### 浏览器会话与优先级

没有 Authorization Header 时，接口继续复用本站 Cookie 会话和写请求 CSRF。Bearer Header 存在时必须验证这个 Token，失败不能退回 Cookie。本站其他业务及管理接口仍使用原 Cookie/CSRF，不因本次接入开放 Bearer 管理权限。

### 首次使用与创作资格

IDONE 账号相同不等于用户已开通 CreativeOne/Reseller 创作资格。若 CreativeOne 尚无该 `(issuer, sub)` 用户，或者本地缺少模型服务绑定，返回 403 `authorization_required`。引导用户通过 CreativeOne 官方页面完成首次登录及已有模型授权：可打开 `/api/auth/login?returnTo=/studio`，再在站内完成授权；不要把用户 Token 放进跳转地址。

模型服务资格仍由 CreativeOne 的既有 Reseller 链路确认，按该用户 Key 扣费。目录成功只是本地资格快照；提交时仍可能发现授权失效或余额等上游问题。

## 3. 能力目录

```http
GET /api/integrations/v1/capabilities
```

200 示例（假模型和 ID，示意分辨率与时长联动）：

```json
{
  "models": [
    {
      "id": "demo-video",
      "name": "配置中的视频型号名称",
      "description": "后台填写的可选说明",
      "kind": "video",
      "parameters": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "mode": {"type": "string", "title": "首尾帧或全能参考", "enum": ["frames", "reference"]},
          "resolution": {"type": "string", "title": "分辨率", "enum": ["1080P", "2K"]},
          "ratio": {"type": "string", "title": "画幅", "enum": ["16:9", "1:1"]},
          "seconds": {"type": "integer", "title": "时长（秒）", "minimum": 4, "maximum": 30}
        },
        "additionalProperties": false,
        "allOf": [{
          "if": {"properties": {"resolution": {"const": "2K"}}, "required": ["resolution"]},
          "then": {"properties": {"seconds": {"type": "integer", "minimum": 4, "maximum": 15}}}
        }]
      },
      "inputs": {"referenceImages": true, "referenceVideos": true, "referenceAudios": true},
      "constraints": {
        "durationConfigurable": true,
        "duration": {"min": 4, "max": 30, "auto": false},
        "durationByResolution": {
          "1080P": {"min": 4, "max": 30, "auto": false},
          "2K": {"min": 4, "max": 15, "auto": false}
        },
        "modes": ["frames", "reference"], "defaultMode": "frames",
        "maxImages": 9, "maxVideos": 3, "maxAudios": 3,
        "requireImage": false, "audioOnly": true, "referenceSeconds": null,
        "frames": {"maxImages": 2, "maxFirstFrames": 1, "maxLastFrames": 1, "lastRequiresFirst": true, "mixedReferences": false, "requirePair": false, "adaptiveRatio": false},
        "framesWithoutImagesDisallowOtherMedia": true
      },
      "presets": [{"id": "demo-video-default", "parameters": {"resolution": "1080P", "ratio": "16:9", "seconds": 6}}],
      "defaultPreset": "demo-video-default"
    }
  ],
  "defaults": {"video": "demo-video"},
  "submission": {"presetOnly": false, "referenceMedia": true, "referenceKinds": ["image", "video", "audio"], "maxReferenceImageBytes": 10485760, "maxReferenceMediaBytes": 104857600}
}
```

### 身份、名称和默认预设

- `kind` 为 `image`、`video` 或 `music`。`name` 原样使用后台配置的型号名称，不从不透明 ID 猜名称；`description` 为后台填写的可选描述。
- `id` 是回传模型选择的不透明标识，不解析或拼接。展示使用 name，提交使用 id。
- 模型级 `parameters` 是 JSON Schema（draft 2020-12），描述完整参数类型、枚举、数值范围及可表达的组合条件；`constraints` 补充像素积、参考素材等不能只靠独立枚举表达的规则。二者由现有模型配置和校验规则投影，不由 BotONE 维护型号表。
- `presets[].parameters` 是某个已校验默认组合的具体值，与模型级参数 Schema 不是同一种结构。`defaultPreset` 始终指向该型号列出的预设；根 defaults 可缺少某类模型。
- 模型身份稳定；默认有效请求改变时产生新预设 ID。仅修改允许范围、说明或名称不应改变未变化的默认请求身份。只读目录不取 Key、不写绑定、不触发收费。
- `submission.presetOnly=false` 表示可提交目录允许的 parameters 覆盖；默认预设继续作为基础组合。`referenceMedia=true` 且 referenceKinds=["image","video","audio"] 表示上传入口接受三类素材。每个型号的 inputs.referenceImages、referenceVideos、referenceAudios 分别表示该型号接受的输入类型，并须同时满足 constraints 中的数量和组合规则；图片模型不接视频/音频，音乐模型不接素材。maxReferenceImageBytes 为当前实际单图上限，maxReferenceMediaBytes 为单视频/音频上限，客户端读取返回值，不硬编码示例数值。

### 参数与组合约束

JSON Schema 中未出现的字段不要自行补出；optional 字段省略沿用原模型默认行为。枚举仅列合法选项，数值范围使用 minimum/maximum；按分辨率变化的时长同时出现在 allOf/if/then 和 `constraints.durationByResolution` 中，必须结合所选分辨率判断。自动时长支持时以 `anyOf` 的 `const:-1` 表示；不能将它当普通负数时长。

| 类型 | 参数 Schema | 补充 constraints |
|---|---|---|
| 图片 | size 或 aspect_ratio、可用时的 resolution/quality/background | pixelSize、允许 resolutions/ratios、固定 fixedResolution、sizePresets、pixelBounds、maxReferences、singleReferenceRatioLocked |
| 视频 | mode、resolution、ratio、可控时长 seconds、实际开放的 generateAudio/watermark/fastMode/seed | durationConfigurable、分辨率时长联动、modes、素材数量/时长、首尾帧/全能参考组合、提示词限制 |
| 音乐 | mode 的 song/instrumental 枚举 | 当前无额外组合规则；不另设歌词参数 |

图片 `size` 的 `format:image-size` 是语义标记：auto、宽x高或正数宽高比。支持像素尺寸时，宽高必须为正整数且为 `pixelBounds.step` 的倍数，最长边不超过 maxEdge，长短边比不超过 maxRatio，总像素积在 minPixels/maxPixels 内；ratioShortSide 用于比例转像素的默认短边。sizePresets 提供已有配置中分辨率与画幅对应的尺寸，已过滤不在允许选项内的映射。fixedResolution 是型号固定输出档位，不能假设所有图片型号都有可调 resolution。singleReferenceRatioLocked 表示单参考图时沿用素材画幅，不额外传画幅。

视频的 `durationConfigurable=false` 表示不发送时长字段，不把内部默认秒数当成可调选项。fastMode 为布尔选项，省略表示不显式发送。只有实际允许的音频/水印/种子字段才出现在 Schema；种子范围复用现有请求 Schema。

图片 maxReferences 及视频 maxImages/maxVideos/maxAudios 的 null 表示未确认，不能解释为无限。视频素材约束：requireImage 表示必须有图；audioOnly 表示允许仅参考音频，否则音频必须搭配图片或视频；referenceSeconds 限制参考视频总时长及音频总时长（分别计算），null 为未确认。referenceImages 给出全能参考模式图片最少/最多数量。frames 描述首尾帧的数量、尾帧依赖首帧、不能混入其他参考素材、必须成对及仅自动画幅的限制。framesWithoutImagesDisallowOtherMedia 为 true 时，首尾帧模式即便没有图片也不能使用音视频参考。prompt.maxCharacters / maxUtf8Bytes 存在时同时约束 Unicode 字符数和 UTF-8 字节数。

以上素材能力用于完整表达模型规则；当前公共接口是否允许输入素材必须以 submission 为准。协议族、上游路径、内部预设 ID、渠道、分组、倍率及凭据不会随能力 Schema 返回。

## 4. 提交创作

### 4.1 上传图片、视频或音频参考素材

BotONE 先读取用户明确选中的聊天附件，在后端以同一用户 Access Token 上传原始二进制；图片、视频、音频共用此接口：

```http
POST /api/integrations/v1/references
Authorization: Bearer <当前用户 IDONE Access Token>
Content-Type: image/jpeg

<原始文件字节，不是 JSON / Base64 / 附件 URL>
```

Content-Type 可用真实 MIME（如 image/jpeg、video/mp4、audio/wav）或 application/octet-stream。服务端按真实字节识别类型，不相信文件名或 Header 声称的类型；复用现有图片解码、音频解析和视频元数据读取。图片支持 JPEG、PNG、WebP、GIF、AVIF、BMP；音频沿用 WAV、MP3、M4A/MP4、AAC、FLAC、OGG、AIFF 等现有解析格式；视频由现有文件类型识别及存储能力接受，不转码。音频专用 MP4 按音频返回。单图上限为 MAX_REFERENCE_IMAGE_BYTES 与 MAX_MEDIA_BYTES 的较小值，单视频/音频沿用 MAX_MEDIA_BYTES，通过目录两个上限字段返回。超限返回 413，不截断或自动压缩。

201 示例：

```json
{"id":"d2ef2225-fcc6-4f1e-ad3e-a19ba299d348","kind":"image","mimeType":"image/jpeg","bytes":132198,"width":1024,"height":768}
```

命令示例：

```bash
curl --fail-with-body -X POST "$CREATIVEONE_ORIGIN/api/integrations/v1/references" \
  -H "Authorization: Bearer $IDONE_ACCESS_TOKEN" \
  -H 'Content-Type: image/jpeg' --data-binary @photo.jpg
```

持久保存返回的 id，再提交任务；不能把 BotONE 自己的附件 ID、文件路径、Data URI 或远程 URL 填进 references。同用户重复上传完全相同的文件字节返回同一不可变 ID；不同用户不能互用 ID。上传不取模型 Key、不调用模型、不收费。

返回的 kind 为 image / video / audio；可读取尺寸时包含 width/height，可读取时长时包含 durationMs（毫秒），不能将缺失时长当成零。模型设有 referenceSeconds 时，服务端必须读到正时长才受理，并分别校验全部参考视频与全部参考音频的总时长。上传本身不指定模型；接受上传不代表所有模型都支持该素材。

已保存作品的输出 ID 也可在同一用户下作为对应类型参考；素材读取、归属和大小校验仍在服务端完成。

取消未提交操作或清理临时参考素材时调用 `DELETE /api/integrations/v1/references/{id}`，成功为 204。该删除入口仅管理本接口上传的参考文件，不删除生成作品。删除后新任务不能再使用该 ID；已经受理的任务保留自己的输入，重放不会重新计费。重新上传同一字节可恢复该用户对该参考文件的使用。

### 4.2 提交

```http
PUT /api/integrations/v1/jobs/{operationId}
Content-Type: application/json
```

```json
{"kind":"video","model":"demo-video","preset":"demo-video-default","prompt":"晨雾中的山谷","parameters":{"resolution":"1080P","ratio":"16:9","seconds":10}}
```

kind、model、prompt 必填，prompt 不得为空白。preset 可省略，省略时选当前 defaultPreset；parameters 可省略或为空对象。references 可省略或为空数组；带参考素材时按用户希望的顺序填写上传返回的 UUID 数组，图片/视频/音频可以放在同一数组中，服务端按实际文件类型分类并保留各类内部顺序。建议 BotONE 显式传所选 preset，确保用户确认的其余默认参数没有悄悄变化。

服务器先取基础预设，再覆盖 parameters 中显式填写的字段；覆盖字段名、类型、枚举、范围和组合必须符合该型号目录 Schema 和现有校验。不会因非法分辨率或时长而悄悄回落默认值。提交未知字段、用户身份、渠道、Key、URL、Header 或直接内嵌文件等均返回 422 invalid_parameters。参考素材只通过 references UUID 数组传递；归属、大小、数量、时长和组合在获取 Key 前检查，其他用户、删除或不存在的素材统一返回 404 not_found。

示例：图片可提交 `parameters:{"size":"2048x2048","quality":"high","background":"transparent"}`（仅适用于目录实际开放这些字段的型号）；分开接收画幅/分辨率的图片型号使用 aspect_ratio、resolution；视频使用 mode、resolution、ratio、seconds 及目录实际开放的布尔/种子参数；音乐可用 `parameters:{"mode":"instrumental"}`。歌曲的描述与歌词仍由用户写入 prompt，不另加歌词字段。

图片画幅、像素尺寸、画质、透明背景和视频时长/分辨率组合复用现有请求组装与校验；自动时长 -1 按原协议省略上游 duration。Veo 等不可控时长型号不能传 seconds；固定分辨率图片不能强行传目录未开放的 resolution。选择的布尔 false、种子 0 等显式值会保留。

例如用户要求“使用 banana2-1k 将附件里的人物放到斯坦福门口”：读取目录找到 name 对应的型号，并确认 inputs.referenceImages；上传原始附件，然后提交：

```json
{"kind":"image","model":"<目录模型 ID>","preset":"<目录默认预设 ID>","prompt":"以参考图片中的人物为主体，在斯坦福大学入口前拍摄自然的旅行照片","references":["d2ef2225-fcc6-4f1e-ad3e-a19ba299d348"]}
```

BotONE 不应因旧工具声明而继续声称“创作应用不能带参考图”。应将选中的附件真正上传并在 references 中传返回 ID；不能只在 prompt 中写文件名或用外貌描述替代原图。图像身份保持效果由模型决定，此例只说明正确传图流程。

视频可以混合引用图片、视频和音频（以所选模型 inputs 和 constraints 为准），例如：

```json
{"kind":"video","model":"<支持三类参考的目录模型 ID>","prompt":"保持参考人物形象，延续视频的镜头运动，并使用音频节奏","parameters":{"mode":"reference"},"references":["<图片 UUID>","<视频 UUID>","<音频 UUID>"]}
```

视频 parameters.mode 仅接受目录枚举：frames 为首尾帧，reference 为全能参考；显式选择非法组合直接拒绝。省略时，无音视频参考沿用既有图片数量/默认模式逻辑（constraints.defaultMode 给出配置默认）；有视频或音频参考默认按 reference 处理。frames 中第一、第二张图片分别为首帧、尾帧，不能与音视频混用；其他最少图片数、成对图片、自动画幅、仅音频许可等仍以模型规则为准。服务端复用原有媒体签名链接供上游读取，BotONE 不负责签名或供应商上传；能否被具体上游读取仍需真实联调，不能以另建 operationId 重试未知结果。

图片调用端点和格式由后台配置决定：服务端复用 Banana JSON 参考图、OpenAI multipart 编辑及 Grok JSON 编辑；单参考图锁定画幅的型号不能强行覆盖 aspect_ratio，多图仍按原规则处理。BotONE 不需要维护供应商协议。

首次受理返回 202，等价重放返回 200 或 202，均使用下节的任务结构。受理仅表示任务已持久化，不能向用户宣称作品完成。

### 操作 ID 与去重

BotONE 在第一次任务提交网络请求前为用户的这一次创作意图生成并持久保存 UUID。数据库保存 operationId、原公开请求以及当前 Bot 任务/消息归属，之后的查询和重试复用它。

- 同一用户 + 同一 operationId 只对应一项任务，与 BotONE 实例、登录会话或客户端无关。
- 同一 ID、同一模型/正文/预设且实际生效参数相同，返回原任务。参数属性换序、空对象与省略、显式默认值，以及通过共享组装得到同一尺寸的表达（如支持型号的 2:3 与 1024x1536）不新增任务。真实参数、正文、显式预设或 references 的内容/顺序改变返回 409 operation_conflict，不模糊合并不同作品。相同参考 ID 重放即使上传记录已请求删除也仍返回原任务，不重新生成。
- 两个不同用户使用相同 UUID，会分别受理各自的任务，不互相读取。
- 受理时保存基础预设、规则和最终请求快照。默认预设、参数范围改变或型号下架后，同 ID 重放按首次规则规范化比较，不获取新 Key、不读最新预设；省略 preset 的重放也不会改用新的默认预设。
- 新 ID 引用已经不可用的选择返回 422 `selection_unavailable`。重读目录后，选择发生变化须重新取得对应创作审批，不自动换档。
- 隐藏任务保留去重记录并返回 404。404 不证明从未受理；重放同一个请求不会让隐藏任务复活或再次计费。
- 新创作必须来自新的用户意图/审批，不能为绕过错误自动换 operationId。

## 5. 查询任务及后台恢复

```http
GET /api/integrations/v1/jobs/{operationId}
```

200 示例：

```json
{
  "operationId": "65d929ab-6739-44e4-97fa-1ee7e98c02ce",
  "status": "succeeded",
  "outputs": [{"id":"74c92aa9-3124-4430-8538-fae414d56a9b","mimeType":"audio/mpeg","name":"74c92aa9-3124-4430-8538-fae414d56a9b.mpeg"}]
}
```

| status | 含义 | BotONE 行为 |
|---|---|---|
| queued | 已受理、尚未提交模型 | 保存原 ID，沿用现有查询策略 |
| running | 正在提交，或视频已有上游任务但未完成 | 查询原任务，不能重提生成 |
| succeeded | 生成和保存完成 | 遍历全部 outputs，下载并交付 |
| failed | 已知失败/取消/过期 | 展示公开原因，不自动换 ID 生成 |
| unknown | 提交、查询或保存结果不确定 | 展示待确认及原 ID，不自动发起新付费请求 |

`outputs` 有序，可为空或有多个。unknown 也可能带已保存的部分输出。视频提交成功不等于 succeeded。后台执行独立于页面和 BotONE 轮询，BotONE 中断不取消已经受理的任务。

`errorCode` 为可选字段：

| errorCode | 含义 |
|---|---|
| authorization_required | 用户创作资格失效，需现有模型授权流程 |
| generation_failed | 已知生成失败，内部上游错误不对外暴露 |
| cancelled / expired | 原任务取消或过期 |
| submission_uncertain | 可能已经提交计费，但未持久获得可靠回执 |
| task_query_failed | 视频已有任务 ID，后续状态查询停止 |
| output_incomplete | 已有结果，文件下载或保存不完整 |
| output_unavailable | 完成任务的全部输出已删除或丢失；仍为 succeeded、outputs 为空 |

授权失效优先返回 authorization_required，不误报文件保存失败。unknown 不意味着可重新计费；有可靠回执时只能恢复原任务查询或保存。首版没有额外的公共 resume 端点，不能从 GET 或重复 PUT 触发重新生成。

## 6. 下载与附件交付

```http
GET /api/integrations/v1/jobs/{operationId}/outputs/{outputId}
Authorization: Bearer <同一用户的有效 IDONE Access Token>
```

返回文件流及真实 Content-Type。不返回供应商 URL 或带凭据的地址。按 BotONE 现有附件上限和流式处理策略接收，不新增另一套下载限制。

每次下载仍验证用户、任务和输出归属。其他用户、跨任务输出、隐藏任务、已删除或丢失的文件统一 404 `not_found`。输出 ID 固定对应某个已保存文件，不会指向替换文件；不要把数组下标当文件 ID。

音乐须处理全部输出，不能假设只有一首或固定 MP3。部分输出消失时其余文件仍可用；全部消失不触发重新生成。投递前 BotONE 自己核对当前用户与会话/线程归属，避免将用户 A 的作品发进用户 B 的对话。

## 7. HTTP 错误与恢复

统一正文：`{"error":{"code":"authentication_required"}}`。

| HTTP | code | 处理 |
|---|---|---|
| 401 | authentication_required | Token 无效/过期，或 Cookie 会话失效；用原认证机制刷新或重新登录，再查原任务 |
| 403 | authorization_required | 缺本站账号/模型绑定或创作授权；引导官方登录/模型授权 |
| 403 | forbidden | Cookie 写请求 CSRF 失败；检查客户端认证方式，不用新增操作绕过 |
| 404 | not_found | 不存在、不可见或不属于当前用户；不要泄露其他用户归属 |
| 409 | operation_conflict | 同一 ID 改请求；保留原任务，不自动换 ID |
| 409 | account_changed | 可选 X-Expected-User 与实际身份不符；停止旧用户操作 |
| 422 | invalid_parameters | 请求结构、未知字段或实际参数不合法 |
| 422 | invalid_reference_image | 图片无效、损坏或实际文件缺失 |
| 422 | invalid_reference_media | 上传为空，或音频/MP4 容器无法有效解析 |
| 415 | unsupported_media | 文件不是现有支持的图片格式 |
| 413 | reference_image_too_large | 参考图超过目录返回的当前图片字节上限 |
| 413 | reference_media_too_large | 上传或引用超过目录 maxReferenceMediaBytes |
| 422 | selection_unavailable | 当前模型/预设不存在；重读目录并重新确认选择 |
| 429 | rate_limited | 沿用已有等待策略，保留原 ID |
| 503 | authentication_unavailable | IDONE Discovery/UserInfo 网络或服务故障；不要当成用户撤销或提示重新授权 |
| 5xx | service_unavailable | 其他内部或依赖故障；保留原 ID，先确认任务状态 |

超过现有请求体上限仍可能收到 413 `invalid_parameters`。连接层故障或反向代理错误不保证 JSON，客户端须处理非 JSON 响应。

PUT 超时或响应丢失：先 GET 原 operationId；需要重放时仍发相同 PUT、相同 ID。Token 刷新不会改变任务归属，也不能作为创建新任务的理由。CreativeOne 不接收或刷新 BotONE 的 Refresh Token。

## 8. 最小调用示例

下列环境变量只用于展示 HTTP 协议。实际 BotONE 后端应为每个当前用户从现有认证链路取有效 Access Token，不配置全站共用 Token：

```bash
curl --fail-with-body "$CREATIVEONE_ORIGIN/api/integrations/v1/capabilities" \
  -H "Authorization: Bearer $IDONE_ACCESS_TOKEN"

# operationId 必须先持久化；MODEL_ID / PRESET_ID 从刚读取的目录取得。
curl --fail-with-body -X PUT \
  "$CREATIVEONE_ORIGIN/api/integrations/v1/jobs/$OPERATION_ID" \
  -H "Authorization: Bearer $IDONE_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"kind":"music","model":"MODEL_ID","preset":"PRESET_ID","prompt":"柔和的钢琴片头"}'

curl --fail-with-body \
  "$CREATIVEONE_ORIGIN/api/integrations/v1/jobs/$OPERATION_ID" \
  -H "Authorization: Bearer $IDONE_ACCESS_TOKEN"

curl --fail-with-body \
  "$CREATIVEONE_ORIGIN/api/integrations/v1/jobs/$OPERATION_ID/outputs/$OUTPUT_ID" \
  -H "Authorization: Bearer $IDONE_ACCESS_TOKEN" -o "$OUTPUT_PATH"
```

实际提交应使用 JSON 序列化器构造正文，不手拼用户 prompt。lab 使用部署 CA 正常验证 HTTPS，不关闭 TLS 校验；不跟随到不受信目标转发 Bearer。

## 9. BotONE 实施清单

1. 删除旧版服务断言签名、grant 记录、授权反查及连接器信任配置的依赖；用户身份只来自自己的已验证登录。
2. 按当前用户取得原 IDONE OIDC 账户 Access Token；复用已有加密存储、解密和刷新链路，不将数据库密文直接当 Token 发送。
3. 用当前用户 Token 拉目录，以 name/description 展示模型；基于 JSON Schema/constraints 收集用户选择，审批后提交 model、建议显式的 preset 及 parameters。仅提交目录开放的字段，不复制型号规则，不透传供应商请求。
4. 有参考素材时，按类型检查型号 inputs.referenceImages/referenceVideos/referenceAudios 及 constraints；上传用户选中的真实附件并保存返回 ID、kind、MIME 和元数据，视频工具开放 mode 选择；让工具/Skill 接收 references UUID 数组，不能只更新文案。审批后先持久化用户、operationId、原公开请求、参考 ID 和消息归属，再提交；恢复运行、刷新 Token、服务重启均复用记录。
5. 按原任务状态查询和处理 unknown；下载全部可用输出，再按当前用户/线程归属交付。
6. 显示认证暂不可用与用户认证失效的区别；不要把 503 当作用户断开。

## 10. 联调与证据

自动化使用 `server/src/creative-service.integration.test.ts` 与隔离 `_test` PostgreSQL。覆盖无 Cookie 的 Bearer 目录/提交/查询/下载、同一用户 Cookie/Bearer 混合并发去重、跨用户输出拒绝、令牌拒绝和身份服务故障，以及原多媒体、发送恢复和错误映射路径。

已通过真实 lab 只读 Discovery 检查，issuer/UserInfo/public subject 与协议一致；真实 IDONE 对故意无效 Token 返回 HTTP 200 错误正文，已纳入处理。没有读取 BotONE 用户 Token、借用用户 Cookie、修改 IDONE/BotONE 或发起收费生成。

公共创作、既有接口/音频及登录认证回归共 94 项全部通过，隔离测试数据库已清理。需要双方使用测试账号完成以下真实验收：

- 用户 A、B 分别用自己的 BotONE 登录 Token 调能力；账户未开通时准确显示官方授权入口。
- A 提交一次，刷新 Token/重启 Bot 后仍读同一任务；B 不能读 A 的任务或输出。
- 授权后分别验证图片、视频、歌曲与纯音乐，检查真实 MIME、多文件和费用归属。
- 并发重放/丢失响应不增加计费次数，查询故障不伪装作品完成。
- 有效 Token 的真实正向联调及供应商账单须明确记录，不能用模拟测试或未认证探测代替。

## 11. lab 部署结果

已部署到上述两个 lab 域名。部署前确认 CreativeOne 使用独立 PostgreSQL `127.0.0.1:5433/creativeone` 且没有进行中的生成任务；数据库、媒体、配置和源码已备份至 `server/data/backups/before-idone-access-hmMgm6/` 并验证归档。已重启 `creativeone-lab-api.service`，无需新增环境变量或修改 IDONE/BotONE。

两域名页面与健康检查均为 200；匿名站内/公共接口为 401。携带故意无效的 IDONE Token 调能力与 PUT 均返回 `401 authentication_required`，数据库确认没有创建对应任务。验证记录为备份目录内 `validation.json`。

有效测试用户的真实 Token 正向联调、完整付费生成及供应商账单尚未执行；没有借用真实用户凭据、发起收费调用、运行构建或语法/类型检查。BotONE 可按本文实施接入，再使用双方明确授权的测试账号完成第 10 节验收。

## 12. 能力目录扩展

目录已增加可读名称、后台可选描述、完整参数 JSON Schema 和组合约束，保留 defaultPreset、presets 及其默认值。5 项能力投影测试及完整公共创作集成场景共 6 项通过，覆盖像素规则、分辨率时长联动、固定/自动时长、参考组合、配置即时读取及默认预设稳定性；隔离数据库已清理。该轮扩展先提供能力目录，现已开放 parameters 提交，最新合同见第 4 节。已备份至 `server/data/backups/before-capability-options-uTU2qN/` 并验证归档后重启 lab API；两域名健康检查为 200，匿名能力请求为 401。使用 lab 当前配置只读验证 9 个型号均有名称、参数 Schema、组合约束和有效默认预设，未发起收费调用。有效用户 Token 的新版目录浏览与 BotONE 展示仍待双方联调。

## 13. 自定义参数提交

公共提交已开放 parameters，目录标记 presetOnly=false，保留基础预设选择和默认预设。每次受理保存规则及实际请求快照，重放依实际参数判等；后台变更不覆盖原任务。参数错误在 Key 获取前拒绝。

隔离测试覆盖视频 1080P/画幅/时长/种子、H3 2K 分辨率时长组合与快速模式、原生视频自动时长和音频布尔值、图片尺寸/透明背景及分离画幅/分辨率、音乐模式覆盖；直接检查模拟上游收到的实际请求。同时覆盖非法类型、未知字段、组合冲突、等价尺寸与显式默认值去重，以及旧任务按保存规则重放。测试使用假服务，不代表真实供应商已完成相同参数的付费生成。

本轮能力与公共创作、既有接口及音频回归共 79 项通过，隔离数据库已清理。已备份至 `server/data/backups/before-parameter-submit-KUTulH/` 并验证归档后重启 lab API，新增规则快照字段生效；两域名健康为 200、匿名能力接口为 401。核对部署前后原有 1 个已完成公共任务，请求、结果及状态均未变化；只读验证 lab 的 12 个默认预设行为不变，且非默认视频分辨率能进入实际请求。没有发起真实收费生成，BotONE 的真实自定义参数任务与账单仍待联调。

## 14. 图片参考输入

公共接口已增加参考图二进制上传、临时参考文件清理和图片提交 references；复用原图片请求转换、能力校验、账户文件存储及任务 worker。服务端选择端点，不允许客户端指定供应商 URL、Header 或 Key。上传和任务的文件归属均以已验证用户为准，提交记录保留参考来源及原调用类型。

自动化覆盖 Banana JSON、OpenAI 单/多图 multipart、Grok 单图画幅锁定、重复上传/任务重放、跨用户读取/删除拒绝、引用替换与顺序冲突、尺寸与数量限制，以及删除后已受理任务继续读取原图。全部使用模拟图片和假供应商，不代替真实人像参考效果或收费联调。本轮能力/公共创作、既有接口及音频回归共 79 项通过，隔离数据库已清理。已备份至 `server/data/backups/before-reference-images-v8giRf/` 并验证归档后重启 lab API；两域名健康为 200，匿名能力和上传入口为 401。只读校验当前 5 个图片型号支持参考输入，包含 banana2-1k；12 个默认预设行为不变，原有 2 个公共任务的请求、结果、状态及规则快照未变化。没有发起真实收费调用，BotONE 仍需按第 4 节实现附件上传及 references 提交，再验收真实参考图生成效果。


## 15. 视频与音频参考输入

上传入口现接受图片、视频、音频三类二进制，返回 id/kind/mimeType/bytes 和可读取的尺寸、毫秒时长；音频专用 MP4 复用现有解析器识别为 audio。视频任务通过统一 references UUID 数组引用素材，服务端按真实 MIME 分类，新增 parameters.mode 首尾帧/全能参考选择，继续使用现有统一视频与 Seedance 原生请求、媒体签名和后台 worker。图片与音乐不接受视频或音频参考，不增加服务身份、供应商上传凭据或私有适配。

能力目录增加 inputs.referenceVideos/referenceAudios、视频 parameters.mode、constraints.defaultMode 及 submission.maxReferenceMediaBytes；单图仍用 maxReferenceImageBytes，其他媒体沿用原 MAX_MEDIA_BYTES。数量、是否允许仅音频、图片配对、画幅和参考视频/音频分别累计时长均复用原有模型校验，在获取 Key 前完成；时长限制存在但元数据缺失时拒绝受理。文件删除、跨用户拒绝、同字节上传复用及任务重放沿用原行为。

模拟联调覆盖混合三类素材、首尾帧顺序、仅音频、统一视频与原生路径、签名原文件读取及伪造签名拒绝、MP4 音频分类、跨用户引用和删除拒绝、非法类型/数量/累计时长/模式组合，以及删除后已受理任务继续读取音视频。公共创作/能力与既有接口、音频回归共 79 项通过，隔离测试数据库已清理，未执行构建或语法/类型检查。已备份至 `server/data/backups/before-reference-media-q7w24a/`，数据库、媒体和源码归档验证成功后重启 lab API；本机 API `/healthz` 为 200，两域名页面为 200，匿名目录和视频上传均为 401。

lab 当前目录有 9 个型号，MiniMax-H3 同时接受图片、视频和音频参考，视频/音频各最多 3 段，具体组合读取实时目录；12 个默认预设的实际请求和原有 4 个公共任务的请求、结果、状态及规则快照保持不变。本轮没有真实收费生成。BotONE 应按第 4 节接入三类附件上传、读取类型和元数据、提交混合 references 与参考模式，再由用户验收真实上游读取、生成效果及账单；旧工具不能继续声明只能上传图片。关联项目未修改或部署。
