import { describe, expect, test } from "bun:test";
import {
  normalizeAccountName,
  resolveTimeout,
  parsePhotos,
  mergePhotoLists,
  extractImageUrls,
  replaceImageUrls,
  isRetryableTokenFetchError,
  resolveFilenameFromUrl,
  resolveDraftMediaId,
  readResponseBodyWithLimit,
  createWechatNewspic,
  calculatePicCrop,
  createWechatDraft,
} from "./wechat";
import { PNG } from "pngjs";
import { PipelineConfigSchema } from "../schema/config";

describe("cover crop", () => {
  test("keeps the built-in split cover regions", () => {
    expect(calculatePicCrop(1340, 400)).toEqual({ pic_crop_235_1: "0_0_0.7015_1", pic_crop_1_1: "0.7015_0_1_1" });
  });
  test("right-aligns square crops and centers wide crops at the target ratios", () => {
    for (const [width, height] of [[400, 100], [100, 200], [100, 100], [235, 100]]) {
      const crops = calculatePicCrop(width, height);
      for (const [crop, ratio] of [[crops.pic_crop_235_1, 2.35], [crops.pic_crop_1_1, 1]] as const) {
        const [x1, y1, x2, y2] = crop.split("_").map(Number);
        expect((x2! - x1!) * width / ((y2! - y1!) * height)).toBeCloseTo(ratio, 2);
        if (ratio === 1) expect(x2).toBe(1);
        else expect(x1! + x2!).toBeCloseTo(1);
        expect(y1! + y2!).toBeCloseTo(1);
      }
    }
  });

  test("draft add and update reuse crop dimensions from remote and Data URL uploads", async () => {
    const png = new PNG({ width: 235, height: 100 });
    png.data.fill(255);
    const image = PNG.sync.write(png);
    const drafts: any[] = [];
    let downloads = 0;
    const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/cover.png") { downloads += 1; return new Response(new Uint8Array(image), { headers: { "content-type": "image/png" } }); }
      if (path.endsWith("/token")) return Response.json({ accessToken: "test-token" });
      if (path.includes("material")) return Response.json({ media_id: "cover-id", url: "https://mmbiz.example/cover.png" });
      drafts.push(await request.json());
      return Response.json({ media_id: "draft-id" });
    } });
    const overrides = { ZZHUB_WX_BASE_URL: `http://127.0.0.1:${relay.port}`, ZZCLUB_PAT: "test-pat", WX_APPID: "test-app", WX_APPSECRET: "test-secret" };
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try {
      const config = PipelineConfigSchema.parse({});
      await createWechatDraft({ config, title: "test", html: "<p>body</p>", photos: [`${overrides.ZZHUB_WX_BASE_URL}/cover.png`] });
      await createWechatDraft({ config, title: "test", html: "<p>body</p>", photos: [`data:image/png;base64,${image.toString("base64")}`], existingDraftMediaId: "existing-id" });
      expect(downloads).toBe(1);
      const expectedCrops = { pic_crop_235_1: "0.0000_0.0000_1.0000_1.0000", pic_crop_1_1: "0.5745_0.0000_1.0000_1.0000" };
      expect(drafts[0].articles[0]).toMatchObject(expectedCrops);
      expect(drafts[1].articles).toMatchObject(expectedCrops);
    } finally {
      relay.stop(true);
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test("贴图配文按 UTF-8 长度校验，上传前拒绝超限内容", async () => {
  await expect(createWechatNewspic({ content: "😀".repeat(512) + "a" } as any)).rejects.toThrow("贴图配文过长");
});

// 公众号后台删除草稿后，draft/update 会一直失败；worker 必须确认草稿丢失后降级为新建。
describe("draft update with a remotely deleted draft", () => {
  const png = new PNG({ width: 8, height: 8 });
  png.data.fill(255);
  const image = PNG.sync.write(png);
  const dataUrl = `data:image/png;base64,${image.toString("base64")}`;

  function startRelay(handlers: { update: () => Response; get: () => Response; add: () => Response }) {
    const calls: Array<{ path: string; idempotencyKey: string | null; body: any }> = [];
    const relay = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/token")) return Response.json({ accessToken: "test-token" });
      if (path.includes("material")) return Response.json({ media_id: "cover-id", url: "https://mmbiz.example/cover.png" });
      if (path.endsWith("/draft/get")) { calls.push({ path: "get", idempotencyKey: null, body: await request.json() }); return handlers.get(); }
      if (path.endsWith("/draft/update")) { calls.push({ path: "update", idempotencyKey: request.headers.get("idempotency-key"), body: await request.json() }); return handlers.update(); }
      if (path.endsWith("/draft/add")) { calls.push({ path: "add", idempotencyKey: request.headers.get("idempotency-key"), body: await request.json() }); return handlers.add(); }
      return new Response("not found", { status: 404 });
    } });
    return { relay, calls, baseUrl: `http://127.0.0.1:${relay.port}` };
  }

  function withRelayEnv<T>(baseUrl: string, run: () => Promise<T>): Promise<T> {
    const overrides = { ZZHUB_WX_BASE_URL: baseUrl, ZZCLUB_PAT: "test-pat", WX_APPID: "test-app", WX_APPSECRET: "test-secret" };
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    return run().finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }

  const goneReject = () => Response.json({ code: 9002, message: "invalid media_id", data: { wxErrcode: 40007, wxErrmsg: "invalid media_id" } }, { status: 400 });

  test("article update recreates the draft and returns the new media id", async () => {
    const { relay, calls, baseUrl } = startRelay({
      update: goneReject,
      get: goneReject,
      add: () => Response.json({ media_id: "recreated-draft-id" }),
    });
    try {
      const result = await withRelayEnv(baseUrl, () => createWechatDraft({
        config: PipelineConfigSchema.parse({}),
        title: "test",
        html: "<p>body</p>",
        photos: [dataUrl],
        idempotencyKey: "original-key",
        existingDraftMediaId: "deleted-draft-id",
      }));
      expect(result.isUpdate).toBe(true);
      expect(result.recreated).toBe(true);
      expect(result.originalDraftMediaId).toBe("deleted-draft-id");
      expect(result.draftMediaId).toBe("recreated-draft-id");
      expect(calls.map(call => call.path)).toEqual(["update", "get", "add"]);
      expect(calls[0]!.idempotencyKey).toBe("original-key");
      // 重建是新的外部写操作，必须换幂等键，不能与失败的 update 请求共用。
      expect(calls[2]!.idempotencyKey).not.toBe("original-key");
      expect(calls[2]!.idempotencyKey).toBeTruthy();
      expect(calls[2]!.body.articles[0]).toMatchObject({ article_type: "news", title: "test" });
    } finally {
      relay.stop(true);
    }
  });

  test("newspic update also recreates when the remote draft is gone", async () => {
    const { relay, calls, baseUrl } = startRelay({
      update: goneReject,
      get: goneReject,
      add: () => Response.json({ media_id: "recreated-newspic-id" }),
    });
    try {
      const result = await withRelayEnv(baseUrl, () => createWechatNewspic({
        config: PipelineConfigSchema.parse({}),
        title: "test",
        content: "配文",
        photos: [dataUrl],
        idempotencyKey: "newspic-key",
        existingDraftMediaId: "deleted-newspic-id",
      }));
      expect(result.recreated).toBe(true);
      expect(result.draftMediaId).toBe("recreated-newspic-id");
      expect(calls.map(call => call.path)).toEqual(["update", "get", "add"]);
      expect(calls[2]!.body.articles[0]).toMatchObject({ article_type: "newspic" });
    } finally {
      relay.stop(true);
    }
  });

  test("keeps the original error when the draft still exists", async () => {
    const { relay, calls, baseUrl } = startRelay({
      update: goneReject,
      get: () => Response.json({ news_item: [{ title: "test" }] }),
      add: () => Response.json({ media_id: "should-not-happen" }),
    });
    try {
      await expect(withRelayEnv(baseUrl, () => createWechatDraft({
        config: PipelineConfigSchema.parse({}),
        title: "test",
        html: "<p>body</p>",
        photos: [dataUrl],
        existingDraftMediaId: "live-draft-id",
      }))).rejects.toThrow("API request failed with status 400");
      expect(calls.map(call => call.path)).toEqual(["update", "get"]);
    } finally {
      relay.stop(true);
    }
  });

  test("keeps the original error when the probe cannot confirm the draft state", async () => {
    const { relay, calls, baseUrl } = startRelay({
      update: goneReject,
      get: () => Response.json({ code: 9002, message: "upstream unavailable" }, { status: 503 }),
      add: () => Response.json({ media_id: "should-not-happen" }),
    });
    try {
      await expect(withRelayEnv(baseUrl, () => createWechatDraft({
        config: PipelineConfigSchema.parse({}),
        title: "test",
        html: "<p>body</p>",
        photos: [dataUrl],
        existingDraftMediaId: "unknown-draft-id",
      }))).rejects.toThrow("API request failed with status 400");
      expect(calls.map(call => call.path)).toEqual(["update", "get"]);
    } finally {
      relay.stop(true);
    }
  });
});

