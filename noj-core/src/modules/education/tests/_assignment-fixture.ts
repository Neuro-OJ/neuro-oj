import { eq } from "drizzle-orm";
import {
  domainProblemBindings,
  domains,
  problems,
  problemVersions,
} from "../../../shared/db/schema.ts";
import { setClassroomMember } from "../index.ts";
import { educationFixture } from "./_fixtures.ts";

/** 建立拥有发布版本和本域绑定的班级作业夹具，数据只在隔离测试库创建。 */
export async function assignmentFixture() {
  const f = await educationFixture();
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.student,
    0,
    { role: "student" },
  );
  const now = new Date().toISOString(),
    problemId = crypto.randomUUID(),
    versionId = crypto.randomUUID(),
    bindingId = crypto.randomUUID();
  await f.db.insert(problems).values({
    id: problemId,
    domain_id: f.school.id,
    number: 1001,
    title: "教学题",
    description: "题面",
    owner_id: f.owner,
    created_at: now,
    updated_at: now,
  });
  await f.db.insert(problemVersions).values({
    id: versionId,
    problem_id: problemId,
    version: 1,
    content: {
      kind: "ai",
      title: "教学题",
      description: "题面",
      samples: [],
      submission_mode: "code",
      template_content: "print(1)",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 5000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 2000,
          memory_limit_mb: 512,
        },
      },
      artifact_max_size_mb: null,
      llm_config: null,
    },
    published_at: now,
  });
  await f.db.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, problemId),
  );
  await f.db.insert(domainProblemBindings).values({
    id: bindingId,
    domain_id: f.school.id,
    problem_id: problemId,
    kind: "owned",
    visibility: "members",
    created_by: f.owner,
    created_at: now,
    updated_at: now,
  });
  await f.db.update(domains).set({ next_problem_number: 1002 }).where(
    eq(domains.id, f.school.id),
  );
  const input = {
    title: "基础作业",
    items: [{
      binding_id: bindingId,
      requirement: "min_score" as const,
      minimum_score: 6000,
    }],
  };
  return { ...f, problemId, versionId, bindingId, input };
}
