/**
 * 两个导出引擎的等价验收：同一输入分别由 Chrome 与 happy-dom 导出，
 * 再交给 Chrome 统一解析为规范 DOM（属性排序、style 展开为排序后的单值属性），要求逐字一致。
 * 规范 DOM 相同即渲染相同；HTML 原文因 CSSOM 序列化写法不同而不要求一致。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import mynoAdapter from "@akairos/myno/adapter";
import { findChrome } from "../imgx/runtime";
import { dumpReadyHtml } from "../imgx/chrome-render";
import { SYNTAX_CATEGORIES } from "./browser/studio/syntax-presets";
import { exportMarkdownToWechatHtml, type ExportMarkdownToWechatHtmlInput } from "./index";

const chromePath = findChrome();
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "all-nodes.md");

const PLUGIN_NODES = `
> [!INTRO] 导读
> **文 / 作者** · 预计阅读 5 分钟
>
> 导读正文。

==高亮文本== 与 [[kbd:Cmd]] + [[kbd:K]]，状态 [badge:brand|重点推荐] [badge:success|已上线] [badge:warning|待确认] [badge:danger|异常] [badge:info|提示]。

> [!NOTE]
> 说明。

> [!TIP] 💡 实用技巧
> 技巧正文。

> [!WARNING]
> 警告正文。

> [!IMPORTANT]
> 重要正文。

> [!CAUTION]
> 注意正文。

> [!CTA] 欢迎交流与关注
`;

/** 在 Chrome 中把 HTML 解析成规范字符串：属性按名排序，style 展开为排序后的单值属性。 */
async function canonicalize(htmls: string[]): Promise<string[]> {
  const input = JSON.stringify(htmls).replace(/</g, "\\u003c");
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script id="canonical-input" type="application/json">${input}</script>
<script>
  const canonical = JSON.parse(document.getElementById("canonical-input").textContent).map((html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const element of doc.body.querySelectorAll("*")) {
      // 只有内联样式时，不继承属性的 initial 与不声明等价；Chrome 对简写省略分量的展开方式不同，不参与比较。
      // list-style-image 不在导出白名单内，祖先从不设置，initial 同样等价于不声明。
      const style = element.getAttribute("style") === null ? null : Array.from(element.style).sort()
        .filter((name) => !(element.style.getPropertyValue(name) === "initial" && /^(?:text-decoration|border|background|margin|padding|outline)-|^list-style-image$/.test(name)))
        .map((name) => name + ": " + element.style.getPropertyValue(name) + (element.style.getPropertyPriority(name) ? " !important" : ""))
        .join("; ");
      const attributes = Array.from(element.attributes).map((attribute) => [attribute.name, attribute.value]);
      for (const [name] of attributes) element.removeAttribute(name);
      for (const [name, value] of attributes.sort(([a], [b]) => a.localeCompare(b))) {
        if (name === "style") { if (style) element.setAttribute("style", style); }
        else element.setAttribute(name, value);
      }
    }
    return doc.body.innerHTML;
  });
  const output = document.createElement("script");
  output.id = "canonical-output";
  output.type = "application/json";
  output.textContent = JSON.stringify(canonical);
  document.body.appendChild(output);
  window.__zzhubRenderReady = Promise.resolve();
