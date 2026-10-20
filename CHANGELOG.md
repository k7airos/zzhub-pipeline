# Changelog

## v0.24.0

### Features

- Add an optional happy-dom article export engine (`PIPELINE_ARTICLE_EXPORT_ENGINE=dom`) that runs the same browser export bundle in an isolated Bun subprocess without Chrome; the default stays `chrome`. Equivalence tests require both engines, with the built-in and myno bundles, to produce the same canonical DOM across themes, every syntax preset, structure options, standalone themes, scaled images and long articles.
- Time out each Worker CLI step (`PIPELINE_WORKER_STEP_TIMEOUT_MS`, `PIPELINE_WORKER_PUBLISH_STEP_TIMEOUT_MS`, default 10 minutes) and kill its whole process group on timeout, overflow or completion, so a grandchild such as Chrome can no longer hold the output pipe or block the serial queue.
- Let callers discard unconfirmed previews with `POST /v1/jobs/:id/discard` and expire stale ones with `PIPELINE_WORKER_PREVIEW_TTL_HOURS`; both close the job as `failed`, and confirmation re-checks the preview after waiting for its reservation.
- Tombstone `succeeded`/`failed` jobs after `PIPELINE_WORKER_TERMINAL_RETENTION_DAYS`: remove their workspace and bulky fields while keeping identity, request and body hashes and publish results, so idempotent submissions still resolve to the original job. Artifacts of tombstoned jobs return `410`.
- Report `runningJob`, `oldestQueuedAt`, `previewReady` and retention status in `/health`, and advertise `previewDiscard`, `terminalRetention` and `articleExportEngine`.
- Add `scripts/worker-probe.ts` to measure Worker memory, timing and disk use in memory-limited containers.

### Fixes

- Match inline code with a simple selector so code blocks render correctly in DOM implementations without `:not()` combinator support.
- Declare standard `text-size-adjust` and read `initial` border components as initial values when expanding border shorthands.

### Compatibility

- Use myno 0.4.7, which carries the same renderer fixes. Retention, preview expiry and the DOM engine are off by default; existing deployments keep their behavior.

## v0.23.1

### Features

- Accept v2 complete article styles and app-rendered 3350×1000 PNG cover snapshots for frozen article previews, and harden theme CSS resource validation.

## v0.23.0

### Features

- Add authenticated job lookup by the original idempotency key and Worker account, with immutable body hashes on job responses.
- Persist accepting jobs before material preparation, share concurrent same-key acceptance, and preserve failed keys without preparing again after failures or restart.
- Bound shared asset cache capacity and unreferenced retention, concurrent preparation, pinned defaults, child output, Worker diagnostics, and artifact copies.
- Reserve conservative per-job disk growth and check available space before new writes, first confirmation, and workflow growth phases.
- Preserve uncertain WeChat writes and known receipts as interrupted jobs, without requeueing the original run or releasing its unresolved business status.

### Compatibility

- Preserve CLI next-action execution, old request hashes, queued restart recovery, and running-job interruption behavior.
- Keep myno 0.4.1 and Typeset Studio 0.4.0; Worker-only output guards do not change ordinary CLI limits.

## v0.22.0

### Features

- Expose complete article input and artifact manifest validation at `@akairos/pipeline/article-snapshot`.
- Accept bounded, hash-verified body image bytes and freeze effective article defaults, cover templates, resources, and font identities before queueing previews.
- Generate local article HTML and cover previews without WeChat requests, persist `preview_ready`, and confirm publication through the original job/run using the frozen artifacts.
- Authenticate artifact downloads by fixed manifest keys and verify saved snapshot, manifest, and file hashes before confirmation and publication.

### Compatibility

- Preserve direct-publish requests and hashes when the new preview fields are absent.
- Pin myno 0.4.1 and Typeset Studio 0.4.0; keep HTML typography stacks and bind only Typeset cover fonts to the verified Noto bytes.

## v0.21.1

### Fixes

- Pin Typeset Studio 0.3.1 to normalize snapshot cover titles consistently with saved-template previews.

## v0.21.0

### Features

- Expose strict cover snapshots at `@akairos/pipeline/cover-snapshot`, reusing Typeset Studio's finite controls and canonical template factory.
- Persist immutable cover template revisions, normalized JPEG bytes, and fixed font identities in Worker jobs; render from task-private materials without changing shared defaults.
- Advertise cover schema/font capabilities, verify font bytes in the rendering process before measurement, and report snapshot/asset/font hashes in job results.

