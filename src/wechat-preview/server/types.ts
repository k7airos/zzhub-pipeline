export type PreviewErrorKind =
  | "chrome_missing"
  | "chrome_failed"
  | "dom_failed"
  | "timeout"
  | "render_error"
  | "bundle"
  | "other";

export type PreviewEntryStatus = "success" | "failed";

export interface PreviewEntryDebug {
  chrome_path?: string;
  virtual_time_budget_ms?: number;
  timeout_ms?: number;
  bundle_stale?: boolean;
  bundle_rebuilt?: boolean;
  shell_path?: string;
  stderr_tail?: string;
  debug_dir?: string;
}

export interface PreviewEntryMeta {
  id: string;
  title: string;
  account: string;
  status: PreviewEntryStatus;
  created_at: string;
  duration_ms: number;
  markdown_path?: string;
  html_path?: string;
  preview_style?: string;
  error?: string;
  error_kind?: PreviewErrorKind;
  debug?: PreviewEntryDebug;
}

export interface PreviewEntry extends PreviewEntryMeta {
  /** Final inlined article HTML (success only). */
  html?: string;
}

export interface PreviewServerLock {
  pid: number;
  host: string;
  port: number;
  url: string;
  started_at: string;
}

export interface PreviewRegisterInput {
  title: string;
  account: string;
  status: PreviewEntryStatus;
  duration_ms: number;
  markdown_path?: string;
  html_path?: string;
  preview_style?: string;
  html?: string;
  error?: string;
  error_kind?: PreviewErrorKind;
  debug?: PreviewEntryDebug;
}
