import { getSetting } from "../../system/index.ts";
import { DEFAULT_DOMAIN_SLUG } from "../../../shared/workspace/types.ts";
import { ServiceUnavailableError } from "../../../shared/base/errors.ts";

/** 当前实例政策快照，每次读取既有设置通道，不新增进程缓存。 */
export function getInstancePolicy() {
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
