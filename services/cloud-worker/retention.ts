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
