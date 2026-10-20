import { assertEquals } from "jsr:@std/assert@^1";
import { Hono } from "hono";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  domainLimits,
  domainProblemBindings,
  objectiveSubmissions,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import { eq } from "drizzle-orm";
import { connectRedis } from "../../../../shared/mq/connection.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import {
  bindPublishedProblemForTest,
  createUserToken,
} from "../../../../../tests/helper.ts";
import { verifyToken } from "../../../identity/index.ts";
import {
  createDomain,
  ensureDefaultWorkspace,
} from "../../../workspace/index.ts";
import { updateSetting } from "../../../system/index.ts";
import { domainObjectiveRouter } from "../../routes/domain-objective.ts";

Deno.test({
  name: "域客观题限额：已授权交卷在限额后停止新判定落库",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureDefaultWorkspace();
    await updateSetting("domain_creation_policy", "open", "0");
    await connectRedis();
    const token = await createUserToken(),
      actor = (await verifyToken(token)).sub;
    const domain = await createDomain({
      slug: "objective-rate-school",
      name: "学校",
      preset: "education",
    }, actor);
    const db = getDb(), now = new Date().toISOString();
    await db.update(domainLimits).set({ submissions_per_minute: 1 }).where(
      eq(domainLimits.domain_id, domain.id),
    );
    await db.insert(problems).values({
      id: "rate-paper",
      domain_id: domain.id,
      number: 1001,
      title: "卷",
      description: "",
      owner_id: actor,
      is_objective: true,
      visibility: "public",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values({
      id: "rate-paper-v1",
      problem_id: "rate-paper",
      version: 1,
      published_at: now,
      content: {
        kind: "objective",
        title: "卷",
        description: "",
        samples: [],
        questions: [{
          key: "q",
          sort_order: 0,
          type: "single",
          prompt: "选 A",
          options: [{ key: "A", content: "A" }, { key: "B", content: "B" }],
          answer: ["A"],
          explanation: "",
        }],
      },
    });
    await db.update(problems).set({ latest_version_id: "rate-paper-v1" }).where(
      eq(problems.id, "rate-paper"),
    );
    await db.insert(domainProblemBindings).values({
      id: "rate-paper-binding",
      domain_id: domain.id,
      problem_id: "rate-paper",
      kind: "owned",
      visibility: "members",
      created_by: actor,
      created_at: now,
      updated_at: now,
    });
    const app = new Hono();
    app.onError((error, c) =>
      c.json({
        error: error.message,
        code: error instanceof AppError ? error.code : undefined,
      }, error instanceof AppError ? error.statusCode as 429 : 500)
    );
    app.route("/", domainObjectiveRouter);
    const submit = () =>
      app.request(
        `/domains/${domain.slug}/problems/1001/objective-submissions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            answers: { q: ["A"] },
            version_id: "rate-paper-v1",
          }),
        },
      );
    assertEquals((await submit()).status, 201);
    const denied = await submit();
    assertEquals(denied.status, 429);
    assertEquals(
      (await denied.json()).code,
      "DOMAIN_SUBMISSION_QUOTA_EXCEEDED",
    );
    assertEquals((await db.select().from(objectiveSubmissions)).length, 1);
  },
});

Deno.test({
  name: "域客观题历史：分页只返回当前域本人，错误域和同学 ID 不恢复原答案",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await ensureDefaultWorkspace();
    await updateSetting("domain_creation_policy", "open", "0");
    const token = await createUserToken(), otherToken = await createUserToken();
    const actor = (await verifyToken(token)).sub,
      other = (await verifyToken(otherToken)).sub;
    const a = await createDomain({
      slug: "history-school-a",
      name: "学校 A",
      preset: "education",
    }, actor);
    const b = await createDomain({
      slug: "history-school-b",
      name: "学校 B",
      preset: "education",
    }, actor);
    const db = getDb(), now = new Date().toISOString();
    await db.insert(problems).values({
      id: "history-paper",
      domain_id: a.id,
      number: 1001,
      title: "卷",
      description: "隐藏题面",
      is_objective: true,
      visibility: "public",
      created_at: now,
      updated_at: now,
    });
    const bindingId = await bindPublishedProblemForTest("history-paper");
    await db.insert(objectiveSubmissions).values([
      {
        id: "history-own",
        domain_id: a.id,
        domain_problem_binding_id: bindingId,
        paper_id: "history-paper",
        user_id: actor,
        answers: { q: ["A"] },
        submission_type: "practice",
        created_at: now,
      },
      {
        id: "history-peer",
        domain_id: a.id,
        domain_problem_binding_id: bindingId,
        paper_id: "history-paper",
        user_id: other,
        answers: { q: ["B"] },
        submission_type: "practice",
        created_at: now,
      },
    ]);
    const app = new Hono();
    app.onError((error, c) =>
      c.json(
        { error: error.message },
        error instanceof AppError ? error.statusCode as 404 : 500,
      )
    );
    app.route("/", domainObjectiveRouter);
    const request = (path: string) =>
      app.request(path, { headers: { Authorization: `Bearer ${token}` } });
    const list = await request(
      `/domains/${a.slug}/objective-submissions?per_page=1`,
    );
    assertEquals(list.status, 200);
    const body = await list.json();
    assertEquals(body.total, 1);
    assertEquals(body.data[0].id, "history-own");
    assertEquals(body.data[0].answers, undefined);
    assertEquals(
      (await (await request(`/domains/${b.slug}/objective-submissions`)).json())
        .total,
      0,
    );
    assertEquals(
      (await request(`/domains/${a.slug}/objective-submissions/history-peer`))
        .status,
      404,
    );
    assertEquals(
      (await request(`/domains/${b.slug}/objective-submissions/history-own`))
        .status,
      404,
    );
    assertEquals(
      (await (await request(
        `/domains/${a.slug}/objective-submissions/history-own`,
      )).json()).data.answers,
      { q: ["A"] },
    );
    assertEquals(
      (await request(`/domains/${a.slug}/objective-submissions?per_page=101`))
        .status,
      400,
    );
  },
});
