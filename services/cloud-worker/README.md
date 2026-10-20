# Cloud Worker：私有云端执行服务

Worker 接收完整正文，串行调用本仓库的 CLI，按 `status → next_action` 推进到微信公众号文章或贴图草稿。Pipeline 状态机仍是业务真相源；Worker 只管理队列、执行和查询，不包含 LLM 写稿、用户登录、计费或公众号中转服务。

> 云端 Worker 已实现并可从本仓库独立部署。本文描述当前源码：账号通过 `accounts.json` 和账号 API 管理，任务通过 HTTP 提交并轮询。`v0.14.0` tag 的初版 Worker 使用 Pipeline 配置中的账号，若固定到该旧 tag，请按对应源码和文档部署。Worker 位于 `services/`，不包含在 npm 包中。

推荐调用链：

```text
Web / App / 桌面端 → 业务后端 → 私有 Worker → Pipeline CLI → 微信中转 API → 微信草稿箱
```

Worker 是 [Pipeline](../../README.md) 仓库中的部署组件，不是独立 npm 包。现有应用消费方包括 Nezus 后端；其他后端可按本文 HTTP 契约接入，无需依赖该应用。正文可通过 [myno](https://github.com/k7airos/myno) 排版，封面与贴图可通过 [Typeset Studio](https://github.com/k7airos/typeset-studio) 渲染，均由 Pipeline 配置选择。

Pipeline 0.23.0 固定安装 myno 0.4.1，并从 myno 复用正文 CSS。完整 myno 排版配置示例：

```json
{
  "plugins": {
    "markdownRenderer": { "module": "@akairos/myno/adapter", "options": {} }
  }
}
```

镜像需要包含可解析的插件包；myno 提供排版资源，Chrome、超时清理和输出由 Pipeline 管理。Worker 本身不托管 Studio 页面。

业务后端负责用户鉴权、账号与任务归属、配额、请求内容校验和幂等键隔离。Worker 的服务令牌允许访问所有任务及账号，不能下发到客户端，也不能仅检查登录后就透传客户端提供的账号键或任务 ID。

## 本机启动

先按[主 README](../../README.md)安装 Bun、依赖和 Chrome/Chromium。准备服务端配置文件，至少包含兼容微信中转服务的地址：

```json
{
  "wx": { "baseUrl": "https://wx-api.example.com" }
}
```

`wx.baseUrl` 不能直接指向微信官方 API；中转服务需实现 `/api/v1/wx/*` 契约，详见[账号与外部服务](../../README.md#微信账号与外部服务)。账号凭据通过下文的账号接口写入，配置文件还可保存排版、Logo 等默认值。

在仓库根目录运行（替换配置路径，令牌由调用后端安全保存）：

```bash
export PIPELINE_WORKER_TOKEN="$(openssl rand -hex 32)"
PIPELINE_WORKSPACE_ROOT="$HOME/.local/share/zzhub-pipeline-worker" \
PIPELINE_WORKER_STATE_FILE="$HOME/.local/share/zzhub-pipeline-worker/jobs.json" \
PIPELINE_CONFIG_FILE=/absolute/path/to/pipeline.json \
bun run services/cloud-worker/server.ts
```

默认监听 `127.0.0.1:18887`。调用方使用同一个令牌；包括健康检查在内，所有接口均要求 `Authorization: Bearer <PIPELINE_WORKER_TOKEN>`。令牌由部署环境生成、保存和轮换，Worker 只校验，不签发或管理用户 token。

## Docker 部署

仓库自带的 [Dockerfile](Dockerfile) 使用 Bun 1.3.14，并安装 Chromium 与 CJK 字体，云端不需要桌面浏览器或 Electron。先准备外部配置文件、数据目录和已导出的 `PIPELINE_WORKER_TOKEN`，再运行：

```bash
docker build -f services/cloud-worker/Dockerfile -t zzhub-pipeline-worker:local .
docker network create pipeline-internal

docker run -d --name pipeline-worker --restart unless-stopped \
  --network pipeline-internal \
  -e PIPELINE_WORKER_TOKEN \
  -e PIPELINE_WORKER_HOST=0.0.0.0 \
  -e PIPELINE_WORKER_PRIVATE_NETWORK=1 \
  -e PIPELINE_CONFIG_FILE=/run/secrets/pipeline.json \
  --mount type=bind,src=/absolute/path/to/pipeline.json,dst=/run/secrets/pipeline.json,readonly \
  --mount type=bind,src=/absolute/path/to/worker-data,dst=/data \
  zzhub-pipeline-worker:local
```

`pipeline-internal` 是示例网络名。将获准访问的业务后端加入该网络，通过 `http://pipeline-worker:18887` 调用；不要添加公网端口映射或公网反代。仅供宿主机验收时，可加 `-p 127.0.0.1:18887:18887`。Worker 还需要访问中转服务及正文图片地址；网络隔离不能阻断这些必需的出站请求。

`PIPELINE_WORKER_PRIVATE_NETWORK=1` 仅允许绑定非回环地址，实际隔离由部署网络保证。镜像没有内置凭据，配置与数据放在镜像外。示例适用于自行部署，不要求使用 Nezus 或其内部运维仓库。

### 环境变量

| 变量 | 默认值 / 作用 |
| --- | --- |
| `PIPELINE_WORKER_TOKEN` | 必填；后端访问 Worker 的共享服务令牌 |
| `PIPELINE_WORKER_HOST` | `127.0.0.1` |
| `PIPELINE_WORKER_PORT` | `18887` |
| `PIPELINE_WORKER_PRIVATE_NETWORK` | 非回环监听时必须显式设为 `1` |
| `PIPELINE_WORKSPACE_ROOT` | `/data/pipeline-worker`，每个 job 建立独立工作目录 |
| `PIPELINE_WORKER_STATE_FILE` | `/data/pipeline-worker/jobs.json`，队列与正文存储 |
| `PIPELINE_WORKER_ACCOUNT_STATE_FILE` | 默认与 `jobs.json` 同目录的 `accounts.json` |
| `PIPELINE_CONFIG_FILE` | 传给子进程的 Pipeline 配置路径；未设时遵循 CLI 配置发现规则 |
| `ZZHUB_WX_BASE_URL` | 可覆盖配置中的微信中转服务地址 |
| `ZZHUB_PIPELINE_BRANDING_LOGO` | Docker 默认使用镜像内 Logo；可指定容器内已挂载图片路径 |
| `PIPELINE_ROOT` / `BUN_BIN` | 可覆盖源码根目录 / Bun 可执行路径，一般无需设置 |
| `TYPESET_ARTICLE_COVER_FONT_PATH` | 受信部署字体路径；默认 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`，任务不能覆盖 |
| `PIPELINE_WORKER_CACHE_BYTES` | 共享正文素材缓存上限，默认 512 MiB，包含临时文件 |
| `PIPELINE_WORKER_CACHE_TTL_MS` | 未被保留任务引用的缓存过期时间，默认 30 分钟 |
| `PIPELINE_WORKER_PREPARE_CONCURRENCY` | 同时接收并准备任务上限，默认 2；没有等待重材料的队列 |
| `PIPELINE_WORKER_FREE_BYTES` | 扣除未实际消耗预留后的可用磁盘安全余量，默认 4 GiB |
| `PIPELINE_WORKER_JOB_RESERVE_BYTES` | 每个准备／执行中任务的保守增长预留，默认 1 GiB |
| `PIPELINE_WORKER_STEP_TIMEOUT_MS` | 单个 CLI 步骤（init、status、prepare、render 等）的墙钟上限，默认 600000（10 分钟）；超时后终止整个进程组，任务记为 `failed` |
| `PIPELINE_WORKER_PUBLISH_STEP_TIMEOUT_MS` | publish 步骤的墙钟上限，默认 600000；超时无法确认是否已写入微信，任务记为 `interrupted` |
| `PIPELINE_WORKER_PREVIEW_TTL_HOURS` | 未确认预览的保留时长，默认 0（不过期）。启动时与此后每小时检查一次，超时的 `preview_ready` 记为 `failed`、`error=preview_expired`；维护模式下不检查 |
| `PIPELINE_ARTICLE_EXPORT_ENGINE` | 正文 HTML 导出引擎，`chrome`（默认）或 `dom`。`dom` 在独立 Bun 子进程中用 happy-dom 运行同一导出 bundle，不启动 Chrome；取值非法时 Worker 启动失败。当前值见 `/health.capabilities.articleExportEngine` |

Worker 每次执行从账号存储读取 `appId`、`appSecret`、`pat`，通过子进程环境注入；不接受在任务正文参数里传入凭据。Pipeline 基础配置中的账号可提供样式，但当前 Worker 不会用它替代账号存储中的注册。

## HTTP API

下列 curl 示例用于本机监听或宿主机回环映射；在业务后端容器中将地址换为 `http://pipeline-worker:18887`。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /health` | 返回服务状态、排队数、是否正在处理队列及已同步账号数 |
| `PUT /v1/maintenance` | `{ "enabled": true/false }` 暂停或恢复接收新任务；已有任务继续，重复幂等请求仍返回原任务 |
| `PUT /v1/accounts/:account` | 创建或替换公众号凭据，返回账号键和 `active` |
| `DELETE /v1/accounts/:account` | 删除同步的凭据，返回 `deleted`；不删除微信草稿 |
| `POST /v1/jobs` | 新任务返回 `202`；相同幂等键及内容返回原任务 `200` |
| `GET /v1/jobs/:id` | 查询任务；不存在返回 `404` |
| `GET /v1/jobs/by-idempotency-key?idempotencyKey=...&account=...` | 按原键与原 Worker 账号只读找回任务；无任务 `404`，账号不匹配 `409` |
| `POST /v1/jobs/:id/discard` | 放弃未确认的预览（`preview_ready` 或仍在排队），任务记为 `failed`、`error=preview_discarded`；重复调用返回原结果，已确认 `409 preview_already_confirmed`，生成中 `409 preview_not_ready` |

未认证为 `401`，非法输入为 `400`，相同幂等键对应不同输入为 `409 idempotency_conflict`。无封面快照请求仍限 2,500,000 字节；带封面请求上限 4,500,000 字节，Bun 同时限制实际读取大小，不依赖调用方声明的 Content-Length。当前没有任务列表、取消、重试、SSE 或任意文件上传接口；正文素材有下文的受限二进制入口。

### 接收恢复与容量门禁（0.23.0）

`/health.capabilities.jobLookupByIdempotencyKey=true` 声明原键找回能力。该 GET 要求一份 `idempotencyKey` 和 `account`，拒绝重复或未知查询参数，并设置 `Cache-Control: no-store`。包括提交、按 ID／键查询及确认在内的任务响应都包含 `bodyHash`（原始 UTF-8 正文 SHA-256），保留 `input`、`requestHash`、`publicationRequested`。业务后端先核对不可变输入和正文 hash，再采用找到的 job ID；无 ID 的未知提交尤其在连接停用后只走 GET，不能重传凭据、素材、新建任务或再次确认。

首次提交在重材料处理前持久化 `status/step=accepting` 和固定 job 身份。HTTP 仍同步完成准备后返回原 `202`；同键并发只共用短暂的持久化接收过程，随后返回同一 `accepting`／终态，不重复准备。并发准备超限在接收前返回 `429 worker_prepare_busy`。接收后准备失败保存同一 `failed` 任务和原键，清理未采用的任务目录；重复 POST 返回原失败。重启将 `accepting` 变为 `failed/worker_acceptance_interrupted`，仅清其未采用材料；保留已排队材料和全部历史已采用材料，`queued` 继续，`running` 沿用 `interrupted`。

`/health` 同时提供 `accepting`、`preparing`、`assetWrites` 计数；`assetWrites` 覆盖请求体读取、解码和缓存落盘。维护备份需等待这三项均为 0、`queued=0` 且 `running=false`。新素材最多两份请求并行，超限 `429 worker_asset_busy`。缓存写入串行核总量，只移除超过 TTL 且没有任何保留任务引用的文件；任何状态的保留任务都保护其素材。启动时清理受控上传临时文件，不为腾空间删除被引用素材。

缓存满或空间不足返回 `507 worker_cache_full/worker_storage_low`，输入或材料超限为 `413`。新素材、接收准备、首次确认和每次增长阶段要求 `free - outstanding reservations - new budget >= 4 GiB`；准备／执行预留随任务实际写入减少，完成时释放。1 GiB 是保守增长预留，不能视为任意旧插件、全部磁盘或 owner 的硬配额。首次确认前空间不足不接受发布；已经持久化 `publicationRequested` 的任务执行前失败仍保留原确认与 run，不能换键盲重排。已存在任务的查询与幂等结果读取始终可用。

完整文章准备限制：header／cover 默认资源合计最多 8 项、20 MiB，每项 5 MiB；metadata／config／template／snapshot 累计 8 MiB，resolver stdout 8 MiB，固定字体实际字节核验后复制。产物在复制前核单项 50 MiB、总量 256 MiB。Worker 子进程 stdout 限 8 MiB，超限终止并排空子进程，绝不把截断 JSON 当成功；stderr 只留 64 KiB 尾部并注明截断。可信 Worker 环境下 HTML 落盘限 50 MiB，诊断日志和监控事件限制单条／累计内容并保留截断标记、退出状态及原业务返回／异常。普通 CLI 不启用这些新增输出门禁；Typeset 固定封面沿用有限尺寸和阶段水位，未增加通用 PNG 字节沙箱。

定向检查由主控执行：`bun test services/cloud-worker/capacity.test.ts services/cloud-worker/acceptance.test.ts services/cloud-worker/server.test.ts services/cloud-worker/preview.test.ts src/logger.test.ts src/monitor.test.ts`。真实 Worker／CLI 预览用例仍需显式字体与 Chrome，不能用本地通过替代正式草稿验收。

每个 CLI 子进程在独立进程组中运行，步骤超时、stdout 超限或步骤结束时都会终止整个进程组，Chrome 等孙进程不会残留或占住串行队列。发布子进程已经启动后，`WX_RESULT_UNKNOWN`、publish 步骤超时、stdout 超限终止、响应缺失或 JSON 不完整都保留为 `interrupted`；完整 CLI 结果明确为失败且无未知写入时才记 `failed`。已取得成功 receipt 后的状态读取或完整性校验失败同样保留 receipt 和 `interrupted`。发布前空间、素材、模板或 hash 校验失败仍为 `failed`。Worker 不自动重排这些原 job/run，调用后端继续保留 unresolved active，核对原状态和草稿箱后再决定处置；定向回归见 `services/cloud-worker/uncertainty.test.ts` 与 `services/cloud-worker/timeout.test.ts`。

### 正文样式快照

新源码的 `/health` 包含 `capabilities.articleStyleSchemaVersions: [1, 2]`。调用方有样式时必须先确认该能力；旧 Worker 缺此字段，不能假设它会应用未知参数。无样式请求不增加字段，沿用原请求 hash 和执行方式。

业务后端通过 `@akairos/pipeline/article-style` 的 `createArticleStyleSnapshot(manifest, id, revision)` 创建快照，用 `validateArticleStyleSnapshot(value)` 复查与验证 hash。可选 `articleStyle` 仅用于 article，格式为 `{ schemaVersion: 1, id, revision, manifest, hash }`；根 id 必须等于 manifest.id。身份字段沿用 ArticleThemeSchema，revision 为正整数。manifest 只支持 `editorVars.--brand`、`exportTheme.bodyFontSize`（12–24px）、`bodyLineHeight`（1.2–2.4）、`primaryColor`、`h2Color` 与 `syntaxPresets.h2`（pillar/bottom-line/plain）。颜色仅 `#RRGGBB`，归一化小写；数值去多余零。css 缺省为空且只允许空字符串；structure、资源、字体、路径、模块及其他字段均拒绝。

Worker 严格验证后持久化 `input.articleStyle`，执行时写入 job 私有 `article-style.json` 并传给 CLI `init --article-theme`，不修改共享配置。`result.articleStyleHash` 是规范化 manifest 的 SHA-256；`result.articleThemeHash` 是现有 CLI 加入主题默认字段后的独立 hash，与实际发布结果 `article_theme_hash` 核对，两者不要求相等。这样可以从请求快照、私有文件追踪到 CLI 发布主题；未知版本、篡改或主题不匹配明确失败，不回落默认样式继续确认成功。

`createArticleStyleSnapshotV2(manifest, id, revision)` 创建外层 `schemaVersion: 2`，manifest 的主题版本仍是 `schemaVersion: 1 / engineVersion: 1`。该版本保留完整 `ArticleThemeSchema` 的 editorVars、exportTheme、syntaxPresets、structure 和显式 css；内容 hash 使用排序键的 `canonicalHash(manifest)`。只允许独立配置，拒绝 assets 目录文件和 structure.headerImage 相对路径；headerImageUrl 沿用已支持的内嵌 PNG/JPEG/GIF/WebP，限 5 MiB，并在 Worker 解码复验。变量和 CSS 复用主题安全边界，拒绝 url、@import、CSS 转义和表达式。v2 仅用于完整文章预览；v1 创建、验证、默认值与 hash 保持原样。

### 封面模板快照

Pipeline 0.21.0 使用 Typeset Studio 0.3.0 的有限控件和模板工厂。调用方先检查 `/health` 的 `capabilities.coverSnapshotSchemaVersions` 与 `articleCoverFonts: [{ id, sha256 }]`，v1 字体身份须与 Typeset `ARTICLE_COVER_FONT` 相同。当前声明 `[1, 2]`；字体缺失、hash 不符或注册失败时仅声明 `[2]`，已渲染封面不依赖 Worker 字体。提交者不能把旧 Worker 的 2xx 当作支持新字段。

公共入口 `@akairos/pipeline/cover-snapshot` 提供 `createCoverSnapshot(input)`、`validateCoverSnapshot(value)` 及 `CoverSnapshot` / `CoverSnapshotInput` 类型。创建输入：

```ts
{
  id, revision, name, controls,
  asset: { id: assetId, sha256, contentType: "image/jpeg", dataBase64 },
  font: { id: ARTICLE_COVER_FONT.id, sha256: ARTICLE_COVER_FONT.sha256 }
}
```

根 id 和素材 id 均为 UUID，revision 为正整数，name 为 1–80 字符。`controls` 由 Typeset `validateArticleCoverControls` 规范化，只允许背景色、标题色、80–200 整数字号、left/center/right 对齐及 60–200 整数安全留白。快照增加 `schemaVersion: 1`、工厂生成的完整 `config` 与 `hash`。hash 是包含模板身份、规范化控件/config、素材字节及字体身份的整个规范对象 SHA-256；素材 sha256 是实际规范化 JPEG 字节的 SHA-256，两者不同。

`asset.dataBase64` 仅接受标准 base64 的 1000×1000 JPEG，字节不超过 1 MiB，并校验尺寸、内容 hash；Worker 执行时再次实际解码。业务后端负责在上传入口解码原图、限制原图尺寸与容量，中心裁成该固定方图。快照拒绝任意 URL、路径、CSS、字体文件、模块及非工厂生成的自由配置。带封面快照的正文另限 UTF-8 2 MiB。

POST `/v1/jobs` 的可选 `coverSnapshot` 只用于 article，可与 `articleStyle` 同时使用；未选封面时完全省略字段，不注入默认快照。Worker 持久保存全部快照与 JPEG 字节，执行时在 `<job>/cover/` 写入 `snapshot.json`、`image.jpg`、`template-images.json` 及私有 `typeset/templates/<id>.json`。只有该任务 CLI 子进程收到私有 `TYPESET_DATA_DIR` 和受信字体路径。render 步骤通过 `--studio-cover-template` 与 `--template-images-file` 精确绑定模板/图片；发布前通过 `status --full` 核对冻结选择，配置渲染器必须是 Typeset Studio，不能静默回退。共享模板、账号默认配置及老请求 hash 不变。

字体固定为 `publishing-noto-cjk-regular-v1`、别名 `Publishing Cover`，SHA-256 `b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a`。Docker 固定 Debian `fonts-noto-cjk=1:20240730+repack1-1`；实际字节仍由 Typeset `server-font` 验证。该受信注册也在实际渲染插件进程首次测量前执行，不能仅在 Worker 父进程注册后假设字体跨进程继承。字体包保留原许可证，不将字体文件放入任务快照。

任务结果新增 `result.coverSnapshotHash`、`coverAssetHash`、`coverFontHash`，既有 `publishResults` 契约不变。调用方将这些值与原 job 快照比对；排队后修改共享模板、换图或改名不会改变已存任务，unknown/interrupted 继续查原 job/run/草稿箱，不换键重发。

#### 完整封面 v2

应用用完整 Typeset 模板、受管理素材和受信字体先生成最终 3350×1000 PNG（不超过 5 MiB），经 `PUT /v1/assets/:sha256` 上传原字节，再使用 `createRenderedCoverSnapshot(input)`：

```ts
{
  id, revision, name,
  sourceHash, // canonicalHash(完整 Typeset 配置)
  assetsHash, // canonicalHash(按 id 排序的源素材身份)
  fontHashes: [{ id, sha256 }],
  titleHash: hashRenderedCoverTitle(title),
  renderedAsset: { id, sha256, contentType: "image/png", byteLength, width: 3350, height: 1000 }
}
```

输出增加 `schemaVersion: 2` 与 `hash=canonicalHash(规范化内容)`，fontHashes 按 id 排序并拒绝重复。标题 hash 由公共 `hashRenderedCoverTitle(title)` 对 trim 后 UTF-8 字节计算。完整模板和源素材保存在应用侧；Worker 不接收这些文件、外部 URL、路径或脚本，也不重新排版 PNG。`coverSnapshotIdentity(snapshot)` 统一结果身份：v1 保留原字段，v2 的 coverAssetHash 为最终 PNG sha256，coverFontHash 为 canonicalHash(fontHashes)。canonicalHash 由公共 article-snapshot 入口导出。

v2 仅接受 `operation: "preview"` 的 article，ArticleSnapshot inputHash 包含整个封面快照且核对标题。Worker 在接受阶段从二进制缓存实际解码、复核身份并复制至 job 私有目录，snapshotHash 和 fileHashes 同时固定快照及 PNG。CLI 原 render action 通过受信子进程环境读取私有图片，原子写入 cover.png，并走原 render_assets、render_version 和状态写入流程；预览、确认和草稿发布复用同一 run，不另建任务或手改状态 JSON。旧无字段、v1、默认模板和直接发布路径保持原行为。

v2 端到端定向检查由主控执行：`PIPELINE_V2_PREVIEW_TEST=1 bun test services/cloud-worker/rendered-preview.test.ts`。该用例使用真实 Worker/CLI/Chrome 和可计数的微信 HTTP 替身，验证完整样式、原 PNG、零写入预览和一次确认草稿；不能当作正式微信草稿验收。

定向检查入口：`bun test src/cover-snapshot.test.ts services/cloud-worker/server.test.ts services/cloud-worker/cover.test.ts`。`cover.test.ts` 的实际私有材料与 CLI 参数案例需主控显式提供上述同 hash 字体的 `TYPESET_ARTICLE_COVER_FONT_PATH`；缺省时跳过该用例，不能声称已验证字体或实际微信发布。

维护模式下提交新任务返回 `503 worker_maintenance`，`/health` 增加 `maintenance`。该开关持久化在任务存储旁，重启后仍保持暂停，必须显式恢复。更新时暂停并等待队列清空，再备份、停止 Worker、切换配置并重建容器，验收后恢复。图片插件和 myno 都使用镜像内的 npm 入口，不要求独立 Studio 服务或管理员密钥。运行时资产可同步到 `/data/pipeline-runtime`，业务凭据仍在 `accounts.json`，详见[运行时配置指南](../../docs/visual-studio-and-config-sync.md)。

### 完整文章预览与确认（0.22.0）

完整预览沿用现 `title/body/account/articleStyle/coverSnapshot` 字段，只增加 `operation: "preview"` 和 `articleSnapshot`。公共入口 `@akairos/pipeline/article-snapshot` 的 `createArticleSnapshot({ documentId, documentRevision, title, body, account, articleStyle?, coverSnapshot?, bodyAssets })` 生成 `{ schemaVersion: 1, documentId, documentRevision, bodyAssets, inputHash }`；`validateArticleSnapshot(value, content)` 重算输入身份。缺少这些新字段的旧请求仍直接发布，不注入 operation 或改变原 requestHash。

正文素材先用 `PUT /v1/assets/:sha256` 传二进制，要求 Worker Token 和实际 Content-Type（PNG/JPEG/WebP）。单图限 5 MiB/3200 万像素，每篇可见图片节点最多 20 个，去重正文资源总 40 MiB，封面方图另计。Worker 实际解码并核 SHA-256，重复上传同字节幂等；任务 `bodyAssets` 仅含 `{ id, sha256, contentType, byteLength, width, height }`，不接调用方路径或 URL。正文图片必须是 `asset:<UUID>`，引用式图片可定点转换，代码和普通链接不改；未托管及 raw HTML 图片明确拒绝。产品上传、旧图主动导入与所有权仍属于调用后端。

Worker 接受任务、入队前解析并固化有效默认或已选配置，复制正文图片、默认资源、私有模板和固定封面字体，生成 `snapshotHash`。系统默认模板的远程资源仅允许部署显式 `PIPELINE_DEFAULT_ASSET_ORIGIN`（HTTPS origin）与 `PIPELINE_DEFAULT_ASSET_PATH_PREFIX` 前缀，拒绝重定向；该规则不用于任意正文 URL 下载。Typeset 默认字体映射为已验证 `Publishing Cover` 字节，并记录 requested/resolved 身份；未知自定义字体拒绝。正文 HTML 保留有效 CSS 字体栈，不宣称已固定客户端字体字节。

`/health.capabilities` 增加 `articleSnapshotSchemaVersions: [1]`、`previewConfirm: true`、`previewDiscard: true`、`bodyAssetUpload: true`。调用方还需核固定封面字体能力。完整快照要求包内 myno 与 Typeset Studio 适配器；Worker 固定任务私有 config/env，不在确认时读取实时默认。

预览任务由真实 CLI 的 `status → next_action` 推进到 publish 检查点，再运行只做本地导出的 `article-export`，保存最终 HTML、封面 PNG、正文素材及产物 manifest，停在 `status/step=preview_ready`。预览不会调用微信 token、素材上传或草稿写接口；额外 provider guard 拒绝未确认预览执行 publish。`preview_ready` 重启后保持待确认，不自动入队。

未确认的预览可以由调用后端 `POST /v1/jobs/:id/discard` 放弃，或在开启 `PIPELINE_WORKER_PREVIEW_TTL_HOURS` 后自动过期，二者都记为 `failed`（`error` 分别为 `preview_discarded` / `preview_expired`），沿用调用后端已有的失败语义释放额度；任务身份、幂等键与产物保留，此后确认返回 `409 preview_not_ready`。确认在等待空间预留期间如遇预览被放弃或过期，同样返回 `409`，不会把已关闭的预览重新入队。调用前先检查 `/health.capabilities.previewDiscard`。

结果含 `inputHash`、`snapshotHash`、`artifactManifestHash`、`artifactManifest`。manifest 是 `{ schemaVersion: 1, snapshotHash, runtime: { pipeline, myno, typeset }, artifacts: [{ key, kind, contentType, byteLength, sha256 }] }`；固定 key 为 `article`、`cover`、`media_<UUID>`。公共 `createArtifactManifest`、`hashArtifactManifest`、`validateArtifactManifest` 供调用后端复用，避免另建格式。

`GET /v1/jobs/:id/artifacts/:key` 只读取该任务 manifest 的固定 key，要求 Worker Token，校对 job 保存的 manifest/snapshot 身份与实际文件 hash；不接受文件路径。业务后端检查 owner/job 归属后代理字节，前端以无脚本 sandbox 展示，将 HTML 中 `asset:<UUID>` 的实际 img 属性映射为受控素材，不注入主页面 DOM。

`POST /v1/jobs/:id/publish` 只接 `{ snapshotHash, artifactManifestHash }`。首次确认核对双 hash 和材料完整性，持久化 `publicationRequested` 后继续同 job/run；重复确认返回原身份，不修改原输入 hash，不重新 init/导出/渲染。维护模式拒绝首次确认。业务后端必须在自己的事务中锁定文档与任务，核对当前 documentRevision 后接受确认；接受后再编辑文章不撤销已经接受的任务，同 hash 重试仍查原结果。

发布使用冻结 HTML/PNG/素材，再交现有微信上传和 URL 替换。微信回读 URL 和 HTML 清洗单独验证，不要求回读字节与预览 HTML 相同。所有私有材料、`prepared.json`、产物和确认意图都需随 Worker 卷备份恢复；interrupted/unknown 仍先检查原 run/草稿箱，不换键或新 run 盲重试。

定向测试由主控执行：`bun test src/article-snapshot.test.ts services/cloud-worker/preview.test.ts`。实际 Worker/CLI 集成用例需显式固定 `TYPESET_ARTICLE_COVER_FONT_PATH` 和 Chrome，微信边界用可计数 HTTP 替身验证预览零写；它不等同于正式真实草稿验收。

### 1. 同步账号

准备受控的 `account.json`（不要提交到 Git）：

```json
{
  "appId": "YOUR_WECHAT_APP_ID",
  "appSecret": "YOUR_WECHAT_APP_SECRET",
  "pat": "YOUR_RELAY_API_PAT"
}
```

```bash
curl -X PUT http://127.0.0.1:18887/v1/accounts/my-account \
  -H "Authorization: Bearer ${PIPELINE_WORKER_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary @account.json
```

账号键只允许字母、数字、`_`、`.`、`-`，注册时长度为 1–80。三个凭据必填；可选 `account` 字段必须与路径一致。凭据以文件权限 `0600` 写入 `accounts.json`，并非加密保管库，数据卷与备份需要限制访问。任务响应不包含这些凭据。

### 2. 提交完整正文

`job.json`：

```json
{
  "idempotencyKey": "user-123:article-456:revision-1",
  "title": "Pipeline 云端草稿示例",
  "body": "# Pipeline 云端草稿示例\n\n这是一篇已确认的 Markdown 正文。",
  "contentForm": "article",
  "account": "my-account"
}
```

```bash
curl -X POST http://127.0.0.1:18887/v1/jobs \
  -H "Authorization: Bearer ${PIPELINE_WORKER_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary @job.json
```

| 字段 | 约束 |
| --- | --- |
| `idempotencyKey` | 必填，最多 200 字符；后端应绑定用户、内容和修订版本 |
| `title` | 必填，最多 255 字符 |
| `body` | 必填，完整 Markdown；代码按 JS 字符串长度限制为 2,000,000 |
| `contentForm` | 必填，`article` 或 `newspic` |
| `account` | 必填，已经通过账号接口注册的键 |
| `intentText` | 可选，发布意图；默认使用标题 |
| `existingDraftMediaId` | 可选，更新已有草稿；必须属于目标公众号 |

Worker 不提供客户端本地文件传输。正文内的图片必须在 Worker 环境中可读取，例如可访问的 HTTP(S) 图片或在请求大小范围内的 Base64 图片；客户端本机路径不会自动上传。正文与封面可通过上述受限快照显式选择；未传快照时默认样式由服务端配置提供。

Worker 将正文视为调用方已确认的内容，遇到 `review-content` 会执行 `review --status passed`，这不代表进行过模型或人工审核。需要补图、修订或其他未支持动作时，会返回失败而不会调用外部 Agent。

### 3. 查询步骤与结果

把 `JOB_ID` 替换为提交响应里的 `id`：

```bash
curl http://127.0.0.1:18887/v1/jobs/JOB_ID \
  -H "Authorization: Bearer ${PIPELINE_WORKER_TOKEN}"
```

主要字段：

- `id`、`status`、`step`、`createdAt`、`updatedAt`、`startedAt`、`finishedAt`：队列身份、阶段和时间。
- `input`：提交元数据，不含 `body`；`requestHash` 用于幂等冲突校验。
- `runId`、`statePath`：原 Pipeline run 及服务端状态路径。
- `result.publishResults`：发布结果，成功目标含 `external_id`（微信草稿 `media_id`）。
- `error`：失败或中断说明；发布失败时 `result` 也可能保留已有业务结果。
- `progress`：运行中的当前 CLI 动作若已记录进度，附带 `stage`、可选 `message/current/total/unit`；轮询获取，不是 SSE，也不保证每个动作都有进度。

调用后端保存账号时可使用 `PUT /v1/accounts/:account` 同步公众号凭据；Nezus 已采用此路径。凭据只写入 Worker 的持久卷 `accounts.json`，不进入任务请求或任务状态响应。删除账号使用 `DELETE /v1/accounts/:account`。

`job.json` 至少包含 `idempotencyKey`、`title`、`body`、`contentForm`（`article` 或 `newspic`）和 `account`。用 `GET /v1/jobs/:id` 轮询状态；`succeeded` 表示 Pipeline 已完成目标发布，`failed` 的原因在 `error`。同一个 `idempotencyKey` 会返回原任务，不会重复入队。

生产环境至少配置 `PIPELINE_WORKER_TOKEN`、`PIPELINE_WORKSPACE_ROOT`、`PIPELINE_WORKER_STATE_FILE` 和挂载的 `PIPELINE_CONFIG_FILE`。基础配置保存排版与默认值；Nezus 同步的账号凭据保存到 worker 数据卷的 `accounts.json`。

状态为 `queued → running → succeeded / failed`；服务重启时发现原来在运行的任务，会标记 `interrupted`。成功要求 Pipeline 已完成，并有该账号成功的草稿 `media_id`，不代表文章已经公开发布。

`step` 可能为 `queued`、`starting`、`attach-body`、`prepare`、`review-content`、`prepare-finalize`、`render`、`publish`、`done`。Worker 为每个任务隔离 CLI 事件记录，只投影当前动作的可用进度，不返回原始日志或提供云端 SSE。[本机 Monitor](../../docs/monitor.md) 的 HTTP/SSE 是另一套接口。

查询响应包含服务端路径等内部信息。业务后端应生成面向用户的响应，保留自己的账号绑定和 job 归属，不直接公开 Worker 原始接口。

## 幂等、恢复与更新

相同 `idempotencyKey` 且输入一致时，返回已存任务，包含已经失败或中断的任务；不会重新入队。输入变化必须使用新的键。键在整个 Worker 内共享，由业务后端隔离不同用户。

`jobs.json` 持久化任务和正文，每个工作区位于 `<PIPELINE_WORKSPACE_ROOT>/jobs/<job-id>/`。重启后 `queued` 任务继续执行，`running` 任务标记为 `interrupted`，不自动重发。没有任务历史自动清理或多副本锁；只运行一个 Worker 进程管理该数据目录。

出现 `WX_RESULT_UNKNOWN`、超时或 `interrupted` 时，先检查原 Pipeline run 和微信草稿箱。确认已创建草稿后，后续修订可通过 `existingDraftMediaId` 更新；确认需要新任务后再分配新的幂等键。不要通过更换键来盲目重试，否则可能重复建草稿。

更新流程：

1. 暂停业务后端提交，等待队列清空且 `/health` 的 `running` 为 `false`。健康状态不证明公众号凭据可用。
2. 备份配置、`jobs.json`、`accounts.json` 和工作目录；检出指定 tag/commit，使用该 revision 作为镜像标签构建新镜像。
3. 用新镜像重建容器，沿用相同令牌、挂载路径与网络。停止容器不会删除绑定挂载数据；不要删数据目录。
4. 检查认证后的 `/health`、旧任务可查询，再提交一篇草稿验收，核对最终 `media_id` 与草稿箱。

Worker 镜像可以独立于前端更新；账号同步等 API 变更仍需与业务后端协调。此实现是单进程 JSON 队列，不具备多副本调度或自动故障重试能力。

边界测试：`bun test services/cloud-worker/server.test.ts`（临时目录内验证鉴权、账号接口和监听限制，不等同于真实微信发布验收）。

### 贴图发送副本

`contentForm=newspic` 可传 `newspic: { content, photos }`：`content` 是用户确认的纯文本，`photos` 为 0–20 个 HTTP(S) 图片地址。未上传图片（空数组或未传副本）时，Worker 通过原状态机生成封面和分页内容图；最多 19 张内容图，另加 1 张封面。上传图片时直接使用这些图片，顺序即草稿配图顺序，首图作为封面，跳过自动生成。副本通过 `init --newspic-file` 传递，正文原样发送，不修改来源笔记。
