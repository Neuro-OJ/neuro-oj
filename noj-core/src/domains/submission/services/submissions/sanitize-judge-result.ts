/**
 * 评测结果防御性归一（2026-09-12 架构评审 §4.3）。
 *
 * Redis 队列是 noj-core ↔ noj-judge 之间的**信任边界**。judge 侧虽然已对分数做了
 * clamp（`noj-judge/src/dual/mod.rs` 限定 0..10000），但 core 此前对回传的
 * `score` / `status` / `time_ms` / `memory_kb` **零校验**：
 *
 * - `score` 直接写入 `evaluation_results.score`，而榜单/竞赛排名 SQL
 *   直接用 `er.score` 聚合（`contest-ranking.ts`）→ 脏分数会直接进入排名；
 * - `status` 直接落库；非预期值会让前端/统计分支落空。
 *
 * 触发场景不需要恶意构造：judge 版本回退、judge 被替换、队列被其他主体写入、
 * 消息中途被截断（JSON 仍可解析但字段类型变了）都会产生脏值。
 *
 * 与 `sanitizeJudgeDetails`（仅 details 做白名单）保持同一严格度，形成"整条结果
 * 都经过 core 侧归一"的纵深防御。
 */
import { FULL_SCORE } from "../../../../shared/base/constants.ts";
import type { JudgeResult } from "../../types/index.ts";

/**
 * 允许落库的评测状态白名单。
 *
 * 来源：noj-judge `JudgeStatus`（finished / error 为统一映射结果，其余为
 * 具体失败归因）。未知状态一律降级为 `error`——宁可显示"评测失败"，
 * 也不把未定义状态写进数据库。
 */
export const ALLOWED_JUDGE_STATUSES: readonly string[] = [
  "finished",
  "error",
  "SystemError",
  "TimeLimitExceeded",
  "MemoryLimitExceeded",
  "RuntimeError",
];

/** output 字段的防御性上限（judge 侧为 1 MiB，这里留一倍余量） */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface SanitizedJudgeResult {
  result: JudgeResult;
  /** 归一过程中实际发生的修正（空数组表示原始值全部合规） */
  adjustments: string[];
}

/** 把任意值收窄为非负有限整数；不合法时返回 null。 */
function toNonNegativeIntOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0) return null;
  // 上限防御：避免极端值溢出 int4（time_ms/memory_kb 为 INTEGER 列）
  return Math.min(rounded, 2_147_483_647);
}

/**
 * 归一一条 judge 结果。返回新对象（不修改入参），并给出修正清单供日志记录。
 */
export function sanitizeJudgeResult(result: JudgeResult): SanitizedJudgeResult {
  const adjustments: string[] = [];
  const safe: JudgeResult = { ...result };

  // ── status：白名单 ──
  if (!ALLOWED_JUDGE_STATUSES.includes(safe.status)) {
    adjustments.push(`status ${JSON.stringify(safe.status)} → "error"`);
    safe.status = "error";
  }

  // ── score：整数 + 0..FULL_SCORE clamp ──
  if (typeof safe.score !== "number" || !Number.isFinite(safe.score)) {
    adjustments.push(`score ${JSON.stringify(safe.score)} → 0`);
    safe.score = 0;
  } else {
    const clamped = Math.min(Math.max(Math.round(safe.score), 0), FULL_SCORE);
    if (clamped !== safe.score) {
      adjustments.push(`score ${safe.score} → ${clamped}`);
      safe.score = clamped;
    }
  }

  // ── output：类型 + 字节上限 ──
  if (typeof safe.output !== "string") {
    adjustments.push("output 非字符串 → 空串");
    safe.output = "";
  } else if (safe.output.length > MAX_OUTPUT_BYTES) {
    adjustments.push(`output 超过 ${MAX_OUTPUT_BYTES} 字节，已截断`);
    safe.output = safe.output.slice(0, MAX_OUTPUT_BYTES);
  }

  // ── time_ms / memory_kb：允许缺省，拒绝负值/非有限值 ──
  // 注意 JudgeResult 的可选字段类型是 `number | undefined`，因此不合法时置
  // undefined（落库时由 `?? null` 转为 NULL）。
  const timeMs = toNonNegativeIntOrNull(safe.time_ms);
  if (timeMs === null) {
    if (safe.time_ms !== undefined) {
      adjustments.push(`time_ms ${JSON.stringify(safe.time_ms)} → 未设置`);
    }
    safe.time_ms = undefined;
  } else if (timeMs !== safe.time_ms) {
    adjustments.push(`time_ms ${safe.time_ms} → ${timeMs}`);
    safe.time_ms = timeMs;
  }
  const memoryKb = toNonNegativeIntOrNull(safe.memory_kb);
  if (memoryKb === null) {
    if (safe.memory_kb !== undefined) {
      adjustments.push(`memory_kb ${JSON.stringify(safe.memory_kb)} → 未设置`);
    }
    safe.memory_kb = undefined;
  } else if (memoryKb !== safe.memory_kb) {
    adjustments.push(`memory_kb ${safe.memory_kb} → ${memoryKb}`);
    safe.memory_kb = memoryKb;
  }

  return { result: safe, adjustments };
}
