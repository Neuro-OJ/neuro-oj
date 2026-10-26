import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { unwrapRows } from "../../../shared/base/sql-rows.ts";
import {
  AppError,
  BadRequestError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import {
  deliverStoredArtifact,
  getStorageProvider,
} from "../../system/index.ts";
import { readEvaluationEntries } from "../../catalog/index.ts";
import { workspaceAudit } from "../../workspace/index.ts";
import { assertClassroomCapability, loadClassroom } from "./access.ts";
import { teachingSubmissionRelation } from "./student-submissions.ts";

type TextSource = {
  id: string;
  user_id: string;
  code: string;
  file_name: string | null;
  artifact_storage_url: string | null;
};
const TEXT_BYTES = 1024 * 1024;
const ARCHIVE_BYTES = 64 * 1024 * 1024;
const textExtension =
  /\.(py|cpp|cc|c|h|hpp|rs|js|ts|jsx|tsx|json|csv|tsv|txt|md|yaml|yml|toml|ini|cfg|log|html|css|xml|sql|sh)$/i;

/** 预览和批注统一验证班级关系，学生只能读取本人原提交；不访问题目支持包。 */
export async function loadTeachingTextSource(
  access: Awaited<ReturnType<typeof loadClassroom>>,
  id: string,
  executor: Executor = getDb(),
  lock = false,
) {
  const student = access.classMembership?.role === "student" ||
    !access.classMembership && !access.managesDomain;
  if (!student) assertClassroomCapability(access, "submissions:read");
  const result = await executor.execute(
    sql`SELECT s.id, s.user_id, s.code, s.file_name, s.artifact_storage_url
    FROM (SELECT *, 'submission'::text AS kind FROM submissions) s
    WHERE s.id = ${id} AND ${teachingSubmissionRelation(access)}
      ${student ? sql`AND s.user_id = ${access.context.actorId}` : sql``}
    ${lock ? sql`FOR SHARE OF s` : sql``}`,
  );
  const [source] = unwrapRows<TextSource>(result as never);
  if (!source) throw new NotFoundError("提交不存在或不可访问");
  if (access.platformAdmin) {
    await workspaceAudit(
      executor,
      access.context.actorId!,
      access.domain.id,
      "domain.update",
      {
        operation: "classroom.submission.text.read",
        classroom_id: access.classroom.id,
        submission_id: id,
      },
    );
  }
  return source;
}

async function archiveFiles(source: TextSource) {
  const storage = await getStorageProvider();
  const stat = await storage.stat(source.artifact_storage_url!);
  if (!stat.exists) throw new NotFoundError("提交产物暂不可用");
  if (stat.sizeBytes === null || stat.sizeBytes > ARCHIVE_BYTES) {
    throw new AppError(
      "在线预览支持不超过 64 MiB 的 ZIP 产物",
      422,
      "ARTIFACT_PREVIEW_UNSUPPORTED",
    );
  }
  const bytes = await storage.get(source.artifact_storage_url!);
  return readEvaluationEntries(
    bytes,
    true,
    undefined,
    (name, size) => size <= TEXT_BYTES && textExtension.test(name),
  );
}

/** 哈希覆盖原始 UTF-8 字节，行号按编辑器换行方式计算，不迁移到新提交。 */
export async function teachingTextVersion(bytes: Uint8Array) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BadRequestError(
      "该文件不是可预览的 UTF-8 文本",
      "TEXT_PREVIEW_UNSUPPORTED",
    );
  }
  if (text.includes("\0")) {
    throw new BadRequestError(
      "二进制文件不能进行行批注",
      "TEXT_PREVIEW_UNSUPPORTED",
    );
  }
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return {
    text,
    source_hash: Array.from(
      new Uint8Array(hash),
      (n) => n.toString(16).padStart(2, "0"),
    ).join(""),
    line_count: text.split(/\r\n|\r|\n/).length,
  };
}

/** 只返回原代码或学生产物中的指定文本，不暴露源题数据、评测输出及存储地址。 */
export async function readTeachingText(source: TextSource, fileName: string) {
  const files = source.artifact_storage_url ? await archiveFiles(source) : {
    [source.file_name ?? "solution"]: new TextEncoder().encode(source.code),
  };
  const bytes = files[fileName];
  if (!bytes) throw new NotFoundError("文件不存在或不支持文本预览");
  return { file_name: fileName, ...await teachingTextVersion(bytes) };
}

/** 文件列表保持提交上下文；不支持的二进制及大型文件不成为在线批注对象。 */
export async function listTeachingTextFiles(
  slug: string,
  classroomId: string,
  id: string,
  actorId: string,
) {
  const access = await loadClassroom(slug, classroomId, actorId, {
    historicalStudent: true,
  });
  const source = await loadTeachingTextSource(access, id);
  if (!source.artifact_storage_url) {
    return {
      submission_id: id,
      files: [{
        file_name: source.file_name ?? "solution",
        size_bytes: new TextEncoder().encode(source.code).length,
      }],
    };
  }
  const files = await archiveFiles(source);
  const result: { file_name: string; size_bytes: number }[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    try {
      await teachingTextVersion(bytes);
      result.push({ file_name: name, size_bytes: bytes.length });
    } catch (error) {
      if (!(error instanceof BadRequestError)) throw error;
    }
  }
  return { submission_id: id, files: result };
}

/** 每次读取文本重新验证域、班级、提交和比赛窗口。 */
export async function getTeachingTextFile(
  slug: string,
  classroomId: string,
  id: string,
  actorId: string,
  fileName: string,
) {
  const access = await loadClassroom(slug, classroomId, actorId, {
    historicalStudent: true,
  });
  return {
    submission_id: id,
    ...await readTeachingText(
      await loadTeachingTextSource(access, id),
      fileName,
    ),
  };
}

/** 下载只读取原提交产物；源题授权撤销不恢复题面、支持包或隐藏评测数据。 */
export async function downloadTeachingArtifact(
  slug: string,
  classroomId: string,
  id: string,
  actorId: string,
) {
  const access = await loadClassroom(slug, classroomId, actorId, {
    historicalStudent: true,
  });
  const source = await loadTeachingTextSource(access, id);
  if (!source.artifact_storage_url) {
    throw new NotFoundError("此提交没有产物文件");
  }
  return await deliverStoredArtifact(
    source.artifact_storage_url,
    source.file_name ?? `${source.id}.zip`,
  );
}
