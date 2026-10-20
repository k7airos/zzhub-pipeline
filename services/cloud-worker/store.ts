import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ArticleStyleSnapshot } from "../../src/article-style";
import type { CoverSnapshot } from "../../src/cover-snapshot";
import type { ArticleSnapshot } from "../../src/article-snapshot";

export type CloudJobStatus = "accepting" | "queued" | "running" | "preview_ready" | "succeeded" | "failed" | "interrupted";

export interface CloudJobInput {
  idempotencyKey: string;
  title: string;
  body: string;
  contentForm: "article" | "newspic";
  account: string;
  intentText?: string;
  existingDraftMediaId?: string | null;
  useDefaultCover?: boolean;
  coverTheme?: string | null;
  newspic?: { content: string; photos: string[] };
  articleStyle?: ArticleStyleSnapshot;
  coverSnapshot?: CoverSnapshot;
  operation?: "preview";
  articleSnapshot?: ArticleSnapshot;
}

export interface CloudJob {
  id: string;
  requestHash: string;
  input: Omit<CloudJobInput, "body">;
  status: CloudJobStatus;
  step: string;
  runId: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StoredCloudJob extends CloudJob {
  body: string;
  /** 原始正文的 SHA-256；墓碑化清空正文后仍用于调用方核对。 */
  bodyHash?: string;
  /** 终态任务超过保留期后，大字段与工作目录已清理。 */
  pruned?: { at: string; retentionDays: number };
  statePath: string | null;
  publicationRequested?: boolean;
  preparedHash?: string;
  acceptanceIncomplete?: boolean;
}

export interface PipelineWorkerAccount {
  account: string;
  appId: string;
  appSecret: string;
  pat: string;
  updatedAt: string;
}

interface PersistedStore {
  jobs: StoredCloudJob[];
}

/** ponytail: 单进程全量写 JSON；多副本或大量历史任务时迁移到数据库队列。 */
export class JobStore {
  readonly jobs = new Map<string, StoredCloudJob>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as PersistedStore;
      if (!Array.isArray(parsed.jobs)) throw new Error("Invalid worker job store");
      for (const job of parsed.jobs) {
        job.requestHash ||= createHash("sha256").update(JSON.stringify({ ...job.input, body: job.body })).digest("hex");
        job.bodyHash ||= createHash("sha256").update(job.body).digest("hex");
        if (job.status === "accepting") {
          job.status = "failed";
          job.error = "worker_acceptance_interrupted";
          job.step = "acceptance";
          job.finishedAt = new Date().toISOString();
          job.updatedAt = job.finishedAt;
          job.acceptanceIncomplete = true;
        } else if (job.status === "running") {
          job.status = "interrupted";
          job.error = "Worker interrupted; inspect the original Pipeline run and draft box before retrying. Publishing may already have succeeded.";
          job.finishedAt = new Date().toISOString();
          job.updatedAt = job.finishedAt;
        }
        this.jobs.set(job.id, job);
      }
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
      await this.persist();
    }
  }

  get(id: string): StoredCloudJob | null {
    return this.jobs.get(id) || null;
  }

  findByIdempotencyKey(key: string): StoredCloudJob | null {
    for (const job of this.jobs.values()) {
      if (job.input.idempotencyKey === key)
        return job;
    }
    return null;
  }

  async set(job: StoredCloudJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    this.jobs.set(job.id, job);
    await this.persist();
  }

  async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ jobs: [...this.jobs.values()] }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
    });
    return this.writeChain;
  }
}

/** 账号凭据只存在 worker 持久卷，任务状态不会复制这些字段。 */
export class AccountStore {
  readonly accounts = new Map<string, PipelineWorkerAccount>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as { accounts?: PipelineWorkerAccount[] };
      if (!Array.isArray(parsed.accounts)) throw new Error("Invalid worker account store");
      for (const account of parsed.accounts)
        this.accounts.set(account.account, account);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
      await this.persist();
    }
  }

  get(account: string): PipelineWorkerAccount | null {
    return this.accounts.get(account) || null;
  }

  async set(account: PipelineWorkerAccount): Promise<void> {
    this.accounts.set(account.account, account);
    await this.persist();
  }

  async delete(account: string): Promise<boolean> {
    const deleted = this.accounts.delete(account);
    if (deleted)
      await this.persist();
    return deleted;
  }

  async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ accounts: [...this.accounts.values()] }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
    });
    return this.writeChain;
  }
}

export function defaultJobWorkspace(root: string, jobId: string): string {
  return join(root, "jobs", jobId);
}
