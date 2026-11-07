import { eq } from "drizzle-orm";
import {
  domainProblemBindings,
  problems,
  problemVersions,
} from "../db/schema.ts";
import type { DbRoot, DbTx } from "../db/executor.ts";

type Executor = DbRoot | DbTx;

/**
 * 测试用：在目标域创建源题的独立副本。
 *
 * 复制语义已收敛为“只产生本域副本”，因此跨域场景的夹具不能再插入指向别域题目的
 * 绑定。这里按源题当前已发布版本复制题目、V1 版本与本域绑定，供测试构造合法的
 * 跨域对照数据。
 */
export async function insertDomainProblemCopy(
  executor: Executor,
  input: {
    sourceProblemId: string;
    domainId: string;
    number: number;
    ownerId: string;
    now?: string;
  },
): Promise<{ problemId: string; versionId: string; bindingId: string }> {
  const now = input.now ?? new Date().toISOString();
  const [source] = await executor.select().from(problems).where(
    eq(problems.id, input.sourceProblemId),
  );
  if (!source) throw new Error("复制夹具：源题不存在");
  if (!source.latest_version_id) throw new Error("复制夹具：源题尚未发布");
  const [version] = await executor.select().from(problemVersions).where(
    eq(problemVersions.id, source.latest_version_id),
  );
  if (!version) throw new Error("复制夹具：源版本不存在");
  const problemId = crypto.randomUUID(), versionId = crypto.randomUUID();
  await executor.insert(problems).values({
    id: problemId,
    domain_id: input.domainId,
    number: input.number,
    title: source.title,
    description: source.description,
    owner_id: input.ownerId,
    difficulty: source.difficulty,
    judge_type: source.judge_type,
    is_objective: source.is_objective,
    visibility: source.visibility,
    created_at: now,
    updated_at: now,
  });
  await executor.insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version: 1,
    content: version.content,
    content_sha256: version.content_sha256,
    published_at: now,
  });
  await executor.update(problems).set({ latest_version_id: versionId })
    .where(eq(problems.id, problemId));
  const bindingId = crypto.randomUUID();
  await executor.insert(domainProblemBindings).values({
    id: bindingId,
    domain_id: input.domainId,
    problem_id: problemId,
    visibility: source.visibility === "public" ? "public" : "members",
    created_by: input.ownerId,
    created_at: now,
    updated_at: now,
  });
  return { problemId, versionId, bindingId };
}
