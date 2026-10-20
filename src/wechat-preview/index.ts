import { existsSync, readdirSync, statSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { createRequire } from "module";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  ensureParentDir,
  escapeHtml,
  findChrome,
  readUtf8,
  renderTemplate,
} from "../imgx/runtime";
import { ChromeRenderError, dumpReadyHtml } from "../imgx/chrome-render";
import { DomExportError, exportInDom, resolveArticleExportEngine, type ArticleExportEngine } from "./dom-export";
import {
  PACKAGE_ROOT,
  TEMPLATE_PATH,
  DIST_DIR,
  MANIFEST_PATH,
  VITE_CONFIG_PATH,
  WECHAT_PREVIEW_DIR,
} from "../runtime-paths";
import { extractFrontmatter } from "./frontmatter-handler";
import { readArticleTheme, type ArticleThemePackage } from "../article-theme";
import type { WechatThemeOverrides } from "../schema/config";
import { getWechatPreviewStyleName, getWechatPreviewTheme } from "./themes";
import { stripLeadingH1 } from "../text";
import { buildCombinedPresetsCss } from "./browser/studio/syntax-presets";
import type { ArticleStructure } from "./wechat-renderer";

interface ViteManifestEntry {
  file: string;
}

interface BundleAssets {
  scriptPath: string;
  rebuilt: boolean;
  stale: boolean;
}

export type WechatExportErrorKind =
  | "chrome_missing"
  | "chrome_failed"
  | "dom_failed"
  | "timeout"
  | "render_error"
  | "bundle"
  | "other";

export interface WechatExportDebugInfo {
  chrome_path?: string;
  engine?: ArticleExportEngine;
  virtual_time_budget_ms?: number;
  timeout_ms?: number;
  bundle_stale?: boolean;
  bundle_rebuilt?: boolean;
  shell_path?: string;
  stderr_tail?: string;
  debug_dir?: string;
  semantic_html?: string;
}

export class WechatExportError extends Error {
  readonly kind: WechatExportErrorKind;
  readonly durationMs: number;
  readonly debug: WechatExportDebugInfo;
  readonly account: string;
  readonly title?: string;
  readonly markdownPath?: string;

  constructor(
    message: string,
    options: {
      kind: WechatExportErrorKind;
      durationMs: number;
      debug?: WechatExportDebugInfo;
      account: string;
      title?: string;
      markdownPath?: string;
    },
  ) {
    super(message);
    this.name = "WechatExportError";
    this.kind = options.kind;
    this.durationMs = options.durationMs;
    this.debug = options.debug ?? {};
    this.account = options.account;
    this.title = options.title;
    this.markdownPath = options.markdownPath;
  }
}

export interface ExportMarkdownToWechatHtmlInput {
  markdownPath: string;
  outPath: string;
  account: string;
  title?: string;
  previewShellOutPath?: string;
  customCss?: string | null;
  articleThemePath?: string | null;
  themeOverrides?: Partial<WechatThemeOverrides>;
  /** 浏览器真实等待上限，默认 15000 毫秒。 */
  timeoutMs?: number;
  /** Write intermediate artifacts for debugging. */
  debugDir?: string;
  /** 外部插件提供的已构建入口；浏览器和文件输出继续由宿主管理。 */
  browserScriptPath?: string;
}

export interface ExportMarkdownToWechatHtmlResult {
  html: string;
  htmlPath: string;
  account: string;
  previewStyle: string;
  previewShellPath?: string;
  durationMs: number;
  bundleRebuilt: boolean;
  bundleStale: boolean;
  debugDir?: string;
  semanticHtml?: string;
}

const requireFromHere = createRequire(import.meta.url);

/** Absolute path to shared article.css (@akairos/myno). */
export function resolveMilkdownArticleStylePath(): string {
  return requireFromHere.resolve("@akairos/myno/article.css");
}