describe("resolveDraftMediaId", () => {
  test("extracts media_id from a successful draft response", () => {
    expect(resolveDraftMediaId({ code: 0, data: { media_id: "media-1" } }))
      .toBe("media-1");
  });

  test("rejects business errors returned with HTTP 200", () => {
    expect(() => resolveDraftMediaId({ errcode: 40001, errmsg: "invalid credential" }))
      .toThrow("WeChat draft API error: 40001");
  });

  test("rejects string business error codes for draft updates", () => {
    expect(() => resolveDraftMediaId(
      { errcode: "40001", errmsg: "invalid credential" },
      "existing-media",
    )).toThrow("WeChat draft API error: 40001");
  });

  test("requires media_id for a newly created draft", () => {
    expect(() => resolveDraftMediaId({ code: 0, data: {} }))
      .toThrow("did not include media_id");
  });

  test("uses the existing media id for a successful update", () => {
    expect(resolveDraftMediaId({ errcode: 0 }, "existing-media"))
      .toBe("existing-media");
  });
});

describe("readResponseBodyWithLimit", () => {
  test("accepts a streamed response at the byte limit", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    const body = await readResponseBodyWithLimit(response, 3);
    expect(new Uint8Array(body)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("rejects a streamed response as soon as it exceeds the byte limit", async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]));
    await expect(readResponseBodyWithLimit(response, 3)).rejects.toThrow(
      "Image exceeds 3 byte limit",
    );
  });

  test("rejects an oversized content-length before reading the body", async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { "content-length": "4" },
    });
    await expect(readResponseBodyWithLimit(response, 3)).rejects.toThrow(
      "Image exceeds 3 byte limit",
    );
  });
});

