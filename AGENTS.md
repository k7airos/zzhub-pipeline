# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# AGENTS.md — zzhub-pipeline

Content-publishing state machine for agents and application backends: WeChat article/newspic drafts, blog sync, local monitoring, and a private cloud worker.

WeChat `publish` creates or updates drafts; it does not send or publicly publish them. The blog route runs the configured publish command. See [README.md](README.md) for external API dependencies and source/release differences.

## Runtime & toolchain

- Runtime: Bun, not Node. All commands use `bun run src/cli.ts`.
- TypeScript: strict mode, `noUnusedLocals`, `noUnusedParameters`, so the compiler rejects unused variables.
- Module resolution: `"bundler"`, use ESM imports only, no CommonJS.
- Test runner: `bun test`, not Jest or Vitest. Main test file: `src/workflow.test.ts`.
- Typecheck: `bun x tsc --noEmit`, separate from tests.

## Key commands

```bash
# Run any CLI command directly from source (always up-to-date, no rebuild needed)
bun run src/cli.ts <command> [options]
# Global commands run the installed package (refresh with bun install --global .)
zzhub-pipeline <command> [options]
zzp <command> [options]

# Run all tests
bun test

# Run a specific test file
bun test src/workflow.test.ts

# Typecheck without building
bun x tsc --noEmit

# Build WeChat preview bundle, separate Vite config
bun run build:wechat-preview

# Release versioning
bun run release:patch   # bug fix, 0.1.2 → 0.1.3
bun run release:major   # new feature (0.x: 0.1.2 → 0.2.0 / 1.x+: breaking 1.2.3 → 2.0.0)
bun run release:minor   # new feature (1.x+ only: 1.2.3 → 1.3.0)

# Publish to npm
npm publish
```

**Important:** `bun run src/cli.ts` runs the current checkout. The current npm `bin` entries point to `src/cli.ts` with a Bun shebang. Global `zzp` / `zzhub-pipeline` use the installed package, not necessarily this checkout. `bun run build:npm` separately produces `dist/cli.js`; global installation does not select or build that bundle.

> **强制性规则：任何代码修改完成后，必须立即执行 `bun install --global .`**
>
> 这是不可跳过的硬性步骤。全局 `zzp` 使用已安装包内的源码与浏览器资源；不执行 `bun install --global .` 可能继续使用旧副本。浏览器渲染源码或共享 CSS 变化时，先执行 `bun run build:wechat-preview`。即使是改一行代码、加一个字段、修一个 typo 也必须执行全局安装。编辑 .md 文档文件除外。

## Agent workflow loop

The only correct agent procedure is:

1. Find the active task:
   `bun run src/cli.ts find-run --workspace {ws} --active --view agent`
   Or list all active tasks:
   `bun run src/cli.ts tasks --workspace {ws} --active --view agent`
2. If no task exists, create one with `init`.
3. Check current state:
   `bun run src/cli.ts status --state {state_path} --view agent`
4. Read `next_action` from the output.
5. Execute only the action identified by `next_action.action`.
6. Re-run `status` to confirm progress.
7. Repeat until `mode` is `done`.

Do not:

- Scan session history to guess the current task.
- Modify `workflow-state.json` directly.
- Skip `status` or `reconcile` and assume the next step.
- Execute multiple steps without checking status between them.

`--view agent` output includes:

- `next_action.action`, the next step/action identifier.
- `next_action.reason`, why this action is needed.
- `next_action.params`, which may include `state_path`, `spawn`, `requires_research`, `source_body_path`, and `feedback`.
- `gaps`, missing materials.
- `blockers`, blocking issues.

Use `--view agent` for `find-run`, `tasks`, and `status` whenever an agent needs the next step.

### next_action decision tree

`buildTaskStatus()` in `src/task-manager.ts` determines the next action by priority, each branch mutually exclusive:

