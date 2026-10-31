import { sql } from "drizzle-orm";
import { accountNotifications } from "../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";

/**
 * 答疑通知的可见性条件（收件箱列表、未读、详情、已读与 SSE 重放共用）。
 *
 * 授权口径分三层，缺一不可：
 *
 * 1. **域可达**：通知所属域必须与通知数据里的比赛一致，且域未被停用；域的可见性
 *    按现行规则判定（公开域对所有人，其余域要求当前活跃成员），平台管理员绕过。
 * 2. **源资源存在**：`contest_clarifications` 行仍在——提问被删除后通知随之隐藏。
 * 3. **答疑本身可见**：公开回复对全域可见；私密回复只对提问者、比赛创建者与平台
 *    管理员可见。
 *
 * 这里**刻意不再判定 `contests.is_public`**：比赛不再有公开赛/邀请赛分类，该列已恒为
 * `true`，写在条件里只会让读代码的人误以为存在第二道授权。域可达性由第 1 层承担，
 * 与 `loadDomainContest` 的现行规则一致——删除这个死子句不改变任何可见结果。
 *
 * 答疑通知不受社区功能开关影响：这是本轮修复的一个缺陷（关闭社区会连答疑通知一起
 * 隐藏），因此本条件独立于 `communityNotificationVisibleWhere`。
 */
export function contestNotificationVisibleWhere(
  actorId: string,
  platformAdmin: boolean,
) {
  return sql`${accountNotifications.type} = 'clarification'
    AND ${accountNotifications.assignment_id} IS NULL
    AND EXISTS (SELECT 1 FROM contests c
      JOIN domains d ON d.id = COALESCE(c.domain_id, ${DEFAULT_DOMAIN_ID})
      JOIN contest_clarifications q ON q.contest_id = c.id
      WHERE c.id = ${accountNotifications.data}->>'contest_id'
        AND q.id = ${accountNotifications.data}->>'clarification_id'
        AND d.id = ${accountNotifications.domain_id} AND d.status <> 'suspended'
        AND (d.configuration->>'access' = 'public' OR ${platformAdmin}
          OR EXISTS (SELECT 1 FROM domain_memberships dm WHERE dm.domain_id = d.id
            AND dm.user_id = ${actorId} AND dm.status = 'active'))
        AND (q.is_public OR q.sender_id = ${actorId} OR c.created_by = ${actorId} OR ${platformAdmin}))`;
}
