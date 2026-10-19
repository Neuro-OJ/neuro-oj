import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import {
  contests,
  domains,
  problemShareSettings,
  submissions,
} from "../../../../shared/db/schema.ts";
import {
  ForbiddenError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import {
  removeDomainMember,
  transferDomain,
} from "../../../workspace/index.ts";
import { createDomainContest } from "../../../contest/index.ts";
import { updateSetting } from "../../../system/index.ts";
import {
  countPostsByType,
  createComment,
  createPost,
  createReport,
  createSanction,
  getPost,
  hasAcceptedSolution,
  listBookmarks,
  listComments,
  listFeed,
  listNotifications,
  listPosts,
  listReports,
  listSanctions,
  toggleBookmark,
  toggleCommentLike,
  toggleFollow,
  updatePost,
  withDomainCommunity,
} from "../../index.ts";
import { domainFixture, sharedItem } from "./domain-fixture.ts";

Deno.test({
  name: "域社区：板块slug可复用、列表计数动态域过滤、旧入口与移除成员隔离",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await domainFixture("community-scope");
    assertEquals(f.boardA.slug, f.boardB.slug);
    await assertRejects(() => getPost(f.postB.id, f.b, true), NotFoundError);
    await assertRejects(() =>
      withDomainCommunity(
        f.source.slug,
        f.a,
        {},
        (s) => getPost(f.postB.id, f.a, true, s),
      ), NotFoundError);
    const rows = await withDomainCommunity(
      f.target.slug,
      f.student,
      {},
      (s) => listPosts({ viewerId: f.student, scope: s }),
    );
    assertEquals(
      rows.data.map((r) => r.post.id),
      [f.postB.id],
    );
    assertEquals(
      (await withDomainCommunity(
        f.target.slug,
        f.student,
        {},
        (s) => countPostsByType(s),
      )).discussion,
      1,
    );
    await toggleFollow(f.student, f.a);
    await withDomainCommunity(
      f.source.slug,
      f.a,
      { write: true, permission: "community:create" },
      (s) =>
        createPost(f.a, { type: "moment", content: "public moment" }, true, s),
    );
    const moment = await withDomainCommunity(f.target.slug, f.student, {
      write: true,
      permission: "community:create",
    }, (s) =>
      createPost(
        f.student,
        { type: "moment", content: "private student moment" },
        false,
        s,
      ));
    assertEquals(
      (await withDomainCommunity(
        f.target.slug,
        f.student,
        {},
        (s) => listFeed("latest", f.student, undefined, 20, s),
      )).data.map((r) => r.post.id),
      [moment.id],
    );
    assertEquals(
      (await withDomainCommunity(
        f.target.slug,
        f.student,
        {},
        (s) => listFeed("following", f.student, undefined, 20, s),
      )).data.length,
      0,
    );
    await removeDomainMember(f.target.slug, f.b, f.student);
    await assertRejects(
      () =>
        withDomainCommunity(
          f.target.slug,
          f.student,
          {},
          (s) => getPost(moment.id, f.student, false, s),
        ),
      NotFoundError,
    );
    assertEquals(
      (await listPosts({ viewerId: f.student, moderator: true })).data.length,
      0,
    );
  },
});