1. `mode=done` or `phase=done` → **complete**
2. `mode=failed` → **reset-or-repair** (checkpoint diagnose → reset)
3. `mode=handoff` + body_inputs pending → **attach-body-images**
4. `mode=handoff` + no body_inputs → **resolve-handoff**
5. Body not mounted (no `source_body_path` or `asset_path`) → **attach-body**
6. body_inputs pending → **attach-body-images**
7. Metadata incomplete (title, slug, date) → **prepare**
8. `content_review=needs_revision` → **revise-content**
9. `content_review=unchecked` → **review-content**
10. `content_review=passed` + no `asset_path` → **prepare-finalize**
11. `asset_path` exists + render needs progress → **render**
12. `asset_path` exists + publish needs progress → **publish**
13. Fallback → **prepare** (re-prepare if nothing else matches)

Key invariants:
- C7 (content_review) only triggers when `asset_path` does not yet exist.
- C9/C10 enter only after `asset_path` is guaranteed (written by `prepare-finalize`).
- `attach-newspic-spec` is not in the decision tree — it's an optional command the agent may call before render.
- `reconcile` is not in the decision tree — it's a manual maintenance command.

### Task entry points: init and ingest-handoff

Tasks are created two ways:

**`init`** — Agent directly initializes a new task:
```bash
bun run src/cli.ts init \
  --workspace {workspace} \
  --task-kind publish \
  --content-form article \
  --content-origin user \
  --targets wechat \
  --intent-text "发公众号文章给大号"
```

Optional init flags:
- `--existing-draft-media-id MEDIA_ID` — update an existing WeChat draft instead of creating a new one
- `--note-id NOTE_ID` — link to a Nezus note for publish result callback

**`ingest-handoff`** — External system hands off a JSON file:
```bash
bun run src/cli.ts ingest-handoff --file handoff.json
```

Two handoff JSON formats are supported:

```jsonc
// workflow_handoff — create new task
{
  "workflow_handoff": {
    "mode": "new",
    "content_form": "article",
    "body_path": "/abs/path/body.md",
    "target_account": "default",
    "title": "文章标题"
  }
}

// workflow_handoff — resume existing task
{
  "workflow_handoff": {
    "mode": "resume",
    "state_path": "/abs/path/workflow-state.json",
    "body_path": "/abs/path/revised-body.md",
    "review_policy": "trust_user"
  }
}

// publish_handoff — simplified format (always creates new)
{
  "publish_handoff": {
    "content_form": "article",
    "body_path": "/abs/path/body.md",
    "target_account": "default",
    "title": "文章标题"
  }
}
```

Resume mode compares core inputs (body, title, route, intent_text, explicit_constraints). If changed, `resetDerivedState()` resets all phases to pending while preserving `run_id` and `workspace_root`. If only `review_policy` changed to `trust_user` and a `handoff.body_path` exists, content_review is auto-set to `passed`.

## State machine rules

- Prefer `updateState(path, mutate)` for new work. Some existing commands still use `readState` and `writeState` directly.
- Never write `workflow-state.json` by hand.
- `content_review.status` must be `"passed"` before `render` or `publish` can proceed.
- `redo_hint` is set by `reset --mode redo.*` and cleared by `prepare-finalize`, so leave it alone.
- Body text is never stored in workflow state. It lives in `{workspace}/.zzhub-media/tmp/{run_id}/` during preparation and in `asset_path/post.md` after finalization. Worker job storage separately persists the submitted body.
- `republish` adds to `publish_targets` and `publish.results`, but does not change `mode`.

## State file lifecycle

```
Temporary (prepare phase)              Canonical (after prepare-finalize)
{workspace}/.zzhub-media/              {workspace}/posts/{date-slug}/
  runs/{run_id}.json ←─────────────────── workflow-state.json
  tmp/{run_id}/source-body.md   ───────→ post.md
                                         images/wechat/   ← article render images
                                         images/newspic/  ← newspic render images
```

