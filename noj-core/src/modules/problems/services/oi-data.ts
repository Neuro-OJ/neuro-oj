/**
 * OI 数据访问的授权与路径校验（Handbook §6.3）。
 *
 * 内容事实源是**草稿**与**已发布版本**：读写都必须显式选择作用域，
 * 见 `versioning/oi-draft.ts` 的 `loadOiDataFromDraft` / `loadOiDataFromVersion` /
 * `saveOiDraft`。本模块只保留跨路径共用的权限与路径安全规则，不再读写
 * `problems.oi_data_files` 这类"最新版投影"。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { problems } from "../../../shared/db/schema.ts";
import { assertProblemEditPermissionForActor } from "./problems/problems-crud.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { getUserPermissions } from "../../access/contracts/cross-module/identity_services_security_permissions.ts";
import { resolveProblem } from "./problem-resolve.ts";
import type { UserActor } from "../../access/contracts/actor.ts";

/** 数据路径不能逃逸题包根目录。 */
export function validateOiDataPath(path: string): void {
  if (
    !path || path.startsWith("/") || path.includes("\\") ||
    path.includes("\0") || /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new BadRequestError("数据文件路径非法");
}

/**
 * 先确认题目可见性及编辑/数据权限，再允许读写隐藏数据。
 *
 * @throws {BadRequestError} 非 OI 题
 */
export async function authorizeOiData(actor: UserActor, reference: string) {
  const isAdmin = (await getUserPermissions(actor.userId)).has(
    "admin:full_access",
  );
  const problem = await resolveProblem(reference, {
    userId: actor.userId,
    isAdmin,
  });
  await assertProblemEditPermissionForActor(problem, actor);
  if (problem.judge_type !== "oi") {
    throw new BadRequestError("数据编辑仅用于 OI 题");
  }
  const [row] = await getDb().select().from(problems).where(
    eq(problems.id, problem.id),
  );
  return { problem, row };
}
