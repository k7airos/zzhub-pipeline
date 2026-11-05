---
name: zzhub-style-config
description: >
  直接配置 zzhub-pipeline 的公众号文章样式、封面主题和 Typeset Studio 模板。
  当用户要调整正文颜色、字号、页脚、封面配色、品牌 Logo、模板槽位或排版配置时使用。
  触发：文章样式、正文排版、封面模板、封面主题、公众号 Logo、排版配置。
---

# zzhub-style-config — 文章样式与封面配置

这个 skill 负责把用户的视觉要求转换成 Pipeline 已支持的 JSON 配置和模板选择。
Agent 直接写配置；Studio 适合用户继续微调。先确认目标是正文 HTML、封面图片，还是
Typeset Studio 模板，再修改对应入口。

## 配置入口

| 目标 | 配置入口 | 适用范围 |
| --- | --- | --- |
| 正文 HTML 的颜色、字号、行距和语法预设 | `wx.accounts.<account>.theme` | 账号级正文排版 |
| 正文临时或长期 CSS | `--custom-css` 或 `wx.accounts.<account>.customCss` | 文章 HTML 导出 |
| 独立正文样式包 | `articleTheme` 或 `--article-theme` | 不绑定账号的完整 JSON/模板 |
| 内置封面主题 | `render.cover` | `poster-3-4` 和 `wechat-cover-split` |
| 封面/正文图片的品牌标识 | `render.branding` | Logo 与署名，支持账号覆盖 |
| Studio 图片模板和固定素材 | `plugins.imageRenderer` 的 `dataDir` | Typeset Studio 模板、槽位和上传素材 |

不要把 `render.cover` 当作正文 HTML 样式；也不要用 `wx.accounts.*.theme` 修改图片封面。
启用 Typeset Studio 模板后，模板本身决定字体、配色、布局和图片层级。

## 修改前检查

1. 用 `zzp config --export` 读取当前配置，确认账号键和现有引用。
2. 涉及正文时确认 `plugins.markdownRenderer`；`null` 表示 Pipeline 内置 renderer，
   `@akairos/myno/adapter` 表示 myno renderer 和 Studio。
3. 涉及图片时确认 `plugins.imageRenderer`；Typeset Studio 需要 `options.dataDir`。
4. 不读取、不复制、不覆盖账号凭据、PAT、AppSecret 或 Worker token。
5. 只改用户指定的账号或主题；保留未涉及的字段和已有模板素材。

## 正文样式

账号正文配置示例：

```json
{
  "wx": {
    "accounts": {
      "default": {
        "customCss": "styles/default.css",
        "theme": {
          "editorVars": { "--brand": "#285349" },
          "exportTheme": {
            "bodyFontSize": "16px",
            "bodyLineHeight": "1.84",
            "bodyColor": "#292526",
            "primaryColor": "#285349",
            "footerText": "公众号：我的公众号"
          },
          "syntaxPresets": { "h2": "pillar", "divider": "short-center" },
          "structure": { "numberedHeadings": false, "headingLabel": "", "quoteLabel": "" }
        }
      }
    }
  }
}
```

支持的正文主题字段包括：

- `editorVars`：CSS 变量，例如 `--brand`。
- `exportTheme`：正文颜色、字体、字号、行距、字距、标题色、分割线和页脚。
- `syntaxPresets`：标题、分割线等已注册预设；只能使用当前 renderer 支持的值。
- `structure`：编号标题、标题/引用标签和提示卡片预设。
- `customCss`：相对配置文件目录或绝对路径的 CSS 文件；单次导出可用 `--custom-css` 覆盖。

独立样式 JSON 不绑定账号，也不叠加账号 `theme` 或 `customCss`：

```bash
zzp article-theme --path ./wechat-style.json
zzp wechat-export --markdown ./article.md --out ./article.html \
  --article-theme ./wechat-style.json --no-preview
```

账号引用独立模板时，把 `articleTheme` 设置为相对配置文件目录的路径。独立 JSON 必须
内嵌 CSS 和页首图片，不能引用模板目录资源；使用前先运行 `zzp article-theme` 校验。

## 封面主题与品牌

内置封面主题集中在 `render.cover`：

```bash
zzp config --key render.cover --json
zzp config --schema --key render.cover
zzp config --key render.cover.defaultTheme --value business
zzp config --key render.cover.accountThemes.default --value fresh-sage
```

主题字段按以下层次配置：

- `defaultTheme`：全局默认主题；`accountThemes.<account>`：账号默认主题。
- `themes.<id>.typography`：标题、副标题、署名字体和字号。
- `themes.<id>.colors`：正文色、强调色、署名色。
- `themes.<id>.background`：纯色/渐变/径向背景、背景图和遮罩。
- `themes.<id>.decoration`：线条、网格、圆点、圆环、爆发线及装饰图。
- `themes.<id>.layout`：水平/垂直对齐和安全区。
- `themes.<id>.formats`：对 `poster-3-4` 或 `wechat-cover-split` 的局部覆盖。

封面主题只接受已有主题 ID 或符合 schema 的新主题。图片路径相对实际配置文件目录；
远程素材要使用稳定的 HTTPS URL。修改后可先用本地渲染验证：

```bash
zzp imgx render-card --template poster-3-4 --cover-theme business \
  --text '标题' --out /tmp/cover.png --json
```

品牌配置独立于主题：

```bash
zzp config --key render.branding.logo --value '/path/to/logo.png'
zzp config --key render.branding.footerText --value '公众号：我的公众号'
zzp config --schema --key render.branding
```

优先级是本次渲染参数、账号覆盖、全局配置和旧版 `imgx.icon`/账号默认值。空字符串
隐藏对应项，`null` 继续使用更高层默认值。

## Studio 模板

启用 Typeset Studio：

```json
{
  "plugins": {
    "imageRenderer": {
      "module": "@akairos/typeset-studio/adapter",
      "options": { "dataDir": "/absolute/path/typeset-studio/data" }
    }
  }
}
```

`dataDir` 外部目录中的 `templates/*.json` 保存模板，`default-template.json` 保存全局
和账号槽位，`uploads/` 保存上传图片。运行任务时可以选择模板并替换固定素材：

```bash
zzp render --state /absolute/path/workflow-state.json \
  --studio-cover-template tpl_my_cover \
  --studio-content-template tpl_my_content \
  --template-images-file /absolute/path/template-images.json
```

映射文件按 `cover`/`content` 分组，键必须是模板声明的 `templateAssetKey`。模板选择和
素材映射会写入任务状态，重跑 render 会复用；传空模板 ID 恢复槽位默认，传 `{}` 清除
素材映射。模板中的 `/uploads/...` 文件必须随 `dataDir` 一起部署。

## 修改与验证流程

1. 读取配置和相关 schema，列出将要修改的具体路径。
2. 用 `zzp config --key ... --value ...` 或准备 JSON 后 `zzp config --import` 写入。
3. 用 `zzp config --export` 回读并确认未改变凭据和无关账号。
4. 正文样式用 `zzp wechat-export --no-preview` 生成 HTML；封面用 `imgx render-card`。
5. 发布任务只通过 `status --view agent` 返回的下一步推进，不直接编辑 `workflow-state.json`。

配置写入只发生在用户明确指定的本机配置或任务状态；不要联网、发布、上传素材或修改
模板源文件来“猜”用户想要的效果。需要视觉判断时，把生成的本地产物交给用户在 Studio
或本地预览中确认。
