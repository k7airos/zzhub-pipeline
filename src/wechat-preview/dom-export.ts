/**
 * happy-dom 导出引擎：在子进程中运行浏览器导出 bundle，不启动 Chrome。
 *
 * 子进程隔离全局 DOM，超时直接终止，导出结束后内存随进程释放。
 */
import { resolve } from "node:path";
import type { ExtractedRenderResult } from "./index";

export type ArticleExportEngine = "chrome" | "dom";

// HTML 上限 50 MiB，结果另含 semanticHtml，留出两倍余量。
const MAX_RESULT_BYTES = 128 * 1024 * 1024;
const RUNNER_PATH = resolve(import.meta.dir, "dom-export-runner.ts");

export class DomExportError extends Error {
  constructor(message: string, readonly kind: "timeout" | "dom_failed", readonly stderr: string) {
    super(message);
    this.name = "DomExportError";
  }
}

/** 环境变量优先，未设置时使用 Chrome，保持现有部署行为。 */
export function resolveArticleExportEngine(env: Record<string, string | undefined> = process.env): ArticleExportEngine {
  const value = env.PIPELINE_ARTICLE_EXPORT_ENGINE?.trim().toLowerCase();
  if (!value || value === "chrome") return "chrome";
  if (value === "dom") return "dom";
  throw new Error(`PIPELINE_ARTICLE_EXPORT_ENGINE must be chrome or dom, got ${value}`);
}

async function readLimited(stream: ReadableStream<Uint8Array>, limit: number, onExceeded: () => void): Promise<{ text: string; exceeded: boolean }> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let exceeded = false;
  for await (const chunk of stream) {
    if (exceeded) continue;
    bytes += chunk.byteLength;
    if (bytes > limit) {
      exceeded = true;
      chunks.length = 0;
      onExceeded();
      continue;
    }
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), exceeded };
}

export async function exportInDom(options: {
  scriptPath: string;
  payload: unknown;
  baseUrl: string;
  timeoutMs: number;
}): Promise<ExtractedRenderResult> {
  const child = Bun.spawn([process.execPath, RUNNER_PATH], {
    stdin: new Blob([JSON.stringify({ scriptPath: options.scriptPath, payload: options.payload, baseUrl: options.baseUrl })]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, options.timeoutMs);
  try {
    const [stdout, stderrText, exitCode] = await Promise.all([
      readLimited(child.stdout, MAX_RESULT_BYTES, () => child.kill("SIGKILL")),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const stderr = { text: stderrText.slice(-16_384) };
    if (timedOut) throw new DomExportError(`DOM 导出超时（${options.timeoutMs}ms）`, "timeout", stderr.text);
    if (stdout.exceeded) throw new DomExportError("DOM 导出结果超过 128 MiB", "dom_failed", stderr.text);
    if (exitCode !== 0) throw new DomExportError(`DOM 导出进程退出码 ${exitCode}`, "dom_failed", stderr.text);
    try {
      return JSON.parse(stdout.text) as ExtractedRenderResult;
    } catch (error) {
      throw new DomExportError(`DOM 导出返回无效 JSON：${error instanceof Error ? error.message : String(error)}`, "dom_failed", stderr.text);
    }
  } finally {
    clearTimeout(timer);
  }
}
