import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredCloudJob } from "./store";
import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { closePreview, expiredPreviews, isClosedPreview, isOpenPreview, PREVIEW_DISCARDED, PREVIEW_EXPIRED, prunableJobs, pruneJob } from "./retention";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-20T12:00:00.000Z");

function previewJob(id: string, overrides: Partial<StoredCloudJob> = {}): StoredCloudJob {
  const at = new Date(NOW - 2 * HOUR).toISOString();
  return {
    id, requestHash: `hash-${id}`, status: "preview_ready", step: "preview_ready", runId: `run-${id}`, error: null,
    input: { idempotencyKey: `key-${id}`, title: "title", contentForm: "article", account: "test", operation: "preview",
      articleSnapshot: { schemaVersion: 1, documentId: "doc", documentRevision: 1, bodyAssets: [], inputHash: "input" } } as unknown as StoredCloudJob["input"],
    result: { snapshotHash: "snapshot", artifactManifestHash: "manifest" },
    createdAt: at, updatedAt: at, startedAt: at, finishedAt: null,
    body: "body", statePath: null, publicationRequested: false, preparedHash: "prepared",
    ...overrides,
  };
}

describe("preview retention rules", () => {
  test("only unconfirmed previews that are ready or still queued are open", () => {
    expect(isOpenPreview(previewJob("ready"))).toBe(true);
    expect(isOpenPreview(previewJob("queued", { status: "queued" }))).toBe(true);
    expect(isOpenPreview(previewJob("running", { status: "running" }))).toBe(false);
    expect(isOpenPreview(previewJob("confirmed", { status: "queued", publicationRequested: true }))).toBe(false);
    const direct = previewJob("direct");
    delete (direct.input as Record<string, unknown>).articleSnapshot;
    expect(isOpenPreview(direct)).toBe(false);
  });

  test("closing a preview records a failed job with the reason", () => {
    const job = previewJob("close");
    closePreview(job, "expired", new Date(NOW));
    expect(job).toMatchObject({ status: "failed", step: "expired", error: PREVIEW_EXPIRED, finishedAt: new Date(NOW).toISOString() });
    expect(isClosedPreview(job)).toBe(true);
    expect(isOpenPreview(job)).toBe(false);
  });

  test("expires ready previews older than the TTL and nothing when the TTL is off", () => {
    const old = previewJob("old");
    const fresh = previewJob("fresh", { updatedAt: new Date(NOW - 30 * 60 * 1000).toISOString() });
    const confirmed = previewJob("confirmed", { publicationRequested: true });
    const queued = previewJob("queued", { status: "queued" });
    const jobs = [old, fresh, confirmed, queued];
    expect(expiredPreviews(jobs, NOW, HOUR).map(job => job.id)).toEqual(["old"]);
    expect(expiredPreviews(jobs, NOW, 2 * HOUR).map(job => job.id)).toEqual(["old"]);
    expect(expiredPreviews(jobs, NOW, 0)).toEqual([]);
  });
});

