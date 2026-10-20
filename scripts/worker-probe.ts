#!/usr/bin/env bun
/**
 * Worker 容量实测：在带内存上限的容器中走完整的 studio 流程（预览 → 确认 → 草稿），
 * 记录内存峰值、耗时与磁盘占用，用于确定 mem_limit 与两种正文导出引擎的取舍。
 *
 * Usage:
 *   bun scripts/worker-probe.ts [--build] [--image TAG] [--memory 1200m]
 *     [--engines chrome,dom] [--scenarios short,medium,long] [--out result.json]
 *
 * 每个「引擎 × 场景」使用全新容器，关闭 swap，让内存不足如实表现为 OOM。
 * 微信中转为宿主机上的可计数替身，不触达真实微信。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { createArticleStyleSnapshotV2 } from "../article-style";
import { createRenderedCoverSnapshot, hashRenderedCoverTitle } from "../cover-snapshot";
import { canonicalHash, createArticleSnapshot } from "../article-snapshot";

const ROOT = resolve(import.meta.dir, "..");
const TOKEN = "worker-probe-token";
const MiB = 1024 * 1024;

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

async function run(command: string[], options: { quiet?: boolean } = {}): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: options.quiet ? "pipe" : "inherit" });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
  return output.trim();
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  let bytes = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    bytes += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
  }
  return bytes;
}

/** 带噪点的 JPEG，体积接近真实照片而不是纯色图。 */
function photo(width: number, height: number, seed: number): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  let value = seed * 2654435761;
  for (let index = 0; index < image.data.length; index += 4) {
    value = (value * 1103515245 + 12345) >>> 0;
    image.data[index] = (index / 4 % width) * 255 / width;
    image.data[index + 1] = value & 0xff;
    image.data[index + 2] = (seed * 37) & 0xff;
    image.data[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas.toBuffer("image/jpeg", 85);
}

interface Scenario {
  title: string;
  body: string;
  images: Array<{ id: string; bytes: Buffer; width: number; height: number }>;
}

function scenario(name: string): Scenario {
  const paragraph = "这是一段用于容量实测的中文正文，包含常见的标点、数字 2026 与英文 Pipeline，长度接近真实文章的段落。";
  if (name === "short") {
    const image = { id: randomUUID(), bytes: photo(800, 500, 1), width: 800, height: 500 };
    return { title: "容量实测短文", images: [image], body: [
      "## 配置保真", paragraph, `![示例图片](asset:${image.id} "图注")`, "> 摘录内容",
      "| 表头一 | 表头二 |\n|---|---|\n| 内容 | 内容 |", "```ts\nconst probe = true;\n```",
    ].join("\n\n") };
  }
  if (name === "medium") {
    // 常见文章：约 2000 字、10 张图。
    const images = Array.from({ length: 10 }, (_, index) => ({ id: randomUUID(), bytes: photo(1600, 1000, index + 30), width: 1600, height: 1000 }));
    const sections: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      sections.push(`## 第 ${index + 1} 节`, ...Array.from({ length: 4 }, () => paragraph), `![第 ${index + 1} 张图](asset:${images[index]!.id} "图注 ${index + 1}")`);
    }
    sections.push("> [!TIP] 提示\n> 提示卡片内容。", "- 列表一\n- 列表二", "```ts\nconst medium = true;\n```");
    return { title: "容量实测常规文章", images, body: sections.join("\n\n") };
  }
  if (name === "long") {
    const images = Array.from({ length: 20 }, (_, index) => ({ id: randomUUID(), bytes: photo(1600, 1000, index + 2), width: 1600, height: 1000 }));
    const sections: string[] = [];
    // 约 2 万字：20 节，每节约 1000 字并带一张图。
    for (let index = 0; index < 20; index += 1) {
      sections.push(`## 第 ${index + 1} 节`, ...Array.from({ length: 20 }, () => paragraph), `![第 ${index + 1} 张图](asset:${images[index]!.id} "图注 ${index + 1}")`,
        "> [!TIP] 提示\n> 提示卡片内容。", "- 列表一\n- 列表二\n  - 嵌套", "```ts\nconst section = " + index + ";\n```");
    }
    return { title: "容量实测长文", images, body: sections.join("\n\n") };
  }
  throw new Error(`Unknown scenario ${name}`);
}

