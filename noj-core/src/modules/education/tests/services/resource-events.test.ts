import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  assignmentItems,
  domainProblemBindings,
  educationOutbox,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import {
  createAssignment,
  getMyAssignmentProgress,
  publishAssignment,
} from "../../index.ts";
import {
  publishProblemVersion,
  recordPublishedBindingChanges,
  saveProblemDraft,
  setDomainProblemBindingPolicy,
} from "../../../problems/index.ts";
import { userActorFromAuthenticatedId } from "../../../access/index.ts";
import { setMemberRole } from "../../../access/workspace/index.ts";
import { processEducationBatch } from "../../services/progress-worker.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";
import { insertDomainProblemCopy } from "../../../../shared/testing/domain-problem-copy.ts";

async function drain() {
  for (let i = 0; i < 20; i++) {
    if (!(await processEducationBatch()).length) break;
  }
}

Deno.test("版本与策略事件：消费者延迟后重算仍落到最新绑定依据", async () => {
  const f = await assignmentFixture();
  const task = await createAssignment(
    f.school.slug,
    f.classroom.id,
    f.teacher,
    f.input,
  );
  await publishAssignment(f.school.slug, task.id, f.teacher, 0, "publish");
  await setMemberRole(f.school.slug, f.owner, f.teacher, "educator");
  const v2 = crypto.randomUUID(), now = new Date().toISOString();
  await f.db.transaction(async (tx) => {
    await tx.insert(problemVersions).values({
      id: v2,
      problem_id: f.problemId,
      version: 2,
      content: { kind: "ai", title: "新版", description: "新版题面" },
      published_by: f.owner,
      published_at: now,
    });
    await tx.update(problems).set({ latest_version_id: v2 }).where(
      eq(problems.id, f.problemId),
    );
    await recordPublishedBindingChanges(tx, f.problemId, v2, f.owner, now);
  });
  await setDomainProblemBindingPolicy(f.school.slug, "1001", f.owner, 1, {
    mode: "exact",
    version_id: f.versionId,
  }, "暂用旧版");
  await setDomainProblemBindingPolicy(f.school.slug, "1001", f.owner, 2, {
    mode: "any",
  }, "恢复全部版本");
  await drain();
  await getMyAssignmentProgress(f.school.slug, task.id, f.student);
  const [item] = await f.db.select().from(assignmentItems).where(
    eq(assignmentItems.assignment_id, task.id),
  );
  assertEquals(item.answer_version_id, v2);
  assertEquals(item.policy_revision, 3);
});

Deno.test("真实发布：源版本发布自动记录 any 作答切换，其他域副本保持不变", async () => {
  const f = await assignmentFixture();
  // 其他域持有独立副本：源题发布只推进本域绑定，副本 revision 不动。
  await insertDomainProblemCopy(f.db, {
    sourceProblemId: f.problemId,
    domainId: f.other.id,
    number: 1001,
    ownerId: f.owner,
  });
  const draft = await saveProblemDraft(f.problemId, {
    expectedRevision: 0,
    actorId: "0",
    content: {
      kind: "ai",
      title: "真正发布新版",
      description: "题面",
      samples: [],
      submission_mode: "code",
      runtime_config: {
        evaluator: {
          image: "noj-evaluator-python",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 60000,
          memory_limit_mb: 512,
        },
        solution: {
          image: "noj-solution-python",
          call_timeout_ms: 60000,
          memory_limit_mb: 512,
        },
      },
      template_content: "print(1)",
      artifact_max_size_mb: null,
      llm_config: null,
    },
  });
  const published = await publishProblemVersion(f.problemId, {
    expectedRevision: draft.revision,
    actor: userActorFromAuthenticatedId("0"),
  });
  assertEquals(published.unchanged, false);
  const bindings = await f.db.select().from(domainProblemBindings);
  assertEquals(bindings.find((b) => b.domain_id === f.school.id)?.revision, 1);
  assertEquals(bindings.find((b) => b.domain_id === f.other.id)?.revision, 0);
  assertEquals(
    (await f.db.select().from(educationOutbox)).filter((e) =>
      e.event_type === "problem.changed"
    ).length,
    1,
  );
});