`prepare-finalize` solidifies temporary state into the canonical directory. After that, all commands auto-resolve `posts/{date-slug}/workflow-state.json` as the authoritative source.

## Workflow routes and targets

Three active workflow routes exist:

- `wechat-article`, WeChat public account article, HTML export.
- `wechat-newspic`, WeChat image-message draft, single or multi-page PNG set.
- `blog`, Markdown sync to the configured blog project and publish command.

`blog` participates in the normal `prepare → publish` workflow and skips render when it is the only target. The legacy `sync-blog` command remains available for post-hoc sync; both paths write results to `publish.results` in state JSON.

## Three-phase pipeline

The active pipeline is: `prepare → render → publish → done` (or `failed`). Routes that do not require render, such as blog-only publishing, go directly from prepare to publish.

### prepare sub-steps (executed sequentially inside `prepare` command)

1. `channel-route` — resolve route and target account
2. `author-select` — determine rewrite permission and style mode
3. `format` — text formatting rules
4. `asset-meta` — extract title/date/summary
5. `body-inputs` — scan body for illustration markers
6. `highlight-words` — extract cover highlight words from title (in `prepare-finalize`)
7. `asset-save` — write final files to `posts/` directory (in `prepare-finalize`)

> `style` polishing is NOT inside `prepare` — it requires an external agent/LLM. This is distinct from the cloud worker, which only runs supported CLI actions on submitted content.

### render sub-steps

1. `image-plan` — template selection (wechat-cover-split / poster-3-4 / longform-3-4)
2. `body-inputs` — collect illustration images (may pause in longform mode for user input)
3. `adapter-render` — call image render plugin
4. Record `render_assets`, increment `render_version`

### publish sub-steps

1. Collect publish routes (primary + extras)
2. Idempotency check (skip if content_version + render_version match)
3. `provider.publish()` — WeChat / COS / blog
4. Record publish results, set mode=done if all succeed

## Output and view modes

- Default output is raw JSON, which works well for agents, pipes, and redirects.
- `--view markdown` renders a structured markdown table.
- `--view agent` renders agent-optimized markdown with an explicit `next_action.params` block.
- Agents should use `--view agent` for `find-run`, `tasks`, and `status`.
- TTY output is pretty-printed when stdout is a terminal, raw JSON otherwise.
- `NO_COLOR=1` forces raw JSON.
- `FORCE_COLOR=1` forces pretty output.

## Directory layout

```text
src/
  cli.ts               # Entrypoint, dispatches to command registry
  plugins.ts           # Command registry, workflow and ops plugin groups
  state.ts             # WorkflowState type + CRUD, authoritative contract
  schema/
    state.ts           # Zod schemas for state validation and defaults
    config.ts          # Zod schema for PipelineConfig
  task-manager.ts      # listTasks / findTask / getTaskByStatePath / buildTaskStatus
  task-views.ts        # markdown and agent view renderers
  workflow-materials.ts# body path resolution, body-input reconciliation
  routes.ts            # deterministic routing, keyword match + account resolution
  profiles.ts          # authoring rules, rewrite_allowed, style_mode decision tree
  text.ts              # text formatting, frontmatter, markdown normalization
  output.ts            # TTY-aware output layer, printResult and pretty renderers
  config.ts            # config loading, env overrides, workspace path resolution
  args.ts              # argument parsing
  spawn.ts             # subprocess wrapper, PATH enhancement
  adapter-types.ts     # ImageRenderPlugin / MarkdownRenderPlugin interfaces
  adapter-loader.ts    # resolveImageRenderer / resolveMarkdownRenderer / runPluginDoctorChecks
  runtime-paths.ts     # asset path resolution (dev/compiled modes), font cache
  adapters/            # built-in adapter implementations
  commands/            # one file per CLI command
  imgx/                # image rendering subsystem, Chrome headless + @napi-rs/canvas
  providers/           # publish providers, wechat, cos, blog
  monitor/             # execution records, HTTP snapshots, SSE
  wechat-preview/      # WeChat article HTML preview, Milkdown + themes
services/
  cloud-worker/        # private HTTP execution service and Dockerfile
```

