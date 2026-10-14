import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { contestProblemExecutionForTest } from "../../../../../tests/helper.ts";
import { eq } from "drizzle-orm";
import {
  contestProblems,
  contests,
  domainProblemBindings,
  domains,
  problemShareSettings,
  problemShareTargets,
} from "../../../../shared/db/schema.ts";
import { loadBindingAvailability } from "../../../catalog/index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("共享可用性：批量读取实时授权，目标域比赛不会把源题在全实例隐藏", async () => {
  const f = await assignmentFixture(),
    bindingId = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.db.update(domains).set({
    configuration: { ...f.school.configuration, access: "public" },
  }).where(eq(domains.id, f.school.id));
  await f.db.update(domainProblemBindings).set({ visibility: "public" }).where(
    eq(domainProblemBindings.id, f.bindingId),
  );
  const contestId = crypto.randomUUID();
  await f.db.insert(contests).values({
    id: contestId,
    domain_id: f.other.id,
    title: "学校内部比赛",
    type: "oi",
    start_time: "2026-10-01T00:00:00.000Z",
    end_time: "2026-11-01T00:00:00.000Z",
    created_at: now,
    updated_at: now,
  });
  await assertRejects(
    () => contestProblemExecutionForTest(contestId, f.problemId),
    Error,
    "共享赛题夹具缺少比赛使用域的题库绑定",
  );
  await f.db.insert(domainProblemBindings).values({
    id: bindingId,
    domain_id: f.other.id,
    problem_id: f.problemId,
    kind: "shared",
    created_by: f.owner,
    created_at: now,
    updated_at: now,
  });
  const read = async () =>
    (await loadBindingAvailability(f.db, f.other.id, [bindingId]))[0].available;
  assertEquals(await read(), false);
  await f.db.insert(problemShareSettings).values({
    problem_id: f.problemId,
    enabled: true,
    scope: "selected",
    updated_by: f.owner,
    updated_at: now,
  });
  assertEquals(await read(), false);
  await f.db.insert(problemShareTargets).values({
    problem_id: f.problemId,
    domain_id: f.other.id,
  });
  assertEquals(await read(), true);
  await f.db.insert(contestProblems).values({
    ...await contestProblemExecutionForTest(contestId, f.problemId),
    contest_id: contestId,
    problem_id: f.problemId,
    sort_order: 0,
    score: 100,
    label: "A",
    pinned_version_id: f.versionId,
  });
  assertEquals(await read(), true);
  const sourceContestId = crypto.randomUUID();
  await f.db.insert(contests).values({
    id: sourceContestId,
    domain_id: f.school.id,
    title: "来源域比赛",
    type: "oi",
    start_time: "2026-10-01T00:00:00.000Z",
    end_time: "2026-11-01T00:00:00.000Z",
    created_at: now,
    updated_at: now,
  });
  await f.db.insert(contestProblems).values({
    ...await contestProblemExecutionForTest(sourceContestId, f.problemId),
    contest_id: sourceContestId,
    problem_id: f.problemId,
    sort_order: 0,
    score: 100,
    label: "A",
    pinned_version_id: f.versionId,
  });
  assertEquals(await read(), false);
  await f.db.update(contests).set({ end_time: "2026-10-02T00:00:00.000Z" })
    .where(eq(contests.id, sourceContestId));
  assertEquals(await read(), true);
  await f.db.update(problemShareSettings).set({ enabled: false }).where(
    eq(problemShareSettings.problem_id, f.problemId),
  );
  assertEquals(await read(), false);
  assertEquals(
    (await loadBindingAvailability(f.db, f.school.id, [bindingId])).length,
    0,
  );
});
