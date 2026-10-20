import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { StoredCloudJob } from "./store";

const MiB = 1024 * 1024;

export class WorkerLimitError extends Error {
  constructor(readonly code: string, readonly status: 413 | 429 | 507) { super(code); }
}

function setting(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}`);
  return parsed;
}

export const workerLimits = {
  cacheBytes: setting("PIPELINE_WORKER_CACHE_BYTES", 512 * MiB),
  cacheTtlMs: setting("PIPELINE_WORKER_CACHE_TTL_MS", 30 * 60 * 1000),
  prepareConcurrency: setting("PIPELINE_WORKER_PREPARE_CONCURRENCY", 2),
  freeBytes: setting("PIPELINE_WORKER_FREE_BYTES", 4 * 1024 * MiB),
  jobReserveBytes: setting("PIPELINE_WORKER_JOB_RESERVE_BYTES", 1024 * MiB),
  // 单个 CLI 步骤的墙钟上限，防止卡住的步骤占住串行队列。
  stepTimeoutMs: setting("PIPELINE_WORKER_STEP_TIMEOUT_MS", 10 * 60 * 1000),
  publishStepTimeoutMs: setting("PIPELINE_WORKER_PUBLISH_STEP_TIMEOUT_MS", 10 * 60 * 1000),
};

/** 仅统计受控任务目录；未来写入预留随已实际写入的字节减少。 */
async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  let bytes = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(child);
    else if (entry.isFile()) bytes += (await stat(child)).size;
  }
  return bytes;
}

/** 单进程容量门禁，不替代任务队列或精确磁盘配额。 */
export class WorkerCapacity {
  private chain: Promise<void> = Promise.resolve();
  private preparing = 0;
  private reservations = new Map<string, { workspace: string; initialBytes: number; bytes: number; preparing: boolean }>();
  constructor(private root: string, private jobs: () => Iterable<StoredCloudJob>) {}

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.chain;
    let unlock!: () => void;
    this.chain = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    try { return await action(); } finally { unlock(); }
  }

  private async checkSpace(additional = 0) {
    let outstanding = additional;
    for (const reserve of this.reservations.values()) {
      const growth = Math.max(0, await directoryBytes(reserve.workspace) - reserve.initialBytes);
      outstanding += Math.max(0, reserve.bytes - growth);
    }
    // 先算预留再采空闲值，避免用写入前 free 搭配写入后 growth 重复计空闲。
    const disk = await statfs(this.root);
    if (disk.bavail * disk.bsize - outstanding < workerLimits.freeBytes) throw new WorkerLimitError("worker_storage_low", 507);
  }

  async reserveJob(id: string, workspace: string, preparing = false): Promise<boolean> {
    return this.locked(async () => {
      if (this.reservations.has(id)) return false;
      if (preparing && this.preparing >= workerLimits.prepareConcurrency) throw new WorkerLimitError("worker_prepare_busy", 429);
      await this.checkSpace(workerLimits.jobReserveBytes);
      this.reservations.set(id, { workspace, initialBytes: await directoryBytes(workspace), bytes: workerLimits.jobReserveBytes, preparing });
      if (preparing) this.preparing += 1;
      return true;
    });
  }

  releaseJob(id: string) {
    const reservation = this.reservations.get(id);
    if (this.reservations.delete(id) && reservation?.preparing) this.preparing -= 1;
  }

  get preparingCount() { return this.preparing; }

  async checkPhase() { await this.locked(() => this.checkSpace()); }

  /** 缓存清理只删除过期且没有任何保留任务引用的字节和启动遗留临时文件。 */
  private async cacheFiles(startup: boolean) {
    const directory = join(this.root, "assets");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const referenced = new Set<string>();
    for (const job of this.jobs()) {
      for (const asset of job.input.articleSnapshot?.bodyAssets || []) referenced.add(asset.sha256);
      if (job.input.coverSnapshot?.schemaVersion === 2) referenced.add(job.input.coverSnapshot.renderedAsset.sha256);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(directory, entry.name);
      const info = await stat(path);
      const hash = /^([a-f\d]{64})\.bytes$/.exec(entry.name)?.[1];
      if (startup && /^[a-f\d]{64}\.bytes\.[a-f\d-]+\.tmp$/.test(entry.name)
        || hash && !referenced.has(hash) && Date.now() - info.mtimeMs > workerLimits.cacheTtlMs) {
        await rm(path); continue;
      }
      bytes += info.size;
    }
    return bytes;
  }

  async initialize() { await this.locked(async () => { await this.cacheFiles(true); }); }

  async writeCache<T>(target: string, length: number, action: () => Promise<T>): Promise<T> {
    return this.locked(async () => {
      const current = await this.cacheFiles(false);
      const exists = await stat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      const newBytes = exists ? 0 : length;
      if (current + newBytes > workerLimits.cacheBytes) throw new WorkerLimitError("worker_cache_full", 507);
      await this.checkSpace(newBytes);
      return action();
    });
  }
}
