import { sql } from "drizzle-orm";
import {
  accountNotifications,
  communityPosts,
} from "../../../../shared/db/schema.ts";
import { domainProblemBindingAvailableWhere } from "../../../problems/contracts/cross-module/services_workspace_binding-availability.ts";
import { unendedPublicContestForProblem } from "../../../contests/contracts/cross-module/services_problem-secrecy.ts";

/** 账号收件箱跨域读取，逐条按通知所属域检查当前源授权与赛题保密。 */
export function communityNotificationVisibleWhere(
  actorId: string,
  platformAdmin: boolean,
) {
  const member =
    sql`${platformAdmin} OR EXISTS (SELECT 1 FROM domain_memberships dm
    WHERE dm.domain_id = ${accountNotifications.domain_id} AND dm.user_id = ${actorId} AND dm.status = 'active')`;
  return sql`${accountNotifications.assignment_id} IS NULL AND (
    ${accountNotifications.domain_id} IS NULL OR EXISTS (SELECT 1 FROM domains d
      WHERE d.id = ${accountNotifications.domain_id} AND d.status <> 'suspended'
        AND (d.configuration->>'access' = 'public' OR ${member})
        AND (d.configuration->'features'->>'community')::boolean IS TRUE))
    AND (${accountNotifications.post_id} IS NULL OR EXISTS (SELECT 1 FROM community_posts
      WHERE ${communityPosts.id} = ${accountNotifications.post_id}
        AND ${communityPosts.domain_id} = ${accountNotifications.domain_id}
        AND (${communityPosts.status} = 'published' OR ${communityPosts.author_id} = ${actorId})
        AND (${communityPosts.problem_id} IS NULL OR ${
    domainProblemBindingAvailableWhere(
      communityPosts.domain_problem_binding_id,
      accountNotifications.domain_id,
      { member },
    )
  })
        AND NOT (${communityPosts.type} IN ('solution','discussion') AND ${communityPosts.problem_id} IS NOT NULL
          AND ${
    unendedPublicContestForProblem(
      communityPosts.problem_id,
      accountNotifications.domain_id,
    )
  })
    ))`;
}