## Commands

### workflow group (17 commands)

| Command | Description |
|---|---|
| `init` | Create run state from intent classification |
| `ingest-handoff` | Create or resume task from handoff JSON |
| `attach-body` | Attach source body file to task |
| `attach-body-images` | Attach body image markers to task |
| `attach-newspic-spec` | Attach or update newspic render intent |
| `prepare` | Route + author + format + metadata |
| `prepare-finalize` | Highlight words + asset save |
| `render` | Image plan + imgx render |
| `publish` | Execute publish routes |
| `reconcile` | Reconcile task materials and derived state |
| `checkpoint` | Read task state and validate current phase |
| `status` | Read task with gaps and next action |
| `find-run` | Find the best matching task |
| `tasks` | List tasks in workspace |
| `reset` | Reset phases for revision |
| `review` | Update content review status |
| `abandon` | Mark tasks as abandoned |

### ops group (current source)

| Command | Description |
|---|---|
| `monitor` | Start, inspect, or stop local HTTP/SSE monitoring |
| `sync-blog` | Copy post.md to blog repo, publish, and record result in state JSON |
| `republish` | Publish completed task to additional accounts/platforms |
| `imgx` | Run bundled imgx renderer subcommands |
| `article-theme` | Validate or install a local article theme package |
| `wechat-export` | Render markdown to WeChat HTML |
| `wechat-preview` | Run the local WeChat HTML preview server |
| `cos-upload` | Upload image to COS CDN |
| `config` | Read or update pipeline config |
| `doctor` | Inspect resolved paths and provider health |
| `hermes-metrics` | Show Hermes execution metrics per task |
| `wx-drafts` | List or get drafts from WeChat draft box |
| `wx-draft-delete` | Delete a draft from WeChat draft box |

### Reset modes

```bash
bun run src/cli.ts reset --state {state_path} --mode content        # full re-prepare
bun run src/cli.ts reset --state {state_path} --mode redo.style     # redo style polish only
bun run src/cli.ts reset --state {state_path} --mode redo.format    # redo formatting only
bun run src/cli.ts reset --state {state_path} --mode redo.metadata  # redo metadata only
bun run src/cli.ts reset --state {state_path} --mode redo.route     # redo route parsing only
bun run src/cli.ts reset --state {state_path} --mode render         # redo render
bun run src/cli.ts reset --state {state_path} --mode publish        # redo publish
bun run src/cli.ts reset --state {state_path} --mode full           # abandon task (mode=failed)
```

Each mode sets `redo_hint` so the agent knows which sub-step to resume from.

## Config

Config file location on macOS: `~/Library/Application Support/zzhub-pipeline/config.json`

Override with `ZZHUB_PIPELINE_CONFIG=/abs/path/config.json`

Other env overrides: `ZZHUB_PIPELINE_WORKSPACE_ROOT`, `ZZHUB_PIPELINE_POSTS_DIR`, `ZZHUB_PIPELINE_BLOG_ROOT`.

Tests isolate config with `process.env.ZZHUB_PIPELINE_CONFIG = <tmp path>`.

Config structure: `paths`, `services`, `commands`, `wx.accounts`, `cos`, `plugins`, `imgx`, `render`.

### 核心必要配置清单 (Minimal Required Config)

新环境接入或部署时，需具备的基础依赖与配置项：

1. **环境依赖**：
   - **Bun** (>= 1.1)
   - **Chrome / Chromium**（图片与公众号排版渲染依赖 headless Chrome）
   - **中文字体**（排版渲染依赖内置 CJK 字体）

