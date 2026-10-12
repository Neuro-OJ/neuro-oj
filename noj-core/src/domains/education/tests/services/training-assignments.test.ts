import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  assignmentItems,
  assignments,
  domainLimits,
  domainProblemBindings,
  domains,
  domainTrainingBindings,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import {
  importDomainTraining,
  readDomainTraining,
  saveDomainTraining,
  setDomainProblemSharing,
  setDomainTrainingSharing,
} from "../../../catalog/index.ts";
import {
  copyAssignment,
  createAssignment,
  getAssignment,
  publishAssignment,
  setClassroomMember,
} from "../../index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

async function fixture() {
  const f = await assignmentFixture();
  await f.db.update(domains).set({
    configuration: { ...f.other.configuration, access: "public" },
  }).where(eq(domains.id, f.other.id));
  const refs: string[] = [];
  for (const number of [2001, 2002]) {
    const problemId = crypto.randomUUID(),
      versionId = crypto.randomUUID(),
      now = new Date().toISOString();
    await f.db.insert(problems).values({
      id: problemId,
      domain_id: f.other.id,
      type: "P",
      number,
      title: String(number),
      description: "公开题面",
      owner_id: f.owner,
      visibility: "public",
      created_at: now,
      updated_at: now,
    });
    await f.db.insert(problemVersions).values({
      id: versionId,
      problem_id: problemId,
      version: 1,
      content: { kind: "ai", title: String(number), description: "公开题面" },
      published_at: now,
    });
    await f.db.update(problems).set({ latest_version_id: versionId }).where(
      eq(problems.id, problemId),
    );
    await f.db.insert(domainProblemBindings).values({
      id: crypto.randomUUID(),
      domain_id: f.other.id,
      problem_id: problemId,
      kind: "owned",
      visibility: "public",
      created_by: f.owner,
      created_at: now,
      updated_at: now,
    });
    await setDomainProblemSharing(f.other.slug, String(number), f.owner, {
      expectedRevision: 0,
      enabled: true,
      scope: "all",
      targetDomainIds: [],
    });
    refs.push(String(number));
  }
  const input = {
    title: "公开训练",
    visibility: "public" as const,
    problems: refs,
  };
  const training = await saveDomainTraining(f.other.slug, f.owner, input);
  await setDomainTrainingSharing(f.other.slug, training.id, f.owner, {
    expectedRevision: 0,
    enabled: true,
    scope: "all",
    targetDomainIds: [],
  });
  const taskInput = {
    title: "来自公开题单",
    training: {
      id: training.id,
      requirement: "min_score" as const,
      minimum_score: 6000,
    },
  };
  return { ...f, refs, training, trainingInput: input, taskInput };
}

Deno.test("题单作业：只保存来源引用，发布时取当前顺序并建立绑定；后续题单变化不改已发布集合", async () => {
  const f = await fixture();
  const imported = await importDomainTraining(
    f.school.slug,
    f.training.id,
    f.teacher,
  );
  assertEquals(
    (await importDomainTraining(f.school.slug, f.training.id, f.teacher)).id,
    imported.id,
  );
  assertEquals((await f.db.select().from(domainTrainingBindings)).length, 1);
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.taskInput,
  );
  assertEquals(
    (await getAssignment(f.school.slug, draft.id, f.teacher)).items.length,
    0,
  );
  const draftCopy = await copyAssignment(
    f.school.slug,
    draft.id,
    f.teacher,
    0,
    "draft-copy",
    {},
  );
  assertEquals(draftCopy.source_training_id, f.training.id);
  assertEquals(
    (await f.db.select().from(domainProblemBindings).where(
      eq(domainProblemBindings.domain_id, f.school.id),
    )).length,
    1,
  );
  await saveDomainTraining(f.other.slug, f.owner, {
    ...f.trainingInput,
    problems: [...f.refs].reverse(),
  }, { id: f.training.id, revision: 0 });
  const preview = await readDomainTraining(
    f.school.slug,
    f.training.id,
    f.teacher,
  );
  assertEquals(preview.items.map((item) => item.display_ref), [
    "other-school:2002",
    "other-school:2001",
  ]);
  assertEquals(preview.items[0].binding_id, null);
  const published = await publishAssignment(
    f.school.slug,
    draft.id,
    f.teacher,
    0,
    "expand",
  );
  const detail = await getAssignment(f.school.slug, draft.id, f.student);
  assertEquals(detail.items.length, 2);
  assertEquals(
    detail.items.every((item) =>
      item.minimum_score === 6000 && !!item.published_version_id
    ),
    true,
  );
  const problemIds = preview.items.map((item) => item.problem_id);
  assertEquals(detail.items.map((item) => item.problem_id), problemIds);
  await saveDomainTraining(f.other.slug, f.owner, {
    ...f.trainingInput,
    problems: [f.refs[0]],
  }, { id: f.training.id, revision: 1 });
  assertEquals(
    (await getAssignment(f.school.slug, draft.id, f.student)).items.map((
      item,
    ) => item.problem_id),
    problemIds,
  );
  assertEquals(
    await publishAssignment(f.school.slug, draft.id, f.teacher, 0, "expand"),
    published,
  );
});

