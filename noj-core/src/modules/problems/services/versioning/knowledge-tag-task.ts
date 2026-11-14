/**
 * 发布后投递知识图谱 AI 打标任务（`knowledge.tag`）。
 *
 * 任务类型与目标约定以**字符串**与 `features/knowledge/tagging.ts` 保持一致：
 * 旧模块不得 import 功能代码（`scripts/check-feature-boundaries.ts`），任务
 * 类型本身就是两者的合同（见 `modules/runtime/tasks/contracts.ts`）。
 *
 * 只在总开关与 AI 打标开关都开启时投递，避免给默认关闭的实例堆积无效任务；
 * 开关在任务执行时会再读一次（关闭期间堆积的任务直接成功返回）。
 * 去重键按「题目 + 版本」，与草稿保存无关——草稿不投递。
 *
 * 低峰时段（`knowledge_ai_offpeak_only`，默认开启）：不在时段内时直接把
 * `availableAt` 设为下一个时段开始（北京时间 `knowledge_ai_offpeak_window`），
 * 避免白天被反复领取再顺延；handler 执行时还会再判一次。
 */
import type { DbTx } from "../../../../shared/db/executor.ts";
import { getSetting } from "../../../platform/index.ts";
import { enqueueTaskTx } from "../../../runtime/index.ts";

/** 与 `features/knowledge/tagging.ts` 的 `KNOWLEDGE_TAG_TASK_TYPE` 一致。 */
const KNOWLEDGE_TAG_TASK_TYPE = "knowledge.tag";

/** 与 `features/knowledge/offpeak.ts` 的 `DEFAULT_OFFPEAK_WINDOW` 一致。 */
const DEFAULT_OFFPEAK_WINDOW = "00:30-08:30";

/**
 * 测试注入点：覆盖「当前时刻」以便断言 `availableAt`（null = 真实时钟）。
 */
let nowOverride: Date | null = null;
export function setOffpeakNowForTest(now: Date | null): void {
  nowOverride = now;
}
/** UTC+8 偏移（毫秒）。 */
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 合法时段：`HH:MM-HH:MM`，起止不同。 */
function parseWindow(
  window: string,
): { startMin: number; endMin: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(
    window.trim(),
  );
  if (!match) return null;
  const startMin = Number(match[1]) * 60 + Number(match[2]);
  const endMin = Number(match[3]) * 60 + Number(match[4]);
  return startMin === endMin ? null : { startMin, endMin };
}

/**
 * 需要等低峰时返回下一个时段开始时刻（ISO），否则 null。
 *
 * 旧模块不得 import 功能代码（`scripts/check-feature-boundaries.ts`），
 * 故按与 `features/knowledge/offpeak.ts` 相同的 UTC+8 算法本地实现；
 * 设置键名即两者的合同。
 */
export function offpeakAvailableAt(
  now: Date = nowOverride ?? new Date(),
): string | null {
  if (getSetting("knowledge_ai_offpeak_only")?.value === false) return null;
  const raw = getSetting("knowledge_ai_offpeak_window")?.value;
  const parsed = (typeof raw === "string" ? parseWindow(raw) : null) ??
    parseWindow(DEFAULT_OFFPEAK_WINDOW)!;
  const { startMin, endMin } = parsed;
  const dayStart =
    Math.floor((now.getTime() + CST_OFFSET_MS) / DAY_MS) * DAY_MS -
    CST_OFFSET_MS;
  const minute = Math.floor(((now.getTime() + CST_OFFSET_MS) % DAY_MS) / 60000);
  const inside = startMin < endMin
    ? minute >= startMin && minute < endMin
    : minute >= startMin || minute < endMin;
  if (inside) return null;
  const todayStart = dayStart + startMin * 60000;
  return new Date(
    now.getTime() <= todayStart
      ? todayStart
      : dayStart + DAY_MS + startMin * 60000,
  ).toISOString();
}

/**
 * 在发布事务内登记打标任务（与版本同提交或同回滚）。
 *
 * 未开启时静默跳过；`enqueueTaskTx` 失败会让发布事务回滚——与搜索索引任务
 * 同样的取舍：宁可发布失败，也不留下「已发布但永远不打标」的静默缺口。
 */
export async function enqueueKnowledgeTagTaskTx(
  tx: DbTx,
  problemId: string,
  versionId: string,
): Promise<void> {
  if (getSetting("knowledge_enabled")?.value !== true) return;
  if (getSetting("knowledge_ai_tagging_enabled")?.value !== true) return;
  const availableAt = offpeakAvailableAt();
  await enqueueTaskTx(tx, {
    taskType: KNOWLEDGE_TAG_TASK_TYPE,
    targetKind: "problem",
    targetId: problemId,
    dedupeKey: `tag:${versionId}`,
    ...(availableAt ? { availableAt } : {}),
    payload: { problem_id: problemId, version_id: versionId },
  });
}
