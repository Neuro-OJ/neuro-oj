/**
 * OI 数据文件路径校验（Handbook §6.3）。
 *
 * 内容事实源是**草稿**与**已发布版本**：读写都必须显式选择作用域，
 * 见 `versioning/oi-draft.ts` 的 `loadOiDataFromDraft` / `loadOiDataFromVersion` /
 * `saveOiDraft`。本模块只保留跨路径共用的路径安全规则，不再读写
 * `problems.oi_data_files` 这类"最新版投影"。
 */
import { BadRequestError } from "../../../shared/base/errors.ts";

/** 数据路径不能逃逸题包根目录。 */
export function validateOiDataPath(path: string): void {
  if (
    !path || path.startsWith("/") || path.includes("\\") ||
    path.includes("\0") || /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new BadRequestError("数据文件路径非法");
}
