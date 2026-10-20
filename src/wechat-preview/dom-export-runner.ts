#!/usr/bin/env bun
/**
 * 在独立 Bun 进程中用 happy-dom 运行浏览器导出 bundle，替代 Chrome。
 *
 * 导出 bundle 只把浏览器当作 DOM：Milkdown 解析 Markdown，juice 内联 CSS，
 * 不读取布局。全局 DOM 只在本进程注册，结果以 JSON 写到 stdout。
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { imageSize } from "image-size";

interface RunnerInput {
  scriptPath: string;
  payload: unknown;
  baseUrl: string;
}

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
// 注册 happy-dom 会替换全局 fetch 并套用页面同源策略；图片读取使用 Bun 原生实现，与 Chrome 加载图片一致。
const nativeFetch = globalThis.fetch;
const REMOTE_IMAGE_TIMEOUT_MS = 10_000;

// bundle 内的日志不能混入 stdout 结果。
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const input = JSON.parse(await Bun.stdin.text()) as RunnerInput;

let settled = false;
let settle!: (result: unknown) => void;
const done = new Promise<unknown>((resolve) => { settle = resolve; });
const setResult = (result: unknown) => {
  if (settled) return;
  settled = true;
  settle(result);
};
const fail = (error: unknown) => setResult({ status: "error", error: error instanceof Error ? error.message : String(error) });
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

GlobalRegistrator.register({
  url: input.baseUrl,
  width: 1024,
  height: 768,
  settings: {
    disableJavaScriptFileLoading: true,
    navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true },
  },
});

async function imageBytes(src: string): Promise<Uint8Array> {
  if (src.startsWith("data:")) {
    const comma = src.indexOf(",");
    if (comma < 0) throw new Error("图片 data URL 无效");
    const meta = src.slice(5, comma);
    const data = decodeURIComponent(src.slice(comma + 1));
    return meta.endsWith(";base64") ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
  }
  if (/^https?:/i.test(src)) {
    const response = await nativeFetch(src, { signal: AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`图片请求失败：HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("图片超过 50 MiB");
    return bytes;
  }
  const url = new URL(src, input.baseUrl);
  if (url.protocol !== "file:") throw new Error(`不支持的图片地址：${url.protocol}`);
  return readFile(fileURLToPath(url));
}

// happy-dom 不解码图片；按真实字节读取原始尺寸，语义与 Chrome 的 decode() 一致。
const imagePrototype = globalThis.HTMLImageElement.prototype as HTMLImageElement & Record<string, unknown>;
imagePrototype.decode = async function decode(this: HTMLImageElement) {
  const src = this.getAttribute("src") || "";
  if (!src) throw new Error("图片地址为空");
  const size = imageSize(await imageBytes(src));
  if (!size.width || !size.height) throw new Error("无法读取图片尺寸");
  Object.defineProperty(this, "naturalWidth", { configurable: true, value: size.width });
  Object.defineProperty(this, "naturalHeight", { configurable: true, value: size.height });
};

document.body.innerHTML = '<div id="app" class="preview-root"><div id="editor-host" class="milkdown-container"></div></div>';
const exportWindow = window as unknown as Record<string, unknown>;
exportWindow.__ZZHUB_SET_RESULT__ = setResult;
exportWindow.__ZZHUB_WECHAT_PAYLOAD__ = input.payload;

try {
  await import(pathToFileURL(input.scriptPath).href);
} catch (error) {
  fail(new Error(`failed to load wechat preview bundle: ${error instanceof Error ? error.message : String(error)}`));
}

const result = await done;
await new Promise<void>((resolve, reject) => {
  process.stdout.write(JSON.stringify(result), (error) => (error ? reject(error) : resolve()));
});
process.exit(0);