describe("normalizeAccountName", () => {
  test("accepts valid account names", () => {
    expect(normalizeAccountName("default")).toBe("default");
    expect(normalizeAccountName("my-account")).toBe("my-account");
    expect(normalizeAccountName("account_v2")).toBe("account_v2");
    expect(normalizeAccountName("test.account")).toBe("test.account");
  });

  test("trims whitespace", () => {
    expect(normalizeAccountName("  default  ")).toBe("default");
  });

  test("throws on empty string", () => {
    expect(() => normalizeAccountName("")).toThrow("wx account cannot be empty");
    expect(() => normalizeAccountName("  ")).toThrow("wx account cannot be empty");
  });

  test("throws on invalid characters", () => {
    expect(() => normalizeAccountName("my account")).toThrow("invalid wx account");
    expect(() => normalizeAccountName("account@name")).toThrow("invalid wx account");
  });
});

describe("resolveTimeout", () => {
  test("returns override when valid", () => {
    expect(resolveTimeout(5000, 10000, 15000)).toBe(15000);
  });

  test("returns config timeout when override is absent", () => {
    expect(resolveTimeout(5000, 10000)).toBe(10000);
  });

  test("returns default when config and override are absent", () => {
    expect(resolveTimeout(5000, 0)).toBe(5000);
  });

  test("ignores invalid override (zero, negative, non-finite)", () => {
    expect(resolveTimeout(5000, 10000, 0)).toBe(10000);
    expect(resolveTimeout(5000, 10000, -1)).toBe(10000);
    expect(resolveTimeout(5000, 10000, Infinity)).toBe(10000);
    expect(resolveTimeout(5000, 10000, NaN)).toBe(10000);
  });

  test("ignores invalid config timeout", () => {
    expect(resolveTimeout(5000, -1)).toBe(5000);
    expect(resolveTimeout(5000, 0)).toBe(5000);
  });
});

describe("parsePhotos", () => {
  test("trims and filters empty entries", () => {
    expect(parsePhotos(["  img1.png  ", "", "  img2.png  "])).toEqual(["img1.png", "img2.png"]);
  });

  test("returns empty array for undefined", () => {
    expect(parsePhotos(undefined)).toEqual([]);
  });

  test("returns empty array for empty array", () => {
    expect(parsePhotos([])).toEqual([]);
  });

  test("filters whitespace-only entries", () => {
    expect(parsePhotos(["img.png", "  ", "other.png"])).toEqual(["img.png", "other.png"]);
  });
});

describe("mergePhotoLists", () => {
  test("deduplicates across multiple lists", () => {
    const result = mergePhotoLists(
      ["a.png", "b.png"],
      ["b.png", "c.png"],
      ["c.png", "d.png"],
    );
    expect(result).toEqual(["a.png", "b.png", "c.png", "d.png"]);
  });

  test("handles empty lists", () => {
    expect(mergePhotoLists([], ["a.png"], [])).toEqual(["a.png"]);
  });

  test("trims entries before deduplication", () => {
    expect(mergePhotoLists(["  a.png  "], ["a.png"])).toEqual(["a.png"]);
  });

  test("filters empty entries", () => {
    expect(mergePhotoLists(["", "a.png", "  "])).toEqual(["a.png"]);
  });
});

