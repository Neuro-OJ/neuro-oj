import type { Context } from "hono";
import { logAudit } from "../../system/services/audit-log.ts";
import type { AuditAction, AuditDetail } from "../../system/types/audit-log.ts";
import type { AuditMeta } from "../types/admin-audit.ts";

const registry = new Map<string, AuditMeta>();

export function registerAudit(
  method: string,
  pathPattern: string,
  meta: AuditMeta,
): void {
  registry.set(`${method} ${pathPattern}`, meta);
}

export function getAuditMeta(
  method: string,
  path: string,
): AuditMeta | undefined {
  return registry.get(`${method} ${path}`);
}

export async function adminAudit(
  _c: Context,
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
      const detail = meta.buildDetail(c, res);
      const target = meta.target?.(c);
      await adminAudit(c, meta.action, detail, target);
    }
    return res;
  };
}