Deno.test({
  name:
    "域社区：引用题撤销过滤题解、评论、收藏、通知与举报，跨域通过不满足门槛",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await domainFixture("community-share"), p = await sharedItem(f);
    await f.db.insert(submissions).values({
      id: crypto.randomUUID(),
      problem_id: p.id,
      user_id: f.student,
      domain_id: f.source.id,
      domain_problem_binding_id: p.binding,
      submitted_version_id: p.version,
      version_origin: "known",
      language: "cpp20",
      code: "source code",
      status: "finished",
      is_accepted: true,
      created_at: f.now,
    });
    assertEquals(
      await withDomainCommunity(
        f.target.slug,
        f.student,
        {},
        (s) => hasAcceptedSolution(f.student, p.id, s),
      ),
      false,
    );
    const solution = await withDomainCommunity(f.target.slug, f.b, {
      write: true,
      permission: "community:create",
    }, (s) =>
      createPost(
        f.b,
        {
          type: "solution",
          problem_id: p.id,
          title: "solution",
          content: "private solution",
        },
        true,
        s,
      ));
    const comment = await withDomainCommunity(f.target.slug, f.student, {
      write: true,
      permission: "community:comment",
    }, (s) =>
      createComment(
        f.student,
        solution.id,
        "student help",
        undefined,
        false,
        s,
      ));
    await withDomainCommunity(f.target.slug, f.student, {
      write: true,
      permission: "community:read",
    }, (s) => toggleBookmark(f.student, solution.id, s));
    await withDomainCommunity(
      f.target.slug,
      f.b,
      { write: true, permission: "community:comment" },
      (s) =>
        createComment(f.b, solution.id, "teacher reply", comment.id, true, s),
    );
    assertEquals(
      (await withDomainCommunity(
        f.target.slug,
        f.student,
        {},
        (s) => listNotifications(f.student, 30, s),
      )).length,
      1,
    );
    await f.db.update(problemShareSettings).set({ enabled: false }).where(
      eq(problemShareSettings.problem_id, p.id),
    );
    await assertRejects(
      () =>
        withDomainCommunity(
          f.target.slug,
          f.student,
          {},
          (s) => getPost(solution.id, f.student, false, s),
        ),
      NotFoundError,
    );
    await assertRejects(
      () =>
        withDomainCommunity(
          f.target.slug,
          f.student,
          {},
          (s) => listComments(solution.id, f.student, false, s),
        ),
      NotFoundError,
    );
    await assertRejects(
      () =>
        withDomainCommunity(f.target.slug, f.student, {
          write: true,
          permission: "community:read",
        }, (s) => toggleCommentLike(f.student, comment.id, s)),
      NotFoundError,
    );
    await assertRejects(
      () =>
        withDomainCommunity(f.target.slug, f.student, {
          write: true,
          permission: "community:read",
        }, (s) =>
          createReport(
            f.student,
            { post_id: solution.id, category: "其他", reason: "report" },
            false,
            s,
          )),
      NotFoundError,
    );
    assertEquals(
      (await withDomainCommunity(
        f.target.slug,
        f.student,
        {},
        (s) => listBookmarks(f.student, undefined, 20, s),
      )).data.length,
      0,
    );
    assertEquals(
      (await withDomainCommunity(
        f.target.slug,
        f.student,
        {},
        (s) => listNotifications(f.student, 30, s),
      )).length,
      0,
    );
    assertEquals(
      (await withDomainCommunity(
        f.target.slug,
        f.student,
        {},
        (s) => countPostsByType(s),
      )).solution,
      0,
    );
    assertEquals(
      (await withDomainCommunity(
        f.target.slug,
        f.student,
        {},
        (s) =>
          listPosts({
            scope: s,
            viewerId: f.student,
            type: "solution",
            limit: 1,
          }),
      )).data.length,
      0,
    );
  },
});

