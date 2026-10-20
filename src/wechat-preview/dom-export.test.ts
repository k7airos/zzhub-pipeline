import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { PNG } from "pngjs";
import { DomExportError, exportInDom, resolveArticleExportEngine } from "./dom-export";
import { exportMarkdownToWechatHtml } from "./index";

describe("happy-dom article export engine", () => {
  let tempDir: string;
  const previousEngine = process.env.PIPELINE_ARTICLE_EXPORT_ENGINE;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zzhub-dom-export-"));
  });

  afterEach(async () => {
    if (previousEngine === undefined) delete process.env.PIPELINE_ARTICLE_EXPORT_ENGINE;
    else process.env.PIPELINE_ARTICLE_EXPORT_ENGINE = previousEngine;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function bundle(source: string): Promise<string> {
    const path = join(tempDir, `bundle-${crypto.randomUUID()}.js`);
    await writeFile(path, source);
    return path;
  }

  function run(scriptPath: string, payload: unknown = {}, timeoutMs = 5_000) {
    return exportInDom({ scriptPath, payload, baseUrl: pathToFileURL(`${tempDir}/`).href, timeoutMs });
  }

  test("defaults to Chrome and accepts only known engines", () => {
    expect(resolveArticleExportEngine({})).toBe("chrome");
    expect(resolveArticleExportEngine({ PIPELINE_ARTICLE_EXPORT_ENGINE: " DOM " })).toBe("dom");
    expect(() => resolveArticleExportEngine({ PIPELINE_ARTICLE_EXPORT_ENGINE: "webkit" })).toThrow("chrome or dom");
  });

  test("runs the bundle against a DOM and keeps bundle logs out of the result", async () => {
    const script = await bundle(`
      console.log("noise");
      const host = document.getElementById("editor-host");
      host.innerHTML = "<p>" + window.__ZZHUB_WECHAT_PAYLOAD__.markdown + "</p>";
      window.__ZZHUB_SET_RESULT__({ status: "success", html: host.innerHTML, semanticHtml: "s" });
    `);
    expect(await run(script, { markdown: "hello" })).toEqual({ status: "success", html: "<p>hello</p>", semanticHtml: "s" });
  });

  test("settles with an error when the bundle fails to load", async () => {
    const script = await bundle(`throw new Error("boom");`);
    const result = await run(script) as { status: string; error: string };
    expect(result.status).toBe("error");
    expect(result.error).toContain("boom");
  });

  test("reports asynchronous bundle failures as export errors", async () => {
    const script = await bundle(`Promise.reject(new Error("late failure"));`);
    expect(await run(script)).toEqual({ status: "error", error: "late failure" });
  });

  test("kills a bundle that never settles", async () => {
    const script = await bundle(`setInterval(() => {}, 1000);`);
    const started = Date.now();
    const error = await run(script, {}, 300).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomExportError);
    expect((error as DomExportError).kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("decodes local and data URL images to their real dimensions", async () => {
    const png = new PNG({ width: 320, height: 90 });
    png.data.fill(255);
    await writeFile(join(tempDir, "photo.png"), PNG.sync.write(png));
    const gif = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const script = await bundle(`
      const sizes = [];
      for (const src of ["photo.png", ${JSON.stringify(gif)}]) {
        const image = new Image();
        image.src = src;
        await image.decode();
        sizes.push([image.naturalWidth, image.naturalHeight]);
      }
      const missing = new Image();
      missing.src = "missing.png";
      const failed = await missing.decode().then(() => false, () => true);
      window.__ZZHUB_SET_RESULT__({ status: "success", html: JSON.stringify({ sizes, failed }) });
    `);
    const result = await run(script) as { html: string };
    expect(JSON.parse(result.html)).toEqual({ sizes: [[320, 90], [1, 1]], failed: true });
  });

  test("exports real articles without Chrome", async () => {
    process.env.PIPELINE_ARTICLE_EXPORT_ENGINE = "dom";
    const png = new PNG({ width: 200, height: 100 });
    png.data.fill(255);
    await writeFile(join(tempDir, "photo.png"), PNG.sync.write(png));
    const markdownPath = join(tempDir, "post.md");
    await writeFile(markdownPath, "## 小节\n\n正文 `inline()`。\n\n```ts\nconst a = 1;\n```\n\n![0.50](photo.png \"图注\")");
    const result = await exportMarkdownToWechatHtml({ markdownPath, outPath: join(tempDir, "post.html"), account: "default" });
    expect(result.html).toContain("max-width: 100px");
    expect(result.html).toContain("图注</p>");
    // 行内代码转为 span，代码块内的 code 不被当作行内代码。
    expect(result.html).toMatch(/<span[^>]*>inline\(\)<\/span>/);
    expect(result.html).toMatch(/<code[^>]*>const a = 1;/);
  });
});