/** Source files that feed the browser Vite bundle. */
export function getWechatPreviewBundleSources(): string[] {
  const pluginDirectory = dirname(fileURLToPath(import.meta.resolve("@akairos/milkdown-article-plugins")));
  return [
    join(WECHAT_PREVIEW_DIR, "browser/editor-export.ts"),
    join(WECHAT_PREVIEW_DIR, "browser/studio/studio.ts"),
    join(WECHAT_PREVIEW_DIR, "browser/studio/studio.html"),
    join(WECHAT_PREVIEW_DIR, "browser/studio/studio.css"),
    join(WECHAT_PREVIEW_DIR, "browser/studio/syntax-presets.ts"),
    join(WECHAT_PREVIEW_DIR, "browser/studio/color-palettes.ts"),
    join(WECHAT_PREVIEW_DIR, "browser/studio/style-packs.ts"),
    join(WECHAT_PREVIEW_DIR, "browser/studio/milkdown-article-menu.ts"),
    join(WECHAT_PREVIEW_DIR, "browser/studio/myno-editor.ts"),
    join(WECHAT_PREVIEW_DIR, "browser/studio/config-manager.ts"),
    join(WECHAT_PREVIEW_DIR, "themes.ts"),
    join(WECHAT_PREVIEW_DIR, "frontmatter-handler.ts"),
    join(PACKAGE_ROOT, "src/text.ts"),
    ...readdirSync(pluginDirectory).filter(name => name.endsWith(".js")).map(name => join(pluginDirectory, name)),
    resolveMilkdownArticleStylePath(),
    join(WECHAT_PREVIEW_DIR, "wechat-renderer.ts"),
  ];
}

/** 独立配置跨账号复用；目录模板仍沿用账号覆盖顺序。 */
export function resolveWechatArticleTheme(
  account: string,
  overrides?: Partial<WechatThemeOverrides>,
  articleTheme?: ArticleThemePackage | null,
) {
  const standalone = articleTheme?.manifest.css !== undefined;
  const accountOverrides = standalone ? undefined : overrides;
  const { headerImage, ...templateStructure } = articleTheme?.manifest.structure ?? {};
  const theme = getWechatPreviewTheme(standalone ? "default" : account, articleTheme ? {
    editorVars: { ...articleTheme.manifest.editorVars, ...accountOverrides?.editorVars },
    exportTheme: { footerText: "", ...articleTheme.manifest.exportTheme, ...accountOverrides?.exportTheme },
  } : accountOverrides);
  const structure: ArticleStructure | undefined = articleTheme ? {
    ...templateStructure,
    ...accountOverrides?.structure,
    headerImageUrl: headerImage
      ? `data:image/${headerImage.split(".").pop()!.toLowerCase().replace("jpg", "jpeg")};base64,${Buffer.from(articleTheme.files.get(headerImage)!).toString("base64")}` : articleTheme.manifest.structure.headerImageUrl ?? null,
  } : accountOverrides?.structure;
  const syntaxPresets = accountOverrides?.syntaxPresets ?? articleTheme?.manifest.syntaxPresets;
  return { theme, structure, syntaxPresets };
}

export function isWechatPreviewBundleStale(
  sources: string[] = getWechatPreviewBundleSources(),
  manifestPath: string = MANIFEST_PATH,
): boolean {
  if (!existsSync(manifestPath)) return true;
  let distMtime: number;
  try {
    distMtime = statSync(manifestPath).mtimeMs;
  } catch {
    return true;
  }
  for (const src of sources) {
    if (!existsSync(src)) continue;
    try {
      if (statSync(src).mtimeMs > distMtime) return true;
    } catch {
      // ignore unreadable sources
    }
  }
  return false;
}

function buildBundle(): void {
  const result = Bun.spawnSync({
    cmd: ["bun", "x", "vite", "build", "--config", VITE_CONFIG_PATH],
    cwd: PACKAGE_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`Failed to build wechat preview bundle:\n${stderr}`);
  }
}

function readBundleScriptPath(): string {
  const manifestRaw = readUtf8(MANIFEST_PATH);
  const manifest = JSON.parse(manifestRaw) as Record<string, ViteManifestEntry>;
  const entry =
    manifest["src/wechat-preview/browser/editor-export.ts"] ??
    Object.values(manifest)[0];

  if (!entry?.file) {
    throw new Error("Wechat preview manifest missing editor-export entry");
  }

  return join(DIST_DIR, entry.file);
}

function ensureBundle(): BundleAssets {
  const stale = isWechatPreviewBundleStale();
  let rebuilt = false;
  if (!existsSync(MANIFEST_PATH) || stale) {
    try {
      buildBundle();
      rebuilt = true;
    } catch (error) {
      // Fall back to existing dist when rebuild tooling is unavailable (e.g. missing juice).
      if (!existsSync(MANIFEST_PATH)) {
        throw error;
      }
    }
  }

  return {
    scriptPath: readBundleScriptPath(),
    rebuilt,
    stale: stale && !rebuilt,
  };
}

