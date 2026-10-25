import { existsSync, readFileSync } from "fs";
import { basename, extname } from "path";
import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import { PipelineConfig, WxAccountConfig } from "../config";
import { reportProgress } from "../monitor/recorder";

const TOKEN_PATH = "/api/v1/wx/cgi-bin/token";
const MATERIAL_PATH = "/api/v1/wx/cgi-bin/material/add_material";
const DRAFT_ADD_PATH = "/api/v1/wx/cgi-bin/draft/add";
const DRAFT_UPDATE_PATH = "/api/v1/wx/cgi-bin/draft/update";
const DRAFT_GET_PATH = "/api/v1/wx/cgi-bin/draft/get";
const DRAFT_DELETE_PATH = "/api/v1/wx/cgi-bin/draft/delete";
const BATCH_GET_PATH = "/api/v1/wx/cgi-bin/draft/batchget";
const TOKEN_TIMEOUT = 10000;
const UPLOAD_TIMEOUT = 60000;
const DRAFT_TIMEOUT = 30000;
const TOKEN_FETCH_RETRY_MAX_ATTEMPTS = 3;
const TOKEN_FETCH_RETRY_DELAY_MS = 500;
const IMAGE_DOWNLOAD_TIMEOUT = 30000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/bmp", "bmp"],
]);

const EXTENSION_CONTENT_TYPES = new Map<string, string>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
]);

interface TokenResponse {
  code?: number;
  data?: {
    accessToken?: string;
    expiresIn?: number;
  };
  accessToken?: string;
}