2. **本地开发必要配置 (`config.json`)**：
   ```json
   {
     "wx": {
       "baseUrl": "https://wx-relay.example.com",
       "accounts": {
         "default": {
           "pat": "RELAY_API_TOKEN",
           "appId": "wx_your_app_id",
           "appSecret": "your_app_secret"
         }
       }
     }
   }
   ```
   - `wx.baseUrl`：兼容 `/api/v1/wx/*` 契约的微信中转代理服务地址。
   - `pat`：中转服务的鉴权令牌。
   - `appId` & `appSecret`：微信公众号开发者凭据。

3. **Cloud Worker 生产服务必要配置**：
   - 环境变量 `PIPELINE_WORKER_TOKEN`：服务鉴权 Token。
   - 宿主机配置挂载：通过 `PIPELINE_CONFIG_FILE` 指定基础配置文件，数据卷挂载至 `/data`。

WeChat publishing requires a compatible `/api/v1/wx/*` relay at `wx.baseUrl` (or `ZZHUB_WX_BASE_URL`), plus account `appId`, `appSecret`, and relay `pat`. COS requires the `/api/v1/upload/cos` STS contract. Neither backend is bundled here; do not document the CLI as a direct client for `api.weixin.qq.com`.

## Cloud worker and monitoring

- `services/cloud-worker/server.ts` is a separate Bun process, not a `zzp serve` command. Deploy from the source repository; npm currently packages `src/`, not `services/`.
- All worker endpoints, including `/health`, require the deployment-injected `PIPELINE_WORKER_TOKEN`. User authentication, ownership, and quotas belong in the calling backend.
- Current source registers credentials through `PUT /v1/accounts/:account` and stores them in `accounts.json`. This API is newer than the basic worker in v0.14.0.
- Jobs support `article` / `newspic`, run serially, and expose `status`, `step`, and results by polling. Submitted content is treated as approved; unsupported handoff/revision actions fail without an LLM call.
- The worker records CLI Monitor events in an isolated directory per job and exposes optional current-action `progress` by polling. Do not promise cloud SSE, raw logs, or progress for every action. Local `zzp monitor` separately provides read-only HTTP/SSE observation.
- On restart, queued jobs resume and running jobs become `interrupted`. Inspect the original run and draft box before retrying; changing an idempotency key may create a duplicate draft.

Current contracts: [worker](services/cloud-worker/README.md), [monitor](docs/monitor.md), and [README](README.md). The old serve draft is not a current public API.

## Chrome dependency

Rendering requires headless Chrome. `findChrome()` in `src/imgx/runtime.ts` probes these paths in order:

