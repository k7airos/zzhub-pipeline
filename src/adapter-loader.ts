/**
 * Adapter loader — resolves and validates rendering plugins.
 *
 * Priority:
 * 1. User-provided plugin (via config.plugins, executed in an isolated process)
 * 2. Built-in adapter (builtin-imgx / builtin-wechat-preview)
 */

import type { PipelineConfig } from "./schema/config";
import { resolveConfigRelativePath } from "./config";
import type {
  ImageRenderPlugin,
  MarkdownRenderPlugin,
  PipelinePluginDoctorCheck,
} from "./adapter-types";
import { builtinImageRenderer } from "./adapters/builtin-image-renderer";
import { builtinMarkdownRenderer } from "./adapters/builtin-markdown-renderer";
import { PluginBrowserSchema, PluginDoctorSchema, PluginImageOutputSchema, PluginMarkdownOutputSchema, PluginMetadataSchema, PluginStudioSchema, runExternalPlugin } from "./plugin-runtime";
import { exportMarkdownToWechatHtml } from "./wechat-preview";
import { notifyProgress } from "./monitor/recorder";
import { findChrome } from "./imgx/runtime";
import { resolveArticleExportEngine } from "./wechat-preview/dom-export";

// ── Public API ───────────────────────────────────────────────────

/**
 * Resolve the image renderer plugin.
 * 配置外部插件时，加载与调用在子进程执行。
 * Otherwise returns the built-in imgx adapter.
 */
export async function resolveImageRenderer(
  config: PipelineConfig,
): Promise<ImageRenderPlugin> {
  const entry = config.plugins.imageRenderer;
  const specifier = typeof entry === "string" ? entry : entry?.module;

  if (specifier && specifier.trim()) {
    const pluginPath = specifier.trim();
    const options = typeof entry === "object" && entry ? entry.options : {};
    const environment: Record<string, string> = {};
    const metadata = await runExternalPlugin(pluginPath, "describe", PluginMetadataSchema);
    // 兼容仍从环境变量读取目录的 Studio npm 适配器。
    if (metadata.name === "typeset-studio") {
      if (options.dataDir != null && typeof options.dataDir !== "string") {
        throw new Error("Typeset Studio options.dataDir 必须是目录字符串或 null");
      }
      const dataDir = process.env.TYPESET_DATA_DIR?.trim() || resolveConfigRelativePath(options.dataDir as string | null | undefined);
      if (dataDir) environment.TYPESET_DATA_DIR = dataDir;
      environment.TYPESET_STUDIO_URL = "";
      environment.TYPESET_ADMIN_KEY = "";
    }
    const configuration = { options, environment };
    return {
      name: metadata.name,
      version: metadata.version,
      ...(metadata.hasDoctor ? { doctor: () => runExternalPlugin(pluginPath, "doctor", PluginDoctorSchema, undefined, configuration) } : {}),
      render: ({ onProgress, ...input }) => runExternalPlugin(pluginPath, "render", PluginImageOutputSchema, input, configuration, onProgress),
    };
  }

  return builtinImageRenderer;
}

/**
 * Resolve the markdown renderer plugin.
 * 配置外部插件时，加载与调用在子进程执行。
 * Otherwise returns the built-in wechat-preview adapter.
 */
export async function resolveMarkdownRenderer(
  config: PipelineConfig,
): Promise<MarkdownRenderPlugin> {
  const entry = config.plugins.markdownRenderer;
  const specifier = typeof entry === "string" ? entry : entry?.module;

  if (specifier && specifier.trim()) {
    const pluginPath = specifier.trim();
    const options = typeof entry === "object" && entry ? entry.options : {};
    const metadata = await runExternalPlugin(pluginPath, "describe", PluginMetadataSchema);
    return {
      name: metadata.name,
      version: metadata.version,
      ...(metadata.hasDoctor || metadata.hasBrowser ? { doctor: async () => {
        const checks = metadata.hasDoctor ? await runExternalPlugin(pluginPath, "doctor", PluginDoctorSchema, undefined, { options }) : [];
        if (metadata.hasBrowser) {
          if (resolveArticleExportEngine() === "dom") {
            checks.push({ name: "chrome", ok: true, message: "not required (PIPELINE_ARTICLE_EXPORT_ENGINE=dom)" });
          } else {
            const chrome = findChrome();
            checks.push({ name: "chrome", ok: Boolean(chrome), message: chrome ?? "Chrome/Chromium not found" });
          }
        }
        return checks;
      } } : {}),
      ...(metadata.hasStudio ? { studio: () => runExternalPlugin(pluginPath, "studio", PluginStudioSchema, undefined, { options }) } : {}),
      render: async ({ onProgress, ...input }) => {
        if (metadata.hasBrowser) {
          const browser = await runExternalPlugin(pluginPath, "browser", PluginBrowserSchema, undefined, { options });
          notifyProgress(onProgress, { stage: "render.html", message: "正在导出微信 HTML" });
          const result = await exportMarkdownToWechatHtml({ ...input, browserScriptPath: browser.scriptPath });
          notifyProgress(onProgress, { stage: "render.html", message: "微信 HTML 导出完成", current: 1, total: 1, unit: "files" });
          return result;
        }
        return runExternalPlugin(pluginPath, "render", PluginMarkdownOutputSchema, input, { options }, onProgress,
          input.timeoutMs && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs + 10_000 : 120_000);
      },
    };
  }

  return builtinMarkdownRenderer;
}

/**
 * Run doctor checks on resolved plugins.
 */
export async function runPluginDoctorChecks(
  config: PipelineConfig,
): Promise<PipelinePluginDoctorCheck[]> {
  const checks: PipelinePluginDoctorCheck[] = [];

  try {
    const imageRenderer = await resolveImageRenderer(config);
    if (imageRenderer.doctor) {
      checks.push(...(await imageRenderer.doctor()));
    } else {
      checks.push({ name: imageRenderer.name, ok: true, message: "no doctor check defined" });
    }
  } catch (err) {
    checks.push({
      name: "image-renderer",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const markdownRenderer = await resolveMarkdownRenderer(config);
    if (markdownRenderer.doctor) {
      checks.push(...(await markdownRenderer.doctor()));
    } else {
      checks.push({ name: markdownRenderer.name, ok: true, message: "no doctor check defined" });
    }
  } catch (err) {
    checks.push({
      name: "markdown-renderer",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return checks;
}