interface UploadApiResponse {
  code?: number;
  message?: string;
  data?: { media_id?: string; url?: string };
  media_id?: string;
  url?: string;
  errcode?: number;
  errmsg?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function asApiCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function resolveDraftMediaId(
  response: unknown,
  existingDraftMediaId?: string | null,
): string {
  const record = asRecord(response);
  const data = asRecord(record.data);
  const errcode = asApiCode(record.errcode) ?? asApiCode(data.errcode) ?? 0;
  const code = asApiCode(record.code) ?? asApiCode(data.code) ?? 0;
  if (errcode !== 0 || (code !== 0 && code !== 200)) {
    const message = record.errmsg ?? record.message ?? data.errmsg ?? data.message ?? "Unknown error";
    throw new Error(`WeChat draft API error: ${errcode || code} - ${String(message)}`);
  }

  if (existingDraftMediaId) {
    return existingDraftMediaId;
  }
  const mediaId = typeof data.media_id === "string"
    ? data.media_id
    : typeof record.media_id === "string"
      ? record.media_id
      : null;
  if (!mediaId) {
    throw new Error("WX_RESULT_UNKNOWN: WeChat draft API response did not include media_id");
  }
  return mediaId;
}

interface UploadedMedia {
  originalUrl: string;
  mediaId: string;
  wxUrl: string;
  index: number;
}

interface UploadResult {
  uploadedMedia: UploadedMedia[];
  imageUrlMap: Record<string, string>;
  coverMediaId: string;
  totalUploaded: number;
  photos: string[];
  coverCrop?: ReturnType<typeof calculatePicCrop>;
}

interface WxRuntimeConfig {
  accountName: string;
  baseUrl: string;
  timeout: number;
  pat: string;
  appId: string;
  appSecret: string;
}

interface BaseWechatPublishInput {
  account?: string;
  title: string;
  photos?: string[];
  timeout?: number;
  config: PipelineConfig;
  noteId?: string | null;
  /** 同一运行的同一发布版本复用幂等标识。 */
  idempotencyKey?: string;
  nezusBaseUrl?: string | null;
  nezusPat?: string | null;
}

export interface WechatDraftInput extends BaseWechatPublishInput {
  /** 冻结产物已给出真实图片清单，禁止从代码文本再猜图片来源。 */
  explicitPhotos?: boolean;
  html: string;
  existingDraftMediaId?: string | null;
}

export interface WechatNewspicInput extends BaseWechatPublishInput {
  /** 明确选择配图时，不从正文中的示例语法补充图片。 */
  explicitPhotos?: boolean;
  content: string;
  existingDraftMediaId?: string | null;
}

function requireValue(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required value: ${name}`);
  }
  return value;
}

export function normalizeAccountName(value: string): string {
  const account = value.trim();
  if (!account) {
    throw new Error("wx account cannot be empty");
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(account)) {
    throw new Error(`invalid wx account: ${value}`);
  }
  return account;
}

/** Fill missing wx account fields with defaults. Preserves optional display `name`. */
export function fillWxAccountConfig(source?: WxAccountConfig): WxAccountConfig {
  return {
    name: source?.name ?? "",
    pat: source?.pat ?? "",
    appId: source?.appId ?? "",
    appSecret: source?.appSecret ?? "",
    customCss: source?.customCss ?? null,
    ...(source?.articleTheme ? { articleTheme: source.articleTheme } : {}),
    theme: source?.theme ?? { editorVars: {}, exportTheme: {} },
  } as WxAccountConfig;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function getWxRuntimeConfig(
  config: PipelineConfig,
  accountOverride?: string,
): WxRuntimeConfig {
  const accountName = normalizeAccountName(
    accountOverride || config.wx.defaultAccount,
  );
  const configuredAccount = config.wx.accounts[accountName];
  // 云端 worker 以每个任务的环境变量注入凭据，不要求把用户账号写进基础 config。
  const hasInjectedCredentials = Boolean(process.env.WX_APPID && process.env.WX_APPSECRET && process.env.ZZCLUB_PAT);
  if (!configuredAccount && !hasInjectedCredentials) {
    throw new Error(`Unknown wx account: ${accountName}`);
  }
  const accountConfig = fillWxAccountConfig(configuredAccount);
  return {
    accountName,
    baseUrl: trimTrailingSlash(process.env.ZZHUB_WX_BASE_URL || config.wx.baseUrl),
    timeout: config.wx.timeout,
    pat: requireValue(
      "ZZCLUB_PAT",
      process.env.ZZCLUB_PAT || accountConfig.pat,
    ),
    appId: requireValue(
      "WX_APPID",
      process.env.WX_APPID || accountConfig.appId,
    ),
    appSecret: requireValue(
      "WX_APPSECRET",
      process.env.WX_APPSECRET || accountConfig.appSecret,
    ),
  };
}

export function resolveTimeout(defaultTimeout: number, configTimeout: number, override?: number): number {
  if (override && Number.isFinite(override) && override > 0) {
    return override;
  }
  if (configTimeout && Number.isFinite(configTimeout) && configTimeout > 0) {
    return configTimeout;
  }
  return defaultTimeout;
}

export function parsePhotos(photos?: string[]): string[] {
  return (photos ?? []).map((item) => item.trim()).filter(Boolean);
}

export function mergePhotoLists(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      const normalized = item.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      merged.push(normalized);
    }
  }
  return merged;
}

export function extractImageUrls(input: string): string[] {
  const urls = new Set<string>();
  // Handle both standard ![alt](url) and angle-bracket ![alt](<url>) syntax.
  // Angle brackets allow URLs with spaces per CommonMark spec.
  // Match markdown images: ![alt](url) and ![alt](<url with spaces>)
  // Second alternative uses lazy match so titles like ![alt](url "title") still work.
  const markdownImageRegex = /!\[[^\]]*\]\((?:<([^>]+)>|([^)]+?))(?:\s+"[^"]*")?\)/g;
  const htmlImageRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/g;
  let match = markdownImageRegex.exec(input);
  while (match) {
    const url = match[1] || match[2];
    if (url) {
      urls.add(url);
    }
    match = markdownImageRegex.exec(input);
  }
  match = htmlImageRegex.exec(input);
  while (match) {
    if (match[1]) {
      urls.add(match[1]);
    }
    match = htmlImageRegex.exec(input);
  }
  // Filter out URLs that look like HTML fragments (unescaped code block content
  // that was incorrectly matched by the image regex patterns).
  return [...urls].filter((url) => {
    if (url.startsWith('<') || url.includes('/>')) return false;
    return true;
  });
}

export function replaceImageUrls(html: string, imageUrlMap: Record<string, string>): string {
  let replaced = html;
  for (const [orig, wx] of Object.entries(imageUrlMap)) {
    if (!orig || !wx) {
      continue;
    }
    // Base64 图片地址可能数 MB，按字面替换，避免超大正则及替换串转义。
    replaced = replaced.replaceAll(orig, () => wx);
  }
  return replaced;
}

export async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<ArrayBuffer> {
  const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Image exceeds ${maxBytes} byte limit`);
  }
  if (!response.body) {
    return new ArrayBuffer(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Image exceeds ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

/** 服务端错误只保留分类和脱敏提示，正文及凭据不进入 Pipeline 状态。 */
class WxServiceHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function serviceError(response: Response, payload: unknown, mutating: boolean): Error {
  const detail = asRecord(payload);
  const code = String(asRecord(detail.data).code || "WX_SERVICE_ERROR").replace(/[^A-Z0-9_]/g, "").slice(0, 80);
  if (mutating && response.status >= 500 && !code.startsWith("WX_")) return unknownResult();
  if (mutating && response.status >= 500 && code === "WX_SERVICE_ERROR") return unknownResult();
  const message = String(detail.statusMessage || detail.message || "发布服务请求失败")
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:access_token|token|pat|appSecret|secret)["']?\s*[:=]\s*)["']?[^\s"'&,}]+["']?/gi, "$1[redacted]");
  const requestId = response.headers.get("x-request-id") || String(detail.requestId || "");
  const trace = /^[a-zA-Z0-9_-]{1,100}$/.test(requestId) ? ` [request ${requestId}]` : "";
  return new WxServiceHttpError(response.status, `API request failed with status ${response.status}: ${code}: ${message.slice(0, 300)}${trace}`);
}

function unknownResult(): Error {
  return new Error("WX_RESULT_UNKNOWN: 请求结果未确认，请检查公众号草稿箱后再决定是否重试");
}

/** 网络、响应读取及 JSON 解析中断都可能发生在上游已经写入之后。 */
async function requestWechat(url: string, options: RequestInit, timeout: number): Promise<unknown> {
  const mutating = /\/draft\/(?:add|update|delete)$/.test(url);
  let response: Response;
  let payload: unknown;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
    const responseText = await response.text();
    try { payload = responseText ? JSON.parse(responseText) : {}; }
    catch {
      if (response.ok || mutating) throw new Error("invalid response");
      payload = {};
    }
  } catch (error) {
    if (mutating) throw unknownResult();
    throw error;
  }
  if (!response.ok) throw serviceError(response, payload, mutating);
  return payload;
}