describe("terminal job tombstones", () => {
  const DAY = 24 * HOUR;
  const ended = (id: string, status: StoredCloudJob["status"], daysAgo: number, overrides: Partial<StoredCloudJob> = {}) =>
    previewJob(id, { status, finishedAt: new Date(NOW - daysAgo * DAY).toISOString(), ...overrides });

  test("selects only unpruned, unreserved terminal jobs past the retention period", () => {
    const jobs = [
      ended("old-success", "succeeded", 40), ended("old-failed", "failed", 36), ended("recent", "succeeded", 10),
      ended("interrupted", "interrupted", 40), ended("ready", "preview_ready", 40), ended("reserved", "failed", 40),
      ended("pruned", "succeeded", 40, { pruned: { at: new Date(NOW).toISOString(), retentionDays: 35 } }),
    ];
    expect(prunableJobs(jobs, NOW, 35, id => id === "reserved").map(job => job.id)).toEqual(["old-success", "old-failed"]);
    expect(prunableJobs(jobs, NOW, 0, () => false)).toEqual([]);
  });

  test("keeps identity, hashes and publish results and drops bulky fields", () => {
    const job = ended("tomb", "succeeded", 40, {
      body: "原始正文", statePath: "/data/jobs/tomb/state.json",
      result: { snapshotHash: "snapshot", artifactManifestHash: "manifest", artifactManifest: { artifacts: [] }, publishResults: [{ status: "success", external_id: "MEDIA" }] },
    });
    const before = { requestHash: job.requestHash, key: job.input.idempotencyKey };
    pruneJob(job, 35, new Date(NOW));
    expect(job.body).toBe("");
    expect(job.bodyHash).toBe(createHash("sha256").update("原始正文").digest("hex"));
    expect(job.statePath).toBeNull();
    expect(job.input).toEqual({ idempotencyKey: before.key, title: "title", contentForm: "article", account: "test", operation: "preview" });
    expect(job.requestHash).toBe(before.requestHash);
    expect(job.result).toEqual({ snapshotHash: "snapshot", artifactManifestHash: "manifest", publishResults: [{ status: "success", external_id: "MEDIA" }] });
    expect(job.pruned).toEqual({ at: new Date(NOW).toISOString(), retentionDays: 35 });
  });

  test("tombstoned jobs still answer idempotent submissions and refuse their artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "zzp-tombstone-"));
    const input = { idempotencyKey: "tomb-key", title: "墓碑", body: "墓碑正文", contentForm: "article", account: "missing" };
    try {
      // 用真实提交生成任务：账号不存在，任务在调用 CLI 前失败，requestHash 与线上一致。
      let worker = await startWorker(root, {});
      let id: string;
      try {
        const submitted = await fetch(`${worker.url}/v1/jobs`, { method: "POST", headers, body: JSON.stringify(input) });
        id = (await submitted.json()).id;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if ((await (await fetch(`${worker.url}/v1/jobs/${id}`, { headers })).json()).status === "failed") break;
          await Bun.sleep(25);
        }
      } finally { await worker.stop(); }
      const stateFile = join(root, "jobs.json");
      const store = JSON.parse(await readFile(stateFile, "utf8"));
      const job = store.jobs.find((item: StoredCloudJob) => item.id === id);
      expect(job.status).toBe("failed");
      job.finishedAt = new Date(Date.now() - 40 * DAY).toISOString();
      const closedPreview = previewJob("closed-preview", { status: "failed", error: PREVIEW_EXPIRED, finishedAt: new Date(Date.now() - 40 * DAY).toISOString() });
      store.jobs.push(closedPreview);
      await writeFile(stateFile, JSON.stringify(store));
      for (const jobId of [id!, "closed-preview"]) {
        await mkdir(join(root, "jobs", jobId), { recursive: true });
        await writeFile(join(root, "jobs", jobId, "artifact.html"), "x".repeat(1024));
      }

      worker = await startWorker(root, { PIPELINE_WORKER_TERMINAL_RETENTION_DAYS: "35" });
      try {
        expect((await (await fetch(`${worker.url}/health`, { headers })).json()).capabilities.terminalRetention).toBe(true);
        const tomb = await (await fetch(`${worker.url}/v1/jobs/${id!}`, { headers })).json();
        expect(tomb).toMatchObject({ id, status: "failed", bodyHash: createHash("sha256").update(input.body).digest("hex"), pruned: { retentionDays: 35 } });
        for (const jobId of [id!, "closed-preview"]) await expect(stat(join(root, "jobs", jobId))).rejects.toThrow();
        const again = await fetch(`${worker.url}/v1/jobs`, { method: "POST", headers, body: JSON.stringify(input) });
        expect(again.status).toBe(200);
        expect((await again.json()).id).toBe(id!);
        const changed = await fetch(`${worker.url}/v1/jobs`, { method: "POST", headers, body: JSON.stringify({ ...input, body: "改过的正文" }) });
        expect(changed.status).toBe(409);
        const lookup = await fetch(`${worker.url}/v1/jobs/by-idempotency-key?idempotencyKey=tomb-key&account=missing`, { headers });
        expect((await lookup.json()).id).toBe(id!);
        const artifact = await fetch(`${worker.url}/v1/jobs/closed-preview/artifacts/article`, { headers });
        expect(artifact.status).toBe(410);
        expect((await artifact.json()).error).toBe("artifact_pruned");
      } finally { await worker.stop(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30_000);
});

// 真实 Worker HTTP；任务存储直接写入已就绪预览，避免依赖 Chrome 与真实 CLI。
async function withWorker(jobs: StoredCloudJob[], env: Record<string, string>, run: (url: string, root: string) => Promise<void>, options: { maintenance?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zzp-preview-retention-"));
  const stateFile = join(root, "jobs.json");
  await writeFile(stateFile, JSON.stringify({ jobs }));
  if (options.maintenance) await writeFile(`${stateFile}.maintenance.json`, "true");
  const worker = await startWorker(root, env);
  try { await run(worker.url, root); }
  finally { await worker.stop(); await rm(root, { recursive: true, force: true }); }
}

async function startWorker(root: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
    env: { ...process.env, PIPELINE_WORKER_HOST: "127.0.0.1", PIPELINE_WORKER_PORT: "0", PIPELINE_WORKER_TOKEN: "retention-test",
      PIPELINE_WORKSPACE_ROOT: root, PIPELINE_WORKER_STATE_FILE: join(root, "jobs.json"), PIPELINE_WORKER_FREE_BYTES: "1", PIPELINE_WORKER_JOB_RESERVE_BYTES: "1", ...env },
    stdout: "pipe", stderr: "inherit",
  });
  const stop = async () => { child.kill(); await child.exited; };
  const reader = child.stdout.getReader(); const { value } = await reader.read(); reader.releaseLock();
  const address = new TextDecoder().decode(value).match(/listening on (127\.0\.0\.1:\d+)/)?.[1];
  if (!address) { await stop(); throw new Error("Worker did not start"); }
  return { url: `http://${address}`, stop };
}

const headers = { Authorization: "Bearer retention-test" };

describe("preview discard and expiry over HTTP", () => {
  test("discarding closes the preview once, blocks confirmation and survives restarts", async () => {
    await withWorker([previewJob("discard"), previewJob("confirmed", { status: "queued", publicationRequested: true, step: "queued" })], {}, async (url, root) => {
      const health = await (await fetch(`${url}/health`, { headers })).json();
      expect(health.capabilities.previewDiscard).toBe(true);
      const first = await fetch(`${url}/v1/jobs/discard/discard`, { method: "POST", headers });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ id: "discard", status: "failed", step: "discarded", error: PREVIEW_DISCARDED });
      const again = await fetch(`${url}/v1/jobs/discard/discard`, { method: "POST", headers });
      expect(again.status).toBe(200);
      expect((await again.json()).error).toBe(PREVIEW_DISCARDED);
      const confirm = await fetch(`${url}/v1/jobs/discard/publish`, { method: "POST", headers, body: JSON.stringify({ snapshotHash: "snapshot", artifactManifestHash: "manifest" }) });
      expect(confirm.status).toBe(409);
      expect((await confirm.json()).error).toBe("preview_not_ready");
      expect((await fetch(`${url}/v1/jobs/missing/discard`, { method: "POST", headers })).status).toBe(404);
      const stored = JSON.parse(await readFile(join(root, "jobs.json"), "utf8")).jobs.find((job: StoredCloudJob) => job.id === "discard");
      expect(stored).toMatchObject({ status: "failed", error: PREVIEW_DISCARDED });
    });
  }, 30_000);

  test("a confirmed preview cannot be discarded", async () => {
    // interrupted 不会被重新入队，确认状态在检查期间保持不变。
    const confirmed = previewJob("confirmed", { publicationRequested: true, status: "interrupted", step: "publish" });
    await withWorker([confirmed], {}, async (url) => {
      const response = await fetch(`${url}/v1/jobs/confirmed/discard`, { method: "POST", headers });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("preview_already_confirmed");
    });
  }, 30_000);

  test("expires stale previews at startup and leaves fresh ones and maintenance windows alone", async () => {
    const fresh = previewJob("fresh", { updatedAt: new Date().toISOString() });
    await withWorker([previewJob("stale"), fresh], { PIPELINE_WORKER_PREVIEW_TTL_HOURS: "1" }, async (url) => {
      expect(await (await fetch(`${url}/v1/jobs/stale`, { headers })).json()).toMatchObject({ status: "failed", step: "expired", error: PREVIEW_EXPIRED });
      expect((await (await fetch(`${url}/v1/jobs/fresh`, { headers })).json()).status).toBe("preview_ready");
    });
    await withWorker([previewJob("off")], {}, async (url) => {
      expect((await (await fetch(`${url}/v1/jobs/off`, { headers })).json()).status).toBe("preview_ready");
    });
    await withWorker([previewJob("held")], { PIPELINE_WORKER_PREVIEW_TTL_HOURS: "1" }, async (url) => {
      expect((await (await fetch(`${url}/v1/jobs/held`, { headers })).json()).status).toBe("preview_ready");
    }, { maintenance: true });
  }, 30_000);
});
