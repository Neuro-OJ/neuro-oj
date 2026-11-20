import { parse } from "jsr:@std/csv@1.0.6/parse";
import { BadRequestError } from "../../../shared/base/errors.ts";

/** CSV 只定位已有账号或邮箱邀请，不提供账号创建字段。 */
export interface ClassroomImportEntry {
  row: number;
  email: string;
  username: string;
  error?: string;
}
/** 单批 500 条，标准 CSV 支持 BOM、CRLF、引号和带逗号的字段。 */
export function parseClassroomImport(csv: string): ClassroomImportEntry[] {
  if (
    typeof csv !== "string" || new TextEncoder().encode(csv).length > 512 * 1024
  ) {
    throw new BadRequestError("CSV 必须为不超过 512 KiB 的文本");
  }
  let records: string[][];
  try {
    records = parse(csv.replace(/^\uFEFF/, ""));
  } catch {
    throw new BadRequestError("CSV 格式错误，请检查引号与列数");
  }
  const [first, ...rows] = records;
  const headers = first?.map((h) => h.trim().toLowerCase());
  if (
    !headers || !headers.some((h) => h === "email" || h === "username") ||
    new Set(headers).size !== headers.length
  ) {
    throw new BadRequestError("CSV 表头需要 email 或 username，列名不能重复");
  }
  if (!rows.length || rows.length > 500) {
    throw new BadRequestError("每批需要 1–500 条记录");
  }
  const emailIndex = headers.indexOf("email"),
    usernameIndex = headers.indexOf("username");
  return rows.map((cells, index) => {
    const email = (cells[emailIndex] ?? "").trim().toLowerCase(),
      username = (cells[usernameIndex] ?? "").trim();
    let error: string | undefined;
    if (cells.length !== headers.length) error = "列数与表头不一致";
    else if (!email && !username) error = "需要邮箱或已有账号用户名";
    else if (
      email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    ) error = "邮箱格式错误";
    else if (username.length > 128) error = "用户名过长";
    return { row: index + 2, email, username, ...(error ? { error } : {}) };
  });
}
