/**
 * 提交 ID 解析（resolveSubmissionId）：UUID / public_id → 内部 UUID。
 */

import { submissions } from "../../../../shared/db/schema.ts";
import { resolvePublicId } from "../../../../shared/security/public-id.ts";

/**
 * 将 UUID 或 public_id 解析为内部提交 UUID；其它格式按主键兜底。
 */
export function resolveSubmissionId(value: string): Promise<string> {
  return resolvePublicId(
    submissions,
    submissions.id,
    submissions.public_id,
    "sub",
    value,
    "提交不存在",
  );
}