export function escapeInlineJson(value: string): string {
  return value
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026");
}

export function isExternalUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
}

export function resolveMarkdownAsset(rawPath: string, baseDir: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed || isExternalUrl(trimmed) || isAbsolute(trimmed)) {
    return trimmed;
  }
  return resolve(baseDir, trimmed);
}

export function rewriteRelativeImagePaths(markdown: string, baseDir: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\((?:<([^>]+)>|([^)]+?))(?:\s+(["'])([^"']*)\4)?\)/g, (_match, alt, angleUrl, plainUrl, _quote, title) => {
      const src = angleUrl ?? plainUrl ?? "";
      const hasAngleBrackets = angleUrl !== undefined;
      const resolved = resolveMarkdownAsset(src, baseDir);
      const needsBrackets = resolved ? resolved.includes(" ") : src.includes(" ");
      const titleStr = title ? ` "${title}"` : "";
      if (!resolved || resolved === src) {
        const wrap = !!(hasAngleBrackets || needsBrackets);
        return `![${alt}](${wrap ? "<" : ""}${src}${wrap ? ">" : ""}${titleStr})`;
      }
      return `![${alt}](${needsBrackets ? "<" : ""}${resolved}${needsBrackets ? ">" : ""}${titleStr})`;
    })
    .replace(/^([ \t]*\[[^\]]+\]:\s*)(\S+)(.*)$/gm, (match, prefix, rawUrl, suffix) => {
      if (isExternalUrl(rawUrl)) return match;
      const cleanUrl = rawUrl.replace(/^<([^>]+)>$/, "$1");
      const hadAngle = rawUrl.startsWith("<") && rawUrl.endsWith(">");
      const resolved = resolveMarkdownAsset(cleanUrl, baseDir);
      const needsBrackets = resolved ? resolved.includes(" ") : hadAngle;
      return `${prefix}${needsBrackets ? "<" : ""}${resolved}${needsBrackets ? ">" : ""}${suffix}`;
    })
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (_match, prefix, src, suffix) => {
      const resolved = resolveMarkdownAsset(String(src ?? ""), baseDir);
      return `${prefix}${resolved}${suffix}`;
    });
}

