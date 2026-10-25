/// <reference lib="dom" />
/** Public/Mixed 实际用户旅程：页面写操作与当前域请求一起验收。 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.13";
import { expect } from "npm:playwright@1.62.1/test";
import { collectPendingConsents } from "../../../noj-ui/utils/legalConsent.ts";
import { api, getAdminToken, registerUser, TEST_PASSWORD } from "../helper.ts";
import {
  BROWSER_E2E,
  gotoPage as navigatePage,
  launchBrowser,
  teardownBrowser,
  UI_URL,
} from "./browser.ts";

type Page = import("npm:playwright@1.62.1").Page;
interface Account {
  id: string;
  username: string;
  email: string;
  token: string;
}
interface Setting {
  key: string;
  effective_value: unknown;
  updated_at: string | null;
}

async function fixture<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await api(method, `/api/v1${path}`, {
    token,
    body,
    headers,
  });
  assertEquals(
    response.status >= 200 && response.status < 300,
    true,
    `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`,
  );
  return response.body as T;
}
async function account(name: string, suffix: string): Promise<Account> {
  const username = `${name}_${suffix}`, email = `${username}@test.com`;
  const token = await registerUser(username, email, TEST_PASSWORD);
  const identity = await fixture<{ data: { id: string } }>(
    "GET",
    "/auth/me",
    token,
  );
  return { id: identity.data.id, username, email, token };
}
async function invite(path: string, owner: string, member: Account) {
  const invitation = await fixture<{ data: { token: string } }>(
    "POST",
    `${path}/invitations`,
    owner,
    { email: member.email },
  );
  await fixture("POST", "/domain-invitations/accept", member.token, {
    token: invitation.data.token,
  });
}
async function gotoPage(page: Page, path: string) {
  await navigatePage(page, path);
  await page.waitForFunction(() =>
    Boolean(
      (document.querySelector("#__nuxt") as Element & { __vue_app__?: unknown })
        ?.__vue_app__,
    )
  );
}
async function login(page: Page, user: Account) {
  await gotoPage(page, "/login");
  await page.getByPlaceholder("请输入用户名或邮箱").fill(user.username);
  await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
    TEST_PASSWORD,
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await gotoPage(page, "/workspaces");
  const identity = await page.request.get(`${UI_URL}/api/v1/auth/me`);
  assertEquals(identity.status(), 200);
  const actor = await identity.json();
  assertEquals(actor.data.id, user.id);
  assertEquals(actor.data.is_admin, false);
  if (collectPendingConsents(actor.data.legal).length) {
    await page.getByRole("button", { name: "我已知悉并同意", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "政策更新通知" }))
      .toBeHidden();
  }
}
async function write(
  page: Page,
  method: string,
  path: string,
  action: () => Promise<unknown>,
) {
  const [response] = await Promise.all([
    page.waitForResponse((result) =>
      decodeURIComponent(new URL(result.url()).pathname) === `/api/v1${path}` &&
      result.request().method() === method
    ),
    action(),
  ]);
  const body = await response.json();
  assertEquals(
    response.ok(),
    true,
    `${method} ${path}: ${JSON.stringify(body)}`,
  );
  return body;
}
async function handIn(
  page: Page,
  path: string,
  choice: string,
  button = "交卷",
) {
  await page.getByRole("checkbox", { name: choice, exact: true }).check();
  await page.getByRole("button", { name: button, exact: true }).click();
  return await write(
    page,
    "POST",
    path,
    () => page.getByRole("button", { name: "确认", exact: true }).click(),
  );
}
async function post(page: Page, slug: string, title: string, board: string) {
  await gotoPage(page, `/d/${slug}/community`);
  await page.getByRole("button", { name: "发布内容", exact: true }).click();
  await page.getByPlaceholder("讨论标题", { exact: true }).fill(title);
  await page.getByPlaceholder(/支持 Markdown/).fill(`${title} 的独立正文。`);
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: board, exact: true }).click();
  const published = await write(
    page,
    "POST",
    `/domains/${slug}/community/posts`,
    () => page.getByRole("button", { name: "发布", exact: true }).click(),
  );
  assertEquals(published.data.status, "published");
  await page.getByRole("link").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  }).click();
  await expect(page.getByRole("heading", { name: title, exact: true }))
    .toBeVisible();
  return published.data.id as string;
}
async function objectiveFixture(admin: string, title: string) {
  const created = await fixture<
    { problem_id: string; number: number; draft_revision: number }
  >("POST", "/domains/main/problems", admin, {
    title,
    description: "选择正确选项；用于题单、比赛和学校引用。",
    is_objective: true,
  });
  const root = `/domains/main/problems/${created.number}`;
  const draft = await fixture<{ revision: number }>(
    "PUT",
    `${root}/draft`,
    admin,
    {
      content: {
        kind: "objective",
        title,
        description: "选择正确选项。",
        samples: [],
        questions: [{
          key: "one",
          sort_order: 0,
          type: "single",
          prompt: "请选择正确答案。",
          options: [{ key: "A", text: "正确选项" }, {
            key: "B",
            text: "待改进选项",
          }],
          answer: ["A"],
          explanation: "选择 A。",
        }],
      },
    },
    { "If-Match": String(created.draft_revision) },
  );
  await fixture("POST", `${root}/publish`, admin, {
    change_note: "完整 Web 旅程 V1",
  }, { "If-Match": String(draft.revision) });
  return created;
}

Deno.test({
  name: "[ui/public-mixed] 默认题单社区比赛、两学校同源题及私有角色内容隔离",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const suffix = `${Date.now().toString(36)}${
      crypto.randomUUID().slice(0, 4)
    }`;
    const schoolA = `mixed-a-${suffix}`, schoolB = `mixed-b-${suffix}`;
    const names = {
      main: `公共讨论 ${suffix}`,
      a: `学校A秘密 ${suffix}`,
      b: `学校B秘密 ${suffix}`,
    };
    const boardNames: Record<string, string> = {
      main: `公共板块 ${suffix}`,
      [schoolA]: `学校A板块 ${suffix}`,
      [schoolB]: `学校B板块 ${suffix}`,
    };
    const admin = await getAdminToken();
    const instance = await fixture<{ data: { access: string } }>(
      "GET",
      "/instance",
      admin,
    );
    assertEquals(
      instance.data.access,
      "public",
      "Public验收实例应允许公开访问",
    );
    const main = await fixture<
      {
        data: {
          status: string;
          configuration: { access: string; features: { community: boolean } };
        };
      }
    >(
      "GET",
      "/domains/main",
      admin,
    );
    assertEquals(main.data.status, "active");
    assertEquals(main.data.configuration.access, "public");
    assertEquals(main.data.configuration.features.community, true);
    const actor = await account("mixed_actor", suffix),
      peer = await account("mixed_peer", suffix),
      host = await account("mixed_host", suffix);
    for (const member of [actor, peer, host]) {
      await invite("/domains/main", admin, member);
    }
    await fixture("PUT", `/domains/main/members/${host.id}/roles`, admin, {
      roles: ["admin"],
    });
    for (const slug of [schoolA, schoolB]) {
      await fixture("POST", "/domains", admin, {
        slug,
        name: slug === schoolA ? `学校A ${suffix}` : `学校B ${suffix}`,
        preset: "education",
      });
      const domain = await fixture<
        {
          data: {
            revision: number;
            configuration: { features: Record<string, boolean> };
          };
        }
      >("GET", `/domains/${slug}`, admin);
      await fixture("PATCH", `/domains/${slug}`, admin, {
        configuration: {
          ...domain.data.configuration,
          features: { ...domain.data.configuration.features, community: true },
        },
      }, { "If-Match": String(domain.data.revision) });
    }
    await invite(`/domains/${schoolA}`, admin, host);
    await fixture("POST", `/domains/${schoolA}/transfer`, admin, {
      user_id: host.id,
    });
    await invite(`/domains/${schoolB}`, admin, actor);
    await fixture("POST", `/domains/${schoolB}/transfer`, admin, {
      user_id: actor.id,
    });
    const roomA = await fixture<{ data: { id: string } }>(
      "POST",
      `/domains/${schoolA}/classrooms`,
      host.token,
      { name: `A学生班 ${suffix}` },
    );
    const roomB = await fixture<{ data: { id: string } }>(
      "POST",
      `/domains/${schoolB}/classrooms`,
      actor.token,
      { name: `B教练班 ${suffix}` },
    );
    await invite(
      `/domains/${schoolA}/classrooms/${roomA.data.id}`,
      host.token,
      actor,
    );
    await invite(
      `/domains/${schoolB}/classrooms/${roomB.data.id}`,
      actor.token,
      peer,
    );
    const problem = await objectiveFixture(admin, `共同源题 ${suffix}`),
      reference = `main:${problem.number}`;
    const shareRoot = `/domains/main/problems/${problem.number}/sharing`;
    const sharing = await fixture<{ data: { revision: number } }>(
      "GET",
      shareRoot,
      admin,
    );
    await fixture("POST", shareRoot, admin, {
      enabled: true,
      scope: "selected",
      target_domain_slugs: [schoolA, schoolB],
    }, { "If-Match": String(sharing.data.revision) });
    for (const [slug, owner] of [[schoolA, host], [schoolB, actor]] as const) {
      await fixture("POST", `/domains/${slug}/problem-bindings`, owner.token, {
        source_ref: reference,
      });
      const provider = await fixture<{ data: { id: string } }>(
        "POST",
        `/domains/${slug}/llm/providers`,
        owner.token,
        {
          name: `独立Provider ${slug}`,
          base_url: Deno.env.get("E2E_LLM_MOCK_URL") ||
            "http://noj-e2e-llm-mock:8002/v1",
          api_key: "browser-mock-key",
          cost_per_1k_tokens: 0,
          enabled: true,
        },
        { "If-Match": "0" },
      );
      const settings = await fixture<{ data: { revision: number } }>(
        "GET",
        `/domains/${slug}/llm/settings`,
        owner.token,
      );
      await fixture("PUT", `/domains/${slug}/llm/settings`, owner.token, {
        provider_id: provider.data.id,
        model: `model-${slug}`,
      }, { "If-Match": String(settings.data.revision) });
    }
    const trainingTitle = `公共题单 ${suffix}`;
    const training = await fixture<{ data: { id: string } }>(
      "POST",
      "/domains/main/trainings",
      admin,
      {
        title: trainingTitle,
        description: "公开题单实际练习入口。",
        visibility: "public",
        problems: [String(problem.number)],
      },
    );
    for (const slug of ["main", schoolA, schoolB]) {
      await fixture("POST", `/domains/${slug}/community/manage/boards`, admin, {
        slug: `web-${suffix}`,
        name: boardNames[slug],
      });
    }
    const originalSettings = (await fixture<{ data: Setting[] }>(
      "GET",
      "/admin/system/settings",
      admin,
    )).data;
    const communityPolicy: Record<string, unknown> = {
      community_enabled: true,
      community_discussions_enabled: true,
      community_comments_enabled: true,
      community_reactions_enabled: true,
      community_read_only: false,
      community_new_user_review_hours: 0,
    };
    async function setPolicy(key: string, value: unknown) {
      const current = (await fixture<{ data: Setting[] }>(
        "GET",
        "/admin/system/settings",
        admin,
      )).data.find((setting) => setting.key === key)!;
      await fixture(
        "PUT",
        `/admin/system/settings/${key}`,
        admin,
        { value },
        current.updated_at
          ? { "If-Match": `"${current.updated_at}"` }
          : undefined,
      );
    }
    const learner = await launchBrowser(),
      friend = await launchBrowser(),
      organizer = await launchBrowser();
    let failed = true, privateA = "", privateB = "", contestId = "";
    async function step(name: string, action: () => Promise<void>) {
      assertEquals(await t.step(name, action), true, name);
    }
    try {
      for (const [key, value] of Object.entries(communityPolicy)) {
        await setPolicy(key, value);
      }
      await login(learner.page, actor);
      await login(friend.page, peer);
      await login(organizer.page, host);
      await step("Public普通成员从默认题单入口实际练习", async () => {
        await gotoPage(learner.page, "/trainings");
        await learner.page.waitForURL((url) =>
          url.pathname === "/d/main/trainings"
        );
        await learner.page.getByPlaceholder("搜索题单名称").fill(trainingTitle);
        await learner.page.getByRole("button", { name: "搜索", exact: true })
          .click();
        // 当前 Domain 题单列表由整张 NuxtLink 卡片承载，不再渲染旧的
        // “查看题单”子链接；以卡片内标题定位仍保持题单唯一性。
        await learner.page.getByRole("link").filter({
          has: learner.page.getByRole("heading", {
            name: trainingTitle,
            exact: true,
          }),
        }).click();
        await learner.page.waitForURL((url) =>
          url.pathname === `/d/main/trainings/${training.data.id}`
        );
        // 题单条目当前直接使用“继续作答/再次练习”进入题目页；旧的
        // “在当前域作答”按钮已随 Domain 题单重构移除。
        await learner.page.getByRole("link", { name: /(?:继续|再次)作答/ })
          .click();
        await learner.page.waitForURL((url) =>
          url.pathname === `/d/main/problems/${problem.number}`
        );
        const result = await handIn(
          learner.page,
          `/domains/main/problems/${problem.number}/objective-submissions`,
          "正确选项",
        );
        assertEquals(result.data.score, 100);
        await expect(
          learner.page.getByText("本次成绩：100 分", { exact: true }),
        ).toBeVisible();
      });
      await step("Public普通成员发布讨论、另一成员评论和点赞", async () => {
        const id = await post(
          learner.page,
          "main",
          names.main,
          boardNames.main,
        );
        await gotoPage(friend.page, `/d/main/community/posts/${id}`);
        await friend.page.getByPlaceholder(/写下你的想法/).fill(
          `公共回复 ${suffix}`,
        );
        await write(
          friend.page,
          "POST",
          `/domains/main/community/posts/${id}/comments`,
          () =>
            friend.page.getByRole("button", { name: "发送", exact: true })
              .click(),
        );
        await expect(
          friend.page.getByText(`公共回复 ${suffix}`, { exact: true }),
        ).toBeVisible();
        await write(
          friend.page,
          "POST",
          `/domains/main/community/posts/${id}/like`,
          () =>
            friend.page.getByRole("button", { name: "点赞", exact: true })
              .click(),
        );
        await expect(
          friend.page.getByRole("button", { name: "点赞", exact: true }),
        ).toContainText("1");
      });
      await step(
        "Public两成员Web报名、各一次客观题交卷，赛时本人榜",
        async () => {
          const now = Date.now();
          const contest = await fixture<{ data: { id: string } }>(
            "POST",
            "/domains/main/contests",
            host.token,
            {
              title: `Web短比赛 ${suffix}`,
              type: "kaggle",
              start_time: new Date(now - 1000).toISOString(),
              end_time: new Date(now + 45000).toISOString(),
              kind: "public",
              is_public: true,
              affect_global_ranking: false,
              ranking_visibility: "participants",
              config: { scoreboard_scope: "self" },
              problems: [{
                problem_id: problem.problem_id,
                sort_order: 0,
                label: "A",
                score: 10000,
              }],
            },
          );
          contestId = contest.data.id;
          for (
            const [session, choice, score] of [[learner, "正确选项", 100], [
              friend,
              "待改进选项",
              0,
            ]] as const
          ) {
            await gotoPage(session.page, `/d/main/contests/${contestId}`);
            await write(
              session.page,
              "POST",
              `/domains/main/contests/${contestId}/register`,
              () =>
                session.page.getByRole("button", {
                  name: "报名参赛",
                  exact: true,
                }).click(),
            );
            await session.page.getByRole("link", {
              name: `A · 共同源题 ${suffix}`,
              exact: true,
            }).click();
            const result = await handIn(
              session.page,
              `/domains/main/contests/${contestId}/problems/A/objective-submissions`,
              choice,
              "一次正式交卷",
            );
            assertEquals(result.data.score, score);
            await expect(
              session.page.getByText(`本次原始总分：${score} 分`, {
                exact: true,
              }),
            ).toBeVisible();
            await expect(
              session.page.getByRole("button", {
                name: "一次正式交卷",
                exact: true,
              }),
            ).toBeDisabled();
          }
          await gotoPage(learner.page, `/d/main/contests/${contestId}/ranking`);
          const table = learner.page.getByRole("table");
          await expect(table.getByText(actor.username, { exact: true }))
            .toBeVisible();
          await expect(table.getByText(peer.username, { exact: true }))
            .toHaveCount(0);
          await expect(table.getByText("100.00", { exact: true }).first())
            .toBeVisible();
        },
      );
      await step(
        "比赛按真实时间结束，组织者Web发布正式榜，普通成员读取授权完整榜",
        async () => {
          await expect.poll(async () => {
            const response = await learner.page.request.get(
              `${UI_URL}/api/v1/domains/main/contests/${contestId}`,
            );
            assertEquals(response.status(), 200);
            return (await response.json()).data.status;
          }, { timeout: 60000, intervals: [1000] }).toBe("ended");
          await gotoPage(
            organizer.page,
            `/d/main/contests/${contestId}/manage`,
          );
          await organizer.page.getByRole("textbox", {
            name: "正式成绩发布说明",
          }).fill("真实客观题交卷完成后发布。");
          await write(
            organizer.page,
            "POST",
            `/domains/main/contests/${contestId}/publish-ranking`,
            () =>
              organizer.page.getByRole("button", {
                name: "发布新版本正式成绩",
                exact: true,
              }).click(),
          );
          await gotoPage(learner.page, `/d/main/contests/${contestId}/ranking`);
          const official = learner.page.waitForResponse((response) =>
            new URL(response.url()).pathname ===
              `/api/v1/domains/main/contests/${contestId}/final-ranking`
          );
          await learner.page.getByRole("button", {
            name: "正式成绩",
            exact: true,
          }).click();
          const response = await official;
          assertEquals(response.status(), 200);
          assertEquals((await response.json()).data.length, 2);
          await expect(learner.page.getByText(/正式成绩 V1/)).toBeVisible();
          await expect(
            learner.page.getByRole("table").getByText(peer.username, {
              exact: true,
            }),
          ).toBeVisible();
        },
      );
      await step(
        "Mixed同一账号切换为A班学生和B班教练，导航能力随域变化",
        async () => {
          await learner.page.getByRole("button", {
            name: "用户菜单",
            exact: true,
          }).click();
          await learner.page.getByRole("menuitem", {
            name: "切换域",
            exact: true,
          }).hover();
          await learner.page.getByRole("menuitem", {
            name: `学校A ${suffix} · ${schoolA}`,
            exact: true,
          }).click();
          await learner.page.waitForURL((url) =>
            url.pathname === `/d/${schoolA}`
          );
          await gotoPage(
            learner.page,
            `/d/${schoolA}/classrooms/${roomA.data.id}`,
          );
          await expect(
            learner.page.getByRole("link", { name: "创建作业", exact: true }),
          ).toHaveCount(0);
          await expect(learner.page.getByTestId("domain-identity")).toHaveText(
            `${actor.username}@${schoolA}`,
          );
          await learner.page.getByRole("button", {
            name: "用户菜单",
            exact: true,
          }).click();
          await learner.page.getByRole("menuitem", {
            name: "切换域",
            exact: true,
          }).hover();
          await learner.page.getByRole("menuitem", {
            name: `学校B ${suffix} · ${schoolB}`,
            exact: true,
          }).click();
          await learner.page.waitForURL((url) =>
            url.pathname === `/d/${schoolB}`
          );
          await gotoPage(
            learner.page,
            `/d/${schoolB}/classrooms/${roomB.data.id}`,
          );
          await expect(
            learner.page.getByRole("link", { name: "创建作业", exact: true }),
          ).toBeVisible();
          await learner.page.getByRole("button", { name: "更多", exact: true })
            .click();
          await learner.page.getByRole("menuitem", {
            name: "班级研练",
            exact: true,
          }).click();
          await learner.page.waitForURL((url) =>
            url.pathname === `/d/${schoolB}/classrooms`
          );
        },
      );
      await step(
        "两学校Web同源题显示main题号，双标签页交卷及历史归属隔离",
        async () => {
          const second = await learner.context.newPage();
          await gotoPage(learner.page, `/d/${schoolA}/problems/${reference}`);
          await gotoPage(second, `/d/${schoolB}/problems/${reference}`);
          for (const page of [learner.page, second]) {
            await expect(
              page.getByRole("heading", {
                name: `共同源题 ${suffix}`,
                exact: true,
              }),
            ).toBeVisible();
            // 编号徽章与标题位于 ProblemHeader 的同级区域，不在 h1 的
            // 直接父节点内；全局精确文本仍只匹配当前题目的来源编号。
            await expect(page.getByText(reference, { exact: true }))
              .toBeVisible();
          }
          const first = await handIn(
            learner.page,
            `/domains/${schoolA}/problems/${reference}/objective-submissions`,
            "待改进选项",
          );
          const next = await handIn(
            second,
            `/domains/${schoolB}/problems/${reference}/objective-submissions`,
            "正确选项",
          );
          assertEquals(first.data.score, 0);
          assertEquals(next.data.score, 100);
          privateA = first.data.submission_id;
          privateB = next.data.submission_id;
          assertNotEquals(privateA, privateB);
          await expect(
            learner.page.getByText("本次成绩：0 分", { exact: true }),
          ).toBeVisible();
          await expect(second.getByText("本次成绩：100 分", { exact: true }))
            .toBeVisible();
          assertEquals(
            new URL(learner.page.url()).pathname,
            `/d/${schoolA}/problems/${reference}`,
          );
          assertEquals(
            new URL(second.url()).pathname,
            `/d/${schoolB}/problems/${reference}`,
          );
          const wrongDomain = await second.request.get(
            `${UI_URL}/api/v1/domains/${schoolB}/objective-submissions/${privateA}`,
          );
          assertEquals(wrongDomain.status(), 404);
          const outsider = await friend.page.request.get(
            `${UI_URL}/api/v1/domains/${schoolA}/objective-submissions/${privateA}`,
          );
          assertEquals(outsider.status(), 404);
          const otherStudent = await friend.page.request.get(
            `${UI_URL}/api/v1/domains/${schoolB}/objective-submissions/${privateB}`,
          );
          assertEquals(otherStudent.status(), 200);
          const peerSummary = (await otherStudent.json()).data;
          assertEquals(peerSummary.can_view_answers, false);
          assertEquals(peerSummary.can_view_source, false);
          assertEquals(peerSummary.answers, undefined);
          assertEquals(peerSummary.code, undefined);
          assertEquals(peerSummary.assignment_origin, null);
          await gotoPage(learner.page, "/d/main/objective-submissions");
          await expect(learner.page.locator(`a[href$="/${privateA}"]`))
            .toHaveCount(0);
          await expect(learner.page.locator(`a[href$="/${privateB}"]`))
            .toHaveCount(0);
          await gotoPage(learner.page, `/d/${schoolA}/objective-submissions`);
          await expect(
            learner.page.locator(
              `a[href="/d/${schoolA}/objective-submissions/${privateA}"]`,
            ),
          ).toBeVisible();
          await expect(learner.page.locator(`a[href$="/${privateB}"]`))
            .toHaveCount(0);
          await second.close();
        },
      );
      await step(
        "学校社区分别发布，B学生可读本校、不能读A校或错误域帖子",
        async () => {
          const postA = await post(
            learner.page,
            schoolA,
            names.a,
            boardNames[schoolA],
          );
          const postB = await post(
            learner.page,
            schoolB,
            names.b,
            boardNames[schoolB],
          );
          await gotoPage(friend.page, `/d/${schoolB}/community/posts/${postB}`);
          await expect(
            friend.page.getByRole("heading", { name: names.b, exact: true }),
          ).toBeVisible();
          const privatePost = await friend.page.request.get(
            `${UI_URL}/api/v1/domains/${schoolA}/community/posts/${postA}`,
          );
          assertEquals(privatePost.status(), 404);
          const wrongPath = await learner.page.request.get(
            `${UI_URL}/api/v1/domains/${schoolB}/community/posts/${postA}`,
          );
          assertEquals(wrongPath.status(), 404);
          await gotoPage(friend.page, `/d/${schoolB}/community`);
          await expect(
            friend.page.getByRole("link").filter({
              has: friend.page.getByRole("heading", {
                name: names.b,
                exact: true,
              }),
            }),
          ).toBeVisible();
          await expect(friend.page.getByText(names.a, { exact: true }))
            .toHaveCount(0);
          await gotoPage(learner.page, "/d/main/community");
          await expect(learner.page.getByText(names.a, { exact: true }))
            .toHaveCount(0);
          await expect(learner.page.getByText(names.b, { exact: true }))
            .toHaveCount(0);
        },
      );
      await step(
        "两学校LLM配置与用量页面读取当前域，A学生没有管理入口",
        async () => {
          await gotoPage(organizer.page, `/d/${schoolA}/llm`);
          await expect(
            organizer.page.getByRole("textbox", {
              name: "默认模型",
              exact: true,
            }),
          ).toHaveValue(`model-${schoolA}`);
          await gotoPage(organizer.page, `/d/${schoolA}/settings/llm/usage`);
          await expect(
            organizer.page.getByRole("heading", {
              name: "LLM 用量统计",
              exact: true,
            }),
          ).toBeVisible();
          await write(
            organizer.page,
            "GET",
            `/domains/${schoolA}/llm/usage`,
            () =>
              organizer.page.getByRole("button", {
                name: "刷新用量",
                exact: true,
              }).click(),
          );
          await gotoPage(learner.page, `/d/${schoolB}/llm`);
          await expect(
            learner.page.getByRole("textbox", {
              name: "默认模型",
              exact: true,
            }),
          ).toHaveValue(`model-${schoolB}`);
          await expect(
            learner.page.getByText(`独立Provider ${schoolA}`, { exact: true }),
          ).toHaveCount(0);
          await gotoPage(learner.page, `/d/${schoolB}/settings/llm/usage`);
          await write(
            learner.page,
            "GET",
            `/domains/${schoolB}/llm/usage`,
            () =>
              learner.page.getByRole("button", {
                name: "刷新用量",
                exact: true,
              }).click(),
          );
          await gotoPage(learner.page, `/d/${schoolA}/llm`);
          await expect(
            learner.page.getByRole("heading", {
              name: "LLM 配置与用量",
              exact: true,
            }),
          ).toHaveCount(0);
          const denied = await learner.page.request.get(
            `${UI_URL}/api/v1/domains/${schoolA}/llm/providers`,
          );
          assertEquals(denied.status(), 403);
        },
      );
      failed = false;
    } finally {
      for (const key of Object.keys(communityPolicy)) {
        await setPolicy(
          key,
          originalSettings.find((setting) => setting.key === key)!
            .effective_value,
        );
      }
      const restored = (await fixture<{ data: Setting[] }>(
        "GET",
        "/admin/system/settings",
        admin,
      )).data;
      for (const key of Object.keys(communityPolicy)) {
        assertEquals(
          restored.find((setting) => setting.key === key)!.effective_value,
          originalSettings.find((setting) => setting.key === key)!
            .effective_value,
          `恢复社区政策 ${key}`,
        );
      }
      await teardownBrowser(learner, failed, `public-mixed-actor-${suffix}`);
      await teardownBrowser(friend, failed, `public-mixed-peer-${suffix}`);
      await teardownBrowser(organizer, failed, `public-mixed-host-${suffix}`);
    }
  },
});