async function requestJson(
  url: string,
  options: { method: string; headers?: Record<string, string>; body?: unknown },
  timeout: number,
): Promise<unknown> {
  return requestWechat(url, { ...options, body: options.body ? JSON.stringify(options.body) : undefined }, timeout);
}

async function requestFormData(
  url: string,
  options: { method: string; headers?: Record<string, string>; body: FormData },
  timeout: number,
): Promise<unknown> {
  return requestWechat(url, options, timeout);
}

async function postDraft(
  runtime: WxRuntimeConfig,
  draftPath: string,
  draftBody: unknown,
  idempotencyKey: string | undefined,
  timeout: number,
): Promise<unknown> {
  return requestJson(
    `${runtime.baseUrl}${draftPath}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtime.pat}`,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: draftBody,
    },
    timeout,
  );
}

// 远端草稿可能在公众号后台被人工删除；用 draft/get 明确确认，避免把内容错误误判为草稿丢失。
async function remoteDraftMissing(
  runtime: WxRuntimeConfig,
  accessToken: string,
  mediaId: string,
  timeout: number,
): Promise<boolean> {
  try {
    await requestJson(
      `${runtime.baseUrl}${DRAFT_GET_PATH}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${runtime.pat}` },
        body: { access_token: accessToken, media_id: mediaId },
      },
      timeout,
    );
    return false;
  } catch (error) {
    // 只有中转层的明确 4xx 拒绝才视为草稿不存在；网络中断等未知结果保守返回 false。
    return error instanceof WxServiceHttpError && error.status >= 400 && error.status < 500;
  }
}