### Compatibility

- Keep requests without cover snapshots on their existing hash, default-template, and body-limit paths.
- Pin Typeset Studio 0.3.0 and retain myno 0.3.2; the Worker image pins its verified Noto CJK font package.

## v0.20.2

### Fixes

- Pin myno 0.3.2 so Markdown images without titles survive article parsing and WeChat export on Milkdown 7.21 consumers.

## v0.20.1

### Fixes

- Preserve the actual draft receipt when final article style verification fails, so callers can inspect the original result before retrying.

## v0.20.0

### Features

- Expose strict, normalized article style snapshots at `@akairos/pipeline/article-style`.
- Accept optional article styles in cloud Worker jobs, persist their immutable content, and pass private theme files to the existing CLI workflow.
- Advertise supported article style schema versions and report both snapshot and resolved CLI theme hashes.

### Compatibility

- Preserve request hashes and rendering behavior for jobs without an article style.
- Keep the existing myno 0.3.1 and Typeset Studio 0.2.7 runtime versions.

## v0.19.2

[compare changes](https://github.com/aatrooox/zzhub-pipeline/compare/v0.19.1...v0.19.2)

### Fixes

- **cover:** Update Typeset Studio to 0.2.7 ([624268b](https://github.com/aatrooox/zzhub-pipeline/commit/624268b))

### ❤️ Contributors

- Kairos ([@k7airos](https://github.com/k7airos))

## v0.19.1

[compare changes](https://github.com/aatrooox/zzhub-pipeline/compare/v0.19.0...v0.19.1)

### Fixes

- **wechat:** Rebuild article assets for scrollable tables ([ee3067c](https://github.com/aatrooox/zzhub-pipeline/commit/ee3067c))
- **styles:** Consume canonical article styles from myno ([e647c1c](https://github.com/aatrooox/zzhub-pipeline/commit/e647c1c))

### Documentation

- Clarify public ecosystem and current integration guides ([c78294e](https://github.com/aatrooox/zzhub-pipeline/commit/c78294e))

### ❤️ Contributors

- Kairos ([@k7airos](https://github.com/k7airos))

## v0.19.0

### Features

- Load optional myno browser rendering and Studio resources through `plugins.markdownRenderer`.
- Reuse Pipeline's Chrome lifecycle, style validation, and output handling for browser-only plugins.
- Pin the optional `@akairos/myno` dependency to 0.3.0; preserve its npm entry in runtime configuration packages.

### Fixes

- Keep preview registration and history available when an external Studio cannot load.
- Restrict Studio asset paths to the plugin's resource directory, including symbolic links.

## v0.18.1

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.18.0...v0.18.1)

### Fixes

- **wechat:** Right-align square cover crops ([d888d31](https://github.com/k7airos/zzhub-pipeline/commit/d888d31))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.18.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.17.0...v0.18.0)

### Features

- **render:** Support Studio templates and task asset overrides ([762c701](https://github.com/k7airos/zzhub-pipeline/commit/762c701))
- **worker:** Sync portable Studio and Markdown runtime packages ([c1b9952](https://github.com/k7airos/zzhub-pipeline/commit/c1b9952))

### Fixes

- **wechat:** Calculate cover crops from uploaded image bytes ([027db3c](https://github.com/k7airos/zzhub-pipeline/commit/027db3c))
- **wechat-preview:** Persist styles and align preview with export ([ea488fe](https://github.com/k7airos/zzhub-pipeline/commit/ea488fe))
- **render:** Enforce task constraints on renderer output ([e632129](https://github.com/k7airos/zzhub-pipeline/commit/e632129))
- **plugins:** Isolate execution and stop failed render tasks ([1975497](https://github.com/k7airos/zzhub-pipeline/commit/1975497))
- **wechat:** Export fragment links as styled text ([1c2b9b0](https://github.com/k7airos/zzhub-pipeline/commit/1c2b9b0))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.16.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.15.0...v0.16.0)

### Features

- Sync cloud pipeline accounts from Nezus ([dad268d](https://github.com/k7airos/zzhub-pipeline/commit/dad268d))
- Expose cloud worker progress ([d7cb5e9](https://github.com/k7airos/zzhub-pipeline/commit/d7cb5e9))
- **wechat-preview:** Implement milkdown plugin system with callout, kbd, badge and highlight ([6fa9e97](https://github.com/k7airos/zzhub-pipeline/commit/6fa9e97))
- **wechat-preview:** Implement WeChat Visual Studio and studio server endpoints ([8201d0e](https://github.com/k7airos/zzhub-pipeline/commit/8201d0e))
- **studio:** Add syntax presets selector and custom override integration ([eada98b](https://github.com/k7airos/zzhub-pipeline/commit/eada98b))
- **wechat-preview:** Add contrast-green h2 preset, css extraction button, and curated color palettes ([7d13bb9](https://github.com/k7airos/zzhub-pipeline/commit/7d13bb9))
- **wechat-preview:** Connect syntaxPresets and structure into export pipeline and save-config ([8b54d18](https://github.com/k7airos/zzhub-pipeline/commit/8b54d18))
- **wechat-preview:** List all markdown syntaxes in presets panel with 1-click css extract ([149c9f6](https://github.com/k7airos/zzhub-pipeline/commit/149c9f6))
- **wechat-preview:** Support custom callout titles, emojis, and presets ([4fd94bf](https://github.com/k7airos/zzhub-pipeline/commit/4fd94bf))
- **wechat-preview:** Support --no-open flag in studio command ([6e4987c](https://github.com/k7airos/zzhub-pipeline/commit/6e4987c))

### Fixes

- Preserve cloud worker job credentials ([08b5e2f](https://github.com/k7airos/zzhub-pipeline/commit/08b5e2f))
- Send explicit newspic photos and text through cloud jobs ([dcdbc18](https://github.com/k7airos/zzhub-pipeline/commit/dcdbc18))
- Generate newspic images when uploads are omitted ([efad1e6](https://github.com/k7airos/zzhub-pipeline/commit/efad1e6))
- Keep full photo article while bounding draft captions ([8ef6b76](https://github.com/k7airos/zzhub-pipeline/commit/8ef6b76))

### Documentation

- Add minimal required environment config to AGENTS.md ([0710c3e](https://github.com/k7airos/zzhub-pipeline/commit/0710c3e))
- Add wechat visual studio and plugin architecture plan ([337fd22](https://github.com/k7airos/zzhub-pipeline/commit/337fd22))
- Add visual studio guide and remote config sync workflow ([86a3ddb](https://github.com/k7airos/zzhub-pipeline/commit/86a3ddb))

### Chore

- Fix test types and keep tsc clean ([da1e68f](https://github.com/k7airos/zzhub-pipeline/commit/da1e68f))
- Ignore IDEA.md ([d219447](https://github.com/k7airos/zzhub-pipeline/commit/d219447))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>
- Aatrox <gnakzz@qq.com>

## v0.15.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.14.0...v0.15.0)

### Features

- Expand cloud worker publishing and rendering ([0d1f979](https://github.com/k7airos/zzhub-pipeline/commit/0d1f979))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.14.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.13.2...v0.14.0)

### Features

- Add private cloud pipeline worker ([20b474d](https://github.com/k7airos/zzhub-pipeline/commit/20b474d))

### Fixes

- **wechat:** Replace large Base64 image URLs without regex ([869b08d](https://github.com/k7airos/zzhub-pipeline/commit/869b08d))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.13.2

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.13.1...v0.13.2)

### Fixes

- **wechat:** Wait for article rendering before exporting HTML ([f812268](https://github.com/k7airos/zzhub-pipeline/commit/f812268))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.13.1

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.13.0...v0.13.1)

### Fixes

- **wechat:** Preserve Crepe image scaling in article exports ([366b30c](https://github.com/k7airos/zzhub-pipeline/commit/366b30c))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.13.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.12.0...v0.13.0)

### Features

- **render:** Add configurable cover themes ([ad68d3c](https://github.com/k7airos/zzhub-pipeline/commit/ad68d3c))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.12.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.11.0...v0.12.0)

### Features

- Add isolated multi-task monitoring and reliable command outcomes ([1b42ccd](https://github.com/k7airos/zzhub-pipeline/commit/1b42ccd))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.11.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.10.2...v0.11.0)

### Features

- **config:** Add optional wx account display name ([115c2e5](https://github.com/k7airos/zzhub-pipeline/commit/115c2e5))
- **skills:** Add wechat HTML style guide and auto AI daily publish ([5fcc529](https://github.com/k7airos/zzhub-pipeline/commit/5fcc529))
- Remove topic and analytics modules ([d6e545c](https://github.com/k7airos/zzhub-pipeline/commit/d6e545c))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.10.2

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.10.1...v0.10.2)

### Features

- **logger:** Add daily rolling CLI command logs ([b1ee39c](https://github.com/k7airos/zzhub-pipeline/commit/b1ee39c))
- **wechat-preview:** Harden export with diagnostics and stale bundles ([bfa56a8](https://github.com/k7airos/zzhub-pipeline/commit/bfa56a8))
- **wechat-preview:** Add local singleton HTML preview server ([6103a63](https://github.com/k7airos/zzhub-pipeline/commit/6103a63))
- **wechat:** Adopt milkdown-article-style 0.1.1 heading hierarchy ([d2c6966](https://github.com/k7airos/zzhub-pipeline/commit/d2c6966))

### Fixes

- Use Kairos as blog author ([8da5ed0](https://github.com/k7airos/zzhub-pipeline/commit/8da5ed0))
- **wechat-preview:** Dedupe external link footnotes by URL ([b982459](https://github.com/k7airos/zzhub-pipeline/commit/b982459))
- **state:** Harden workflow recovery against stale assets and stale flags ([a979528](https://github.com/k7airos/zzhub-pipeline/commit/a979528))

### Refactors

- **wechat-preview:** Depend on @zzhub/milkdown-article-style ([fc14924](https://github.com/k7airos/zzhub-pipeline/commit/fc14924))

### Documentation

- Document npm dependency for milkdown-article-style ([12d73da](https://github.com/k7airos/zzhub-pipeline/commit/12d73da))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.10.1

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.10.0...v0.10.1)

### Features

- Redesign WeChat markdown HTML rendering ([a3b2ae3](https://github.com/k7airos/zzhub-pipeline/commit/a3b2ae3))

### Fixes

- Preserve explicit blog publishing route ([2d7298d](https://github.com/k7airos/zzhub-pipeline/commit/2d7298d))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.10.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.9.1...v0.10.0)

### Features

- Harden publishing pipeline end to end ([9bbf368](https://github.com/k7airos/zzhub-pipeline/commit/9bbf368))

### ❤️ Contributors

- Kairos <gnakzz@qq.com>

## v0.9.1

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.9.0...v0.9.1)

### Fixes

- Preserve existing account when prepare is called without --account ([0a8f88f](https://github.com/k7airos/zzhub-pipeline/commit/0a8f88f))

### Chore

- Remove stale Unreleased section (already in v0.9.0) ([66142b1](https://github.com/k7airos/zzhub-pipeline/commit/66142b1))

### ❤️ Contributors

- Aatrox3 ([@aatrooox](https://github.com/k7airos))

## v0.9.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.8.0...v0.9.0)

### Features

- **topic:** Add evaluate command for AI scoring ([815ab7e](https://github.com/k7airos/zzhub-pipeline/commit/815ab7e))
- **topic:** Add promote command to convert topic to publish task ([ec3dd14](https://github.com/k7airos/zzhub-pipeline/commit/ec3dd14))
- **schema:** Add account field to PublishResult ([a75c31b](https://github.com/k7airos/zzhub-pipeline/commit/a75c31b))
- **schema:** Add publish_targets field for multi-target publish ([0e4d44c](https://github.com/k7airos/zzhub-pipeline/commit/0e4d44c))
- **providers:** Add accountOverride to PublishRouteContext ([eb406cb](https://github.com/k7airos/zzhub-pipeline/commit/eb406cb))
- **providers:** Register blog in PUBLISH_PROVIDERS ([008b760](https://github.com/k7airos/zzhub-pipeline/commit/008b760))
- **providers:** Extract executePublishTargets core ([e895d9b](https://github.com/k7airos/zzhub-pipeline/commit/e895d9b))
- **publish:** Use executePublishTargets core ([7ae4eac](https://github.com/k7airos/zzhub-pipeline/commit/7ae4eac))
- **init:** Support multi-target --targets format ([8f31929](https://github.com/k7airos/zzhub-pipeline/commit/8f31929))
- **commands:** Add republish for multi-account publish ([00a3174](https://github.com/k7airos/zzhub-pipeline/commit/00a3174))

### Fixes

- **render:** Pass account visual params to cover image for all accounts ([31fda36](https://github.com/k7airos/zzhub-pipeline/commit/31fda36))
- Move republish from workflow to ops group ([a464310](https://github.com/k7airos/zzhub-pipeline/commit/a464310))
- Resolve pre-existing typecheck errors ([b009aa8](https://github.com/k7airos/zzhub-pipeline/commit/b009aa8))

### Documentation

- Update AGENTS.md with topic and analytics commands ([5c5bf24](https://github.com/k7airos/zzhub-pipeline/commit/5c5bf24))
- Document republish and multi-target init ([4724d30](https://github.com/k7airos/zzhub-pipeline/commit/4724d30))

### ❤️ Contributors

- Aatrox3 ([@aatrooox](https://github.com/k7airos))

## v0.8.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.7.0...v0.8.0)

### Features

- **wechat:** Add per-account theme overrides to config schema ([dbf5748](https://github.com/k7airos/zzhub-pipeline/commit/dbf5748))
- **wechat:** Wire theme overrides through export and publish pipeline ([7f0088d](https://github.com/k7airos/zzhub-pipeline/commit/7f0088d))
- **db:** Add SQLite database infrastructure ([f388a7c](https://github.com/k7airos/zzhub-pipeline/commit/f388a7c))
- **schema:** Add Analytics schema with Zod validation ([b78d91e](https://github.com/k7airos/zzhub-pipeline/commit/b78d91e))
- **schema:** Add Topic schema with Zod validation ([5bd289f](https://github.com/k7airos/zzhub-pipeline/commit/5bd289f))
- **topic:** Implement add and list commands ([1720537](https://github.com/k7airos/zzhub-pipeline/commit/1720537))
- **topic:** Implement update, schedule, retro, abandon commands ([ad15d5d](https://github.com/k7airos/zzhub-pipeline/commit/ad15d5d))
- **topic:** Add CLI command handler ([5835eb6](https://github.com/k7airos/zzhub-pipeline/commit/5835eb6))
- **analytics:** Implement analytics commands ([b8ddc24](https://github.com/k7airos/zzhub-pipeline/commit/b8ddc24))
- **skills:** Add topic and analytics skills ([704b7d2](https://github.com/k7airos/zzhub-pipeline/commit/704b7d2))

### Fixes

- **wechat:** Remove h2 left accent bar and strong brand color ([ecea182](https://github.com/k7airos/zzhub-pipeline/commit/ecea182))

### Documentation

- Document wechat-preview CSS rebuild requirement ([a7f9afd](https://github.com/k7airos/zzhub-pipeline/commit/a7f9afd))
- Add design spec for topic and analytics features ([6c11b31](https://github.com/k7airos/zzhub-pipeline/commit/6c11b31))
- Add implementation plan for topic and analytics features ([0860079](https://github.com/k7airos/zzhub-pipeline/commit/0860079))
- Add topic and analytics commands to README ([ffe9910](https://github.com/k7airos/zzhub-pipeline/commit/ffe9910))

### Chore

- Add docs/ to .gitignore ([51d612d](https://github.com/k7airos/zzhub-pipeline/commit/51d612d))

### ❤️ Contributors

- Aatrox3 ([@aatrooox](https://github.com/k7airos))

## v0.6.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.5.1...v0.6.0)

### Fixes

- **newspic:** Exclude cover from image_info and preserve markdown links in body ([0c8e6ce](https://github.com/k7airos/zzhub-pipeline/commit/0c8e6ce))
- **newspic:** Include cover in image_list and handle angle-bracket URLs with spaces ([c5dc2a7](https://github.com/k7airos/zzhub-pipeline/commit/c5dc2a7))

### ❤️ Contributors

- Aatrox3 ([@aatrooox](https://github.com/k7airos))

## v0.5.1

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.5.0...v0.5.1)

### Features

- Wx-drafts/wx-draft-delete commands, draft update, and Nezus publish callback ([c91d14a](https://github.com/k7airos/zzhub-pipeline/commit/c91d14a))

### ❤️ Contributors

- Aatrox3 ([@aatrooox](https://github.com/k7airos))

## v0.5.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.4.0...v0.5.0)

## v0.4.0

[compare changes](https://github.com/k7airos/zzhub-pipeline/compare/v0.3.0...v0.4.0)

### Features

- **skill:** Delegate writing, review, and revision to sub-agents with clean context ([5fea5e1](https://github.com/k7airos/zzhub-pipeline/commit/5fea5e1))
- **skill:** 强化写稿质量要求——标题权重60%、陌生感视角、讲故事风格 ([a6780df](https://github.com/k7airos/zzhub-pipeline/commit/a6780df))
- **skill:** 要求 sub-agent 写稿时产出标题高亮关键词 ([2ec5fc4](https://github.com/k7airos/zzhub-pipeline/commit/2ec5fc4))
- Add modular typographic scale with proportional line-height ([168e122](https://github.com/k7airos/zzhub-pipeline/commit/168e122))
- Apply proportional spacing and modular scale to longform theme geometry ([8329d00](https://github.com/k7airos/zzhub-pipeline/commit/8329d00))
- Refine poster scoring with optical center, last-line sweet spot, and smooth letter-spacing ([735a121](https://github.com/k7airos/zzhub-pipeline/commit/735a121))
- Upgrade wechat cover algorithm from greedy to scored search ([f483fcc](https://github.com/k7airos/zzhub-pipeline/commit/f483fcc))
- Add proportional image-text gap and progressive image shadow ([fad53ed](https://github.com/k7airos/zzhub-pipeline/commit/fad53ed))
- Add visual rhythm engine and longform content highlighting ([80c2978](https://github.com/k7airos/zzhub-pipeline/commit/80c2978))
- Configurable icon for imgx rendering + swap default icon ([d60d216](https://github.com/k7airos/zzhub-pipeline/commit/d60d216))

### Fixes

- Extract only English terms as highlight words, skip CJK entirely ([3f58364](https://github.com/k7airos/zzhub-pipeline/commit/3f58364))
- Remove 12-char ASCII token limit in normalizeMixedTextSpacing, add multi-token join pass ([606f298](https://github.com/k7airos/zzhub-pipeline/commit/606f298))
- Allow whitespace between CJK and first ASCII token in Pass 4 join ([6f68784](https://github.com/k7airos/zzhub-pipeline/commit/6f68784))
- Fix Pass 4 trailing space and 3+ token chain handling ([75bc3a4](https://github.com/k7airos/zzhub-pipeline/commit/75bc3a4))
- Add min-length filter to exclude single chars and short lowercase words from highlights ([8323787](https://github.com/k7airos/zzhub-pipeline/commit/8323787))
- Correct capture group reference in post-join cleanup ( → ) ([2d96962](https://github.com/k7airos/zzhub-pipeline/commit/2d96962))
- Harden proportionalLineHeight edge cases, add computeSpacing and negative-step tests ([4db0b18](https://github.com/k7airos/zzhub-pipeline/commit/4db0b18))
- Use visual-width estimation in poster template for mixed CJK/English titles ([8af0a15](https://github.com/k7airos/zzhub-pipeline/commit/8af0a15))
- Remove dead 0-9 from LATIN_NARROW_RE, narrow \s to avoid CJK_RE overlap ([75bdf38](https://github.com/k7airos/zzhub-pipeline/commit/75bdf38))
- Add English word-boundary awareness to cover title splitting, smooth typography functions ([4a2398c](https://github.com/k7airos/zzhub-pipeline/commit/4a2398c))
- Recalculate linen-news heading line-height and spacing for actual 36px font size ([a71e8e6](https://github.com/k7airos/zzhub-pipeline/commit/a71e8e6))

### Documentation

- Replace agent loop text with mermaid flowchart in README ([15ebf2c](https://github.com/k7airos/zzhub-pipeline/commit/15ebf2c))
- Add build-and-reinstall step after code changes ([0b9775b](https://github.com/k7airos/zzhub-pipeline/commit/0b9775b))

### Chore

- Replace internal skills with zzhub-publish skill ([9c00788](https://github.com/k7airos/zzhub-pipeline/commit/9c00788))
- Switch npm publish from bundled dist to source ([f2ea736](https://github.com/k7airos/zzhub-pipeline/commit/f2ea736))

### ❤️ Contributors

- Aatrox3 ([@aatrooox](https://github.com/k7airos))

## v0.3.0

Initial public release.

Pipeline state machine for WeChat content publishing:
- Agent-driven workflow loop with `--view agent` output
- Two entry points: `init` (agent-created) and `ingest-handoff` (external handoff)
- Three-phase pipeline: prepare → render → publish
- Pluggable render system with built-in imgx (Chrome headless + @napi-rs/canvas)
- WeChat article drafts and newspic image messages
- Config via JSON file + env overrides