interface ProbeResult {
  engine: string;
  scenario: string;
  memoryLimit: string;
  ok: boolean;
  error?: string;
  /** anon + shmem + kernel：内核回收页缓存后仍需占用的内存，Chrome 的共享内存计入 shmem。 */
  idleUnreclaimableMiB?: number;
  previewUnreclaimableMiB?: number;
  publishUnreclaimableMiB?: number;
  peakAnonMiB?: number;
  peakShmemMiB?: number;
  /** cgroup memory.peak，含可回收的页缓存，只作参考上界。 */
  peakMemoryMiB?: number;
  oomKills?: number;
  restarts?: number;
  previewMs?: number;
  publishMs?: number;
  jobDirMiB?: number;
  jobsJsonKiB?: number;
  assetCacheMiB?: number;
}

async function probe(image: string, engine: string, scenarioName: string, memory: string): Promise<ProbeResult> {
  const result: ProbeResult = { engine, scenario: scenarioName, memoryLimit: memory, ok: false };
  // 放在仓库 tmp/ 下，确保 Docker Desktop 的文件共享可以挂载。
  const root = join(ROOT, "tmp", "worker-probe", `${engine}-${scenarioName}-${Date.now()}`);
  await mkdir(join(root, "data"), { recursive: true });
  const calls: string[] = [];
  const relay = Bun.serve({ hostname: "0.0.0.0", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname; calls.push(path);
    await request.arrayBuffer();
    if (path.endsWith("/token")) return Response.json({ accessToken: "FAKE_TOKEN" });
    if (path.includes("material")) return Response.json({ media_id: `FAKE_IMAGE_${calls.length}`, url: `https://mmbiz.test/${calls.length}.jpg` });
    return Response.json({ media_id: "PROBE_DRAFT_ONLY" });
  } });
  await writeFile(join(root, "config.json"), JSON.stringify({ wx: { baseUrl: `http://host.docker.internal:${relay.port}` }, plugins: {
    imageRenderer: "@akairos/typeset-studio/adapter", markdownRenderer: "@akairos/myno/adapter",
  } }));
  const name = `zzp-probe-${randomUUID().slice(0, 8)}`;
  let sampler: ReturnType<typeof Bun.spawn> | undefined;
  let peakAnon = 0, peakShmem = 0, phasePeak = 0;
  const takePhasePeak = () => { const value = phasePeak; phasePeak = 0; return Math.round(value / MiB); };
  try {
    await run(["docker", "run", "-d", "--name", name, "--init", "--memory", memory, "--memory-swap", memory,
      "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::18887",
      "-e", `PIPELINE_WORKER_TOKEN=${TOKEN}`, "-e", "PIPELINE_WORKER_HOST=0.0.0.0", "-e", "PIPELINE_WORKER_PRIVATE_NETWORK=1",
      "-e", "PIPELINE_CONFIG_FILE=/run/probe/config.json", "-e", `PIPELINE_ARTICLE_EXPORT_ENGINE=${engine}`,
      "-v", `${join(root, "config.json")}:/run/probe/config.json:ro`, "-v", `${join(root, "data")}:/data`, image], { quiet: true });
    const port = (await run(["docker", "port", name, "18887/tcp"], { quiet: true })).split(":").pop();
    const url = `http://127.0.0.1:${port}`;
    const headers = { Authorization: `Bearer ${TOKEN}` };
    for (let attempt = 0; ; attempt += 1) {
      const healthy = await fetch(`${url}/health`, { headers }).then(response => response.ok, () => false);
      if (healthy) break;
      if (attempt > 300) throw new Error("Worker did not become healthy");
      await Bun.sleep(100);
    }
    // 流式采样：memory.peak 含页缓存；anon + shmem + kernel 是回收缓存后仍需要的内存。
    sampler = Bun.spawn(["docker", "exec", name, "sh", "-c",
      "while true; do grep -E '^(anon|shmem|kernel) ' /sys/fs/cgroup/memory.stat | tr '\\n' ' '; echo; sleep 0.1; done"], { stdout: "pipe", stderr: "ignore" });
    void (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      for await (const chunk of sampler!.stdout as ReadableStream<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const fields = Object.fromEntries([...line.matchAll(/(anon|shmem|kernel) (\d+)/g)].map(match => [match[1], Number(match[2])]));
          if (fields.anon === undefined) continue;
          peakAnon = Math.max(peakAnon, fields.anon);
          peakShmem = Math.max(peakShmem, fields.shmem ?? 0);
          phasePeak = Math.max(phasePeak, fields.anon + (fields.shmem ?? 0) + (fields.kernel ?? 0));
        }
      }
    })();
    await Bun.sleep(800);
    result.idleUnreclaimableMiB = takePhasePeak();

    const json = (path: string, method: string, body: unknown) => fetch(`${url}${path}`, { method, headers, body: JSON.stringify(body) });
    const content = scenario(scenarioName);
    const cover = createCanvas(3350, 1000);
    const coverContext = cover.getContext("2d"); coverContext.fillStyle = "#1f7a4d"; coverContext.fillRect(0, 0, 3350, 1000);
    const coverPng = cover.toBuffer("image/png");
    const coverSnapshot = createRenderedCoverSnapshot({ id: randomUUID(), revision: 1, name: "实测封面", sourceHash: canonicalHash({ probe: true }), assetsHash: canonicalHash([]),
      fontHashes: [{ id: "probe-font", sha256: "a".repeat(64) }], titleHash: hashRenderedCoverTitle(content.title), renderedAsset: {
        id: randomUUID(), contentType: "image/png", byteLength: coverPng.length, width: 3350, height: 1000, sha256: createHash("sha256").update(coverPng).digest("hex"),
      } });
    const articleStyle = createArticleStyleSnapshotV2({ schemaVersion: 1, engineVersion: 1, id: "probe", name: "实测排版", version: "1.0.0", css: ".milkdown .editor p { letter-spacing: 0.25px; }",
      editorVars: { "--brand": "#1f7a4d" }, exportTheme: { bodyFontSize: "17px", primaryColor: "#1f7a4d" }, syntaxPresets: { h2: "bottom-line", blockquote: "card", table: "zebra" },
      structure: { numberedHeadings: true, headingLabel: "章节", quoteLabel: "摘录" } }, "probe", 1);
    const upload = async (bytes: Buffer, contentType: string) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const response = await fetch(`${url}/v1/assets/${sha256}`, { method: "PUT", headers: { ...headers, "Content-Type": contentType }, body: new Uint8Array(bytes) });
      if (response.status !== 200) throw new Error(`asset upload HTTP ${response.status}: ${await response.text()}`);
      return sha256;
    };
    await upload(coverPng, "image/png");
    const bodyAssets = [];
    for (const item of content.images) {
      bodyAssets.push({ id: item.id, sha256: await upload(item.bytes, "image/jpeg"), contentType: "image/jpeg" as const, byteLength: item.bytes.byteLength, width: item.width, height: item.height });
    }
    if ((await json("/v1/accounts/probe", "PUT", { appId: "FAKE_APP", appSecret: "FAKE_SECRET", pat: "FAKE_PAT" })).status !== 200) throw new Error("account registration failed");
    const request = { title: content.title, body: content.body, account: "probe", articleStyle, coverSnapshot };
    const articleSnapshot = createArticleSnapshot({ ...request, documentId: randomUUID(), documentRevision: 1, bodyAssets });
    const submitted = await json("/v1/jobs", "POST", { ...request, contentForm: "article", idempotencyKey: `probe-${scenarioName}`, operation: "preview", articleSnapshot });
    const job = await submitted.json();
    if (submitted.status !== 202) throw new Error(`submit HTTP ${submitted.status}: ${JSON.stringify(job)}`);
    const waitFor = async (status: string) => {
      for (let attempt = 0; attempt < 3000; attempt += 1) {
        const current = await (await fetch(`${url}/v1/jobs/${job.id}`, { headers })).json().catch(() => ({}));
        if (current.status === status) return current;
        if (["failed", "interrupted"].includes(current.status)) throw new Error(`${current.status}: ${current.error}`);
        await Bun.sleep(100);
      }
      throw new Error(`timed out waiting for ${status}`);
    };
    takePhasePeak();
    let started = Date.now();
    const ready = await waitFor("preview_ready");
    result.previewMs = Date.now() - started;
    await Bun.sleep(300);
    result.previewUnreclaimableMiB = takePhasePeak();
    started = Date.now();
    const confirmed = await json(`/v1/jobs/${job.id}/publish`, "POST", { snapshotHash: ready.result.snapshotHash, artifactManifestHash: ready.result.artifactManifestHash });
    if (![200, 202].includes(confirmed.status)) throw new Error(`confirm HTTP ${confirmed.status}`);
    await waitFor("succeeded");
    result.publishMs = Date.now() - started;
    await Bun.sleep(300);
    result.publishUnreclaimableMiB = takePhasePeak();
    result.ok = calls.filter(path => /draft\/(add|create)/.test(path)).length === 1;
    if (!result.ok) result.error = "draft write count was not exactly one";
    result.jobDirMiB = Math.round(await directoryBytes(join(root, "data", "pipeline-worker", "jobs", job.id)) / MiB * 10) / 10;
    result.assetCacheMiB = Math.round(await directoryBytes(join(root, "data", "pipeline-worker", "assets")) / MiB * 10) / 10;
    result.jobsJsonKiB = Math.round((await stat(join(root, "data", "pipeline-worker", "jobs.json"))).size / 1024);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await Bun.sleep(300);
    result.peakAnonMiB = Math.round(peakAnon / MiB);
    result.peakShmemMiB = Math.round(peakShmem / MiB);
    sampler?.kill();
    const events = await run(["docker", "exec", name, "cat", "/sys/fs/cgroup/memory.events"], { quiet: true }).catch(() => "");
    result.oomKills = Number(/oom_kill (\d+)/.exec(events)?.[1] ?? NaN);
    const peak = await run(["docker", "exec", name, "cat", "/sys/fs/cgroup/memory.peak"], { quiet: true }).catch(() => "");
    if (peak) result.peakMemoryMiB = Math.round(Number(peak) / MiB);
    const inspect = await run(["docker", "inspect", "-f", "{{.State.OOMKilled}} {{.RestartCount}}", name], { quiet: true }).catch(() => "");
    result.restarts = Number(inspect.split(" ")[1] ?? NaN);
    await run(["docker", "rm", "-f", name], { quiet: true }).catch(() => "");
    relay.stop(true);
    await rm(root, { recursive: true, force: true });
  }
  return result;
}

const memory = option("memory", "1200m");
const engines = option("engines", "chrome,dom").split(",");
const scenarios = option("scenarios", "short,long").split(",");
const revision = (await run(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"], { quiet: true }));
const image = option("image", `zzhub-pipeline-worker:probe-${revision}`);
if (process.argv.includes("--build")) {
  await run(["docker", "build", "-f", join(ROOT, "services/cloud-worker/Dockerfile"), "-t", image, ROOT]);
}

const results: ProbeResult[] = [];
for (const engine of engines) {
  for (const name of scenarios) {
    const result = await probe(image, engine, name, memory);
    results.push(result);
    console.error(JSON.stringify(result));
  }
}
const summary = { image, revision, memory, arch: process.arch, measuredAt: new Date().toISOString(), results };
const out = option("out", "");
if (out) await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
