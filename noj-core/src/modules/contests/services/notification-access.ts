import { sql } from "drizzle-orm";
import { accountNotifications } from "../../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";

/** 答疑通知按竞赛与原提问授权，不受社区开关影响。 */
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
        AND (c.is_public OR ${platformAdmin} OR EXISTS (
          SELECT 1 FROM contest_participants cp WHERE cp.contest_id = c.id AND cp.user_id = ${actorId}))
        AND (q.is_public OR q.sender_id = ${actorId} OR c.created_by = ${actorId} OR ${platformAdmin}))`;
}
