import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cloudJobFailureStatus, executeCloudJob } from "./pipeline";
import { cloudJobProgress } from "./progress";
import { AccountStore, defaultJobWorkspace, type CloudJobInput, JobStore, type StoredCloudJob } from "./store";
import { validateArticleStyleSnapshot } from "../../src/article-style";
import { validateCoverSnapshot } from "../../src/cover-snapshot";
import { coverCapabilities } from "./cover";
import { canonicalHash, validateArticleSnapshot } from "../../src/article-snapshot";
import { maxAssetBytes, putBodyAsset } from "./assets";
import { prepareArticleMaterials, readPreparedArticle } from "./job-materials";
import { readArtifact } from "./artifacts";
import { WorkerCapacity, WorkerLimitError } from "./capacity";
import { resolveArticleExportEngine } from "../../src/wechat-preview/dom-export";

// 正文最多 2 MiB，另预留一张 1 MiB JPEG 的 base64 与模板 JSON。
const maxJobRequestBytes = 4_500_000;

const host = process.env.PIPELINE_WORKER_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PIPELINE_WORKER_PORT || "18887");
// 非回环监听只允许部署在隔离容器网络中显式开启。
const privateNetwork = process.env.PIPELINE_WORKER_PRIVATE_NETWORK === "1";
const workspaceRoot = resolve(process.env.PIPELINE_WORKSPACE_ROOT?.trim() || "/data/pipeline-worker");
const workerStateFile = resolve(process.env.PIPELINE_WORKER_STATE_FILE?.trim() || "/data/pipeline-worker/jobs.json");
const store = new JobStore(workerStateFile);
const accounts = new AccountStore(resolve(process.env.PIPELINE_WORKER_ACCOUNT_STATE_FILE?.trim() || `${dirname(workerStateFile)}/accounts.json`));
const capacity = new WorkerCapacity(workspaceRoot, () => store.jobs.values());
const queue: string[] = [];
const acceptingKeys = new Map<string, Promise<StoredCloudJob | null>>();
let draining = false;
let assetWrites = 0;
// 维护标记持久化，重建容器后验收完成前仍拒绝新任务。
const maintenanceFile = `${workerStateFile}.maintenance.json`;
let maintenance = false;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

