import { assertEquals } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  contestProblems,
  contests,
  domainProblemBindings,
  problems,
} from "../../../../shared/db/schema.ts";
import {
  importDomainProblem,
  loadBindingAvailability,
} from "../../../problems/index.ts";
import { assignmentFixture } from "../_assignment-fixture.ts";

Deno.test("副本可用性：源下架和比赛不影响副本，保护保留资源身份，本域下架立即生效", async () => {
  const f = await assignmentFixture();
  const copy = await importDomainProblem(
    f.other.slug,
    `${f.school.slug}:1001`,
    f.owner,
  );
  const read = async () =>
    (await loadBindingAvailability(f.db, f.other.id, [copy.binding.id]))[0]
      .available;
  assertEquals(await read(), true);
  await f.db.update(domainProblemBindings).set({
    disabled_at: new Date().toISOString(),
  }).where(eq(domainProblemBindings.id, f.bindingId));
  assertEquals(await read(), true);
  const now = new Date().toISOString(), contestId = crypto.randomUUID();
  await f.db.insert(contests).values({
    id: contestId,
    domain_id: f.other.id,
    title: "保护副本",
    type: "oi",
    start_time: new Date(Date.now() + 60000).toISOString(),
    end_time: new Date(Date.now() + 120000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  await f.db.insert(contestProblems).values({
    contest_id: contestId,
    problem_id: copy.binding.problem_id,
    domain_id: f.other.id,
    domain_problem_binding_id: copy.binding.id,
    pinned_version_id: copy.version_id,
    score: 10000,
    label: "A",
  });
  // 可用性描述资源生命周期，赛题读写保护由独立守卫执行。
  assertEquals(await read(), true);
  await f.db.update(domainProblemBindings).set({ disabled_at: now }).where(
    eq(domainProblemBindings.id, copy.binding.id),
  );
  assertEquals(await read(), false);
  assertEquals(
    (await loadBindingAvailability(f.db, f.school.id, [copy.binding.id]))
      .length,
    0,
  );
  const [identity] = await f.db.select().from(problems).where(
    eq(problems.id, copy.binding.problem_id),
  );
  assertEquals(identity.latest_version_id, copy.version_id);
});