</script></body></html>`;
  const dom = await dumpReadyHtml({ chromePath: chromePath!, html: page, timeoutMs: 60_000 });
  const match = dom.match(/<script id="canonical-output" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("canonical output missing");
  return JSON.parse(match[1]) as string[];
}

/** 只报告第一个差异点附近的片段，便于定位。 */
function firstDifference(chrome: string, dom: string): { at: number; chrome: string; dom: string } | Record<string, never> {
  if (chrome === dom) return {};
  let at = 0;
  while (at < chrome.length && chrome[at] === dom[at]) at += 1;
  return { at, chrome: chrome.slice(Math.max(0, at - 160), at + 160), dom: dom.slice(Math.max(0, at - 160), at + 160) };
}

describe.skipIf(chromePath === null)("article export engine equivalence", () => {
  let tempDir: string;
  const previousEngine = process.env.PIPELINE_ARTICLE_EXPORT_ENGINE;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zzhub-export-equivalence-"));
    const png = new PNG({ width: 640, height: 360 });
    png.data.fill(200);
    await writeFile(join(tempDir, "photo.png"), PNG.sync.write(png));
  });

  afterAll(async () => {
    if (previousEngine === undefined) delete process.env.PIPELINE_ARTICLE_EXPORT_ENGINE;
    else process.env.PIPELINE_ARTICLE_EXPORT_ENGINE = previousEngine;
    await rm(tempDir, { recursive: true, force: true });
  });

  // 内置 bundle 与 Worker 使用的 myno bundle 都要等价。
  async function exportBoth(name: string, markdown: string, options: Partial<ExportMarkdownToWechatHtmlInput> = {}) {
    const { scriptPath: mynoScriptPath } = await mynoAdapter.browser();
    for (const [bundle, browserScriptPath] of [["builtin", undefined], ["myno", mynoScriptPath]] as const) {
      await exportPair(`${name}-${bundle}`, markdown, { ...options, browserScriptPath });
    }
  }

  async function exportPair(name: string, markdown: string, options: Partial<ExportMarkdownToWechatHtmlInput>) {
    const markdownPath = join(tempDir, `${name}.md`);
    await writeFile(markdownPath, markdown);
    const results = [];
    for (const engine of ["chrome", "dom"] as const) {
      process.env.PIPELINE_ARTICLE_EXPORT_ENGINE = engine;
      results.push(await exportMarkdownToWechatHtml({
        markdownPath, outPath: join(tempDir, `${name}.${engine}.html`), account: "default", timeoutMs: 60_000, ...options,
      }));
    }
    const [chrome, dom] = results;
    // 属性值中 < > 是否转义随 Chrome 版本变化，semanticHtml 同样按解析后的规范 DOM 比较。
    const [chromeSemantic, domSemantic, chromeCanonical, domCanonical] = await canonicalize([chrome!.semanticHtml!, dom!.semanticHtml!, chrome!.html, dom!.html]);
    expect({ name, part: "semanticHtml", ...firstDifference(chromeSemantic!, domSemantic!) }).toEqual({ name, part: "semanticHtml" });
    expect({ name, part: "html", ...firstDifference(chromeCanonical!, domCanonical!) }).toEqual({ name, part: "html" });
  }

  test("all node types under every built-in account theme", async () => {
    const fixture = await readFile(fixturePath, "utf8");
    for (const account of ["default", "ancientone"]) {
      await exportBoth(`account-${account}`, `${fixture}\n\n${PLUGIN_NODES}`, { account });
    }
  }, 240_000);

  test("every syntax preset", async () => {
    const fixture = await readFile(fixturePath, "utf8");
    const rounds = Math.max(...SYNTAX_CATEGORIES.map((category) => category.presets.length));
    // 每轮为每个类别取一个预设，几轮内覆盖全部预设。
    for (let round = 0; round < rounds; round += 1) {
      const syntaxPresets = Object.fromEntries(SYNTAX_CATEGORIES.map((category) => [category.key, category.presets[round % category.presets.length]!.id]));
      await exportBoth(`presets-${round}`, `${fixture}\n\n${PLUGIN_NODES}`, { themeOverrides: { syntaxPresets } });
    }
  }, 600_000);

  test("structure options, custom typography and custom CSS", async () => {
    const customCss = join(tempDir, "custom.css");
    await writeFile(customCss, ".zzhub-wechat-article p { letter-spacing: 0.03em; }\n[data-wechat-node=\"inline-code\"] { color: #b42318; }");
    await exportBoth("structure", `## 第一节\n\n正文 \`code\`。\n\n> 引用。\n\n## 第二节\n\n${PLUGIN_NODES}`, {
      customCss,
      themeOverrides: {
        exportTheme: { bodyFontSize: "17px", bodyParagraphSpacing: "1.4em" },
        structure: { numberedHeadings: true, headingLabel: "Chapter", quoteLabel: "Citation", calloutPresets: { tip: { title: "Advice", icon: "✨" } } },
      },
    });
  }, 240_000);

  test("complete standalone theme with header image and embedded CSS", async () => {
    const header = new PNG({ width: 900, height: 300 });
    header.data.fill(120);
    const themePath = join(tempDir, "theme.json");
    await writeFile(themePath, JSON.stringify({
      schemaVersion: 1, engineVersion: 1, id: "equivalence", name: "Equivalence", version: "1.0.0",
      editorVars: { "--brand": "#1f7a4d" },
      exportTheme: { bodyFontSize: "17px", primaryColor: "#1f7a4d", h2Color: "#1f7a4d" },
      syntaxPresets: { h2: "bottom-line" },
      css: ".zzhub-wechat-article h2 { letter-spacing: 0.04em; }\n.zzhub-wechat-article blockquote { background-color: #f4f8f6; }",
      structure: {
        numberedHeadings: true, headingLabel: "Part", quoteLabel: "Note",
        headerImageUrl: `data:image/png;base64,${PNG.sync.write(header).toString("base64")}`,
      },
    }));
    const fixture = await readFile(fixturePath, "utf8");
    await exportBoth("standalone-theme", `${fixture}\n\n${PLUGIN_NODES}`, { articleThemePath: themePath });
  }, 240_000);

  test("scaled local images with captions", async () => {
    await exportBoth("images", "![0.50](photo.png \"半宽图注\")\n\n![0.75](photo.png)\n\n段落中 ![](photo.png) 的图片。");
  }, 120_000);

  test("long article", async () => {
    const fixture = await readFile(fixturePath, "utf8");
    const body = fixture.replace(/^---[\s\S]*?---\n/, "");
    await exportBoth("long", Array.from({ length: 12 }, (_, index) => `## 第 ${index + 1} 部分\n\n${body}\n\n${PLUGIN_NODES}`).join("\n\n"));
  }, 360_000);
});
