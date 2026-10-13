import { eq } from "drizzle-orm";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  ServiceUnavailableError,
} from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { domainLimits, domains } from "../../../shared/db/schema.ts";
import type {
  DomainFeatures,
  DomainLimits,
} from "../../../shared/workspace/types.ts";
import {
  combineDomainLimits,
  validateDomainLimits,
} from "../../../shared/workspace/resource-policy.ts";
import { assertWorkspacePermission, loadWorkspace } from "./access.ts";
import { workspaceAudit } from "./domains.ts";
import { getInstanceResourcePolicy } from "./instance.ts";

/** 当前域限额与实例上限始终组合；默认值只在新域创建时复制。 */
export async function getDomainEffectiveLimits(
  domainId: string,
  executor: Executor = getDb(),
) {
  const [stored] = await executor.select().from(domainLimits).where(
    eq(domainLimits.domain_id, domainId),
  );
  if (!stored) {
    throw new AppError("工作空间配额未初始化", 500, "DOMAIN_LIMITS_MISSING");
  }
  const policy = await getInstanceResourcePolicy(executor);
  const configured: DomainLimits = {
    members: stored.members,
    problems: stored.problems,
    storage_bytes: stored.storage_bytes,
    submissions_per_minute: stored.submissions_per_minute,
  };
  return {
    configured,
    effective: combineDomainLimits(configured, policy.limit_caps),
    caps: policy.limit_caps,
  };
}

/** 域管理员只能降低自己的有效额度；提高须平台治理权限。 */
export async function updateDomainLimits(
  slug: string,
  actorId: string,
  expectedRevision: number | null,
  input: DomainLimits,
) {
  if (
    expectedRevision === null || !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) throw new AppError("需要工作空间 revision", 428, "REVISION_REQUIRED");
  try {
    validateDomainLimits(input);
  } catch (error) {
    throw new BadRequestError(
      error instanceof Error ? error.message : "配额非法",
    );
  }
  return await getDb().transaction(async (tx) => {
    const { domain, context, platformAdmin } = await loadWorkspace(
      slug,
      actorId,
      { executor: tx, write: true, lock: true },
    );
    assertWorkspacePermission(context, "domain:limits");
    if (domain.revision !== expectedRevision) {
      throw new ConflictError("工作空间配置已变化，请重新读取");
    }
    const current = await getDomainEffectiveLimits(domain.id, tx);
    const desired = combineDomainLimits(input, current.caps);
    for (const key of Object.keys(input) as Array<keyof DomainLimits>) {
      if (
        current.caps[key] !== null && input[key] !== null &&
        input[key]! > current.caps[key]!
      ) throw new ForbiddenError(`${key} 超过实例上限`, "DOMAIN_LIMIT_CAP");
      if (
        !platformAdmin && current.effective[key] !== null &&
        (desired[key] === null || desired[key]! > current.effective[key]!)
      ) {
        throw new ForbiddenError(
          "提高域额度需要平台管理员",
          "DOMAIN_LIMIT_INCREASE_RESTRICTED",
        );
      }
    }
    await tx.insert(domainLimits).values({ domain_id: domain.id, ...input })
      .onConflictDoUpdate({ target: domainLimits.domain_id, set: input });
    const revision = domain.revision + 1;
    await tx.update(domains).set({
      revision,
      updated_at: new Date().toISOString(),
    }).where(eq(domains.id, domain.id));
    await workspaceAudit(tx, actorId, domain.id, "domain.update", {
      operation: "limits",
      configured: input,
      effective: desired,
      revision,
    });
    return {
      configured: input,
      effective: desired,
      caps: current.caps,
      revision,
    };
  });
}

/** 教学停用仍允许授权历史读取；新写入必须同时满足实例和域模块配置。 */
export async function assertDomainFeatureEnabled(
  domain: typeof domains.$inferSelect,
  feature: keyof DomainFeatures,
  options: {
    historicalRead?: boolean;
    executor?: Executor;
    disabledCode?: string;
  } = {},
) {
  const policy = await getInstanceResourcePolicy(options.executor);
  const features = domain.configuration.features;
  const required = feature === "analytics"
    ? ["analytics", "assignment", "classroom"] as const
    : feature === "assignment"
    ? ["assignment", "classroom"] as const
    : [feature];
  if (
    required.some((key) => typeof features?.[key] !== "boolean") ||
    feature === "assignment" && features.assignment && !features.classroom ||
    feature === "analytics" && features.analytics &&
      (!features.assignment || !features.classroom)
  ) {
    throw new ServiceUnavailableError("工作空间模块配置无效，请联系管理员修复");
  }
  if (features[feature] && policy.modules[feature]) return;
  if (options.historicalRead && feature !== "community") return;
  throw new ForbiddenError(
    "此模块已停用",
    options.disabledCode ?? "DOMAIN_MODULE_DISABLED",
  );
}
