/// <reference lib="dom" />
/** 实例治理与Preset真实页面操作；API只准备夹具和核对持久事实。 */
import { assertEquals } from "jsr:@std/assert@^1.0.13";
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
  token: string;
  email: string;
}
interface Setting {
  key: string;
  effective_value: unknown;
  updated_at: string | null;
}
interface Domain {
  id: string;
  slug: string;
  name: string;
  description: string;
  revision: number;
  status: string;
  owner_id: string;
  is_member: boolean;
  configuration: {
    access: string;
    homepage: string;
    features: Record<string, boolean>;
  };
}
interface Problem {
  problem_id: string;
  number: number;
  draft_revision: number;
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
async function account(label: string, suffix: string): Promise<Account> {
  const username = `${label}_${suffix}`, email = `${username}@test.com`;
  const token = await registerUser(username, email, TEST_PASSWORD);
  const me = await fixture<{ data: { id: string; is_admin: boolean } }>(
    "GET",
    "/auth/me",
    token,
  );
  assertEquals(me.data.is_admin, false);
  return { id: me.data.id, username, email, token };
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
async function login(
  page: Page,
  username: string,
  password: string,
  administrator = false,
) {
  await gotoPage(page, "/login");
  await page.getByPlaceholder("请输入用户名或邮箱").fill(username);
  await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
    password,
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await gotoPage(page, "/workspaces");
  const response = await page.request.get(`${UI_URL}/api/v1/auth/me`);
  assertEquals(response.status(), 200);
  const me = await response.json();
  assertEquals(me.data.is_admin, administrator);
  if (collectPendingConsents(me.data.legal).length) {
    await page.getByRole("button", { name: "我已知悉并同意", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "政策更新通知" }))
      .toBeHidden();
  }
  if (administrator) await gotoPage(page, "/admin/instance");
}
async function select(page: Page, name: string, option: string) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function write(
  page: Page,
  method: string,
  path: string,
  action: () => Promise<unknown>,
  status = 200,
) {
  const pending = page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/v1${path}` &&
    response.request().method() === method
  );
  await action();
  const response = await pending, body = await response.json();
  assertEquals(
    response.status(),
    status,
    `${method} ${path}: ${JSON.stringify(body)}`,
  );
  return { body, request: response.request() };
}
async function confirmed(
  page: Page,
  method: string,
  path: string,
  action: () => Promise<unknown>,
  status = 200,
) {
  await action();
  return await write(
    page,
    method,
    path,
    () => page.getByRole("button", { name: "确认", exact: true }).click(),
    status,
  );
}
async function objective(
  slug: string,
  actor: string,
  title: string,
): Promise<Problem> {
  const created = await fixture<Problem>(
    "POST",
    `/domains/${slug}/problems`,
    actor,
    { title, description: "选择正确选项。", is_objective: true },
  );
  const root = `/domains/${slug}/problems/${created.number}`;
  const draft = await fixture<{ revision: number }>(
    "PUT",
    `${root}/draft`,
    actor,
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
            text: "错误选项",
          }],
          answer: ["A"],
          explanation: "选择A。",
        }],
      },
    },
    { "If-Match": String(created.draft_revision) },
  );
  await fixture(
    "POST",
    `${root}/publish`,
    actor,
    { change_note: "治理验收V1" },
    { "If-Match": String(draft.revision) },
  );
  return created;
}

Deno.test({
  name:
    "[ui/workspace-governance] 创建审核、暂停恢复、额度CAS、Preset和即时公开目录",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const suffix = `${Date.now().toString(36)}${
      crypto.randomUUID().slice(0, 4)
    }`;
    const slug = `govern-${suffix}`, rejectedSlug = `deny-${suffix}`;
    const name = `治理学校 ${suffix}`, rejectedName = `拒绝学校 ${suffix}`;
    const admin = await getAdminToken();
    const settings = (await fixture<{ data: Setting[] }>(
      "GET",
      "/admin/system/settings",
      admin,
    )).data;
    const originalMain =
      (await fixture<{ data: Domain }>("GET", "/domains/main", admin)).data;
    const owner = await account("govern_owner", suffix),
      student = await account("govern_student", suffix);
    const manager = await launchBrowser(),
      applicant = await launchBrowser(),
      learner = await launchBrowser();
    let failed = true, problem: Problem, submissionId = "", published: Problem;
    async function restoreSetting(key: string) {
      const current = (await fixture<{ data: Setting[] }>(
        "GET",
        "/admin/system/settings",
        admin,
      )).data.find((row) => row.key === key)!;
      await fixture(
        "PUT",
        `/admin/system/settings/${key}`,
        admin,
        { value: settings.find((row) => row.key === key)!.effective_value },
        current.updated_at
          ? { "If-Match": `"${current.updated_at}"` }
          : undefined,
      );
    }
    const step = async (label: string, fn: () => Promise<void>) =>
      assertEquals(await t.step(label, fn), true, label);
    try {
      await login(
        manager.page,
        Deno.env.get("E2E_ADMIN_EMAIL") || "e2e_admin@test.com",
        "E2eAdminChangedPass1",
        true,
      );
      await login(applicant.page, owner.username, TEST_PASSWORD);
      await login(learner.page, student.username, TEST_PASSWORD);
      await step(
        "平台Web改为申请审核，普通用户Web提交两份创建申请",
        async () => {
          await select(manager.page, "工作空间创建", "申请审核");
          await write(
            manager.page,
            "PUT",
            "/admin/system/settings/domain_creation_policy",
            () =>
              manager.page.getByRole("button", {
                name: "保存工作空间创建",
                exact: true,
              }).click(),
          );
          await gotoPage(applicant.page, "/workspaces");
          for (
            const [target, title] of [[slug, name], [
              rejectedSlug,
              rejectedName,
            ]]
          ) {
            await applicant.page.getByRole("button", {
              name: "申请创建",
              exact: true,
            }).click();
            await applicant.page.getByRole("textbox", {
              name: "空间名称",
              exact: true,
            }).fill(title);
            await applicant.page.getByRole("textbox", {
              name: "空间网址标识",
              exact: true,
            }).fill(target);
            await select(applicant.page, "初始模板", "教学");
            await applicant.page.getByRole("textbox", {
              name: "创建申请理由",
              exact: true,
            }).fill("用于独立治理与教学验收。");
            await write(
              applicant.page,
              "POST",
              "/domain-creation-requests",
              () =>
                applicant.page.getByRole("button", {
                  name: "提交申请",
                  exact: true,
                }).click(),
              201,
            );
            await expect(
              applicant.page.getByRole("dialog", { name: "申请创建空间" }),
            ).toBeHidden();
          }
        },
      );
      await step("平台Web批准与拒绝明确申请，负责人是普通申请人", async () => {
        await gotoPage(manager.page, "/admin/instance");
        const section = manager.page.locator("section").filter({
          has: manager.page.getByRole("heading", {
            name: "工作空间创建申请",
            exact: true,
          }),
        });
        const rows =
          (await fixture<{ data: Array<{ id: string; slug: string }> }>(
            "GET",
            "/admin/instance/domain-creation-requests?status=pending",
            admin,
          )).data;
        for (
          const [target, title, approved] of [[slug, name, true], [
            rejectedSlug,
            rejectedName,
            false,
          ]] as const
        ) {
          const row = section.getByRole("heading", { name: new RegExp(title) })
            .locator("..");
          await expect(row).toContainText(owner.username);
          await confirmed(
            manager.page,
            "POST",
            `/admin/instance/domain-creation-requests/${
              rows.find((row) => row.slug === target)!.id
            }/review`,
            () =>
              row.getByRole("button", {
                name: approved ? "批准创建" : "拒绝申请",
                exact: true,
              }).click(),
          );
        }
        const domain = (await fixture<{ data: Domain }>(
          "GET",
          `/domains/${slug}`,
          owner.token,
        )).data;
        assertEquals(domain.owner_id, owner.id);
        assertEquals(domain.is_member, true);
        const rejected = await api("GET", `/api/v1/domains/${rejectedSlug}`, {
          token: admin,
        });
        assertEquals(rejected.status, 404);
        await select(manager.page, "创建申请状态", "已拒绝");
        await expect(
          section.getByRole("heading", { name: new RegExp(rejectedName) }),
        ).toBeVisible();
      });
      await step(
        "普通域成员完成真实交卷，保存成员、源题和提交历史依据",
        async () => {
          const invitation = await fixture<{ data: { token: string } }>(
            "POST",
            `/domains/${slug}/invitations`,
            owner.token,
            { email: student.email },
          );
          await fixture("POST", "/domain-invitations/accept", student.token, {
            token: invitation.data.token,
          });
          problem = await objective(slug, owner.token, `保留原题 ${suffix}`);
          await gotoPage(learner.page, `/d/${slug}/problems/${problem.number}`);
          await learner.page.getByRole("checkbox", {
            name: "正确选项",
            exact: true,
          }).check();
          const response = await confirmed(
            learner.page,
            "POST",
            `/domains/${slug}/problems/${problem.number}/objective-submissions`,
            () =>
              learner.page.getByRole("button", { name: "交卷", exact: true })
                .click(),
            201,
          );
          assertEquals(response.body.data.score, 100);
          submissionId = response.body.data.submission_id;
          await expect(
            learner.page.getByText("本次成绩：100 分", { exact: true }),
          ).toBeVisible();
        },
      );
      await step(
        "平台Web暂停与恢复同一域，普通用户即时失去并重新获得进入权",
        async () => {
          await manager.page.getByRole("textbox", {
            name: "搜索治理空间",
            exact: true,
          }).fill(slug);
          await manager.page.getByRole("button", {
            name: "搜索空间",
            exact: true,
          }).click();
          const row = manager.page.getByRole("heading", {
            name: new RegExp(name),
          }).locator("..").locator("..");
          await confirmed(
            manager.page,
            "POST",
            `/domains/${slug}/status`,
            () =>
              row.getByRole("button", { name: "暂停访问", exact: true })
                .click(),
          );
          const blocked = await learner.page.request.get(
            `${UI_URL}/api/v1/domains/${slug}`,
          );
          assertEquals(blocked.status(), 404);
          await gotoPage(learner.page, `/d/${slug}/problems/${problem.number}`);
          await expect(
            learner.page.getByText("工作空间不可用", { exact: true }),
          ).toBeVisible();
          await confirmed(
            manager.page,
            "POST",
            `/domains/${slug}/status`,
            () =>
              row.getByRole("button", { name: "恢复使用", exact: true })
                .click(),
          );
          assertEquals(
            (await learner.page.request.get(`${UI_URL}/api/v1/domains/${slug}`))
              .status(),
            200,
          );
        },
      );
      await step(
        "两标签页的额度修改产生真实409，旧表单保留输入并明确提示",
        async () => {
          const other = await manager.context.newPage();
          try {
            for (const page of [manager.page, other]) {
              await gotoPage(page, `/d/${slug}/settings`);
              await page.getByRole("checkbox", {
                name: "成员：不额外限制",
                exact: true,
              }).uncheck();
            }
            await manager.page.getByRole("spinbutton", {
              name: "成员上限",
              exact: true,
            }).fill("40");
            await other.getByRole("spinbutton", {
              name: "成员上限",
              exact: true,
            }).fill("30");
            const first = await write(
              manager.page,
              "PATCH",
              `/domains/${slug}/limits`,
              () =>
                manager.page.getByRole("button", {
                  name: "保存配额",
                  exact: true,
                }).click(),
            );
            const conflict = await write(
              other,
              "PATCH",
              `/domains/${slug}/limits`,
              () =>
                other.getByRole("button", { name: "保存配额", exact: true })
                  .click(),
              409,
            );
            assertEquals(
              conflict.request.headers()["if-match"],
              first.request.headers()["if-match"],
            );
            await expect(
              other.locator('p[role="alert"]').filter({
                hasText: "工作空间配置已变化，请重新读取",
              }),
            ).toBeVisible();
            await expect(
              other.getByRole("spinbutton", { name: "成员上限", exact: true }),
            ).toHaveValue("30");
            const limits = await fixture<
              { data: { configured: { members: number } } }
            >("GET", `/domains/${slug}/limits`, admin);
            assertEquals(limits.data.configured.members, 40);
          } finally {
            await other.close();
          }
        },
      );
      await step(
        "Preset预览不修改数据，显式应用保留成员、原题、答案与成绩",
        async () => {
          const members = await fixture(
            "GET",
            `/domains/${slug}/members`,
            owner.token,
          );
          const detail = await fixture(
            "GET",
            `/domains/${slug}/problems/${problem.number}`,
            owner.token,
          );
          const history = await fixture(
            "GET",
            `/domains/${slug}/objective-submissions/${submissionId}`,
            student.token,
          );
          await gotoPage(applicant.page, `/d/${slug}/settings`);
          await select(applicant.page, "重新应用模板", "社区");
          const preview = await write(
            applicant.page,
            "POST",
            `/domains/${slug}/preset-preview`,
            () =>
              applicant.page.getByRole("button", {
                name: "预览差异",
                exact: true,
              }).click(),
          );
          assertEquals(preview.body.data.changes.length > 0, true);
          assertEquals(
            (await fixture<{ data: Domain }>(
              "GET",
              `/domains/${slug}`,
              owner.token,
            )).data.configuration.homepage,
            "teaching",
          );
          const applied = await confirmed(
            applicant.page,
            "POST",
            `/domains/${slug}/preset-apply`,
            () =>
              applicant.page.getByRole("button", {
                name: "应用这些修改",
                exact: true,
              }).click(),
          );
          assertEquals(
            applied.request.headers()["if-match"],
            String(preview.body.data.revision),
          );
          assertEquals(
            await fixture("GET", `/domains/${slug}/members`, owner.token),
            members,
          );
          assertEquals(
            await fixture(
              "GET",
              `/domains/${slug}/problems/${problem.number}`,
              owner.token,
            ),
            detail,
          );
          assertEquals(
            await fixture(
              "GET",
              `/domains/${slug}/objective-submissions/${submissionId}`,
              student.token,
            ),
            history,
          );
          await select(applicant.page, "空间首页", "题单");
          await write(
            applicant.page,
            "PATCH",
            `/domains/${slug}`,
            () =>
              applicant.page.getByRole("button", {
                name: "保存设置",
                exact: true,
              }).click(),
          );
          await gotoPage(applicant.page, `/d/${slug}`);
          await applicant.page.waitForURL((url) =>
            url.pathname === `/d/${slug}/trainings`
          );
        },
      );
      await step(
        "匿名sitemap实时读取，Web下架本次公开题后不复用旧目录",
        async () => {
          published = await objective("main", admin, `公开目录题 ${suffix}`);
          const anonymous = await manager.browser.newContext();
          try {
            const first = await anonymous.request.get(`${UI_URL}/sitemap.xml`);
            assertEquals(first.status(), 200);
            assertEquals(first.headers()["cache-control"], "no-store");
            assertEquals(
              (await first.text()).includes(
                `/d/main/problems/${published.number}</loc>`,
              ),
              true,
            );
            await gotoPage(manager.page, "/d/main/problem-bindings");
            await manager.page.getByPlaceholder("搜索资源名称", { exact: true })
              .fill(`公开目录题 ${suffix}`);
            await manager.page.getByRole("button", {
              name: "搜索",
              exact: true,
            }).click();
            const row = manager.page.getByRole("heading", {
              name: new RegExp(`公开目录题 ${suffix}`),
            }).locator("..").locator("..");
            await row.getByRole("button", { name: "配置", exact: true })
              .click();
            await manager.page.getByPlaceholder(
              "说明策略、展示范围或上下架调整原因",
            ).fill("公开目录撤销验收，仅下架本次新题。");
            await manager.page.getByRole("checkbox", {
              name: "暂停此题在本域的内容访问和新提交",
              exact: true,
            }).check();
            await confirmed(
              manager.page,
              "POST",
              `/domains/main/problems/${published.number}/state`,
              () =>
                manager.page.getByRole("button", {
                  name: "保存展示与上下架",
                  exact: true,
                }).click(),
            );
            const next = await anonymous.request.get(`${UI_URL}/sitemap.xml`);
            assertEquals(next.status(), 200);
            assertEquals(
              (await next.text()).includes(
                `/d/main/problems/${published.number}</loc>`,
              ),
              false,
            );
            await gotoPage(manager.page, "/admin/instance");
            await select(manager.page, "实例访问", "仅已登录账号");
            await write(
              manager.page,
              "PUT",
              "/admin/system/settings/instance_access",
              () =>
                manager.page.getByRole("button", {
                  name: "保存实例访问",
                  exact: true,
                }).click(),
            );
            const denied = await anonymous.request.get(`${UI_URL}/sitemap.xml`);
            assertEquals(denied.ok(), false);
            assertEquals(denied.headers()["cache-control"], "no-store");
            assertEquals(
              (await denied.text()).includes("/d/main/problems/"),
              false,
            );
          } finally {
            await anonymous.close();
          }
        },
      );
      failed = false;
    } finally {
      try {
        await restoreSetting("instance_access");
        await restoreSetting("domain_creation_policy");
        const currentMain =
          (await fixture<{ data: Domain }>("GET", "/domains/main", admin)).data;
        assertEquals(
          currentMain.configuration,
          originalMain.configuration,
          "main政策没有改变",
        );
        const restored = (await fixture<{ data: Setting[] }>(
          "GET",
          "/admin/system/settings",
          admin,
        )).data;
        for (const key of ["instance_access", "domain_creation_policy"]) {
          assertEquals(
            restored.find((row) => row.key === key)!.effective_value,
            settings.find((row) => row.key === key)!.effective_value,
            `恢复${key}`,
          );
        }
      } finally {
        await teardownBrowser(
          manager,
          failed,
          `workspace-governance-admin-${suffix}`,
        );
        await teardownBrowser(
          applicant,
          failed,
          `workspace-governance-owner-${suffix}`,
        );
        await teardownBrowser(
          learner,
          failed,
          `workspace-governance-student-${suffix}`,
        );
      }
    }
  },
});
