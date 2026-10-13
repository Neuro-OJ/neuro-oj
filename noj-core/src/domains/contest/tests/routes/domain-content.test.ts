import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { AppError } from "../../../../shared/base/errors.ts";
import { getDb, resetDbForTest } from "../../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  problems,
  problemShareSettings,
  problemVersions,
  users,
} from "../../../../shared/db/schema.ts";
import { createDomain } from "../../../workspace/index.ts";
import { importDomainProblem } from "../../../catalog/index.ts";
import { signToken } from "../../../identity/index.ts";
import { createDomainContest, getContestProblems } from "../../index.ts";
import { domainContestRouter } from "../../routes/domain-contests.ts";
import { jsonRequest } from "../../../../../tests/helper.ts";

Deno.test({
  name: "域比赛内容 HTTP：固定版本模板和客观卷面，源共享撤销拒绝读取",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await resetDbForTest();
    const db = getDb(),
      owner = crypto.randomUUID(),
      now = new Date().toISOString();
    await db.insert(users).values({
      id: owner,
      username: owner,
      email: `${owner}@example.com`,
      created_at: now,
      updated_at: now,
    });
    const source = await createDomain(
      { slug: "contest-content-source", name: "source", preset: "community" },
      owner,
      { approved: true },
    );
    const target = await createDomain(
      { slug: "contest-content-target", name: "target", preset: "team" },
      owner,
      { approved: true },
    );
    const ids: string[] = [], versions: string[] = [];
    for (const [index, kind] of (["ai", "objective"] as const).entries()) {
      const id = crypto.randomUUID(),
        v1 = crypto.randomUUID(),
        v2 = crypto.randomUUID();
      ids.push(id);
      versions.push(v1);
      await db.insert(problems).values({
        id,
        domain_id: source.id,
        number: 1001 + index,
        title: kind,
        description: "statement",
        visibility: "public",
        owner_id: owner,
        is_objective: kind === "objective",
        created_at: now,
        updated_at: now,
      });
      for (const [versionId, version] of [[v1, 1], [v2, 2]] as const) {
        const content = kind === "ai"
          ? {
            kind,
            title: kind,
            description: "statement",
            samples: [],
            submission_mode: "code",
            template_content: `# template-v${version}`,
            runtime_config: null,
            artifact_max_size_mb: null,
            llm_config: null,
          }
          : {
            kind,
            title: kind,
            description: "statement",
            samples: [],
            questions: [{
              key: "q",
              sort_order: 0,
              type: "single",
              prompt: `question-v${version}`,
              options: [{ key: "A", text: "a" }],
              answer: ["A"],
              explanation: "secret explanation",
            }],
          };
        await db.insert(problemVersions).values({
          id: versionId,
          problem_id: id,
          version,
          content,
          published_at: now,
        });
      }
      await db.update(problems).set({ latest_version_id: v2 }).where(
        eq(problems.id, id),
      );
      await db.insert(domainProblemBindings).values({
        id: crypto.randomUUID(),
        domain_id: source.id,
        problem_id: id,
        kind: "owned",
        visibility: "public",
        effective_version_mode: "exact",
        required_version_id: v1,
        created_by: owner,
        created_at: now,
        updated_at: now,
      });
      await db.insert(problemShareSettings).values({
        problem_id: id,
        enabled: true,
        scope: "all",
        updated_by: owner,
        updated_at: now,
      });
      await importDomainProblem(
        target.slug,
        `${source.slug}:${1001 + index}`,
        owner,
      );
    }
    const contest = await createDomainContest(target.slug, owner, {
      title: "content contest",
      type: "kaggle",
      start_time: new Date(Date.now() + 60000).toISOString(),
      end_time: new Date(Date.now() + 7200000).toISOString(),
      freeze_duration_seconds: 0,
      problems: ids.map((problem_id, index) => ({
        problem_id,
        label: String(index + 1),
        sort_order: index,
        score: 10000,
      })),
    });
    const application = new Hono();
    application.route("/api/v1", domainContestRouter);
    application.onError((error, c) => {
      if (error instanceof AppError) {
        return c.json({ error: error.message }, error.statusCode as 400);
      }
      throw error;
    });
    const token = await signToken({ sub: owner, role: "user" }),
      path = `/api/v1/domains/${target.slug}/contests/${contest.id}/problems`;
    const template = await jsonRequest(
      application,
      `${path}/1/template?version_id=${versions[1]}`,
      { token },
    );
    assertEquals(template.status, 200);
    assertEquals((await template.json()).data.content, "# template-v1");
    const paper = await jsonRequest(
      application,
      `${path}/2/objective-questions?version_id=${versions[0]}`,
      { token },
    );
    assertEquals(paper.status, 200);
    const body = await paper.json();
    assertEquals(body.version_id, versions[1]);
    assertEquals(body.data[0].prompt, "question-v1");
    assertEquals(body.data[0].answer, undefined);
    assertEquals(body.data[0].explanation, undefined);
    assertEquals(
      (await jsonRequest(application, `${path}/2/template`, { token })).status,
      404,
    );
    await db.update(problemShareSettings).set({ enabled: false }).where(
      and(eq(problemShareSettings.problem_id, ids[0])),
    );
    await assertRejects(() => getContestProblems(contest.id, owner));
    assertEquals(
      (await jsonRequest(application, `${path}/1/template`, { token })).status,
      404,
    );
    assertEquals(
      (await jsonRequest(
        application,
        `/api/v1/domains/${source.slug}/contests/${contest.id}/problems/2/objective-questions`,
        { token },
      )).status,
      404,
    );
  },
});