// 重建草稿是新的外部写操作：派生独立幂等键，避免与原 update 请求在中转层指纹冲突。
function recreateDraftIdempotencyKey(idempotencyKey: string | undefined): string | undefined {
  return idempotencyKey ? createHash("sha256").update(`wx-recreate:${idempotencyKey}`).digest("hex") : undefined;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableTokenFetchError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("fetch failed");
}

async function requestToken(
  runtime: WxRuntimeConfig,
  timeout: number,
): Promise<TokenResponse> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= TOKEN_FETCH_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await requestJson(
        `${runtime.baseUrl}${TOKEN_PATH}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${runtime.pat}`,
          },
          body: { appId: runtime.appId, appSecret: runtime.appSecret },
        },
        timeout,
      );
      return response as TokenResponse;
    } catch (error) {
      lastError = error;
      if (!isRetryableTokenFetchError(error) || attempt >= TOKEN_FETCH_RETRY_MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(TOKEN_FETCH_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("failed to fetch access_token");
}

async function fetchAccessToken(runtime: WxRuntimeConfig, timeout: number): Promise<string> {
  const response = await requestToken(runtime, timeout);
  const accessToken = response.data?.accessToken || response.accessToken;
  if (!accessToken) {
    throw new Error("Access token not found in wx token response");
  }
  return accessToken;
}

async function resolvePhotoPayload(
  photoUrl: string,
  index: number,
): Promise<{ blob: Blob; filename: string }> {
  if (photoUrl.startsWith("data:")) {
    const matches = photoUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid data URL format");
    }
    const contentType = matches[1] || "image/png";
    if (!IMAGE_EXTENSIONS.has(contentType.toLowerCase())) {
      throw new Error(`Unsupported data URL image type: ${contentType}`);
    }
    const buffer = Buffer.from(matches[2] || "", "base64");
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit`);
    }
    const extension = IMAGE_EXTENSIONS.get(contentType.toLowerCase()) || "png";
    return {
      blob: new Blob([buffer], { type: contentType }),
      filename: `image_${index + 1}.${extension}`,
    };
  }

  if (photoUrl.startsWith("http://") || photoUrl.startsWith("https://")) {
    const safeUrl = photoUrl.includes(" ") ? photoUrl.replace(/ /g, "%20") : photoUrl;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT);
    try {
      const response = await fetch(safeUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to download image: HTTP ${response.status}`);
      }
      const contentType = (response.headers.get("content-type") || "")
        .split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (!contentType || !IMAGE_EXTENSIONS.has(contentType)) {
        throw new Error(`Downloaded resource is not a supported image: ${contentType || "unknown type"}`);
      }
      const buffer = await readResponseBodyWithLimit(response, MAX_IMAGE_BYTES);
      return {
        blob: new Blob([buffer], { type: contentType }),
        filename: resolveFilenameFromUrl(photoUrl, contentType, index),
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (photoUrl.startsWith("file://")) {
    const safeUrl = photoUrl.replace(/ /g, "%20");
    const url = new URL(safeUrl);
    return resolveFilePayload(decodeURIComponent(url.pathname), index);
  }

  return resolveFilePayload(photoUrl, index);
}

function resolveFilePayload(
  filePath: string,
  index: number,
): { blob: Blob; filename: string } {
  // Detect HTML fragments incorrectly extracted as image URLs (defense-in-depth)
  if (filePath.startsWith("<") && (filePath.includes("style=") || filePath.includes("</") || filePath.includes("/>"))) {
    throw new Error(
      `Image URL appears to be HTML content, not a valid file path or URL. ` +
      `This usually means extractImageUrls matched unescaped HTML from a code block. ` +
      `Got: ${filePath.slice(0, 120)}`,
    );
  }
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const ext = extname(filePath).toLowerCase();
  const contentType = EXTENSION_CONTENT_TYPES.get(ext);
  if (!contentType) {
    throw new Error(`Unsupported local image type: ${ext || "no extension"}`);
  }
  const buffer = readFileSync(filePath);
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte limit: ${filePath}`);
  }
  const extension = IMAGE_EXTENSIONS.get(contentType.toLowerCase()) || ext.replace(".", "") || "jpg";
  const baseName = basename(filePath, ext) || `image_${index + 1}`;
  return {
    blob: new Blob([buffer], { type: contentType }),
    filename: ext ? `${baseName}${ext}` : `${baseName}.${extension}`,
  };
}

export function resolveFilenameFromUrl(url: string, contentType: string, index: number): string {
  const urlParts = url.split("/");
  let filename = urlParts[urlParts.length - 1] || `image_${index + 1}`;
  filename = filename.split("?")[0] || filename;
  const expectedExt = IMAGE_EXTENSIONS.get(contentType.toLowerCase()) || "jpg";
  const hasExtension = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(filename);

  if (!hasExtension) {
    return `${filename}.${expectedExt}`;
  }

  const urlExt = filename.split(".").pop()?.toLowerCase();
  if (urlExt && urlExt !== expectedExt) {
    return filename.replace(/\.[^.]+$/, `.${expectedExt}`);
  }

  return filename;
}

async function uploadPhotos(
  runtime: WxRuntimeConfig,
  accessToken: string,
  photos: string[],
  timeout: number,
): Promise<UploadResult> {
  const uploadedMedia: UploadedMedia[] = [];
  const imageUrlMap: Record<string, string> = {};
  let coverCrop: UploadResult["coverCrop"];

  for (let index = 0; index < photos.length; index += 1) {
    const photoUrl = photos[index];
    if (!photoUrl) {
      continue;
    }

    reportProgress({ stage: "publish.upload", message: "正在上传微信图片", current: index, total: photos.length, unit: "files" });
    const payload = await resolvePhotoPayload(photoUrl, index);
    if (index === 0) {
      try {
        // 直接读取待上传的封面字节，远程、Data URL 与本地图片共用。
        const { width, height } = imageSize(new Uint8Array(await payload.blob.arrayBuffer()));
        if (width && height) coverCrop = calculatePicCrop(width, height);
      } catch {
        // 部分微信支持的格式无法检测尺寸，沿用微信默认裁剪。
      }
    }
    const formData = new FormData();
    formData.append("access_token", accessToken);
    formData.append("type", "image");
    formData.append("media", payload.blob, payload.filename);

    const response = await requestFormData(
      `${runtime.baseUrl}${MATERIAL_PATH}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${runtime.pat}` },
        body: formData,
      },
      timeout,
    );

    const result = response as UploadApiResponse;
    if (result.errcode && result.errcode !== 0) {
      throw new Error(`WeChat API error: ${result.errcode} - ${result.errmsg || "Unknown"}`);
    }

    const mediaId = result.data?.media_id || result.media_id;
    const wxUrl = result.data?.url || result.url || "";
    if (!mediaId) {
      throw new Error(`Upload API error: No media_id in response. Raw: ${JSON.stringify(result)}`);
    }

    uploadedMedia.push({
      originalUrl: photoUrl,
      mediaId,
      wxUrl,
      index,
    });
    imageUrlMap[photoUrl] = wxUrl || photoUrl;
    reportProgress({ stage: "publish.upload", current: index + 1, total: photos.length, unit: "files" });
  }

  return {
    uploadedMedia,
    imageUrlMap,
    coverMediaId: uploadedMedia[0]?.mediaId || "",
    totalUploaded: uploadedMedia.length,
    photos: photos.map((url) => imageUrlMap[url] || url),
    coverCrop,
  };
}

/** 仅识别内置 3.35:1 拼图，普通封面 1:1 靠右、2.35:1 居中裁切。 */
export function calculatePicCrop(width: number, height: number): { pic_crop_235_1: string; pic_crop_1_1: string } {
  if (Math.abs(width - height * 3.35) <= 1) {
    // 微信头图 split 双比例：左侧 2.35:1，右侧 1:1
    const splitX = Math.min(1, (height * 2.35) / width);
    return {
      pic_crop_235_1: `0_0_${splitX.toFixed(4)}_1`,
      pic_crop_1_1: `${splitX.toFixed(4)}_0_1_1`,
    };
  }
  const cropAtRatio = (targetRatio: number): string => {
    const cropWidth = Math.min(1, height * targetRatio / width);
    const cropHeight = Math.min(1, width / targetRatio / height);
    const x = targetRatio === 1 ? 1 - cropWidth : (1 - cropWidth) / 2;
    const y = (1 - cropHeight) / 2;
    return [x, y, x + cropWidth, y + cropHeight].map(value => value.toFixed(4)).join("_");
  };
  return {
    pic_crop_235_1: cropAtRatio(2.35),
    pic_crop_1_1: cropAtRatio(1),
  };
}

export async function createWechatDraft(input: WechatDraftInput): Promise<Record<string, unknown>> {
  const runtime = getWxRuntimeConfig(input.config, input.account);
  const fallbackPhotos = input.explicitPhotos ? [] : extractImageUrls(input.html);
  const photos = parsePhotos(input.photos);
  const finalPhotos = mergePhotoLists(photos, fallbackPhotos);
  if (finalPhotos.length === 0) {
    throw new Error("No photos available for wx draft upload");
  }

  const tokenTimeout = resolveTimeout(TOKEN_TIMEOUT, runtime.timeout, input.timeout);
  const uploadTimeout = resolveTimeout(UPLOAD_TIMEOUT, runtime.timeout, input.timeout);
  const draftTimeout = resolveTimeout(DRAFT_TIMEOUT, runtime.timeout, input.timeout);
  const accessToken = await fetchAccessToken(runtime, tokenTimeout);
  const uploadResult = await uploadPhotos(runtime, accessToken, finalPhotos, uploadTimeout);
  const replacedHtml = replaceImageUrls(input.html, uploadResult.imageUrlMap);

  const cropParams = uploadResult.coverCrop ?? {};

  const isUpdate = !!input.existingDraftMediaId;
  const article = {
    article_type: "news",
    title: input.title,
    content: replacedHtml,
    thumb_media_id: uploadResult.coverMediaId,
    ...cropParams,
  } as const;
  const draftBody = isUpdate
    ? {
        access_token: accessToken,
        media_id: input.existingDraftMediaId,
        index: 0,
        articles: article,
      }
    : {
        access_token: accessToken,
        articles: [article],
      };

  let response: unknown;
  let recreated = false;
  try {
    response = await postDraft(runtime, isUpdate ? DRAFT_UPDATE_PATH : DRAFT_ADD_PATH, draftBody, input.idempotencyKey, draftTimeout);
  } catch (error) {
    // 原草稿已在公众号后台被删除时，更新永远失败；确认后降级为新建，让本次更新仍然完成。
    if (!isUpdate || !(await remoteDraftMissing(runtime, accessToken, input.existingDraftMediaId!, draftTimeout))) throw error;
    console.warn(`[wechat] existing draft ${input.existingDraftMediaId} is gone on the remote account; recreating via draft/add`);
    response = await postDraft(
      runtime,
      DRAFT_ADD_PATH,
      { access_token: accessToken, articles: [article] },
      recreateDraftIdempotencyKey(input.idempotencyKey),
      draftTimeout,
    );
    recreated = true;
  }

  const draftMediaId = resolveDraftMediaId(response, recreated ? null : input.existingDraftMediaId);

  // ── Callback to Nezus to persist media_id ──
  if (draftMediaId && input.noteId && input.nezusBaseUrl && input.nezusPat) {
    await notifyNezusPublishResult({
      nezusBaseUrl: input.nezusBaseUrl,
      nezusPat: input.nezusPat,
      noteId: input.noteId,
      wechatMediaId: draftMediaId,
      publishType: "article",
    });
  }

  return {
    account: runtime.accountName,
    articleType: "news",
    title: input.title,
    photosCount: finalPhotos.length,
    totalUploaded: uploadResult.totalUploaded,
    coverMediaId: uploadResult.coverMediaId,
    isUpdate,
    ...(recreated ? { recreated, originalDraftMediaId: input.existingDraftMediaId } : {}),
    draftMediaId,
    response,
  };
}

export async function createWechatNewspic(input: WechatNewspicInput): Promise<Record<string, unknown>> {
  // 配文超限时在上传图片前拒绝，避免微信返回不明确的 45166。
  if (Buffer.byteLength(input.content, "utf8") > 2048)
    throw new Error("贴图配文过长，请精简至 2KB 以内；完整文章可保留在内容图中");
  const runtime = getWxRuntimeConfig(input.config, input.account);
  const fallbackPhotos = input.explicitPhotos ? [] : extractImageUrls(input.content);
  const photos = parsePhotos(input.photos);
  const finalPhotos = mergePhotoLists(photos, fallbackPhotos);
  if (finalPhotos.length === 0) {
    throw new Error("No photos available for wx newspic upload");
  }
  if (finalPhotos.length > 20)
    throw new Error("微信贴图最多支持 20 张配图");

  const tokenTimeout = resolveTimeout(TOKEN_TIMEOUT, runtime.timeout, input.timeout);
  const uploadTimeout = resolveTimeout(UPLOAD_TIMEOUT, runtime.timeout, input.timeout);
  const draftTimeout = resolveTimeout(DRAFT_TIMEOUT, runtime.timeout, input.timeout);
  const accessToken = await fetchAccessToken(runtime, tokenTimeout);
  const uploadResult = await uploadPhotos(runtime, accessToken, finalPhotos, uploadTimeout);

  const imageInfo = {
    image_list: uploadResult.uploadedMedia
      .map((item) => ({ image_media_id: item.mediaId })),
  };

  const isUpdate = !!input.existingDraftMediaId;
  const article = {
    article_type: "newspic",
    title: input.title,
    content: input.content,
    thumb_media_id: uploadResult.coverMediaId,
    image_info: imageInfo,
  } as const;
  const draftBody = isUpdate
    ? {
        access_token: accessToken,
        media_id: input.existingDraftMediaId,
        index: 0,
        articles: article,
      }
    : {
        access_token: accessToken,
        articles: [article],
      };

  let response: unknown;
  let recreated = false;
  try {
    response = await postDraft(runtime, isUpdate ? DRAFT_UPDATE_PATH : DRAFT_ADD_PATH, draftBody, input.idempotencyKey, draftTimeout);
  } catch (error) {
    // 原草稿已在公众号后台被删除时，更新永远失败；确认后降级为新建，让本次更新仍然完成。
    if (!isUpdate || !(await remoteDraftMissing(runtime, accessToken, input.existingDraftMediaId!, draftTimeout))) throw error;
    console.warn(`[wechat] existing draft ${input.existingDraftMediaId} is gone on the remote account; recreating via draft/add`);
    response = await postDraft(
      runtime,
      DRAFT_ADD_PATH,
      { access_token: accessToken, articles: [article] },
      recreateDraftIdempotencyKey(input.idempotencyKey),
      draftTimeout,
    );
    recreated = true;
  }

  const draftMediaId = resolveDraftMediaId(response, recreated ? null : input.existingDraftMediaId);

  // ── Callback to Nezus to persist media_id ──
  if (draftMediaId && input.noteId && input.nezusBaseUrl && input.nezusPat) {
    await notifyNezusPublishResult({
      nezusBaseUrl: input.nezusBaseUrl,
      nezusPat: input.nezusPat,
      noteId: input.noteId,
      wechatMediaId: draftMediaId,
      publishType: "newspic",
    });
  }

  return {
    account: runtime.accountName,
    articleType: "newspic",
    title: input.title,
    photosCount: finalPhotos.length,
    totalUploaded: uploadResult.totalUploaded,
    coverMediaId: uploadResult.coverMediaId,
    isUpdate,
    ...(recreated ? { recreated, originalDraftMediaId: input.existingDraftMediaId } : {}),
    draftMediaId,
    response,
  };
}

// ── Nezus callback ────────────────────────────────────────────────

async function notifyNezusPublishResult(params: {
  nezusBaseUrl: string;
  nezusPat: string;
  noteId: string;
  wechatMediaId: string;
  publishType: string;
}): Promise<void> {
  try {
    await requestJson(
      `${params.nezusBaseUrl}/api/v1/notes/${params.noteId}/publish-result`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.nezusPat}`,
        },
        body: {
          wechatMediaId: params.wechatMediaId,
          publishType: params.publishType,
        },
      },
      10000,
    );
    console.error(`[nezus] publish-result callback OK for note ${params.noteId}`);
  } catch (err) {
    // Non-fatal: the draft was created successfully even if the callback failed
    console.warn(`[nezus] publish-result callback failed for note ${params.noteId}:`, err);
  }
}