export function buildWechatPreviewShell(articleHtml: string, pageTitle: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(pageTitle)}</title>
    <style>
      html { background: #f3f1f2; }
      body { margin: 0; padding: 32px 16px 64px; background: #f3f1f2; }
      #wechat-preview-content { width: 100%; max-width: 430px; margin: 0 auto; padding: 18px 16px; box-sizing: border-box; background: #fff; box-shadow: 0 12px 36px rgba(38, 30, 34, 0.10); }
      @media (max-width: 462px) {
        body { padding: 0; background: #fff; }
        #wechat-preview-content { max-width: none; padding: 16px; box-shadow: none; }
      }
    </style>
  </head>
  <body>
    <main id="wechat-preview-content">${articleHtml}</main>
  </body>
</html>`;
}

async function writePreviewShell(
  previewShellOutPath: string,
  pageTitle: string,
  articleHtml: string,
): Promise<string> {
  await mkdir(dirname(previewShellOutPath), { recursive: true });
  await writeFile(
    previewShellOutPath,
    buildWechatPreviewShell(articleHtml, pageTitle),
    "utf-8",
  );
  return previewShellOutPath;
}

export type ExtractedRenderResult =
  | { status: "success"; html: string; semanticHtml?: string }
  | { status: "error"; error: string }
  | { status: string };

export function extractRenderResult(dom: string): ExtractedRenderResult {
  const match = dom.match(
    /<script id="zzhub-wechat-export-result" type="application\/json">([\s\S]*?)<\/script>/,
  );

  if (!match?.[1]) {
    throw new Error("Wechat preview result script not found");
  }

  return JSON.parse(match[1]) as ExtractedRenderResult;
}

function stderrTail(stderr: string, max = 2000): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(-max);
}

async function writeDebugArtifacts(
  debugDir: string,
  files: Record<string, string | undefined>,
): Promise<void> {
  await mkdir(debugDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (content === undefined) continue;
    await writeFile(join(debugDir, name), content, "utf-8");
  }
}

export async function exportMarkdownToWechatHtml(
  input: ExportMarkdownToWechatHtmlInput,
): Promise<ExportMarkdownToWechatHtmlResult> {
  const started = Date.now();
  const timeoutMs = input.timeoutMs && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 15_000;
  const title = input.title ?? "Wechat Preview Export";
  let chromePath: string | undefined;
  let engine: ArticleExportEngine | undefined;
  let bundleRebuilt = false;
  let bundleStale = false;

  const makeError = (
    kind: WechatExportErrorKind,
    message: string,
    debug: WechatExportDebugInfo = {},
  ): WechatExportError =>
    new WechatExportError(message, {
      kind,
      durationMs: Date.now() - started,
      account: input.account,
      title,
      markdownPath: input.markdownPath,
      debug: {
        chrome_path: chromePath,
        engine,
        timeout_ms: timeoutMs,
        bundle_stale: bundleStale,
        bundle_rebuilt: bundleRebuilt,
        debug_dir: input.debugDir,
        ...debug,
      },
    });

  try {
    try {
      engine = resolveArticleExportEngine();
    } catch (error) {
      throw makeError("other", error instanceof Error ? error.message : String(error));
    }
    // DOM 引擎在子进程中运行导出 bundle，不需要 Chrome。
    if (engine === "chrome") {
      const foundChrome = findChrome();
      if (!foundChrome) {
        throw makeError(
          "chrome_missing",
          "Chrome/Chromium not found. Required for WeChat HTML export.\n" +
            "Install one of:\n" +
            "  macOS:   brew install --cask chromium\n" +
            "  Ubuntu:  sudo apt install chromium-browser\n" +
            "  Or install Google Chrome from https://www.google.com/chrome/\n" +
            "  Or set CHROME_PATH environment variable to the binary path.",
        );
      }
      chromePath = foundChrome;
    }

    let bundle: BundleAssets;
    try {
      bundle = input.browserScriptPath
        ? { scriptPath: input.browserScriptPath, rebuilt: false, stale: false }
        : ensureBundle();
      bundleRebuilt = bundle.rebuilt;
      bundleStale = bundle.stale;
    } catch (error) {
      throw makeError(
        "bundle",
        error instanceof Error ? error.message : String(error),
      );
    }

    const sourceMarkdown = await readFile(input.markdownPath, "utf-8");
    const stripped = extractFrontmatter(sourceMarkdown).content;
    const bodyMarkdown = stripLeadingH1(stripped).trimStart();
    const markdown = bodyMarkdown;
    const articleTheme = input.articleThemePath ? await readArticleTheme(input.articleThemePath) : null;
    const { theme, structure, syntaxPresets } = resolveWechatArticleTheme(input.account, input.themeOverrides, articleTheme);
    const presetsCss = syntaxPresets
      ? buildCombinedPresetsCss(syntaxPresets)
      : "";
    const customCss = [presetsCss, articleTheme?.css, input.customCss ? await readFile(input.customCss, "utf-8") : ""].filter(Boolean).join("\n\n");
    const shell = readUtf8(TEMPLATE_PATH);
    const payload = {
      markdown,
      assetBaseUrl: pathToFileURL(`${dirname(resolve(input.markdownPath))}/`).href,
      editorVars: theme.editorVars,
      exportTheme: theme.exportTheme,
      syntaxPresets,
      customCss,
      structure,
    };
    const payloadJson = escapeInlineJson(JSON.stringify(payload));

    const shellHtml = renderTemplate(shell, {
      "{{PAGE_TITLE}}": escapeHtml(title),
      "{{CSS_LINK}}": "",
      "{{PAYLOAD_JSON}}": payloadJson,
      "{{SCRIPT_URL}}": pathToFileURL(bundle.scriptPath).href,
    });

    let dumpedDom: string;
    let domResult: ExtractedRenderResult | undefined;
    try {
      if (engine === "dom") {
        domResult = await exportInDom({ scriptPath: bundle.scriptPath, payload, baseUrl: payload.assetBaseUrl, timeoutMs });
        dumpedDom = JSON.stringify(domResult);
      } else {
        dumpedDom = await dumpReadyHtml({
          chromePath: chromePath!,
          html: shellHtml,
          timeoutMs,
        });
      }
    } catch (error) {
      if (error instanceof ChromeRenderError || error instanceof DomExportError) {
        if (input.debugDir) {
          await writeDebugArtifacts(input.debugDir, {
            "00-payload-markdown.md": markdown,
            "01-export-shell.html": shellHtml,
            "meta.json": JSON.stringify({
              status: "failed",
              kind: error.kind,
              error: error.message,
              stderr: error.stderr,
              duration_ms: Date.now() - started,
              timeout_ms: timeoutMs,
            }, null, 2),
          });
        }
        throw makeError(error.kind, error.kind === "timeout"
          ? `Wechat preview export did not finish before timeout (${timeoutMs}ms real time)`
          : error.message, {
          shell_path: input.debugDir ? join(input.debugDir, "01-export-shell.html") : undefined,
          stderr_tail: stderrTail(error.stderr),
          debug_dir: input.debugDir,
        });
      }
      throw makeError(
        engine === "dom" ? "dom_failed" : "chrome_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    let result: ExtractedRenderResult;
    try {
      result = domResult ?? extractRenderResult(dumpedDom);
    } catch (error) {
      if (input.debugDir) {
        await writeDebugArtifacts(input.debugDir, {
          "00-payload-markdown.md": markdown,
          "01-export-shell.html": shellHtml,
          "02-dump-dom.html": dumpedDom,
          "meta.json": JSON.stringify({
            status: "failed",
            kind: "render_error",
            error: error instanceof Error ? error.message : String(error),
            duration_ms: Date.now() - started,
          }, null, 2),
        });
      }
      throw makeError(
        "render_error",
        `Wechat preview export returned an invalid result: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (result.status === "error" && "error" in result) {
      if (input.debugDir) {
        await writeDebugArtifacts(input.debugDir, {
          "00-payload-markdown.md": markdown,
          "01-export-shell.html": shellHtml,
          "02-dump-dom.html": dumpedDom,
          "meta.json": JSON.stringify({
            status: "failed",
            kind: "render_error",
            error: result.error,
            duration_ms: Date.now() - started,
          }, null, 2),
        });
      }
      throw makeError("render_error", `Wechat preview export failed: ${result.error}`);
    }
    if (result.status !== "success" || !("html" in result)) {
      if (input.debugDir) {
        await writeDebugArtifacts(input.debugDir, {
          "00-payload-markdown.md": markdown,
          "01-export-shell.html": shellHtml,
          "02-dump-dom.html": dumpedDom,
          "meta.json": JSON.stringify({
            status: "failed",
            kind: "render_error",
            status_value: result.status,
            duration_ms: Date.now() - started,
          }, null, 2),
        });
      }
      throw makeError(
        "render_error",
        `Wechat preview export returned an incomplete result (status=${result.status})`,
      );
    }

    const html = result.html;
    if (process.env.ZZHUB_PIPELINE_WORKER_BUDGET === "1" && Buffer.byteLength(html, "utf8") > 50 * 1024 * 1024) {
      throw makeError("render_error", "Worker HTML export exceeds 50 MiB");
    }
    const semanticHtml =
      "semanticHtml" in result && typeof result.semanticHtml === "string"
        ? result.semanticHtml
        : undefined;

    ensureParentDir(input.outPath);
    await writeFile(input.outPath, html, "utf-8");

    let previewShellPath: string | undefined;
    if (input.previewShellOutPath) {
      previewShellPath = await writePreviewShell(
        input.previewShellOutPath,
        title,
        html,
      );
    }

    const durationMs = Date.now() - started;
    if (input.debugDir) {
      await writeDebugArtifacts(input.debugDir, {
        "00-payload-markdown.md": markdown,
        "01-export-shell.html": shellHtml,
        "02-dump-dom.html": dumpedDom,
        "03-article.html": html,
        "03-semantic.html": semanticHtml,
        "04-preview-shell.html": previewShellPath
          ? await readFile(previewShellPath, "utf-8")
          : buildWechatPreviewShell(html, title),
        "meta.json": JSON.stringify({
          status: "success",
          account: input.account,
          duration_ms: durationMs,
          bundle_rebuilt: bundleRebuilt,
          bundle_stale: bundleStale,
          timeout_ms: timeoutMs,
          html_path: input.outPath,
        }, null, 2),
      });
    }

    return {
      html,
      htmlPath: input.outPath,
      account: input.account,
      previewStyle: getWechatPreviewStyleName(input.account),
      previewShellPath,
      durationMs,
      bundleRebuilt,
      bundleStale,
      debugDir: input.debugDir,
      semanticHtml,
    };
  } catch (error) {
    if (error instanceof WechatExportError) throw error;
    throw makeError("other", error instanceof Error ? error.message : String(error));
  }
}
