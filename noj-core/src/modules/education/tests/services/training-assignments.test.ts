import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  assignmentItems,
  domainProblemBindings,
  problems,
  problemVersions,
  trainings,
} from "../../../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  importDomainProblem,
  importDomainTraining,
  readDomainTraining,
  saveDomainTraining,
} from "../../../problems/index.ts";
import {
  createAssignment,
  getAssignment,
  publishAssignment,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture();
  const first = await importDomainProblem(
    f.other.slug,
    `${f.school.slug}:1001`,
    f.owner,
  );
  const [problem] = await f.db.select().from(problems).where(
    eq(problems.id, first.binding.problem_id),
  );
  const training = await saveDomainTraining(f.other.slug, f.owner, {
    title: "来源题单",
    state: "published",
    visibility: "private",
    problems: [String(problem.number)],
  });
  const copied = await importDomainTraining(
    f.school.slug,
    training.id,
    f.owner,
  );
  return {
    ...f,
    sourceTraining: training,
    trainingId: copied.training_id,
    taskInput: {
      title: "独立副本作业",
      training: {
        id: copied.training_id,
        requirement: "min_score" as const,
        minimum_score: 6000,
      },
    },
  };
}

Deno.test("题单作业：使用本域独立副本发布，源题单改动不影响作业集合", async () => {
  const f = await fixture();
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.taskInput,
  );
  await f.db.update(trainings).set({ title: "源题单已更改", state: "draft" })
    .where(eq(trainings.id, f.sourceTraining.id));
  await publishAssignment(
    f.school.slug,
    draft.id,
    f.teacher,
    0,
    "publish-copy",
  );
  const detail = await getAssignment(f.school.slug, draft.id, f.student);
  assertEquals(detail.items.length, 1);
  const [item] = await f.db.select().from(assignmentItems).where(
    eq(assignmentItems.assignment_id, draft.id),
  );
  const [identity] = await f.db.select().from(problems).where(
    eq(problems.id, item.problem_id),
  );
  assertEquals(identity.domain_id, f.school.id);
  assert(identity.id !== f.problemId);
  assertEquals(
    (await readDomainTraining(f.school.slug, f.trainingId, f.student)).state,
    "published",
  );
});

Deno.test("题单作业：不能直接挂接外域题单，草稿题单对学生不可见", async () => {
  const f = await fixture();
  await assertRejects(
    () =>
      createAssignment(f.school.slug, f.classroom.id, f.teacher, {
        ...f.taskInput,
        training: { ...f.taskInput.training, id: f.sourceTraining.id },
      }),
    NotFoundError,
  );
  const draft = await saveDomainTraining(f.school.slug, f.teacher, {
    title: "草稿",
    state: "draft",
    visibility: "private",
    problems: ["1001"],
  });
  await assertRejects(
    () => readDomainTraining(f.school.slug, draft.id, f.student),
    NotFoundError,
  );
  assertEquals(
    (await readDomainTraining(f.school.slug, draft.id, f.teacher)).state,
    "draft",
  );
});

Deno.test("题单复制：学生无创建发布权限，失败不留下副本；版本归属严格属于本域新题", async () => {
  const f = await fixture();
  const before = await f.db.select().from(problems).where(
    eq(problems.domain_id, f.school.id),
  );
  await assertRejects(
    () => importDomainTraining(f.school.slug, f.sourceTraining.id, f.student),
    ForbiddenError,
  );
  assertEquals(
    (await f.db.select().from(problems).where(
      eq(problems.domain_id, f.school.id),
    )).length,
    before.length,
  );
  const detail = await readDomainTraining(
    f.school.slug,
    f.trainingId,
    f.teacher,
  );
  const item = detail.items[0];
  assertEquals(item.source_domain_id, f.school.id);
  const [version] = await f.db.select().from(problemVersions).where(
    eq(problemVersions.problem_id, item.problem_id),
  );
  assertEquals(version.version, 1);
  assert(item.binding_id);
  const [binding] = await f.db.select().from(domainProblemBindings).where(
    eq(domainProblemBindings.id, item.binding_id),
  );
  assertEquals(binding.kind, "owned");
});
