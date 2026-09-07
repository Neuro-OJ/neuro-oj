/**
 * Admin 乐观锁基础工具。
 *
 * 约定（v1 基础版）：
 * - 客户端通过 `If-Match` 头携带强校验器（当前为 version/updated_at 字符串，允许带双引号）。
 * - 弱校验器（`W/"..."`）与 `If-Match: *` 暂不展开解析；实际语义由后续路由迁移统一明确。
 * - 当携带 `If-Match` 且当前版本不匹配时抛 `VersionConflictError`（HTTP 409）。
 * - 当前资源不存在/版本为空时同样按冲突处理；若路由层需要 404，
 *   应在 `getCurrentVersion` 回调中先完成资源存在性判断。
 */
import { AppError } from "../../../shared/base/errors.ts";

export class VersionConflictError extends AppError {
  constructor(current: unknown) {
    super(
      "资源已被其他管理员修改，请刷新后重试",
      409,
      "VERSION_CONFLICT",
      { current },
    );
    this.name = "VersionConflictError";
  }
}

export function assertVersion(
  current: string | null | undefined,
  expected: string | undefined,
): void {
  if (expected && current !== expected) {
    throw new VersionConflictError(current);
  }
}