function bearerMatches(request: Request): boolean {
  const token = process.env.PIPELINE_WORKER_TOKEN?.trim();
  if (!token)
    return false;
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function publicJob(job: StoredCloudJob): Promise<Record<string, unknown>> {
  const safeJob = { ...job } as Record<string, unknown>;
  delete safeJob.body;
  delete safeJob.statePath;
  delete safeJob.preparedHash;
  delete safeJob.acceptanceIncomplete;
  const progress = await cloudJobProgress({ ...job }, workspaceRoot).catch(() => null);
  return { ...safeJob, bodyHash: createHash("sha256").update(job.body).digest("hex"), input: { ...job.input }, ...progress };
}

function validateInput(value: unknown): CloudJobInput {
  if (!value || typeof value !== "object")
    throw new Error("Request body must be an object");
  const input = value as Record<string, unknown>;
  const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body : "";
  const account = typeof input.account === "string" ? input.account.trim() : "";
  const contentForm = input.contentForm === "newspic" ? "newspic" : input.contentForm === "article" ? "article" : null;
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new Error("idempotencyKey is required and must be <= 200 characters");
  if (!title || title.length > 255)
    throw new Error("title is required and must be <= 255 characters");
  if (!body || body.length > 2_000_000)
    throw new Error("body is required and must be <= 2 MB");
  if (!contentForm)
    throw new Error("contentForm must be article or newspic");
  if (!/^[a-zA-Z0-9_.-]+$/.test(account))
    throw new Error("account is required and must contain only letters, numbers, _, ., or -");
  // 独立贴图正文与配图来自用户确认的发送副本。
  const newspic = input.newspic as CloudJobInput["newspic"];
  if (newspic !== undefined && (
    contentForm !== "newspic" || !newspic || typeof newspic.content !== "string" || !newspic.content.trim() || Buffer.byteLength(newspic.content, "utf8") > 2048
    || !Array.isArray(newspic.photos) || newspic.photos.length > 20
    || newspic.photos.some(photo => typeof photo !== "string" || !/^https?:\/\//i.test(photo) || !URL.canParse(photo))
  )) throw new Error("newspic requires text and up to 20 HTTP image URLs; an empty list generates images");
  if (input.articleStyle !== undefined && contentForm !== "article") throw new Error("articleStyle requires article contentForm");
  const articleStyle = input.articleStyle !== undefined ? validateArticleStyleSnapshot(input.articleStyle) : undefined;
  if (input.coverSnapshot !== undefined && contentForm !== "article") throw new Error("coverSnapshot requires article contentForm");
  const coverSnapshot = input.coverSnapshot !== undefined ? validateCoverSnapshot(input.coverSnapshot) : undefined;
  if (coverSnapshot && Buffer.byteLength(body, "utf8") > 2_097_152) throw new Error("body with coverSnapshot must be <= 2 MiB UTF-8");
  if (input.operation !== undefined && input.operation !== "preview") throw new Error("operation must be preview when present");
  if ((input.operation === "preview") !== (input.articleSnapshot !== undefined)) throw new Error("preview requires articleSnapshot");
  if (input.operation === "preview" && (contentForm !== "article" || input.newspic !== undefined || input.existingDraftMediaId)) throw new Error("preview only supports new article drafts");
  if ((coverSnapshot?.schemaVersion === 2 || articleStyle?.schemaVersion === 2) && input.operation !== "preview") throw new Error("Version 2 configuration requires article preview");
  const articleSnapshot = input.articleSnapshot !== undefined ? validateArticleSnapshot(input.articleSnapshot, { title, body, account, articleStyle, coverSnapshot }) : undefined;
  return {
    idempotencyKey,
    title,
    body,
    contentForm,
    account,
    intentText: typeof input.intentText === "string" ? input.intentText.trim() : undefined,
    existingDraftMediaId: typeof input.existingDraftMediaId === "string" ? input.existingDraftMediaId.trim() || null : null,
    ...(newspic ? { newspic } : {}),
    ...(articleStyle ? { articleStyle } : {}),
    ...(coverSnapshot ? { coverSnapshot } : {}),
    ...(articleSnapshot ? { operation: "preview", articleSnapshot } : {}),
  };
}

function validateAccount(value: unknown, accountName: string) {
  if (!value || typeof value !== "object")
    throw new Error("Request body must be an object");
  const input = value as Record<string, unknown>;
  const account = typeof input.account === "string" ? input.account.trim() : accountName;
  const appId = typeof input.appId === "string" ? input.appId.trim() : "";
  const appSecret = typeof input.appSecret === "string" ? input.appSecret.trim() : "";
  const pat = typeof input.pat === "string" ? input.pat.trim() : "";
  if (account !== accountName || !/^[a-zA-Z0-9_.-]{1,80}$/.test(account))
    throw new Error("account is invalid");
  if (!appId || appId.length > 255 || !appSecret || appSecret.length > 512 || !pat || pat.length > 512)
    throw new Error("appId, appSecret and pat are required");
  return { account, appId, appSecret, pat };
}

function requestHash(input: CloudJobInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function drain(): Promise<void> {
  if (draining)
    return;
  draining = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift()!;
      const job = store.get(id);
      if (!job || job.status !== "queued")
        continue;
      job.status = "running";
      job.startedAt = new Date().toISOString();
      job.step = "starting";
      await store.set(job);
      try {
        await capacity.reserveJob(job.id, defaultJobWorkspace(workspaceRoot, job.id));
        await executeCloudJob(job, { ...job.input, body: job.body }, store, accounts, workspaceRoot, capacity);
        if ((job as StoredCloudJob).status !== "preview_ready") { job.status = "succeeded"; job.finishedAt = new Date().toISOString(); }
        await store.set(job);
      } catch (error) {
        job.status = cloudJobFailureStatus(job, error);
        job.error = error instanceof Error ? error.message : String(error);
        job.finishedAt = new Date().toISOString();
        await store.set(job);
      } finally {
        capacity.releaseJob(job.id);
      }
    }
  } finally {
    draining = false;
  }
}

async function main(): Promise<void> {
  if (!process.env.PIPELINE_WORKER_TOKEN?.trim())
    throw new Error("PIPELINE_WORKER_TOKEN is required");
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && !privateNetwork)
    throw new Error("PIPELINE_WORKER_HOST must be loopback unless PIPELINE_WORKER_PRIVATE_NETWORK=1");
  // 导出引擎配置错误时启动即失败，不等到首个任务。
  resolveArticleExportEngine();
  await mkdir(workspaceRoot, { recursive: true });
  await store.load();
  await accounts.load();
  for (const job of store.jobs.values()) {
    if (!job.acceptanceIncomplete) continue;
    await rm(defaultJobWorkspace(workspaceRoot, job.id), { recursive: true, force: true });
    job.acceptanceIncomplete = false;
    await store.set(job);
  }
  await capacity.initialize();
  maintenance = JSON.parse(await readFile(maintenanceFile, "utf8").catch(error => {
    if (error.code === "ENOENT") return "false";
    throw error;
  })) === true;
  for (const job of store.jobs.values()) {
    if (job.status === "queued") queue.push(job.id);
  }
  void drain();

  const server = Bun.serve({
    hostname: host,
    port,
    maxRequestBodySize: maxAssetBytes + 1,
    async fetch(request) {
      const url = new URL(request.url);
      if (!bearerMatches(request))
        return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/health" && request.method === "GET")
        return json({ service: "zzhub-pipeline-worker", status: "ok", queued: queue.length, running: draining, accepting: [...store.jobs.values()].filter(job => job.status === "accepting").length,
          preparing: capacity.preparingCount, assetWrites, accounts: accounts.accounts.size, maintenance,
          capabilities: { articleStyleSchemaVersions: [1, 2], articleSnapshotSchemaVersions: [1], previewConfirm: true, bodyAssetUpload: true, jobLookupByIdempotencyKey: true, articleExportEngine: resolveArticleExportEngine(), ...await coverCapabilities() } });

      try {
        const assetMatch = url.pathname.match(/^\/v1\/assets\/([a-f\d]{64})$/);
        if (assetMatch && request.method === "PUT") {
          if (maintenance) return json({ error: "worker_maintenance" }, 503);
          if (assetWrites >= 2) return json({ error: "worker_asset_busy" }, 429);
          assetWrites += 1;
          try { await capacity.checkPhase(); return json(await putBodyAsset(workspaceRoot, assetMatch[1]!, request, capacity)); }
          finally { assetWrites -= 1; }
        }
        const artifactMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/artifacts\/([^/]+)$/);
        if (artifactMatch && request.method === "GET") {
          const job = store.get(artifactMatch[1]!);
          if (!job?.input.articleSnapshot || !job.result?.artifactManifestHash) return json({ error: "artifact_not_found" }, 404);
          const asset = await readArtifact(defaultJobWorkspace(workspaceRoot, job.id), artifactMatch[2]!, String(job.result.artifactManifestHash), String(job.result.snapshotHash));
          return new Response(new Uint8Array(asset.bytes), { headers: { "Content-Type": asset.artifact.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
        }
        const confirmMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/publish$/);
        if (confirmMatch && request.method === "POST") {
          const job = store.get(confirmMatch[1]!);
          if (!job?.input.articleSnapshot) return json({ error: "preview_job_not_found" }, 404);
          const confirmation = await request.json();
          if (confirmation?.snapshotHash !== job.result?.snapshotHash || confirmation?.artifactManifestHash !== job.result?.artifactManifestHash) return json({ error: "preview_hash_conflict" }, 409);
          if (job.publicationRequested) return json(await publicJob(job), 200);
          if (maintenance) return json({ error: "worker_maintenance" }, 503);
          if (job.status !== "preview_ready") return json({ error: "preview_not_ready" }, 409);
          await capacity.checkPhase();
          await readPreparedArticle(defaultJobWorkspace(workspaceRoot, job.id), job.preparedHash!);
          const manifest = job.result?.artifactManifest as { artifacts?: Array<{ key: string }> };
          for (const artifact of manifest.artifacts || []) await readArtifact(defaultJobWorkspace(workspaceRoot, job.id), artifact.key, String(job.result!.artifactManifestHash), String(job.result!.snapshotHash));
          if (job.publicationRequested) return json(await publicJob(job), 200);
          // 同一内存 job 是并发确认的线性点，先持久化意图再进入原任务队列。
          const reserved = await capacity.reserveJob(job.id, defaultJobWorkspace(workspaceRoot, job.id));
          if (job.publicationRequested) {
            if (reserved) capacity.releaseJob(job.id);
            return json(await publicJob(job), 200);
          }
          if (maintenance) { if (reserved) capacity.releaseJob(job.id); return json({ error: "worker_maintenance" }, 503); }
          job.publicationRequested = true; job.status = "queued"; job.step = "queued";
          try { await store.set(job); } catch (error) { if (reserved) capacity.releaseJob(job.id); throw error; }
          queue.push(job.id); void drain();
          return json(await publicJob(job), 202);
        }
        if (url.pathname === "/v1/maintenance" && request.method === "PUT") {
          const input = await request.json();
          if (typeof input?.enabled !== "boolean") return json({ error: "enabled must be a boolean" }, 400);
          const temporary = `${maintenanceFile}.tmp`;
          await writeFile(temporary, JSON.stringify(input.enabled), { mode: 0o600 });
          await rename(temporary, maintenanceFile);
          maintenance = input.enabled;
          return json({ maintenance, queued: queue.length, running: draining });
        }
        const accountMatch = url.pathname.match(/^\/v1\/accounts\/([^/]+)$/);
        if (accountMatch && request.method === "PUT") {
          await capacity.checkPhase();
          const input = validateAccount(await request.json(), accountMatch[1]);
          await accounts.set({ ...input, updatedAt: new Date().toISOString() });
          return json({ account: input.account, status: "active" });
        }
        if (accountMatch && request.method === "DELETE") {
          await capacity.checkPhase();
          const deleted = await accounts.delete(accountMatch[1]);
          return json({ account: accountMatch[1], deleted });
        }
        if (url.pathname === "/v1/jobs" && request.method === "POST") {
          const contentLength = Number(request.headers.get("content-length") || "0");
          if (Number.isFinite(contentLength) && contentLength > maxJobRequestBytes)
            return json({ error: "request body too large" }, 413);
          const requestText = await request.text();
          if (Buffer.byteLength(requestText) > maxJobRequestBytes) return json({ error: "request body too large" }, 413);
          const input = validateInput(JSON.parse(requestText));
          // 无封面请求继续遵守原 2.5 MB 上限，不改变旧正文字符约定。
          if (!input.coverSnapshot && Buffer.byteLength(requestText, "utf8") > 2_500_000)
            return json({ error: "request body too large" }, 413);
          const inFlight = acceptingKeys.get(input.idempotencyKey);
          if (inFlight) {
            const accepted = await inFlight;
            if (!accepted) return json({ error: "worker_maintenance" }, 503);
            return accepted.requestHash === requestHash(input) ? json(await publicJob(accepted), 200) : json({ error: "idempotency_conflict" }, 409);
          }
          const existing = store.findByIdempotencyKey(input.idempotencyKey);
          if (existing && existing.requestHash !== requestHash(input))
            return json({ error: "idempotency_conflict" }, 409);
          if (existing)
            return json(await publicJob(existing), 200);
          if (maintenance) return json({ error: "worker_maintenance" }, 503);
          // 同键只等待持久化接收身份，不等待重材料准备。
          const acceptance = (async () => {
            const jobId = randomUUID();
            const workspace = defaultJobWorkspace(workspaceRoot, jobId);
            await capacity.reserveJob(jobId, workspace, true);
            if (maintenance) { capacity.releaseJob(jobId); return null; }
            const now = new Date().toISOString();
            const job: StoredCloudJob = {
              id: jobId,
              requestHash: requestHash(input),
              input: {
                idempotencyKey: input.idempotencyKey,
                title: input.title,
                contentForm: input.contentForm,
                account: input.account,
                intentText: input.intentText,
                existingDraftMediaId: input.existingDraftMediaId,
                useDefaultCover: input.useDefaultCover,
                coverTheme: input.coverTheme,
                ...(input.newspic ? { newspic: input.newspic } : {}),
                ...(input.articleStyle ? { articleStyle: input.articleStyle } : {}),
                ...(input.coverSnapshot ? { coverSnapshot: input.coverSnapshot } : {}),
                ...(input.articleSnapshot ? { operation: "preview", articleSnapshot: input.articleSnapshot } : {}),
              },
              status: "accepting",
              step: "accepting",
              runId: null,
              error: null,
              result: null,
              createdAt: now,
              updatedAt: now,
              startedAt: null,
              finishedAt: null,
              body: input.body,
              statePath: null,
              acceptanceIncomplete: true,
              ...(input.articleSnapshot ? { publicationRequested: false } : {}),
            };
            try { await store.set(job); } catch (error) { capacity.releaseJob(jobId); throw error; }
            return job;
          })();
          acceptingKeys.set(input.idempotencyKey, acceptance);
          let job: StoredCloudJob | null;
          try { job = await acceptance; } finally { acceptingKeys.delete(input.idempotencyKey); }
          if (!job) return json({ error: "worker_maintenance" }, 503);
          const workspace = defaultJobWorkspace(workspaceRoot, job.id);
          try {
            const prepared = input.articleSnapshot ? await prepareArticleMaterials(workspace, input, workspaceRoot) : undefined;
            if (prepared) {
              job.preparedHash = canonicalHash(prepared);
              job.result = { inputHash: prepared.inputHash, snapshotHash: prepared.snapshotHash };
            }
            job.status = "queued"; job.step = "queued"; job.acceptanceIncomplete = false;
            await store.set(job);
          } catch (error) {
            await rm(workspace, { recursive: true, force: true });
            job.status = "failed"; job.step = "acceptance"; job.acceptanceIncomplete = false;
            job.error = error instanceof Error ? error.message : String(error); job.finishedAt = new Date().toISOString();
            await store.set(job);
            return json(await publicJob(job), 202);
          } finally { capacity.releaseJob(job.id); }
          queue.push(job.id);
          void drain();
          return json(await publicJob(job), 202);
        }

        if (url.pathname === "/v1/jobs/by-idempotency-key" && request.method === "GET") {
          const keys = url.searchParams.getAll("idempotencyKey"), names = url.searchParams.getAll("account");
          if (keys.length !== 1 || names.length !== 1 || !keys[0] || keys[0].length > 200 || !/^[a-zA-Z0-9_.-]{1,80}$/.test(names[0]!)
            || [...url.searchParams.keys()].some(key => !["idempotencyKey", "account"].includes(key))) return json({ error: "invalid_job_lookup" }, 400);
          await acceptingKeys.get(keys[0]);
          const job = store.findByIdempotencyKey(keys[0]);
          if (!job) return json({ error: "job_not_found" }, 404);
          if (job.input.account !== names[0]) return json({ error: "idempotency_conflict" }, 409);
          return json(await publicJob(job));
        }
        const match = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
        if (match && request.method === "GET") {
          const job = store.get(match[1]);
          return job ? json(await publicJob(job)) : json({ error: "job_not_found" }, 404);
        }
        return json({ error: "not_found" }, 404);
      } catch (error) {
        if (error instanceof WorkerLimitError) return json({ error: error.code }, error.status);
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    },
  });
  console.log(`zzhub-pipeline-worker listening on ${host}:${server.port}`);
}

await main();