describe("extractImageUrls", () => {
  test("extracts markdown image URLs", () => {
    const input = "![alt](https://example.com/img.png) and ![other](https://cdn.com/other.jpg)";
    const urls = extractImageUrls(input);
    expect(urls).toContain("https://example.com/img.png");
    expect(urls).toContain("https://cdn.com/other.jpg");
  });

  test("extracts HTML img src URLs", () => {
    const input = '<img src="https://example.com/img.png" alt="test">';
    const urls = extractImageUrls(input);
    expect(urls).toContain("https://example.com/img.png");
  });

  test("deduplicates URLs", () => {
    const input = "![a](https://example.com/img.png) ![b](https://example.com/img.png)";
    const urls = extractImageUrls(input);
    expect(urls.filter((u) => u === "https://example.com/img.png")).toHaveLength(1);
  });

  test("handles mixed markdown and HTML images", () => {
    const input = '![md](https://a.com/1.png) <img src="https://b.com/2.png">';
    const urls = extractImageUrls(input);
    expect(urls).toHaveLength(2);
  });

  test("returns empty array for no images", () => {
    expect(extractImageUrls("just text")).toEqual([]);
  });

  test("handles image with title attribute", () => {
    const input = '![alt](https://example.com/img.png "title")';
    const urls = extractImageUrls(input);
    expect(urls).toContain("https://example.com/img.png");
  });
});

describe("replaceImageUrls", () => {
  test("replaces large Base64 sources and preserves literal replacement URLs", () => {
    const src = `data:image/png;base64,${"A".repeat(3_400_000)}`;
    const url = "https://example.com/image.png?value=$&";
    expect(replaceImageUrls(`<img src="${src}" data-src="${src}">`, { [src]: url }))
      .toBe(`<img src="${url}" data-src="${url}">`);
  });

  test("replaces URLs using the mapping", () => {
    const html = '<img src="https://old.com/img.png">';
    const result = replaceImageUrls(html, { "https://old.com/img.png": "https://new.com/img.png" });
    expect(result).toBe('<img src="https://new.com/img.png">');
  });

  test("escapes special regex characters in URLs", () => {
    const html = '<img src="https://old.com/img.png?v=1&size=large">';
    const result = replaceImageUrls(html, {
      "https://old.com/img.png?v=1&size=large": "https://new.com/img.png",
    });
    expect(result).toBe('<img src="https://new.com/img.png">');
  });

  test("replaces multiple occurrences", () => {
    const html = '<img src="https://a.com/1.png"><img src="https://a.com/1.png">';
    const result = replaceImageUrls(html, { "https://a.com/1.png": "https://b.com/1.png" });
    expect(result).toBe('<img src="https://b.com/1.png"><img src="https://b.com/1.png">');
  });

  test("skips empty keys or values", () => {
    const html = '<img src="https://a.com/1.png">';
    const result = replaceImageUrls(html, { "": "https://b.com/1.png", "https://a.com/1.png": "" });
    expect(result).toBe(html);
  });
});

describe("isRetryableTokenFetchError", () => {
  test("returns true for fetch failed errors", () => {
    expect(isRetryableTokenFetchError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableTokenFetchError(new Error("Request failed: fetch failed ECONNREFUSED"))).toBe(true);
  });

  test("returns true case-insensitively", () => {
    expect(isRetryableTokenFetchError(new Error("Fetch Failed"))).toBe(true);
    expect(isRetryableTokenFetchError(new Error("FETCH FAILED"))).toBe(true);
  });

  test("returns false for non-fetch errors", () => {
    expect(isRetryableTokenFetchError(new Error("timeout"))).toBe(false);
    expect(isRetryableTokenFetchError(new Error("unauthorized"))).toBe(false);
  });

  test("returns false for non-Error values", () => {
    expect(isRetryableTokenFetchError("fetch failed")).toBe(false);
    expect(isRetryableTokenFetchError(null)).toBe(false);
    expect(isRetryableTokenFetchError(undefined)).toBe(false);
  });
});

describe("resolveFilenameFromUrl", () => {
  test("uses filename from URL path", () => {
    expect(resolveFilenameFromUrl("https://cdn.com/photo.png", "image/png", 0)).toBe("photo.png");
  });

  test("strips query parameters", () => {
    expect(resolveFilenameFromUrl("https://cdn.com/photo.png?v=1&size=large", "image/png", 0)).toBe("photo.png");
  });

  test("adds extension when missing", () => {
    expect(resolveFilenameFromUrl("https://cdn.com/photo", "image/jpeg", 0)).toBe("photo.jpg");
  });

  test("corrects mismatched extension", () => {
    expect(resolveFilenameFromUrl("https://cdn.com/photo.gif", "image/png", 0)).toBe("photo.png");
  });

  test("uses fallback name when URL has no filename", () => {
    expect(resolveFilenameFromUrl("https://cdn.com/", "image/png", 0)).toBe("image_1.png");
  });

  test("uses index for fallback naming", () => {
    expect(resolveFilenameFromUrl("https://cdn.com/", "image/jpeg", 2)).toBe("image_3.jpg");
  });
});
