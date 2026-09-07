import type { Context } from "hono";
import type { AuditAction, AuditDetail } from "../../system/types/audit-log.ts";

export interface AuditMeta {
  action: AuditAction;
  target?: (c: Context) => { type: string; id: string } | undefined;
  buildDetail: (c: Context, res: Response) => AuditDetail;
}
