import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { PNG } from "pngjs";
import { findChrome } from "../imgx/runtime";
import { dumpReadyHtml } from "../imgx/chrome-render";
import { DIST_DIR, TEMPLATE_PATH } from "../runtime-paths";
import { replaceImageUrls } from "../providers/wechat";
import { exportMarkdownToWechatHtml, extractRenderResult } from "./index";
import { PipelineConfigSchema } from "../schema/config";
import { getWechatPreviewTheme } from "./themes";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "all-nodes.md",
);

describe("semantic WeChat HTML export", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test.skipIf(findChrome() === null)("exports persisted Studio typography, syntax presets and structure", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zzhub-studio-export-"));
    const markdownPath = join(tempDir, "post.md");
    await writeFile(markdownPath, "---\ntitle: title\n---\n# Article title\n\n## Section\n\nBody text.\n\n> Quote.\n\n> [!TIP]\n> Tip body.");
    const config = PipelineConfigSchema.parse({ wx: { accounts: { default: { theme: {
      exportTheme: { bodyFontSize: "18px", bodyParagraphSpacing: "1.6em" },
      syntaxPresets: { h2: "contrast-green" },
      structure: { numberedHeadings: true, headingLabel: "Chapter", quoteLabel: "Citation", calloutPresets: { tip: { title: "Advice" } } },
    } } } } });
    const { html } = await exportMarkdownToWechatHtml({
      markdownPath, outPath: join(tempDir, "post.html"), account: "default",
      themeOverrides: config.wx.accounts.default.theme,
    });
    expect(html).not.toContain("Article title");
    expect(html).toMatch(/<p[^>]+font-size: 18px[^>]*>Body text\.<\/p>/);
    expect(html).toContain("margin-bottom: 1.6em");
    expect(html).toContain("Chapter</span>");
    expect(html).toContain("01</span>");
    expect(html).toContain("Citation</p>");
    // 公众号编辑器解析不了 currentcolor/多值 border 简写，导出必须展开为可见边单值属性
    expect(html).not.toContain("currentcolor");
    // 引用导出为 section（规避微信编辑器对原生 blockquote 的强制灰色左边框），样式全靠内联
    expect(html).not.toContain("<blockquote");
    // Chrome 合并为单边简写，DOM 引擎保留单值属性，两者都是公众号可解析的单边写法。
    expect(html).toMatch(/border-left: 3px solid|border-left-width: 3px; border-left-style: solid/);
    expect(html).toContain("Advice</strong>");
    expect(html).toMatch(/background-color: (?:#1f7a4d|rgb\(31, 122, 77\))/);
  }, 30_000);

  test("h2 pillar preset exports border-left on the heading section", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zzhub-wechat-pillar-"));
    const markdownPath = join(tempDir, "post.md");
    await writeFile(markdownPath, "## 竖条标题\n\nBody.");
    const { html } = await exportMarkdownToWechatHtml({
      markdownPath, outPath: join(tempDir, "post.html"), account: "default",
      themeOverrides: { syntaxPresets: { h2: "pillar" } },
    });
    const h2Tag = html.match(/<section[^>]*>(?:<span[^>]*>[^<]*<\/span>)*竖条标题/)?.[0] ?? "";
    expect(h2Tag).toMatch(/border-left: 4px solid|border-left-width: 4px; border-left-style: solid/);
  }, 30_000);

  test.skipIf(findChrome() === null)("Studio saves and resets the same style and ignores stale renders", async () => {
    const studio = await readFile(join(DIST_DIR, "src/wechat-preview/browser/studio/studio.html"), "utf8");
    const theme = getWechatPreviewTheme("default");
    const html = studio.replace('src="/studio.js"', `src="${pathToFileURL(join(DIST_DIR, "studio.js")).href}"`)
      .replace("<head>", `<head><script>
window.fetch = async (url, options) => {
  if (String(url).includes('save-config')) {
    window.saved = JSON.parse(options.body);
    return new Response(JSON.stringify({ok:true}));
  }
  return new Response(JSON.stringify(${JSON.stringify({ defaultAccount: "default", accounts: { default: { name: "default", theme, customCssContent: "" } }, plugins: [], sampleMarkdown: "# Title\n\nInitial body." })}));
};
const originalCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = blob => { window.exportedBlob = blob; return originalCreateObjectURL.call(URL, blob); };
HTMLAnchorElement.prototype.click = function() { window.downloadName = this.download; };
window.__zzhubRenderReady = (async () => {
  const waitFor = async predicate => { while (!predicate()) await new Promise(resolve => setTimeout(resolve, 20)); };
  const edit = (id, value) => { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input')); };
  const source = () => document.getElementById('html-source-code')?.value || '';
  await waitFor(() => source().includes('Initial body.'));
  edit('input-font-size', '18'); edit('input-para-spacing', '1.44');
  edit('input-heading-label', 'Chapter'); edit('input-custom-css', '.milkdown .editor p { color: #123456; }');
  await waitFor(() => source().includes('font-size: 18px') && source().includes('margin-bottom: 1.44em'));
  document.getElementById('btn-export-config').click();
  const exported = JSON.parse(await window.exportedBlob.text());
  const exportDidNotSave = !window.saved;
  document.getElementById('btn-save').click();
  await waitFor(() => window.saved);
  await new Promise(resolve => setTimeout(resolve, 20));
  edit('input-font-size', '14'); edit('input-custom-css', '');
  document.getElementById('btn-reset').click();
  await waitFor(() => source().includes('font-size: 18px'));
  const resetOk = document.getElementById('input-font-size').value === '18' && document.getElementById('input-custom-css').value.includes('#123456');
  const originalDecode = Image.prototype.decode;
  Image.prototype.decode = async function() { await new Promise(resolve => setTimeout(resolve, 250)); return originalDecode.call(this); };
  edit('editor-markdown', '![0.50](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)');
  await new Promise(resolve => setTimeout(resolve, 100));
  edit('editor-markdown', 'Latest body.\\n\\n![1.00](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7 "Crepe 图注")');
  await waitFor(() => source().includes('Latest body.') && source().includes('Crepe 图注</p>'));
  const result = document.createElement('script'); result.id = 'zzhub-wechat-export-result'; result.type = 'application/json';
  result.textContent = JSON.stringify({status:'success',html:JSON.stringify({saved:window.saved,exported,exportDidNotSave,downloadName:window.downloadName,resetOk,html:source()})});
  document.body.appendChild(result);
})();
</script>`);
    const result = extractRenderResult(await dumpReadyHtml({ chromePath: findChrome()!, html, timeoutMs: 15000 }));
    expect(result.status).toBe("success");
    if (!("html" in result)) throw new Error("Studio did not produce HTML");
    const checked = JSON.parse(result.html);
    expect(checked.exported.account).toBeUndefined();
    expect(checked.exported.exportTheme.bodyFontSize).toBe("18px");
    expect(checked.exported.structure.headingLabel).toBe("Chapter");
    expect(checked.exported.css).toContain("#123456");
    expect(checked.exportDidNotSave).toBe(true);
    expect(checked.downloadName).toBe("wechat-style.json");
    tempDir = await mkdtemp(join(tmpdir(), "zzhub-standalone-export-"));
    const profilePath = join(tempDir, "wechat-style.json");
    const markdownPath = join(tempDir, "post.md");
    await writeFile(profilePath, JSON.stringify(checked.exported));
    await writeFile(markdownPath, "## Section\n\nPortable body.");
    const portable = await exportMarkdownToWechatHtml({
      markdownPath, outPath: join(tempDir, "post.html"), account: "ancientone", articleThemePath: profilePath,
      themeOverrides: { exportTheme: { bodyFontSize: "14px" } },
    });
    expect(portable.html).toMatch(/<p[^>]+font-size: 18px[^>]*>Portable body\.<\/p>/);
    expect(portable.html).toContain("Chapter</span>");
    expect(portable.html).toMatch(/color: (?:#123456|rgb\(18, 52, 86\))/);
    expect(checked.saved.exportTheme.bodyFontSize).toBe("18px");
    expect(checked.saved.exportTheme.bodyParagraphSpacing).toBe("1.44em");
    expect(checked.saved.structure.headingLabel).toBe("Chapter");
    expect(checked.resetOk).toBe(true);
    expect(checked.html).toContain("Latest body.");
    expect(checked.html).toContain("Crepe 图注</p>");
  }, 20_000);

  test.skipIf(findChrome() === null)("renders all nodes, cascades CSS, and emits a safe exact preview", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zzhub-wechat-renderer-"));
    const cssPath = join(tempDir, "custom.css");
    const htmlPath = join(tempDir, "article.html");
    const previewPath = join(tempDir, "preview.html");
    await writeFile(cssPath, `
.milkdown .editor { --fixture-paragraph: #123456; }
.milkdown .editor p { color: var(--fixture-paragraph); }
.milkdown .editor h2 { color: #224466; display: grid; position: fixed; }
.milkdown .editor [data-wechat-node="inline-code"] { background-color: #abcdef; }
`, "utf-8");

    const result = await exportMarkdownToWechatHtml({
      markdownPath: fixturePath,
      outPath: htmlPath,
      previewShellOutPath: previewPath,
      customCss: cssPath,
      account: "default",
      title: "全节点精确预览",
    });
    const html = await readFile(htmlPath, "utf-8");
    const preview = await readFile(previewPath, "utf-8");

    expect(result.html).toBe(html);
    expect(html.length).toBeLessThan(65_400);
    expect(html).toContain("二级标题：清晰但不过度装饰");
    expect(html).not.toContain("<blockquote");
    expect(html).toContain("重点结论</span>");
    expect(html).not.toContain("==重点结论==");
    expect(html).toContain("==不高亮==");
    expect(html).toContain("==不是高亮==");
    expect(html).toContain("==只是代码==");
    expect(html).toContain("引用式图注</p>");
    expect(html).toContain("![代码示例](./missing-example.png)");
    expect(html).not.toMatch(/<img[^>]+src="\.\.?\//);
    expect(html).toContain("<table");
    expect(html).toMatch(/<table[^>]*overflow-x: auto/);
    expect(html).toMatch(/<th\b[^>]*white-space: nowrap/);
    expect(html).toMatch(/<td\b[^>]*word-break: break-word/);
    expect(html).toContain("<img ");
    expect(html).toContain("图片说明：克制、清晰、适合移动端阅读");
    expect(html).toContain("typescript</p><pre");
    expect(html).toContain("  title: string;");
    expect(html).toContain("white-space: pre");
    expect(html).toContain("☑");
    expect(html).toContain("☐");
    expect(html).toContain("[1] 外部链接: https://example.com/reading-guide?from=wechat");
    expect(html).toContain("[2] 资料链接: https://example.org/reference");
    expect(html).toContain("相关链接");
    expect(html).toContain("文内链接</span>");
    expect(html).not.toMatch(/<a\b[^>]*href="#/);
    expect(html).toMatch(/color: (?:#123456|rgb\(18, 52, 86\))/);
    expect(html).toMatch(/color: (?:#224466|rgb\(34, 68, 102\))/);
    expect(html).toMatch(/background-color: (?:#abcdef|rgb\(171, 205, 239\))/);
    const inlineStyles = Array.from(
      html.matchAll(/<[a-z][^>]*\sstyle="([^"]*)"/gi),
      (match) => match[1] ?? "",
    );
    expect(inlineStyles.some((style) => style.includes("var("))).toBe(false);

    expect(html).not.toMatch(/\sclass=/i);
    expect(html).not.toContain("data-wechat-node");
    expect(html).not.toContain(".milkdown");
    expect(html).not.toContain(".cm-");
    expect(html).not.toMatch(/<(?:script|style|iframe|object|embed|form|button)\b/i);
    expect(html).not.toMatch(/<[^>]+\son[a-z]+=/i);
    expect(inlineStyles.some((style) => (
      /(?:^|;)\s*display:\s*(?:flex|grid)(?:;|$)/i.test(style) ||
      /(?:^|;)\s*position\s*:/i.test(style)
    ))).toBe(false);
    expect(html).not.toMatch(/<(?:h[1-6]|figure|figcaption|div)\b/i);
    expect(html).toContain("&lt;script&gt;alert('never')&lt;/script&gt;");

    const tagNames = Array.from(html.matchAll(/<\/?([a-z][a-z0-9-]*)\b/gi), (match) => match[1]?.toLowerCase());
    const allowedTags = new Set([
      "section", "p", "ul", "ol", "li", "pre", "code",
      "span", "strong", "em", "b", "i", "u", "s", "del", "a", "img",
      "br", "hr", "table", "thead", "tbody", "tr", "th", "td",
    ]);
    expect(tagNames.every((tagName) => tagName !== undefined && allowedTags.has(tagName))).toBe(true);

    expect(preview).toContain(`<main id="wechat-preview-content">${html}</main>`);
    expect(preview).not.toContain("editor-export.js");
    expect(preview).not.toContain("browser-dist");
  }, 30_000);

  test.skipIf(findChrome() === null)("preserves Crepe image scaling and captions through export and upload URL replacement", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zzhub-wechat-images-"));
    for (const [name, width, height] of [["large", 1200, 600], ["small", 200, 400]] as const) {
      const png = new PNG({ width, height });
      png.data.fill(255);
      await writeFile(join(tempDir, `${name}.png`), PNG.sync.write(png));
    }

    // 同一图片的不同缩放必须各自生效，小图不能按正文宽度放大。
    const scaledImages = [
      { name: "large", ratio: "0.50", width: 50, maxWidth: 600 },
      { name: "large", ratio: "1.00", width: 100, maxWidth: 1200 },
      { name: "large", ratio: "1.50", width: 100, maxWidth: 1800 },
      { name: "small", ratio: "0.50", width: 50, maxWidth: 100 },
      { name: "small", ratio: "1.00", width: 100, maxWidth: 200 },
      { name: "small", ratio: "1.50", width: 100, maxWidth: 300 },
    ];
    const ordinaryAlts = ["普通说明", "", "2026", "0.00", "-0.50", "0.5", "1.00x", "Infinity"];
    const markdownPath = join(tempDir, "images.md");
    await writeFile(markdownPath, [
      ...scaledImages.map(({ name, ratio }, index) => `![${ratio}](./${name}.png "缩放图注 ${index}")`),
      ...ordinaryAlts.map(alt => `![${alt}](./small.png "普通图注")`),
      '行内图片 ![0.50](./small.png "行内图注") 后文',
    ].join("\n\n"));

    const result = await exportMarkdownToWechatHtml({
      markdownPath,
      outPath: join(tempDir, "images.html"),
      account: "default",
    });
    const uploadedHtml = replaceImageUrls(result.html, {
      [join(tempDir, "large.png")]: "https://mmbiz.qpic.cn/large.png",
      [join(tempDir, "small.png")]: "https://mmbiz.qpic.cn/small.png",
    });
    const images = uploadedHtml.match(/<img\b[^>]*>/g) ?? [];
    expect(images).toHaveLength(scaledImages.length + ordinaryAlts.length + 1);
    scaledImages.forEach(({ name, width, maxWidth }, index) => {
      expect(images[index]).toContain(`width: ${width}%;`);
      expect(images[index]).toContain(`max-width: ${maxWidth}px;`);
      expect(images[index]).toContain("height: auto;");
      expect(images[index]).toContain(`src="https://mmbiz.qpic.cn/${name}.png"`);
      expect(images[index]).toContain(`data-src="https://mmbiz.qpic.cn/${name}.png"`);
      expect(uploadedHtml).toMatch(new RegExp(`<p[^>]*>缩放图注 ${index}</p>`));
    });
    ordinaryAlts.forEach((alt, index) => {
      expect(images[scaledImages.length + index]).toContain(`alt="${alt}"`);
      expect(images[scaledImages.length + index]).toContain("width: auto;");
      expect(images[scaledImages.length + index]).toContain("max-width: 100%;");
    });
    expect(uploadedHtml).toMatch(/<p[^>]*>普通图注<\/p>/);
    expect(images.at(-1)).toContain('alt="0.50"');
    expect(images.at(-1)).toContain("width: auto;");
    expect(uploadedHtml).not.toContain(">行内图注</p>");
    expect(uploadedHtml).not.toContain(tempDir);
  }, 30_000);

  test.skipIf(findChrome() === null)("reports an export error when a scaled image cannot be decoded", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zzhub-wechat-image-error-"));
    const markdownPath = join(tempDir, "images.md");
    await writeFile(join(tempDir, "broken.png"), "not an image");
    await writeFile(markdownPath, '![0.50](./broken.png "失败图注")');

    await expect(exportMarkdownToWechatHtml({
      markdownPath,
      outPath: join(tempDir, "images.html"),
      account: "default",
    })).rejects.toMatchObject({
      kind: "render_error",
      message: expect.stringContaining("无法读取缩放图片的原始尺寸"),
    });
  }, 30_000);

  test.skipIf(findChrome() === null)("waits for remote PNG and GIF responses before completing scaled HTML export", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zzhub-wechat-remote-"));
    const png = new PNG({ width: 200, height: 100 });
    png.data.fill(255);
    const pngBytes = PNG.sync.write(png);
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      requested.resolve();
      await release.promise;
      const isGif = request.url.endsWith(".gif");
      return new Response(new Uint8Array(isGif ? gif : pngBytes), { headers: { "content-type": isGif ? "image/gif" : "image/png", "cache-control": "no-store" } });
    } });
    const markdownPath = join(tempDir, "images.md");
    await writeFile(markdownPath, `![0.50](http://127.0.0.1:${server.port}/photo.png "远程图注")\n\n![0.50](http://127.0.0.1:${server.port}/motion.gif "动图图注")`);
    let finished = false;
    const exporting = exportMarkdownToWechatHtml({ markdownPath, outPath: join(tempDir, "images.html"), account: "default" })
      .then(result => { finished = true; return result; });
    try {
      await Promise.race([requested.promise, exporting]);
      // 人为延迟网络响应，确认导出不会提前读到 pending。
      await Bun.sleep(800);
      expect(finished).toBe(false);
      release.resolve();
      const { html } = await exporting;
      expect(html).toContain("width: 50%;");
      expect(html).toContain("max-width: 100px;");
      expect(html).toContain("max-width: 0.5px;");
      expect(html).toContain("远程图注</p>");
      expect(html).toContain("动图图注</p>");
      expect(html).toContain("/motion.gif");
    } finally {
      release.resolve();
      await exporting.catch(() => {});
      await server.stop(true);
    }
  }, 30_000);

  test.skipIf(findChrome() === null)("settles the export result when the browser module fails to load", async () => {
    const html = (await readFile(TEMPLATE_PATH, "utf8"))
      .replace("{{PAGE_TITLE}}", "加载失败")
      .replace("{{CSS_LINK}}", "")
      .replace("{{PAYLOAD_JSON}}", "{}")
      .replace("{{SCRIPT_URL}}", "file:///missing/wechat-editor.js");
    const result = extractRenderResult(await dumpReadyHtml({ chromePath: findChrome()!, html, timeoutMs: 5000 }));
    expect(result).toEqual({ status: "error", error: "failed to load wechat preview bundle" });
  }, 10_000);
});
