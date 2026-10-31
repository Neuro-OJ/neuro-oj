import { eq } from "drizzle-orm";
import { getLogger } from "@logtape/logtape";
import { AppError, NotFoundError } from "../../../../shared/base/errors.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import { submissions } from "../../../../shared/db/schema.ts";
import { enqueueSearchIndexTask } from "../../../application/search-tasks.ts";
import type { UserActor } from "../../../access/contracts/actor.ts";
import { deleteStorageObject } from "../../../assets/contracts/cross-module/services_registry.ts";
import { prepareEducationSubmissionDeletion } from "../../../education/contracts/cross-module/services_submission-lifecycle.ts";
import {
  bumpSubmissionCountRevisions,
  lockProjectionHosts,
} from "../versioning/projection.ts";

const logger = getLogger(["noj", "submission"]);

/**
 * 删除提交。
 *
 * 仅做级联 delete（CASCADE 已覆盖 evaluation_results），不清理 Redis 队列。
 *
 * @throws {NotFoundError} 提交不存在
 */
export async function deleteSubmission(
  actor: UserActor,
  id: string,
): Promise<void> {
  if (actor.kind !== "user") {
    throw new TypeError("删除提交需要显式 UserActor");
  }
  const db = getDb();

  const deleted = await db.transaction(async (tx) => {
    const [identity] = await tx.select().from(submissions).where(
      eq(submissions.id, id),
    );
    if (!identity) throw new NotFoundError("提交不存在");
    await lockProjectionHosts(tx, {
      kind: "submission",
      id,
      problem_id: identity.problem_id,
      contest_id: identity.contest_id,
    });
    const [current] = await tx.select().from(submissions).where(
      eq(submissions.id, id),
    ).for("update");
    if (
      current?.active_attempt_id ||
      (current && ["pending", "judging"].includes(current.status))
    ) throw new AppError("提交正在评测，不能删除", 409, "SOURCE_JUDGING");
    await prepareEducationSubmissionDeletion(tx, {
      id,
      kind: "submission",
      domain_id: identity.domain_id,
      user_id: identity.user_id,
      problem_id: identity.problem_id,
    });
    const [row] = await tx.delete(submissions).where(eq(submissions.id, id))
      .returning();
    if (!row) throw new NotFoundError("提交不存在");
    // 删除同样改变实际提交计数：题目/竞赛/global 全部递增。
    await bumpSubmissionCountRevisions(tx, {
      problem_id: row.problem_id,
      contest_id: row.contest_id,
    });
    return row;
  });
  // 先提交引用删除，再调用带共享引用守卫的物理清理；升级副本仍有引用时保留。
  // 上传预约（reservation）未过期或存在共享引用时清理会返回可重试错误——
  // 提交行已删除，这里不能把清理失败变成删除失败（对象由后续守卫清理回收）。
  if (deleted.artifact_storage_url) {
    try {
      await deleteStorageObject(deleted.artifact_storage_url);
    } catch (err) {
      logger.warn("提交删除后的产物物理清理失败，保留对象等待回收", {
        submission_id: id,
        err,
      });
    }
  }
  await enqueueSearchIndexTask("submission", id, "delete");
}
