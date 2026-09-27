/**
 * 构建身份的展示格式化（纯函数，便于单测）。
 *
 * 前后端各三要素（版本号 / commit / 构建时间）在页脚技术信息条展示；两端共用本模块
 * 的格式化规则，避免"前端显示 v 前缀、后端不显示"这类不一致。
 *
 * 约定：
 * - 版本号统一显示为 Release tag 形态（自动补 `v` 前缀），便于直接对应 GitHub Release；
 * - commit 显示前 7 位（GitHub 惯例），完整 SHA 由调用方放进 `title`；`-dirty` 后缀保留，
 *   它表示"这是本地未提交的工作区"，是开发环境的重要信号；
 * - 时间按**访问者本地时区**渲染并附时区标识，`title` 保留原始 ISO UTC，避免 CI 与
 *   服务器时区不一致时误读；
 * - 任一字段缺失/非法 → `unknown`，由调用方决定降级展示，绝不抛错。
 */

/** 构建身份三元组（前后端同构）。 */
export interface BuildInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
}

/** 字段缺失或无法解析时的占位文本。 */
export const UNKNOWN_TEXT = "unknown";

/** commit 展示长度（GitHub 惯例的前缀位数）。 */
const COMMIT_DISPLAY_LENGTH = 7;

/**
 * 版本号归一化为 Release tag 形态（补 `v` 前缀）。
 *
 * @param version 原始版本号（可能已带 `v`，如 release tag）
 * @returns 展示用版本号；缺失时为 {@link UNKNOWN_TEXT}
 */
export function normalizeVersion(version: string | null | undefined): string {
  const value = (version ?? "").trim();
  if (!value || value === UNKNOWN_TEXT) return UNKNOWN_TEXT;
  return value.startsWith("v") ? value : `v${value}`;
}

/**
 * 拆分 commit 为「纯 SHA」与「是否脏工作区」。
 *
 * 输入形如 `4b7e3e2a9`、`4b7e3e2a9-dirty` 或完整 40 位 SHA。
 */
function splitCommit(
  commit: string | null | undefined,
): { sha: string; dirty: boolean } | null {
  const value = (commit ?? "").trim();
  if (!value || value === UNKNOWN_TEXT) return null;
  const dirty = value.endsWith("-dirty");
  const sha = dirty ? value.slice(0, -"-dirty".length) : value;
  return sha ? { sha, dirty } : null;
}

/**
 * commit 的展示文本：前 7 位 +（开发环境）`-dirty` 后缀。
 *
 * @param commit 原始 commit（短/全长 SHA，可带 `-dirty`）
 * @returns 展示用短 SHA；缺失时为 {@link UNKNOWN_TEXT}
 */
export function commitDisplay(commit: string | null | undefined): string {
  const parsed = splitCommit(commit);
  if (!parsed) return UNKNOWN_TEXT;
  const short = parsed.sha.slice(0, COMMIT_DISPLAY_LENGTH);
  return parsed.dirty ? `${short}-dirty` : short;
}

/**
 * commit 的完整值（去掉 `-dirty` 后缀），供 `title` 与 commit 链接使用。
 *
 * @param commit 原始 commit
 * @returns 完整 SHA；缺失时为 null
 */
export function commitFull(commit: string | null | undefined): string | null {
  return splitCommit(commit)?.sha ?? null;
}

/**
 * 构建时间格式化为 `YYYY-MM-DD HH:mm <时区>`。
 *
 * @param builtAt ISO 8601 时间串（通常是 UTC）
 * @param timeZone 目标时区；缺省用运行环境本地时区（浏览器里即访问者时区）。
 *   显式传入便于测试固定输出。
 * @returns 展示用时间；缺失或非法时为 {@link UNKNOWN_TEXT}
 */
export function formatBuiltAt(
  builtAt: string | null | undefined,
  timeZone?: string,
): string {
  const value = (builtAt ?? "").trim();
  if (!value || value === UNKNOWN_TEXT) return UNKNOWN_TEXT;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return UNKNOWN_TEXT;

  const parts = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const dateText = `${get("year")}-${get("month")}-${get("day")}`;
  const timeText = `${get("hour")}:${get("minute")}`;
  const zone = get("timeZoneName");
  return zone ? `${dateText} ${timeText} ${zone}` : `${dateText} ${timeText}`;
}

/**
 * 单端三要素的纯文本形式（供 `title` / `aria-label` / 无链接降级使用）。
 *
 * @param info 构建身份
 * @returns 形如 `v0.10.1-beta.3 · 4b7e3e2 · 2026-09-27 20:31 GMT+8`
 */
export function buildInfoText(info: BuildInfo): string {
  return [
    normalizeVersion(info.version),
    commitDisplay(info.commit),
    formatBuiltAt(info.builtAt),
  ].join(" · ");
}
