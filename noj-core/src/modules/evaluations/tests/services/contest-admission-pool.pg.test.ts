import { assertEquals } from "jsr:@std/assert@^1";
import { closeDbForShutdown, getDb } from "../../../../shared/db/connection.ts";
import { fixture } from "../_domain-execution-fixture.ts";
import { resolveDomainExecution } from "../../services/workspace-execution.ts";
import {
  addDomainContestParticipants,
  createDomainContest,
} from "../../../contests/services/domain-contests.ts";

Deno.test("Domain admission[真实 PG]: 单连接池中比赛受理全链路沿用事务", async () => {
  const f = await fixture("oi");
  const contest = await createDomainContest(f.a.slug, f.owner, {
    title: "单连接受理",
    type: "ioi",
    start_time: new Date(Date.now() - 60_000).toISOString(),
    end_time: new Date(Date.now() + 3_600_000).toISOString(),
    freeze_duration_seconds: 0,
    problems: [{
      problem_id: f.problemId,
      label: "A",
      sort_order: 0,
      score: 5000,
    }],
  });
  await addDomainContestParticipants(f.a.slug, contest.id, f.owner, [
    f.student,
  ]);
  await closeDbForShutdown();
  const previous = Deno.env.get("DATABASE_POOL_MAX");
  Deno.env.set("DATABASE_POOL_MAX", "1");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = getDb().transaction((tx) =>
    Promise.race([
      resolveDomainExecution(
        { slug: f.a.slug, reference: "A", contestId: contest.id },
        f.student,
        f.v2,
        tx,
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("单连接受理发生连接池互等")),
          5000,
        );
      }),
    ])
  );
  try {
    const resolved = await pending;
    assertEquals(resolved.problem.id, f.problemId);
    assertEquals(resolved.version.id, f.v2);
    assertEquals(resolved.domain.id, f.a.id);
  } finally {
    clearTimeout(timer);
    await closeDbForShutdown();
    if (previous === undefined) Deno.env.delete("DATABASE_POOL_MAX");
    else Deno.env.set("DATABASE_POOL_MAX", previous);
    await pending.catch(() => undefined);
  }
});
