import { sql } from "drizzle-orm";
import {
  accountNotifications,
  communityComments,
  communityPosts,
} from "../../../../shared/db/schema.ts";
import {
  DOMAIN_PRESETS,
  type DomainPreset,
} from "../../../../shared/workspace/types.ts";
import { domainTypeConfiguration } from "../../../../shared/workspace/capabilities.ts";
import { getInstanceResourcePolicy } from "../../../platform/contracts/resource-policy.ts";
import { domainProblemBindingAvailableWhere } from "../../../problems/contracts/cross-module/services_workspace_binding-availability.ts";
import { unendedPublicContestForProblem } from "../../../contests/contracts/cross-module/services_problem-secrecy.ts";

/**
 * 社区能力可用的域类型集合。
 *
 * 数据库只存 access/discoverable/join_policy，能力由类型推导；这里从同一份
 * `domainTypeConfiguration` 生成 SQL 需要的类型集合，再叠加实例模块政策，
 * 避免另写一张能力表或继续读取已经删除的 `configuration.features`。
 */
async function communityPresets(): Promise<DomainPreset[]> {
  const { modules } = await getInstanceResourcePolicy();
  if (!modules.community) return [];
  return DOMAIN_PRESETS.filter((preset) =>
    domainTypeConfiguration(preset).features.community
  );
}

/** 账号收件箱跨域读取，逐条按通知所属域检查当前源授权与赛题保密。 */
export async function communityNotificationVisibleWhere(
  actorId: string,
  platformAdmin: boolean,
) {
  const member =
    sql`${platformAdmin} OR EXISTS (SELECT 1 FROM domain_memberships dm
    WHERE dm.domain_id = ${accountNotifications.domain_id} AND dm.user_id = ${actorId} AND dm.status = 'active')`;
  const presets = await communityPresets();
  const communityPreset = presets.length === 0
    ? sql`FALSE`
    : sql`d.preset IN (${
      sql.join(presets.map((preset) => sql`${preset}`), sql`, `)
    })`;
  return sql`${accountNotifications.type} <> 'clarification' AND ${accountNotifications.assignment_id} IS NULL AND (
    ${accountNotifications.domain_id} IS NULL OR EXISTS (SELECT 1 FROM domains d
      WHERE d.id = ${accountNotifications.domain_id} AND d.status <> 'suspended'
        AND (d.configuration->>'access' = 'public' OR ${member})
        AND ${communityPreset}))
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
    ))
    AND (${accountNotifications.comment_id} IS NULL OR EXISTS (SELECT 1 FROM community_comments
      WHERE ${communityComments.id} = ${accountNotifications.comment_id}
        AND ${communityComments.domain_id} = ${accountNotifications.domain_id}
        AND (${communityComments.status} = 'published' OR ${communityComments.author_id} = ${actorId})))`;
}