Deno.test({
  name: "域社区：比赛静默只约束使用域，不扩大到公开源域",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await domainFixture("community-contest"), p = await sharedItem(f);
    const contest = await createDomainContest(f.target.slug, f.b, {
      title: "school contest",
      type: "ioi",
      start_time: new Date(Date.now() - 60000).toISOString(),
      end_time: new Date(Date.now() + 7200000).toISOString(),
      problems: [{ problem_id: p.id, label: "A", sort_order: 0, score: 10000 }],
    });
    await f.db.insert(submissions).values({
      id: crypto.randomUUID(),
      problem_id: p.id,
      user_id: f.student,
      domain_id: f.target.id,
      domain_problem_binding_id: p.targetBinding,
      contest_id: contest.id,
      submitted_version_id: p.version,
      version_origin: "known",
      language: "cpp20",
      code: "contest code",
      status: "finished",
      is_accepted: true,
      created_at: f.now,
    });
    assertEquals(
      await withDomainCommunity(
        f.target.slug,
        f.student,
        {},
        (s) => hasAcceptedSolution(f.student, p.id, s),
      ),
      false,
    );
    await assertRejects(() =>
      withDomainCommunity(f.target.slug, f.student, {
        write: true,
        permission: "community:comment",
      }, (s) =>
        createComment(
          f.student,
          f.postB.id,
          "not allowed",
          undefined,
          false,
          s,
        )), ForbiddenError);
    const publicPost = await withDomainCommunity(
      f.source.slug,
      f.a,
      { write: true, permission: "community:create" },
      (s) =>
        createPost(
          f.a,
          { type: "moment", content: "source remains usable" },
          false,
          s,
        ),
    );
    assertEquals(publicPost.domain_id, f.source.id);
    const solution = await withDomainCommunity(
      f.source.slug,
      f.a,
      { write: true, permission: "community:create" },
      (s) =>
        createPost(
          f.a,
          {
            type: "solution",
            problem_id: p.id,
            title: "source solution",
            content: "public source solution",
          },
          true,
          s,
        ),
    );
    assertEquals(
      (await withDomainCommunity(
        f.source.slug,
        null,
        {},
        (s) => getPost(solution.id, undefined, false, s),
      )).post.id,
      solution.id,
    );
    await f.db.update(contests).set({
      end_time: new Date(Date.now() - 10000).toISOString(),
    }).where(eq(contests.id, contest.id));
    assertEquals(
      await withDomainCommunity(
        f.target.slug,
        f.student,
        {},
        (s) => hasAcceptedSolution(f.student, p.id, s),
      ),
      true,
    );
  },
});

Deno.test({
  name: "域社区：治理角色撤销、禁言与举报均限定目标域，模块停用实时阻止读取",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await domainFixture("community-moderation");
    await transferDomain(f.target.slug, f.b, f.student);
    const sanction = await withDomainCommunity(f.target.slug, f.student, {
      write: true,
      permission: "community:moderate",
    }, (s) => createSanction(f.student, f.b, "target only", undefined, s));
    assertEquals(sanction.domain_id, f.target.id);
    assertEquals(
      (await withDomainCommunity(f.source.slug, f.a, {
        permission: "community:moderate",
      }, (s) => listSanctions(s))).length,
      0,
    );
    const report = await withDomainCommunity(f.target.slug, f.student, {
      write: true,
      permission: "community:read",
    }, (s) =>
      createReport(
        f.student,
        { post_id: f.postB.id, category: "其他", reason: "target report" },
        true,
        s,
      ));
    assertEquals(report.domain_id, f.target.id);
    assertEquals(
      (await withDomainCommunity(f.source.slug, f.a, {
        permission: "community:moderate",
      }, (s) => listReports("all", s))).length,
      0,
    );
    await transferDomain(f.target.slug, f.student, f.b);
    await assertRejects(
      () =>
        withDomainCommunity(f.target.slug, f.student, {
          write: true,
          permission: "community:moderate",
        }, (s) =>
          updatePost(f.postB.id, f.student, true, { content: "wrong" }, s)),
      ForbiddenError,
    );
    await f.db.update(domains).set({
      configuration: {
        ...f.target.configuration,
        access: "members",
      },
    }).where(eq(domains.id, f.target.id));
    await updateSetting(
      "instance_allowed_modules",
      JSON.stringify({
        community: false,
        classroom: true,
        assignment: true,
        analytics: true,
      }),
      "0",
    );
    await assertRejects(
      () =>
        withDomainCommunity(
          f.target.slug,
          f.student,
          {},
          (s) => listPosts({ scope: s }),
        ),
      ForbiddenError,
    );
  },
});
