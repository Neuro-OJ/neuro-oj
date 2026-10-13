import { and, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  contestProblems,
  domains,
  problems,
  problemVersions,
} from "../../../shared/db/schema.ts";
import { ForbiddenError, NotFoundError } from "../../../shared/base/errors.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  domainProblemReference,
  type ProblemContentV1,
  resolveProblemTemplate,
  resolveProblemUiHtml,
} from "../../catalog/index.ts";
import { serializeQuestion } from "../../objective/index.ts";
import { getDomainContestProblems } from "./domain-results.ts";
import { loadDomainContest } from "./domain-access.ts";
import { computeContestStatus } from "./contests.ts";

/** 提交入口按比赛路径解析标签，受理窗口与报名关系在事务中仍须成立。 */
export async function getDomainContestSubmissionTarget(
  slug: string,
  reference: string,
  label: string,
  actorId: string,
  executor: Executor = getDb(),
) {
  const access = await loadDomainContest(slug, reference, actorId, {
    write: true,
    executor,
  });
  if (
    !access.registered ||
    computeContestStatus(access.contest.start_time, access.contest.end_time) !==
      "running"
  ) throw new ForbiddenError("仅进行中的比赛参赛者可以提交");
  const [row] = await executor.select({ problem: problems, source: domains })
    .from(contestProblems)
    .innerJoin(problems, eq(problems.id, contestProblems.problem_id))
    .innerJoin(domains, eq(domains.id, problems.domain_id))
    .where(
      and(
        eq(contestProblems.contest_id, access.contest.id),
        eq(contestProblems.label, label),
      ),
    );
  if (!row) throw new NotFoundError("比赛题目不存在");
  return {
    contestId: access.contest.id,
    problemId: row.problem.id,
    reference: domainProblemReference(
      { ...row.problem, domain_id: row.source.id },
      row.source.slug,
      access.domain.id,
    )
      .display_ref,
  };
}

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
  const { selected, content } = await contentForLabel(
    slug,
    reference,
    label,
    actorId,
  );
  if (content.kind === "ai" && content.submission_mode === "ui") {
    throw new NotFoundError("界面题不公开执行脚本模板");
  }
  const template = await resolveProblemTemplate({
    id: selected.problem_id,
    number: selected.reference!.number,
    title: selected.title,
  }, { versionId: selected.version_id });
  if (!template) throw new NotFoundError("该题目没有初始代码模板");
  return { data: template, version_id: selected.version_id };
}

/** 界面使用已授权比赛固定版本的 HTML；不返回参数填充脚本或评测配置。 */
export async function getDomainContestUi(
  slug: string,
  reference: string,
  label: string,
  actorId: string,
) {
  const { selected, content } = await contentForLabel(
    slug,
    reference,
    label,
    actorId,
  );
  if (content.kind !== "ai" || content.submission_mode !== "ui") {
    throw new NotFoundError("此赛题没有作答界面");
  }
  const html = await resolveProblemUiHtml(selected.problem_id, {
    versionId: selected.version_id,
  });
  if (!html) throw new NotFoundError("此赛题没有作答界面");
  return { data: { html }, version_id: selected.version_id };
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