// ── Draft management ──────────────────────────────────────────────

export interface WxDraftListInput {
  account?: string;
  limit?: number;
  offset?: number;
  config: PipelineConfig;
}

export interface WxDraftGetInput {
  account?: string;
  mediaId: string;
  config: PipelineConfig;
}

export interface WxDraftDeleteInput {
  account?: string;
  mediaId: string;
  config: PipelineConfig;
}

export async function getWxDraftList(input: WxDraftListInput): Promise<Record<string, unknown>> {
  const runtime = getWxRuntimeConfig(input.config, input.account);
  const tokenTimeout = resolveTimeout(TOKEN_TIMEOUT, runtime.timeout);
  const accessToken = await fetchAccessToken(runtime, tokenTimeout);

  const response = await requestJson(
    `${runtime.baseUrl}${BATCH_GET_PATH}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtime.pat}`,
      },
      body: {
        access_token: accessToken,
        offset: input.offset ?? 0,
        count: input.limit ?? 20,
        no_content: true,
      },
    },
    resolveTimeout(30000, runtime.timeout),
  );

  return {
    account: runtime.accountName,
    response,
  };
}

export async function getWxDraft(input: WxDraftGetInput): Promise<Record<string, unknown>> {
  const runtime = getWxRuntimeConfig(input.config, input.account);
  const tokenTimeout = resolveTimeout(TOKEN_TIMEOUT, runtime.timeout);
  const accessToken = await fetchAccessToken(runtime, tokenTimeout);

  const response = await requestJson(
    `${runtime.baseUrl}${DRAFT_GET_PATH}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtime.pat}`,
      },
      body: {
        access_token: accessToken,
        media_id: input.mediaId,
      },
    },
    resolveTimeout(30000, runtime.timeout),
  );

  return {
    account: runtime.accountName,
    mediaId: input.mediaId,
    response,
  };
}

export async function deleteWxDraft(input: WxDraftDeleteInput): Promise<Record<string, unknown>> {
  const runtime = getWxRuntimeConfig(input.config, input.account);
  const tokenTimeout = resolveTimeout(TOKEN_TIMEOUT, runtime.timeout);
  const accessToken = await fetchAccessToken(runtime, tokenTimeout);

  const response = await requestJson(
    `${runtime.baseUrl}${DRAFT_DELETE_PATH}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtime.pat}`,
      },
      body: {
        access_token: accessToken,
        media_id: input.mediaId,
      },
    },
    resolveTimeout(30000, runtime.timeout),
  );

  return {
    account: runtime.accountName,
    mediaId: input.mediaId,
    response,
  };
}
