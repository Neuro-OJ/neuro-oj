import { setFixtureAvailability } from "../_domain-execution-fixture.ts";
import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { AppError } from "../../../../shared/base/errors.ts";
import { selfTests } from "../../../../shared/db/schema.ts";
import {
  cancelDomainSelfTest,
  createDomainSelfTest,
  getDomainSelfTest,
} from "../../index.ts";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";

Deno.test({
  name: "域自测读取与取消：错误域、其他账号拒绝，原输入保留而源撤销不恢复输出",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const f = await fixture();
    await withQueue(async () => {
      const created = await createDomainSelfTest(f.a.slug, f.ref, f.student, {
        version_id: f.v2,
        language: "python3",
        code: "print(1)",
      });
      const app = new Hono<{ Variables: { userId: string } }>();
      app.onError((error, c) =>
        error instanceof AppError
          ? c.json({ code: error.code }, error.statusCode as 404)
          : c.json({ code: "internal" }, 500)
      );
      app.get("/domains/:slug/self-tests/:id", async (c) => {
        const actor = c.req.header("X-Test-Actor")!;
        c.set("userId", actor);
        return c.json({
          data: await getDomainSelfTest(
            c.req.param("slug"),
            c.req.param("id"),
            actor,
            c,
          ),
        });
      });
      app.post("/domains/:slug/self-tests/:id/cancel", async (c) => {
        const actor = c.req.header("X-Test-Actor")!;
        c.set("userId", actor);
        await cancelDomainSelfTest(
          c.req.param("slug"),
          c.req.param("id"),
          actor,
          c,
        );
        return c.json({ data: { cancel_requested: true } });
      });
      const path = `/domains/${f.a.slug}/self-tests/${created.id}`,
        headers = { "X-Test-Actor": f.student };
      assertEquals(
        (await app.request(path, { headers: { "X-Test-Actor": f.outsider } }))
          .status,
        404,
      );
      assertEquals(
        (await app.request(`/domains/${f.b.slug}/self-tests/${created.id}`, {
          headers,
        })).status,
        404,
      );
      assertEquals(
        (await app.request(path + "/cancel", { method: "POST", headers }))
          .status,
        200,
      );
      assertEquals(
        (await f.db.select().from(selfTests).where(
          eq(selfTests.id, created.id),
        ))[0].status,
        "cancelled",
      );
      await f.db.update(selfTests).set({
        status: "finished",
        result_status: "finished",
        score: 7000,
        output: "checker secret",
        details: JSON.stringify({
          oi: {
            backend: "native",
            verdict: "AC",
            subtasks: [{
              id: "self",
              cases: [{
                id: "custom1",
                verdict: "AC",
                stdout: "student output",
                stderr: "student diagnostic",
                input: "private data",
                checker_output: "hidden checker",
              }],
            }],
          },
          hidden_output: "private",
        }),
      }).where(eq(selfTests.id, created.id));
      const available = await (await app.request(path, { headers })).json() as {
        data: {
          output: null;
          details: {
            oi: { subtasks: Array<{ cases: Array<Record<string, unknown>> }> };
          };
        };
      };
      assertEquals(available.data.output, null);
      const userCase = available.data.details.oi.subtasks[0].cases[0];
      assertEquals(userCase.stdout, "student output");
      assertEquals(userCase.stderr, "student diagnostic");
      assertEquals(userCase.input, undefined);
      assertEquals(userCase.checker_output, undefined);
      await f.db.update(selfTests).set({
        status: "finished",
        result_status: "finished",
        score: 7000,
        output: "hidden evaluator output",
        details: JSON.stringify({ cases: [{ hidden: true, input: "secret" }] }),
      }).where(eq(selfTests.id, created.id));
      await setFixtureAvailability(f, false);
      const response = await app.request(path, { headers });
      assertEquals(response.status, 200);
      const result = await response.json() as {
        data: {
          domain_id: string;
          code: string;
          score: number;
          resource_available: boolean;
          output: unknown;
          details: unknown;
          progress?: unknown;
        };
      };
      assertEquals(result.data.domain_id, f.a.id);
      assertEquals(result.data.code, "print(1)");
      assertEquals(result.data.score, 7000);
      assertEquals(result.data.resource_available, false);
      assertEquals(result.data.output, null);
      assertEquals(result.data.details, null);
      assertEquals(result.data.progress, undefined);
    });
  },
});
