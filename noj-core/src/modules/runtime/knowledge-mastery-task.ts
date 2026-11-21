/**
 * 掌握度增量任务投递（迁移期：供知识图谱掌握度使用）。
 *
 * 有效成绩变更的唯一写入点（`evaluations/services/versioning/projection.ts`）
 * 在同一事务内登记本任务：target = 用户，去重键 `mastery:<problemId>` —— 同一
 * 用户短时间内多题变更合并为若干条任务，处理时整体重算该用户的全部相关节点
 * （见 `features/knowledge/mastery.ts`）。
 *
 * 旧模块不得 import 功能代码，功能代码也不 import 本模块实现；两处只以字符串
 * 任务类型 `knowledge.mastery` 约定，handler 由 `features/knowledge` 注册。
 */
import type { DbTx } from "../../shared/db/executor.ts";
import { enqueueTaskTx } from "./tasks/repository.ts";

/** 掌握度任务类型（`features/knowledge/mastery.ts` 注册同名 handler）。 */
export const KNOWLEDGE_MASTERY_TASK_TYPE = "knowledge.mastery";

/** 掌握度任务的用户目标类别。 */
export const KNOWLEDGE_MASTERY_TARGET_KIND = "user_knowledge_mastery";

/** 在有效成绩变更事务内登记掌握度重算；同一题目重复投递同键时合并。 */
export async function enqueueKnowledgeMasteryTaskTx(
    tx: DbTx,
    input: { userId: string; problemId: string },
): Promise<void> {
    await enqueueTaskTx(tx, {
        taskType: KNOWLEDGE_MASTERY_TASK_TYPE,
        targetKind: KNOWLEDGE_MASTERY_TARGET_KIND,
        targetId: input.userId,
        dedupeKey: `mastery:${input.problemId}`,
        payload: { user_id: input.userId },
    });
}
