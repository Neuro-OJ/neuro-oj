import { assert, assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { selfTests, submissions } from "../../../../shared/db/schema.ts";
import { recordSseEvent } from "../../../../shared/sse/sse-events.ts";
import {
  _dispatchToLocalListenersForTest,
  Channels,
} from "../../../../shared/sse/event-bus.ts";
import { signToken } from "../../../identity/index.ts";
import { removeDomainMember } from "../../../workspace/index.ts";
import { setDomainProblemSharing } from "../../../catalog/index.ts";
import {
  createDomainSelfTest,
  createDomainSubmission,
  getQueueOverview,
} from "../../index.ts";
import { domainSubmissionSse } from "../../routes/sse.ts";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";

for (const kind of ["submission", "self-test"] as const) {
  Deno.test({
    name: `域${kind} SSE：当前域授权、重放裁剪、源撤销和长连接撤权`,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const f = await fixture();
      await withQueue(async () => {
        const input = {
          language: "python3",
          code: "print('private original')",
          version_id: f.v2,
        };
        const created = kind === "submission"
          ? await createDomainSubmission(f.a.slug, f.ref, f.student, input)
          : await createDomainSelfTest(f.a.slug, f.ref, f.student, input);
        const table = kind === "submission" ? submissions : selfTests;
        await f.db.update(table).set({ status: "judging" }).where(
          eq(table.id, created.id),
        );
        const seq = await recordSseEvent(Channels.submission(created.id), {
          type: "submission:updated",
          score: 9876,
          output: "never forward",
          details: { cases: [{ input: "secret data" }] },
        });
        const token = await signToken({ sub: f.student, role: "user" }),
          headers = { Authorization: `Bearer ${token}` };
        const app = new Hono();
        app.onError((e, c) =>
          c.json(
            { error: e.message },
            e instanceof AppError ? e.statusCode as 404 : 500,
          )
        );
        app.route("/", domainSubmissionSse);
        const suffix = kind === "submission" ? "submissions" : "self-tests",
          path = `/domains/${f.a.slug}/${suffix}/${created.id}/events`;
        assertEquals(
          (await app.request(
            `/domains/${f.b.slug}/${suffix}/${created.id}/events`,
            { headers },
          )).status,
          404,
        );
        const controller = new AbortController();
        const response = await app.request(path, {
          headers: { ...headers, "Last-Event-ID": String(seq - 1) },
          signal: controller.signal,
        });
        assertEquals(response.status, 200);
        const reader = response.body!.getReader(), decoder = new TextDecoder();
        try {
          const initial = decoder.decode((await reader.read()).value);
          assert(initial.includes(created.id));
          assert(!initial.includes("private original"));
          const replay = decoder.decode((await reader.read()).value);
          assert(replay.includes(`id: ${seq}`));
          assert(!replay.includes("9876"));
          assert(!replay.includes("never forward"));
          assert(!replay.includes("secret data"));
          await setDomainProblemSharing(f.source.slug, "1001", f.owner, {
            expectedRevision: 1,
            enabled: false,
            scope: "all",
            targetDomainIds: [],
          });
          const update = reader.read();
          _dispatchToLocalListenersForTest(
            Channels.submission(created.id),
            JSON.stringify({ score: 9876, output: "never forward" }),
          );
          const revoked = decoder.decode((await update).value);
          assert(revoked.includes('"resource_available":false'));
          assert(!revoked.includes("9876"));
          await removeDomainMember(f.a.slug, f.owner, f.student);
          const closed = reader.read();
          _dispatchToLocalListenersForTest(
            Channels.submission(created.id),
            "{}",
          );
          assertEquals((await closed).done, true);
        } finally {
          controller.abort();
          await reader.cancel();
        }
      });
    },
  });
}
Deno.test({
  name: "默认域队列：私有学校题名、提交、完成成绩与计数不进入旧入口",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture();
    await withQueue(async () => {
      const baseline = await getQueueOverview(false, f.student);
      const created = await createDomainSubmission(f.a.slug, f.ref, f.student, {
        language: "python3",
        code: "print(1)",
        version_id: f.v2,
      });
      const main = await getQueueOverview(false, f.student);
      assertEquals(main.pending.some((r) => r.id === created.id), false);
      assertEquals(main.judging.some((r) => r.id === created.id), false);
      assertEquals(main.stats.pending_count, baseline.stats.pending_count);
      assertEquals(main.stats.judging_count, baseline.stats.judging_count);
      assertEquals(main.stats.pools, undefined);
      const school = await getQueueOverview(false, f.student, {
        domainId: f.a.id,
        member: true,
      });
      assertEquals(
        [...school.pending, ...school.judging].some((r) => r.id === created.id),
        true,
      );
      await f.db.update(submissions).set({
        status: "finished",
        judge_finished_at: new Date().toISOString(),
      }).where(eq(submissions.id, created.id));
      const done = await getQueueOverview(false, f.student);
      assertEquals(
        done.recently_completed.some((r) => r.id === created.id),
        false,
      );
      assertEquals(done.stats.completed_today, baseline.stats.completed_today);
    });
  },
});
