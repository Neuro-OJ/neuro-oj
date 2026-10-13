import { and, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { problemVersions } from "../../../shared/db/schema.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import {
  type ProblemContentV1,
  resolveProblemTemplate,
} from "../../catalog/index.ts";
import { serializeQuestion } from "../../objective/index.ts";
import { getDomainContestProblems } from "./domain-results.ts";

/** 比赛内容只读取已授权赛题的固定版本，不接受题库默认版本或客户端覆盖。 */
async function contentForLabel(
  slug: string,
  reference: string,
  label: string,
  actorId: string,
) {
  const selected = (await getDomainContestProblems(slug, reference, actorId))
    .find((problem) => problem.label === label);
  if (!selected?.version_id) throw new NotFoundError("比赛题目不存在");
  const [version] = await getDb().select().from(problemVersions).where(and(
    eq(problemVersions.id, selected.version_id),
    eq(problemVersions.problem_id, selected.problem_id),
  ));
  if (!version) throw new NotFoundError("比赛题目版本不可用");
  return { selected, version, content: version.content as ProblemContentV1 };
}

/** 模板与比赛题面同版本；撤销源题共享后不再允许下载模板。 */
export async function getDomainContestTemplate(
  slug: string,
  reference: string,
  label: string,
  actorId: string,
) {
  const { selected } = await contentForLabel(slug, reference, label, actorId);
  const template = await resolveProblemTemplate({
    id: selected.problem_id,
    number: selected.reference!.number,
    title: selected.title,
  }, { versionId: selected.version_id });
  if (!template) throw new NotFoundError("该题目没有初始代码模板");
  return { data: template, version_id: selected.version_id };
}

/** 客观题比赛作答接口始终裁剪答案和解析，组织者也通过相同安全卷面作答。 */
export async function getDomainContestObjectiveQuestions(
  slug: string,
  reference: string,
  label: string,
  actorId: string,
) {
  const { selected, version, content } = await contentForLabel(
    slug,
    reference,
    label,
    actorId,
  );
  if (content.kind !== "objective") {
    throw new NotFoundError("该比赛题目不是客观题套卷");
  }
  return {
    data: content.questions.map((question) =>
      serializeQuestion(selected.problem_id, question, false)
    ),
    version_id: version.id,
    version: version.version,
  };
}
