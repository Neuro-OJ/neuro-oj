import { assertEquals } from "jsr:@std/assert@^1";
import { userActorFromAuthenticatedId } from "../../../access/contracts/actor.ts";
import { eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import { createApp } from "../../../../app.ts";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contestProblems,
  contests,
  domainMemberships,
  domainProblemBindings,
  problems,
  problemVersions,
} from "../../../../shared/db/schema.ts";
import { initRedisForTest, jsonRequest } from "../../../../../tests/helper.ts";
import {
  createDomain,
  DEFAULT_DOMAIN_ID,
} from "../../../access/workspace/index.ts";
import { updateSetting } from "../../../platform/system/index.ts";
import {
  createDefaultCatalogToken,
  resetDbForTest,
} from "../default-fixture.ts";
import type { ObjectiveProblemContent } from "../../types/problem-content.ts";
import { insertDomainProblemCopy } from "../../../../shared/testing/domain-problem-copy.ts";

Deno.test({
  name: "比赛维护权限: 源题编辑角色不受报名身份影响，普通比赛作答仍裁剪答案",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await resetDbForTest();
    await initRedisForTest();
    const token = await createDefaultCatalogToken("educator");
    const organizerToken = await createDefaultCatalogToken("educator");
    const actor = decodeJwt(token).sub!,
      organizer = decodeJwt(organizerToken).sub!;
    const db = getDb(), now = new Date().toISOString();
    const problemId = crypto.randomUUID(), versionId = crypto.randomUUID();
    const bindingId = crypto.randomUUID(), contestId = crypto.randomUUID();
    const content: ObjectiveProblemContent = {
      kind: "objective",
      title: "赛卷",
      description: "题面",
      samples: [],
      questions: [{
        key: "truth",
        sort_order: 0,
        type: "judge",
        prompt: "正确？",
        options: [{ key: "true", text: "正确" }, {
          key: "false",
          text: "错误",
        }],
        answer: [true],
        explanation: "秘密解析",
      }],
    };
    await db.insert(problems).values({
      id: problemId,
      domain_id: DEFAULT_DOMAIN_ID,
      number: 1001,
      title: content.title,
      description: content.description,
      owner_id: actor,
      is_objective: true,
      visibility: "public",
      created_at: now,
      updated_at: now,
    });
    await db.insert(problemVersions).values({
      id: versionId,
      problem_id: problemId,
      version: 1,
      content,
      published_at: now,
    });
    await db.update(problems).set({ latest_version_id: versionId }).where(
      eq(problems.id, problemId),
    );
    await db.insert(domainProblemBindings).values({
      id: bindingId,
      domain_id: DEFAULT_DOMAIN_ID,
      problem_id: problemId,
      visibility: "public",
      created_by: actor,
      created_at: now,
      updated_at: now,
    });
    const app = createApp(), path = "/api/v1/domains/main/problems/1001";
    const read = async (url: string, credential = token) => {
      const response = await jsonRequest(app, url, { token: credential });
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json();
    };
    assertEquals((await read(path)).content.questions[0].answer, [true]);
    await db.insert(contests).values({
      id: contestId,
      domain_id: DEFAULT_DOMAIN_ID,
      title: "进行中赛卷",
      type: "oi",
      kind: "public",
      created_by: organizer,
      start_time: new Date(Date.now() - 60000).toISOString(),
      end_time: new Date(Date.now() + 60000).toISOString(),
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values({
      contest_id: contestId,
      problem_id: problemId,
      domain_id: DEFAULT_DOMAIN_ID,
      domain_problem_binding_id: bindingId,
      label: "A",
      score: 10000,
      pinned_version_id: versionId,
    });
    await db.insert(contestParticipants).values([{
      contest_id: contestId,
      user_id: actor,
      registered_at: now,
    }, { contest_id: contestId, user_id: organizer, registered_at: now }]);
    const student = await read(path);
    assertEquals(student.can_edit, true);
    assertEquals(student.content.questions[0].answer, [true]);
    assertEquals(student.content.questions[0].explanation, "秘密解析");
    for (
      const url of [
        `/api/v1/problems/1001`,
        `/api/v1/problems/1001?version_id=${versionId}`,
      ]
    ) {
      const data = (await read(url)).data;
      assertEquals(data.questions[0].answer, [true]);
      assertEquals(data.questions[0].explanation, "秘密解析");
    }
    const version =
      (await read(`/api/v1/problems/1001/versions/${versionId}`)).data;
    assertEquals(version.content.questions[0].answer, [true]);
    for (const url of [`${path}/draft`, "/api/v1/problems/1001/draft"]) {
      const response = await jsonRequest(app, url, { token });
      assertEquals(response.status, 200);
    }
    // 本人创建且当前具有 manage_own 的比赛才属于真实组织权限。
    await db.update(contests).set({ created_by: actor }).where(
      eq(contests.id, contestId),
    );
    assertEquals((await read(path)).can_edit, true);
    assertEquals((await read(path)).content.questions[0].answer, [true]);
    assertEquals(
      (await jsonRequest(app, `${path}/draft`, { token })).status,
      200,
    );
    await db.update(contests).set({ created_by: organizer }).where(
      eq(contests.id, contestId),
    );
    assertEquals((await read(path)).can_edit, true);
    // 组织者的比赛管理能力不等于源题编辑权限；显式提升 editor 后可管理。
    const [membership] = await db.select().from(domainMemberships).where(
      eq(domainMemberships.user_id, organizer),
    );
    await db.update(domainMemberships).set({ role: "admin" }).where(
      eq(domainMemberships.id, membership.id),
    );
    assertEquals(
      (await read(path, organizerToken)).content.questions[0].answer,
      [true],
    );
    assertEquals(
      (await jsonRequest(app, `${path}/draft`, { token: organizerToken }))
        .status,
      200,
    );
    await db.update(contests).set({
      end_time: new Date(Date.now() - 30000).toISOString(),
    }).where(eq(contests.id, contestId));
    assertEquals((await read(path)).can_edit, true);
    assertEquals((await read(path)).content.questions[0].answer, [true]);
    assertEquals(
      (await jsonRequest(app, `${path}/draft`, { token })).status,
      200,
    );
    // 同一公共源题被学校用于内部比赛，学校参赛身份不能限制源域编辑入口。
    await updateSetting(
      "domain_creation_policy",
      "open",
      userActorFromAuthenticatedId("0"),
    );
    const school = await createDomain({
      slug: "contest-target",
      name: "学校比赛",
      preset: "education",
    }, organizer);
    const schoolContest = crypto.randomUUID();
    await db.insert(domainMemberships).values({
      id: crypto.randomUUID(),
      domain_id: school.id,
      user_id: actor,
      joined_at: now,
    });
    // 学校只能在自己的副本上办内部赛：跨域共享绑定已被同域外键禁止。
    const schoolCopy = await insertDomainProblemCopy(db, {
      sourceProblemId: problemId,
      domainId: school.id,
      number: 1001,
      ownerId: organizer,
      now,
    });
    const schoolBinding = schoolCopy.bindingId;
    await db.insert(contests).values({
      id: schoolContest,
      domain_id: school.id,
      title: "学校内部赛",
      type: "oi",
      kind: "invite",
      created_by: organizer,
      start_time: new Date(Date.now() - 60000).toISOString(),
      end_time: new Date(Date.now() + 60000).toISOString(),
      created_at: now,
      updated_at: now,
    });
    await db.insert(contestProblems).values({
      contest_id: schoolContest,
      problem_id: schoolCopy.problemId,
      domain_id: school.id,
      domain_problem_binding_id: schoolBinding,
      label: "A",
      score: 10000,
      pinned_version_id: schoolCopy.versionId,
    });
    await db.insert(contestParticipants).values({
      contest_id: schoolContest,
      user_id: actor,
      registered_at: now,
    });
    assertEquals((await read(path)).can_edit, true);
    assertEquals((await read(path)).content.questions[0].answer, [true]);
    assertEquals(
      (await jsonRequest(app, `${path}/draft`, { token })).status,
      200,
    );
  },
});
