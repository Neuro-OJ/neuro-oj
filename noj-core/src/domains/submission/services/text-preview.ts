import { and, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { submissions } from "../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import { getStorageProvider } from "../../system/index.ts";
import { readEvaluationEntries } from "../../catalog/index.ts";
import { getDomainSubmission } from "./domain-submission-read.ts";

const TEXT_BYTES = 1024 * 1024;
const TEXT_EXTENSION =
  /\.(py|cpp|cc|c|h|hpp|rs|js|ts|jsx|tsx|json|csv|tsv|txt|md|yaml|yml|toml|ini|cfg|log|html|css|xml|sql|sh)$/i;

async function submissionFiles(slug: string, actorId: string, id: string) {
  const visible = await getDomainSubmission(slug, id, actorId);
  if (!visible.can_view_source || !visible.resource_available) {
    throw new NotFoundError("提交原文不存在或不可访问");
  }
  const [row] = await getDb().select().from(submissions).where(and(
    eq(submissions.id, String(visible.id)),
    eq(submissions.domain_id, visible.domain_id),
  ));
  if (!row) throw new NotFoundError("提交不存在");
  let files: Record<string, Uint8Array>;
  if (row.artifact_storage_url) {
    const storage = await getStorageProvider(),
      stat = await storage.stat(row.artifact_storage_url);
    if (!stat.exists) throw new NotFoundError("提交产物暂不可用");
    if (stat.sizeBytes === null || stat.sizeBytes > 64 * 1024 * 1024) {
      throw new AppError(
        "在线预览支持不超过 64 MiB 的 ZIP 产物",
        422,
        "ARTIFACT_PREVIEW_UNSUPPORTED",
      );
    }
    files = readEvaluationEntries(
      await storage.get(row.artifact_storage_url),
      true,
      undefined,
      (name, size) => size <= TEXT_BYTES && TEXT_EXTENSION.test(name),
    );
  } else {
    files = {
      [row.file_name ?? "solution"]: new TextEncoder().encode(row.code),
    };
  }
  return { row, files };
}

/** 已授权的提交文件目录，只列出可预览的 UTF-8 文本文件。 */
export async function listDomainSubmissionTextFiles(
  slug: string,
  actorId: string,
  id: string,
) {
  const { row, files } = await submissionFiles(slug, actorId, id);
  const result: Array<{ file_name: string; size_bytes: number }> = [];
  for (const [file_name, bytes] of Object.entries(files)) {
    if (bytes.length > TEXT_BYTES) continue;
    try {
      if (
        !new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0")
      ) result.push({ file_name, size_bytes: bytes.length });
    } catch { /* 二进制文件不属于可在线批注的源码。 */ }
  }
  return { submission_id: row.id, files: result };
}

/** 仅从已获完整源码权限的提交提取指定 UTF-8 文件，不访问题目支持包。 */
export async function readDomainSubmissionText(
  slug: string,
  actorId: string,
  id: string,
  fileName: string,
) {
  const { row, files } = await submissionFiles(slug, actorId, id),
    bytes = files[fileName];
  if (!bytes) throw new NotFoundError("文件不存在或不支持文本预览");
  if (bytes.length > TEXT_BYTES) {
    throw new BadRequestError("在线批注的文本文件不能超过 1 MiB");
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BadRequestError("文件不是可预览的 UTF-8 文本");
  }
  if (content.includes("\0")) {
    throw new BadRequestError("二进制文件不能进行行批注");
  }
  return {
    id: row.id,
    public_id: row.public_id,
    user_id: row.user_id,
    file_name: fileName,
    content,
  };
}