Deno.test("题单作业：助教作业授权可使用已存在题库引用，不自动取得题库管理能力", async () => {
  const f = await fixture();
  await importDomainTraining(f.school.slug, f.training.id, f.teacher);
  const initial = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.taskInput,
  );
  await publishAssignment(f.school.slug, initial.id, f.teacher, 0, "initial");
  await setClassroomMember(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.assistant,
    1,
    {
      role: "assistant",
      capabilities: ["assignments:manage"],
    },
  );
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.assistant,
    f.taskInput,
  );
  const published = await publishAssignment(
    f.school.slug,
    task.id,
    f.assistant,
    0,
    "assistant",
  );
  assertEquals(published.state, "published");
  await assertRejects(
    () => importDomainTraining(f.school.slug, f.training.id, f.assistant),
    ForbiddenError,
  );
});

Deno.test("题单作业：并非题单授权即题目授权，发布失败回滚已预留引用和整个任务", async () => {
  const f = await fixture();
  await importDomainTraining(f.school.slug, f.training.id, f.teacher);
  const draft = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.taskInput,
  );
  await f.db.update(domainLimits).set({ problems: 2 }).where(
    eq(domainLimits.domain_id, f.school.id),
  );
  await assertRejects(
    () => publishAssignment(f.school.slug, draft.id, f.teacher, 0, "quota"),
    AppError,
  );
  assertEquals(
    (await f.db.select().from(domainProblemBindings).where(
      eq(domainProblemBindings.domain_id, f.school.id),
    )).length,
    1,
  );
  assertEquals(
    (await f.db.select().from(assignmentItems).where(
      eq(assignmentItems.assignment_id, draft.id),
    )).length,
    0,
  );
  assertEquals(
    (await f.db.select().from(assignments).where(eq(assignments.id, draft.id)))[
      0
    ].state,
    "draft",
  );
  await f.db.update(domainLimits).set({ problems: null }).where(
    eq(domainLimits.domain_id, f.school.id),
  );
  await setDomainProblemSharing(f.other.slug, f.refs[1], f.owner, {
    expectedRevision: 1,
    enabled: false,
    scope: "all",
    targetDomainIds: [],
  });
  await assertRejects(
    () =>
      publishAssignment(f.school.slug, draft.id, f.teacher, 0, "revoked-item"),
    NotFoundError,
  );
  assertEquals(
    (await f.db.select().from(assignmentItems).where(
      eq(assignmentItems.assignment_id, draft.id),
    )).length,
    0,
  );
});

Deno.test("题单作业：题单撤销阻止新展开，已发布任务按源题各自授权保留且可复制补题", async () => {
  const f = await fixture();
  await importDomainTraining(f.school.slug, f.training.id, f.teacher);
  const first = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.taskInput,
  );
  const second = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.taskInput,
  );
  await publishAssignment(f.school.slug, first.id, f.teacher, 0, "first");
  await setDomainTrainingSharing(f.other.slug, f.training.id, f.owner, {
    expectedRevision: 1,
    enabled: false,
    scope: "all",
    targetDomainIds: [],
  });
  await assertRejects(
    () => importDomainTraining(f.school.slug, f.training.id, f.teacher),
    NotFoundError,
  );
  await assertRejects(
    () => readDomainTraining(f.school.slug, f.training.id, f.student),
    NotFoundError,
  );
  await assertRejects(
    () => publishAssignment(f.school.slug, second.id, f.teacher, 0, "second"),
    NotFoundError,
  );
  assertEquals(
    (await getAssignment(f.school.slug, first.id, f.student)).items.length,
    2,
  );
  const copy = await copyAssignment(
    f.school.slug,
    first.id,
    f.teacher,
    1,
    "remediation",
    {},
  );
  assertEquals(copy.source_training_id, null);
  assertEquals(
    (await getAssignment(f.school.slug, copy.id, f.teacher)).items.length,
    2,
  );
});

Deno.test("题单引用：跨域身份、定向授权与资源 revision 独立校验", async () => {
  const f = await fixture();
  await assertRejects(
    () => importDomainTraining(f.school.slug, f.training.id, f.student),
    ForbiddenError,
  );
  await assertRejects(
    () => readDomainTraining(f.school.slug, f.training.id, f.teacher),
    NotFoundError,
  );
  await assertRejects(
    () =>
      saveDomainTraining(f.school.slug, f.owner, f.trainingInput, {
        id: f.training.id,
        revision: 0,
      }),
    NotFoundError,
  );
  await assertRejects(
    () =>
      saveDomainTraining(f.other.slug, f.owner, f.trainingInput, {
        id: f.training.id,
        revision: null,
      }),
    AppError,
  );
  await setDomainTrainingSharing(f.other.slug, f.training.id, f.owner, {
    expectedRevision: 1,
    enabled: true,
    scope: "selected",
    targetDomainIds: [f.school.id],
  });
  await importDomainTraining(f.school.slug, f.training.id, f.teacher);
  await setDomainTrainingSharing(f.other.slug, f.training.id, f.owner, {
    expectedRevision: 2,
    enabled: true,
    scope: "selected",
    targetDomainIds: [f.school.id],
  });
  assertEquals(
    (await readDomainTraining(f.school.slug, f.training.id, f.teacher)).items
      .length,
    2,
  );
  await f.db.update(domainProblemBindings).set({ visibility: "members" }).where(
    and(
      eq(domainProblemBindings.domain_id, f.other.id),
      eq(
        domainProblemBindings.problem_id,
        (await readDomainTraining(f.school.slug, f.training.id, f.teacher))
          .items[0].problem_id,
      ),
    ),
  );
  await assertRejects(
    () => readDomainTraining(f.school.slug, f.training.id, f.teacher),
    NotFoundError,
  );
});
