/**
 * Admin 统一审计封装。
 *
 * 提供：
 * - registerAudit()/getAuditMeta() —— 路由审计元数据注册表，支持 `:param` 路径模式匹配
 * - adminAudit() —— 直接写入审计日志（内部复用 logAudit，失败不影响业务）
 * - withAudit() —— 包装业务 handler，在成功响应后尽力写入审计
 *
 * 审计是辅助能力：无论 buildDetail/target/adminAudit 是否抛错，
 * 都不允许把已经成功的业务响应变成 5xx。
 */
import type { Context } from "hono";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "admin"]);
import { logAudit } from "../../system/services/audit-log.ts";
import type { AuditAction, AuditDetail } from "../../system/types/audit-log.ts";
import type { AuditMeta } from "../types/admin-audit.ts";

const registry = new Map<string, AuditMeta>();

function registryKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** 将 `:param` 路径模式转换为可用于真实请求路径匹配的正则。 */
function pathPatternToRegExp(pathPattern: string): RegExp {
  const parts = pathPattern.split("/").map((part) => {
    if (part.startsWith(":")) return "[^/]+";
    return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`^${parts.join("/")}$`);
}

export function registerAudit(
  method: string,
  pathPattern: string,
  meta: AuditMeta,
): void {
  registry.set(registryKey(method, pathPattern), meta);
}

export function getAuditMeta(
  method: string,
  path: string,
): AuditMeta | undefined {
  const methodUpper = method.toUpperCase();
  const direct = registry.get(registryKey(methodUpper, path));
  if (direct) return direct;

  for (const [key, meta] of registry) {
    const spaceIndex = key.indexOf(" ");
    if (spaceIndex === -1) continue;
    const registeredMethod = key.slice(0, spaceIndex);
    const pathPattern = key.slice(spaceIndex + 1);
    if (
      registeredMethod === methodUpper &&
      pathPatternToRegExp(pathPattern).test(path)
    ) {
      return meta;
    }
  }
  return undefined;
}

export async function adminAudit(
  action: AuditAction,
  detail: AuditDetail,
  target?: { type: string; id: string },
): Promise<void> {
  await logAudit(action, detail, target);
}

export function withAudit(meta: AuditMeta) {
  return (
    handler: (c: Context) => Promise<Response>,
  ) =>
  async (c: Context): Promise<Response> => {
    const res = await handler(c);
    if (res.status >= 200 && res.status < 300) {
      try {
        const detail = meta.buildDetail(c, res);
        const target = meta.target?.(c);
        await adminAudit(meta.action, detail, target);
      } catch (e) {
        // 审计是辅助能力，失败只记录日志，绝不破坏已成功的业务响应。
        logger.error("审计后处理失败，不影响业务响应", {
          action: meta.action,
          err: e,
        });
      }
    }
    return res;
  };
}