1. `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
2. `/Applications/Chromium.app/Contents/MacOS/Chromium`
3. `google-chrome` from PATH
4. `chromium` from PATH

The built-in image renderer and built-in/myno HTML export require Chrome. The Typeset Studio image renderer uses native Canvas without Chrome. Setting `PIPELINE_ARTICLE_EXPORT_ENGINE=dom` runs the same HTML export bundle in a happy-dom subprocess (`src/wechat-preview/dom-export*.ts`) instead of Chrome; `src/wechat-preview/dom-export.equivalence.test.ts` requires both engines to produce the same canonical DOM. Renderer code must use simple selectors and must not rely on browser-only CSSOM normalization. The built-in markdown renderer and Pipeline's browser-plugin host check Chrome through `doctor()`.

Viewport inset quirk: Chrome CLI `--window-size=900,1200` does not guarantee `innerHeight=1200`. The runtime measures the real inset, over-captures, then crops. If a footer looks clipped, check this layer first, not the template CSS.

## Plugin system

Rendering is pluggable via `config.plugins`. Image and Markdown renderers use these interfaces:

- `ImageRenderPlugin` — replaces imgx for image rendering (poster, longform, cover)
- `MarkdownRenderPlugin` — provides `render()` for WeChat HTML export
- `BrowserMarkdownRenderPlugin` — provides `browser()` assets; Pipeline owns Chrome execution and output handling. Optional `studio()` supplies static Studio assets.

Config override (local file path or npm package):

```json
{
  "plugins": {
    "imageRenderer": "./my-image-renderer.js",
    "markdownRenderer": "./my-md-renderer.js"
  }
}
```

Both renderer entries also accept `{ "module": "package-or-path", "options": {} }`.
The pipeline passes each renderer's own options to `doctor(options)` and
`render(input, options)`; the plugin defines and validates its options.
String entries remain supported, and `null` selects the built-in renderer.
Pipeline 0.19.1 requires `@akairos/myno@0.3.1` for shared CSS; enable
`plugins.markdownRenderer.module="@akairos/myno/adapter"` with empty options.
The browser entry and Studio assets stay in the myno package, without a
browser automation dependency or separate service authentication.
Typeset Studio stores its shared directory in
`plugins.imageRenderer.options.dataDir`; pipeline bridges this to
`TYPESET_DATA_DIR` for the current npm adapter and uses local method calls
without service authentication.

When unset, built-in adapters (`builtin-imgx`, `builtin-wechat-preview`) are used.

Key files:
- `src/adapter-types.ts` — interfaces (`ImageRenderPlugin`, `MarkdownRenderPlugin`, `PipelinePluginDoctorCheck`)
- `src/adapter-loader.ts` — `resolveImageRenderer()`, `resolveMarkdownRenderer()`, `runPluginDoctorChecks()`
- `src/adapters/builtin-image-renderer.ts` — wraps imgx
- `src/adapters/builtin-markdown-renderer.ts` — wraps wechat-preview

Runtime dependency checks:
- `@napi-rs/canvas` — checked by image renderer `doctor()`, lazy-loaded in `pretext-runtime.ts`
- Chrome — checked by markdown renderer `doctor()`, error includes install guidance
- CJK fonts — bundled locally and checked by `ensureFonts()` in `runtime-paths.ts`; rendering never downloads fonts. Cover themes also accept local system font names.

## newspic longform pagination

Two pagination modes coexist:

- Auto-flow, the default, fills pages in order.
- Spec-driven, enabled when `page_specs` is present in `newspic_render`, follows the spec.

`pagination_mode` values: `single` (poster-3-4 card) or `multi` (longform-3-4 album).

To pin text to a page, add explicit markers in the body and provide `page_specs`:

```text
【第一页】
...
【第二页】
...
```

`【Page 1】` is also accepted. Without `page_specs`, these markers are ignored.

`target_fill_ratio` is clamped to `0.35` to `0.95`, with `0.8` as the default. Page-level spec takes priority over the top-level value.

## imgx rendering subsystem

- Based on Chrome headless and `@napi-rs/canvas`
- Templates: `longform-3-4` (newspic longform), `poster-3-4` (single-page card), `wechat-cover-split` (article cover)
- Themes: `paper-sage` (default account), `linen-news` (`ancientone` account)
- Geometry auto-derived from header, footer, padding; can be overridden via CLI flags
- Pagination done in-process via `@chenglou/pretext`, no Chrome dump needed
- Built-in `render` and built-in/myno `wechat-export` require Chrome; a Typeset Studio image-only render does not

## wechat-preview subsystem

- Milkdown-based markdown to WeChat HTML conversion
- Multi-theme support
- Build command: `bun run build:wechat-preview`
- `wechat-export` uses this preview style directly
- Local preview server: `wechat-preview serve` (default `http://127.0.0.1:18765`)
- `wechat-export` registers success/failure entries on the server by default (`--no-preview` to skip)
- Bundle dirty detection: source newer than dist → auto rebuild; rebuild failure falls back to existing dist with `bundle_stale`

### Shared article styles

