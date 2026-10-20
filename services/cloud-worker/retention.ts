import { createHash } from "node:crypto";
import type { StoredCloudJob } from "./store";

export const PREVIEW_DISCARDED = "preview_discarded";
export const PREVIEW_EXPIRED = "preview_expired";

/** 仍未确认、可以放弃的预览：已就绪，或还在队列中尚未开始生成。 */
export function isOpenPreview(job: StoredCloudJob): boolean {
  return Boolean(job.input.articleSnapshot) && !job.publicationRequested && (job.status === "preview_ready" || job.status === "queued");
}

export function isClosedPreview(job: StoredCloudJob): boolean {
  return job.status === "failed" && (job.error === PREVIEW_DISCARDED || job.error === PREVIEW_EXPIRED);
}

/**
 * 放弃或过期的预览统一记为 failed：调用后端按已有失败语义释放额度，不需要认识新状态。
 * 任务身份、幂等键和产物保留，确认接口此后返回 preview_not_ready。
 */
export function closePreview(job: StoredCloudJob, reason: "discarded" | "expired", now = new Date()): void {
  job.status = "failed";
  job.step = reason;
  job.error = reason === "discarded" ? PREVIEW_DISCARDED : PREVIEW_EXPIRED;
  job.finishedAt = now.toISOString();
}

/** 超过 TTL 仍未确认的已就绪预览；ttlMs 为 0 时关闭过期。 */
export function expiredPreviews(jobs: Iterable<StoredCloudJob>, now: number, ttlMs: number): StoredCloudJob[] {
  if (ttlMs <= 0) return [];
  return [...jobs].filter(job => job.status === "preview_ready" && isOpenPreview(job) && now - Date.parse(job.updatedAt) >= ttlMs);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 结束超过保留期、尚未墓碑化且没有空间预留的终态任务；days 为 0 时关闭。 */
export function prunableJobs(jobs: Iterable<StoredCloudJob>, now: number, days: number, isReserved: (id: string) => boolean): StoredCloudJob[] {
  if (days <= 0) return [];
  return [...jobs].filter(job => (job.status === "succeeded" || job.status === "failed") && !job.pruned && job.finishedAt
    && now - Date.parse(job.finishedAt) >= days * DAY_MS && !isReserved(job.id));
}

/**
 * 墓碑化：清空正文、快照与产物清单，保留幂等核对所需的身份、requestHash、bodyHash 与发布结果。
 * 调用方须先删除任务工作目录；requestHash 不变，同键同输入仍返回原任务，不会重复发布。
 */
export function pruneJob(job: StoredCloudJob, days: number, now = new Date()): void {
  const { idempotencyKey, title, contentForm, account, operation, existingDraftMediaId } = job.input;
  job.input = { idempotencyKey, title, contentForm, account, ...(operation ? { operation } : {}), ...(existingDraftMediaId ? { existingDraftMediaId } : {}) };
  job.bodyHash ||= createHash("sha256").update(job.body).digest("hex");
  job.body = "";
  job.statePath = null;
  if (job.result) {
    const result = { ...job.result };
    delete result.artifactManifest;
    job.result = result;
  }
  job.pruned = { at: now.toISOString(), retentionDays: days };
}
