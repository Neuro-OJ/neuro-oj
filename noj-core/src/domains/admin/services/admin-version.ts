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
