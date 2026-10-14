import { getSetting } from "../../system/index.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../shared/workspace/types.ts";
import { ServiceUnavailableError } from "../../../shared/base/errors.ts";
import { logger } from "../../../shared/base/logging.ts";
import { inArray } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { systemSettings } from "../../../shared/db/schema.ts";
import type {
  DomainFeatures,
  DomainLimits,
} from "../../../shared/workspace/types.ts";
import {
  allowedDomainFeatures,
  unlimitedDomainLimits,
  validateWorkspaceSetting,
} from "../../../shared/workspace/resource-policy.ts";

/** 结构化政策解析失败时拒绝执行，不放宽限额或模块。 */
function resourcePolicy(read: (key: string) => unknown) {
  try {
    const modules = read("instance_allowed_modules") ??
      JSON.stringify(allowedDomainFeatures());
    const defaults = read("domain_default_limits") ??
      JSON.stringify(unlimitedDomainLimits());
    const caps = read("domain_limit_caps") ??
      JSON.stringify(unlimitedDomainLimits());
    if (
      typeof modules !== "string" || typeof defaults !== "string" ||
      typeof caps !== "string"
    ) throw new Error("政策类型错误");
    return {
      modules: validateWorkspaceSetting(
        "domain_features",
        modules,
      ) as DomainFeatures,
      default_limits: validateWorkspaceSetting(
        "domain_limits",
        defaults,
      ) as DomainLimits,
      limit_caps: validateWorkspaceSetting(
        "domain_limits",
        caps,
      ) as DomainLimits,
    };
  } catch (cause) {
    logger.error("实例资源政策解析失败", {
      error_type: cause instanceof Error ? cause.name : typeof cause,
    });
    const error = new ServiceUnavailableError(
      "实例资源政策无效，请联系管理员修复",
    );
    error.cause = cause;
    throw error;
  }
}

/** 容量及写入守卫直接读取当前持久政策，避免配置通知传播延迟放宽额度。 */
export async function getInstanceResourcePolicy(executor: Executor = getDb()) {
  const rows = await executor.select().from(systemSettings).where(
    inArray(systemSettings.key, [
      "instance_allowed_modules",
      "domain_default_limits",
      "domain_limit_caps",
    ]),
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return resourcePolicy((key) => {
    const stored = values.get(key);
    return stored === undefined ? undefined : JSON.parse(stored) as unknown;
  });
}

/** 身份与访问政策独立于资源配额，错误额度配置不能阻断登录和治理修复。 */
export function getInstanceAccessPolicy() {
  const access = getSetting("instance_access")?.value ?? "public";
  const registration = getSetting("instance_registration_mode")?.value ??
    "open";
  const creation = getSetting("domain_creation_policy")?.value ?? "admin";
  if (
    typeof access !== "string" ||
    !["public", "authenticated"].includes(access) ||
    typeof registration !== "string" ||
    !["open", "invite", "admin_only"].includes(registration) ||
    typeof creation !== "string" ||
    !["admin", "approval", "open"].includes(creation)
  ) throw new ServiceUnavailableError("实例访问政策无效，请联系管理员修复");
  return {
    access: access as "public" | "authenticated",
    registration_mode: registration as "open" | "invite" | "admin_only",
    default_domain_slug: String(
      getSetting("default_domain_slug")?.value ?? DEFAULT_DOMAIN_SLUG,
    ),
    domain_creation_policy: creation as "admin" | "approval" | "open",
    domain_creation_limit: Number(
      getSetting("domain_creation_limit")?.value ?? 3,
    ),
    allow_domain_registration_invites:
      getSetting("allow_domain_registration_invites")?.value === true,
  };
}

/** 实例公开摘要包括资源配置；执行额度检查使用持久读取接口。 */
export function getInstancePolicy() {
  return {
    ...getInstanceAccessPolicy(),
    ...resourcePolicy((key) => getSetting(key)?.value),
  };
}
