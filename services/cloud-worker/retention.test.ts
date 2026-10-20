import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredCloudJob } from "./store";
import { closePreview, expiredPreviews, isClosedPreview, isOpenPreview, PREVIEW_DISCARDED, PREVIEW_EXPIRED } from "./retention";

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

// 真实 Worker HTTP；任务存储直接写入已就绪预览，避免依赖 Chrome 与真实 CLI。
async function withWorker(jobs: StoredCloudJob[], env: Record<string, string>, run: (url: string, root: string) => Promise<void>, options: { maintenance?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zzp-preview-retention-"));
  const stateFile = join(root, "jobs.json");
  await writeFile(stateFile, JSON.stringify({ jobs }));
  if (options.maintenance) await writeFile(`${stateFile}.maintenance.json`, "true");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
    env: { ...process.env, PIPELINE_WORKER_HOST: "127.0.0.1", PIPELINE_WORKER_PORT: "0", PIPELINE_WORKER_TOKEN: "retention-test",
      PIPELINE_WORKSPACE_ROOT: root, PIPELINE_WORKER_STATE_FILE: stateFile, PIPELINE_WORKER_FREE_BYTES: "1", PIPELINE_WORKER_JOB_RESERVE_BYTES: "1", ...env },
    stdout: "pipe", stderr: "inherit",
  });
  try {
    const reader = child.stdout.getReader(); const { value } = await reader.read(); reader.releaseLock();
    const address = new TextDecoder().decode(value).match(/listening on (127\.0\.0\.1:\d+)/)?.[1];
    if (!address) throw new Error("Worker did not start");
    await run(`http://${address}`, root);
  } finally { child.kill(); await child.exited; await rm(root, { recursive: true, force: true }); }
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
