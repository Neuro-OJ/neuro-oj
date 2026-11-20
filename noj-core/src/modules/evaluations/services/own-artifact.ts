import { and, eq } from "drizzle-orm";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { submissions } from "../../../shared/db/schema.ts";
import { assertActiveInstanceAccount } from "../../access/contracts/cross-module/identity_services_security_account-access.ts";
import { deliverStoredArtifact } from "../../assets/storage/artifact-delivery.ts";

/** 本人已受理产物属于原提交历史；不通过该接口取得题目或他人文件。 */
export async function downloadOwnArtifact(
  actorId: string,
  submissionId: string,
) {
  await assertActiveInstanceAccount(actorId);
  const [source] = await getDb().select({
    url: submissions.artifact_storage_url,
    file_name: submissions.file_name,
  }).from(submissions).where(and(
    eq(submissions.id, submissionId),
    eq(submissions.user_id, actorId),
  ));
  if (!source?.url) throw new NotFoundError("提交产物不存在或不可访问");
  return await deliverStoredArtifact(
    source.url,
    source.file_name ?? `${submissionId}.zip`,
  );
}