Typography and syntax plugins are modularized under `@akairos`:
- **`@akairos/myno/article.css`** and **`@akairos/myno/tokens-default.css`**: Canonical typography, maintained in myno `src/styles/`.
- **`@akairos/milkdown-article-plugins`** on npm: Callouts, Badges, Kbd, and Article Cards Remark/Milkdown plugins.
- **`@akairos/typeset-studio`** on npm: Header and banner image composition.
- **`@akairos/myno`** on npm: Editor, standalone typography Studio, and optional browser rendering resources.

Edit CSS only in myno `src/styles/`; do not fork rules into this repo.

```json
{
  "@akairos/myno": "0.3.1",
  "@akairos/milkdown-article-plugins": "^0.1.6"
}
```

### Style modification requires rebuild

The export entry imports `@akairos/myno/article.css` and
**bundles it into** `browser-dist/editor-export.js` at build time. The runtime
`wechat-export` command loads the built bundle, not the package CSS file.

**Editing the package CSS has no effect on export until you rebuild
(or until auto dirty rebuild succeeds):**

```bash
bun run build:wechat-preview
```

This also applies when `ensureBundle()` auto-builds on first export (if `manifest.json` is missing) or when sources are newer than dist. Prefer explicit rebuild after CSS changes. When myno is configured, rebuild/update the myno package instead; rebuilding Pipeline's built-in bundle does not update plugin resources.

## Publish providers

| Provider | Route | Description |
|---|---|---|
| wechat | `wechat-article` | Create WeChat article draft |
| wechat | `wechat-newspic` | Create or update WeChat image-message draft |
| cos | - | Tencent Cloud COS image CDN |
| blog | - | Markdown sync to blog repo |

## npm release workflow

Package name: `@akairos/pipeline`, `publishConfig.access` is `public`.

`files` includes the source tree: `src/`.
CLI entry: `src/cli.ts` (runs directly via Bun shebang).
Assets are resolved from the source tree at runtime via `runtime-paths.ts`.

### Version number rules

changelogen bumps differently for 0.x vs 1.x+:

| Scenario | Current | Command | Result |
|---|---|---|---|
| Bug fix | any | `release:patch` | 0.1.2 → 0.1.3 / 1.2.3 → 1.2.4 |
| New feature (0.x) | 0.1.2 | `release:major` | 0.1.2 → 0.2.0 |
| New feature (1.x+) | 1.2.3 | `release:minor` | 1.2.3 → 1.3.0 |
| Breaking (1.x+) | 1.2.3 | `release:major` | 1.2.3 → 2.0.0 |

At 0.x, `release:major` bumps the middle digit (minor), `release:minor` behaves like patch. After 1.x, standard semver applies.

## Adding a new command

1. Create `src/commands/<name>.ts` exporting `async function <camelName>(args: string[]): Promise<void>`.
2. Register it in `src/plugins.ts` under the correct plugin group.
3. The CLI auto-discovers registered commands, so no other wiring is needed.

Key patterns:

- Parse args with `parseArgs` from `src/args.ts`.
- Output with `printResult(data, renderer)` from `src/output.ts`, never raw `console.log`.
- Prefer `updateState(path, mutate)` from `src/state.ts` for new stateful work; existing commands may still use `readState` and `writeState` directly.
- Load config through `loadConfig()` from `src/config.ts`.

## Code reading order

For understanding the codebase, read in this order:

1. `src/cli.ts` — entrypoint and command dispatch
2. `src/plugins.ts` — command registry
3. `src/state.ts` — WorkflowState type and CRUD operations
4. `src/task-manager.ts` — task listing, finding, status reporting
5. `src/routes.ts` — deterministic routing
6. `src/profiles.ts` — authoring rules and style mode decision
7. `src/workflow-materials.ts` — body path resolution, material reconciliation
8. `src/commands/prepare.ts` — prepare command implementation
9. `src/commands/prepare-finalize.ts` — finalize implementation
10. `src/commands/render.ts` — render command implementation
11. `src/commands/publish.ts` — publish command implementation
