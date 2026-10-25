/// <reference lib="dom" />
/** 班级治理、矩阵导出及补题跟进；API仅准备已有账号、普通角色和原始任务。 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.13";
import { expect } from "npm:playwright@1.62.1/test";
import { collectPendingConsents } from "../../../noj-ui/utils/legalConsent.ts";
import { getAdminToken, TEST_PASSWORD } from "../helper.ts";
import {
  BROWSER_E2E,
  gotoPage as navigate,
  launchBrowser,
  teardownBrowser,
  UI_URL,
} from "./browser.ts";
import {
  classroomJourneyAccount,
  classroomJourneyFixture as fixture,
  classroomJourneyJoin,
  classroomJourneyProblem,
} from "./_workspace-classroom-matrix-fixtures.ts";
import type { ClassroomJourneyAccount } from "./_workspace-classroom-matrix-fixtures.ts";
type Page = import("npm:playwright@1.62.1").Page;
interface Matrix {
  total: number;
  rows: Array<
    {
      username: string;
      cells: Array<
        {
          status: string;
          score: number | null;
          source_submission_id: string | null;
        }
      >;
    }
  >;
}
const capabilities = [
  "查看学情",
  "查看学生提交",
  "创建和管理作业",
  "撰写反馈",
  "处理求助",
  "管理学生成员",
];
async function goto(page: Page, path: string) {
  await navigate(page, path);
  await page.waitForFunction(() =>
    Boolean(
      (document.querySelector("#__nuxt") as Element & { __vue_app__?: unknown })
        ?.__vue_app__,
    )
  );
}
async function login(page: Page, actor: ClassroomJourneyAccount) {
  await goto(page, "/login");
  await page.getByPlaceholder("请输入用户名或邮箱").fill(actor.email);
  await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
    TEST_PASSWORD,
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await goto(page, "/workspaces");
  const result = await page.request.get(`${UI_URL}/api/v1/auth/me`),
    body = await result.json();
  assertEquals(result.status(), 200);
  if (collectPendingConsents(body.data.legal).length) {
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
  const [result] = await Promise.all([
    page.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/v1${path}` &&
      response.request().method() === method
    ),
    action(),
  ]);
  const body = await result.json();
  assertEquals(
    result.ok(),
    true,
    `${method} ${path}: ${result.status()} ${JSON.stringify(body)}`,
  );
  return body;
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
function memberRow(page: Page, username: string) {
  // 成员名位于左侧信息列，操作按钮位于同一行的右侧列；按行的稳定
  // transition-colors 标记收敛两列，而不是依赖内部 div 层级。
  return page.locator("div.transition-colors").filter({
    has: page.getByText(username, { exact: true }),
  }).first();
}
async function setRole(
  page: Page,
  slug: string,
  classId: string,
  actor: ClassroomJourneyAccount,
  role: "教练" | "助教",
  grants: string[] = [],
) {
  await memberRow(page, actor.username).getByRole("button", {
    name: "调整身份",
  }).click();
  const modal = page.getByRole("dialog", { name: "调整班级身份" });
  await choose(page, "班级角色", role);
  if (role === "助教") {
    for (const capability of capabilities) {
      await modal.getByRole("checkbox", { name: capability, exact: true })
        .setChecked(grants.includes(capability));
    }
  }
  return await write(
    page,
    "PUT",
    `/domains/${slug}/classrooms/${classId}/members/${actor.id}`,
    () => modal.getByRole("button", { name: "保存身份配置" }).click(),
  );
}
async function remove(
  page: Page,
  slug: string,
  classId: string,
  actor: ClassroomJourneyAccount,
) {
  await memberRow(page, actor.username).getByRole("button", {
    name: "移出班级",
  }).click();
  await write(
    page,
    "DELETE",
    `/domains/${slug}/classrooms/${classId}/members/${actor.id}`,
    () => page.getByRole("button", { name: "确认", exact: true }).click(),
  );
}
async function download(page: Page, button: string) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: button, exact: true }).click();
  const file = await pending, path = await file.path();
  assertEquals(typeof path, "string");
  return {
    name: file.suggestedFilename(),
    text: await Deno.readTextFile(path!),
  };
}
async function submitObjective(
  page: Page,
  slug: string,
  number: number,
  taskId: string,
  correct: boolean,
) {
  await goto(page, `/d/${slug}/assignments/${taskId}`);
  await page.getByRole("link", { name: "继续练习", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname.startsWith(`/d/${slug}/problems/`)
  );
  assertEquals(new URL(page.url()).searchParams.get("assignment_id"), taskId);
  await page.getByRole("checkbox", {
    name: correct ? "正确选项" : "待改进选项",
    exact: true,
  }).check();
  await page.getByRole("button", { name: "交卷", exact: true }).click();
  const body = await write(
    page,
    "POST",
    `/domains/${slug}/problems/${number}/objective-submissions`,
    () => page.getByRole("button", { name: "确认", exact: true }).click(),
  );
  await expect(
    page.getByText(`本次成绩：${correct ? 100 : 0} 分`, { exact: true }),
  ).toBeVisible();
  assertEquals(body.data.assignment_origin.assignment_id, taskId);
  return body.data.submission_id as string;
}

Deno.test({
  name:
    "workspace-classroom-matrix: 40账号CSV、助教交接撤职、矩阵导出与补题跟进",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const suffix = Date.now().toString(36),
      slug = `classgov-${suffix}`,
      title = `学情跟进 ${suffix}`;
    const admin = await getAdminToken(),
      sessions = await Promise.all(
        Array.from({ length: 4 }, () => launchBrowser()),
      );
    const [coach, successor, assistant, learner] = sessions;
    let failed = true,
      classId = "",
      taskId = "",
      remediationId = "",
      number = 0,
      originalId = "";
    let teacher: ClassroomJourneyAccount;
    const pupils: ClassroomJourneyAccount[] = [];
    const base = () => `/domains/${slug}/classrooms/${classId}`;
    const assignment = (id = taskId) => `/domains/${slug}/assignments/${id}`;
    async function step(name: string, action: () => Promise<void>) {
      assertEquals(await t.step(name, action), true, name);
    }
    try {
      await step(
        "准备40个已经存在的普通账号、独立教育域与无域治理权限的教练",
        async () => {
          teacher = await classroomJourneyAccount(`classgov_teacher_${suffix}`);
          // 逐个自注册并完成验证，与教师 CSV 操作分开；不调用平台批量开户接口。
          for (let i = 0; i < 40; i++) {
            pupils.push(
              await classroomJourneyAccount(
                `classgov_${String(i).padStart(2, "0")}_${suffix}`,
              ),
            );
          }
          await fixture("POST", "/domains", admin, {
            slug,
            name: slug,
            preset: "education",
          });
          for (const actor of [teacher, ...pupils]) {
            await classroomJourneyJoin(slug, admin, actor);
          }
          for (const actor of [teacher, pupils[39]]) {
            await fixture(
              "PUT",
              `/domains/${slug}/members/${actor.id}/roles`,
              admin,
              { roles: ["educator"] },
            );
          }
          const created = await fixture<{ data: { id: string } }>(
            "POST",
            `/domains/${slug}/classrooms`,
            teacher.token,
            { name: title },
          );
          classId = created.data.id;
          await login(coach.page, teacher);
          await goto(coach.page, `/d/${slug}/classrooms/${classId}/members`);
        },
      );
      await step(
        "教师实际上传CSV，预览40有效行与重复/错误行，执行并下载结果",
        async () => {
          const csv = "email,username\n" + pupils.map((actor) =>
            `${actor.email},${actor.username}`
          ).join("\n") +
            `\n${pupils[0].email},${pupils[0].username}\ninvalid-email,\n`;
          await coach.page.getByRole("tab", {
            name: "批量导入与邀请",
            exact: true,
          }).click();
          await expect(
            coach.page.getByRole("textbox", { name: "学生导入 CSV" }),
          ).toBeVisible();
          await coach.page.getByLabel("学生 CSV 文件", { exact: true })
            .setInputFiles({
              name: "classroom.csv",
              mimeType: "text/csv",
              buffer: Buffer.from(csv),
            });
          await expect(
            coach.page.getByRole("textbox", { name: "学生导入 CSV" }),
          ).toHaveValue(csv);
          const preview = await write(
            coach.page,
            "POST",
            `${base()}/imports/preview`,
            () =>
              coach.page.getByRole("button", { name: "预览导入", exact: true })
                .click(),
          );
          assertEquals(preview.data.summary, {
            total: 42,
            join: 40,
            invite: 0,
            skipped: 0,
            errors: 2,
          });
          await expect(coach.page.getByRole("table", { name: "导入逐行预览" }))
            .toContainText("本批次重复账号或邮箱");
          assertEquals(
            preview.data.rows.filter((row: { action: string }) =>
              row.action === "error"
            ).length,
            2,
          );
          const executed = await write(
            coach.page,
            "POST",
            `${base()}/imports/execute`,
            () =>
              coach.page.getByRole("button", {
                name: "执行已预览的有效行",
                exact: true,
              }).click(),
          );
          assertEquals(executed.data.summary.join, 40);
          const exported = await download(
            coach.page,
            "下载执行结果与首次邀请链接",
          );
          assertEquals(exported.name, "classroom-import-result.csv");
          for (const actor of pupils) {
            assertStringIncludes(exported.text, actor.username);
          }
          assertStringIncludes(exported.text, "本批次重复账号或邮箱");
          assertEquals(exported.text.includes("/join#invitation="), false);
          const { data: members } = await fixture<
            { data: Array<{ user_id: string; role: string }> }
          >("GET", `${base()}/members`, teacher.token);
          assertEquals(
            members.filter((row) =>
              row.role === "student"
            ).length,
            40,
          );
          assertEquals(
            new Set(members.map((row) => row.user_id)).size,
            41,
          );
        },
      );
      await step(
        "Web任命接任教练与助教，六能力全选后改为学情+反馈组合",
        async () => {
          await goto(coach.page, `/d/${slug}/classrooms/${classId}/members`);
          await setRole(coach.page, slug, classId, pupils[39], "教练");
          await setRole(
            coach.page,
            slug,
            classId,
            pupils[38],
            "助教",
            capabilities,
          );
          const all = await fixture<
            { data: Array<{ user_id: string; capabilities: string[] }> }
          >("GET", `${base()}/members`, teacher.token);
          assertEquals(
            all.data.find((row) => row.user_id === pupils[38].id)!.capabilities
              .length,
            6,
          );
          await setRole(coach.page, slug, classId, pupils[38], "助教", [
            "查看学情",
            "撰写反馈",
          ]);
          const result = await fixture<
            { data: Array<{ user_id: string; capabilities: string[] }> }
          >("GET", `${base()}/members`, teacher.token);
          assertEquals(
            result.data.find((row) => row.user_id === pupils[38].id)!
              .capabilities.sort(),
            ["feedback:write", "progress:read"],
          );
          const problem = await classroomJourneyProblem(slug, admin, title);
          number = problem.number;
          const created = await fixture<
            { data: { id: string; revision: number } }
          >("POST", `${base()}/assignments`, teacher.token, {
            title,
            items: [{ binding_id: problem.bindingId, requirement: "accepted" }],
          });
          taskId = created.data.id;
          await fixture(
            "POST",
            `${assignment()}/publish`,
            teacher.token,
            {},
            created.data.revision,
            crypto.randomUUID(),
          );
          await login(learner.page, pupils[0]);
          originalId = await submitObjective(
            learner.page,
            slug,
            number,
            taskId,
            false,
          );
          await login(assistant.page, pupils[38]);
          await goto(assistant.page, `/d/${slug}/assignments/${taskId}`);
          await expect(
            assistant.page.getByRole("table", { name: "学生成绩矩阵" }),
          ).toContainText(pupils[0].username);
          await assistant.page.getByRole("tab", {
            name: "反馈与求助",
            exact: true,
          }).click();
          await assistant.page.getByRole("button", {
            name: "写反馈",
            exact: true,
          }).click();
          await assistant.page.getByRole("textbox", { name: "作业反馈正文" })
            .fill(`助教反馈 ${suffix}`);
          await write(assistant.page, "POST", `${assignment()}/feedback`, () =>
            assistant.page.getByRole("button", {
              name: "发送反馈",
              exact: true,
            }).click());
          const denied = await assistant.page.request.get(
            `${UI_URL}/api/v1${base()}/submissions/objective/${originalId}`,
          );
          assertEquals(denied.status(), 403);
          assertEquals(
            (await denied.json()).code,
            "CLASSROOM_PERMISSION_DENIED",
          );
          await expect(
            assistant.page.getByRole("button", {
              name: "为全班未达标学生布置补题",
            }),
          ).toBeHidden();
        },
      );
      await step(
        "实际筛选未达标学生并下载CSV，移除学生后切换历史名单与窄屏读取",
        async () => {
          await goto(coach.page, `/d/${slug}/assignments/${taskId}`);
          await coach.page.getByRole("button", { name: "筛选", exact: true })
            .click();
          await choose(coach.page, "完成状态筛选", "未达标");
          await coach.page.getByRole("textbox", {
            name: "学生搜索",
            exact: true,
          }).fill(pupils[0].username);
          await coach.page.getByRole("button", { name: "搜索", exact: true })
            .click();
          await expect(
            coach.page.getByRole("button", {
              name: `${pupils[0].username} ${number} 0 · 未达标`,
              exact: true,
            }),
          ).toBeVisible({ timeout: 15000 });
          const exported = await download(coach.page, "导出 CSV");
          assertEquals(exported.name, `assignment-${taskId}-on_time.csv`);
          assertEquals(exported.text.trim().split(/\r?\n/).length, 2);
          assertStringIncludes(exported.text, pupils[0].username);
          assertStringIncludes(exported.text, '"未达标","0"');
          await choose(coach.page, "成绩统计范围", "当前补做进度");
          const currentCsv = await download(coach.page, "导出 CSV");
          assertEquals(currentCsv.name, `assignment-${taskId}-current.csv`);
          await goto(coach.page, `/d/${slug}/classrooms/${classId}/members`);
          await remove(coach.page, slug, classId, pupils[1]);
          await goto(coach.page, `/d/${slug}/assignments/${taskId}`);
          await choose(coach.page, "学生范围", "历史学生");
          await expect(coach.page.getByRole("table", { name: "学生成绩矩阵" }))
            .toContainText(pupils[1].username);
          const historicalCsv = await download(coach.page, "导出 CSV");
          assertEquals(historicalCsv.text.trim().split(/\r?\n/).length, 2);
          assertStringIncludes(historicalCsv.text, pupils[1].username);
          assertStringIncludes(historicalCsv.text, "历史学生");
          await coach.page.setViewportSize({ width: 390, height: 844 });
          await expect(coach.page.getByRole("table", { name: "学生成绩矩阵" }))
            .toBeHidden();
          const card = coach.page.locator("div.sm\\:hidden").filter({
            has: coach.page.getByRole("heading", {
              name: pupils[1].username,
              exact: true,
            }),
          });
          await card.getByRole("button", { name: "未开始", exact: true })
            .click();
          await expect(
            coach.page.getByRole("dialog", {
              name: `${pupils[1].username} · ${number}`,
              exact: true,
            }),
          ).toBeVisible();
          await coach.page.setViewportSize({ width: 1440, height: 900 });
        },
      );
      await step(
        "教师为单个学生发布补题，学生实际完成后教师重读新任务达标进度",
        async () => {
          await goto(coach.page, `/d/${slug}/assignments/${taskId}`);
          await coach.page.getByRole("button", {
            name: "为全班未达标学生布置补题",
            exact: true,
          }).click();
          const modal = coach.page.getByRole("dialog", {
            name: "全班补题候选预览",
          });
          await modal.getByRole("button", { name: "取消全选学生", exact: true })
            .click();
          await modal.getByRole("checkbox", {
            name: pupils[0].username,
            exact: true,
          }).check();
          await modal.getByRole("textbox", { name: "补题任务标题" }).fill(
            `${title} 补题`,
          );
          const created = await write(
            coach.page,
            "POST",
            `${assignment()}/remediation`,
            () =>
              modal.getByRole("button", { name: "创建补题草稿", exact: true })
                .click(),
          );
          remediationId = created.data.id;
          await expect(coach.page.getByText("指定学生：1 人", { exact: true }))
            .toBeVisible();
          await coach.page.getByRole("button", {
            name: "发布作业",
            exact: true,
          }).click();
          await write(
            coach.page,
            "POST",
            `${assignment(remediationId)}/publish`,
            () =>
              coach.page.getByRole("button", { name: "确认", exact: true })
                .click(),
          );
          const completedId = await submitObjective(
            learner.page,
            slug,
            number,
            remediationId,
            true,
          );
          await goto(coach.page, `/d/${slug}/assignments/${remediationId}`);
          await expect(
            coach.page.getByRole("button", {
              name: `${pupils[0].username} ${number} 100 · 已达标`,
              exact: true,
            }),
          ).toBeVisible({ timeout: 15000 });
          const matrix = await fixture<{ data: Matrix }>(
            "GET",
            `${assignment(remediationId)}/matrix`,
            teacher.token,
          );
          assertEquals(matrix.data.total, 1);
          assertEquals(
            matrix.data.rows[0].cells[0].source_submission_id,
            completedId,
          );
          const original = await fixture<
            { data: { result: { score: number } } }
          >(
            "GET",
            `/domains/${slug}/objective-submissions/${originalId}`,
            pupils[0].token,
          );
          assertEquals(original.data.result.score, 0);
        },
      );
      await step(
        "Web交接不自动撤职，接任者移除旧教练/助教后其重新导航与读取即时拒绝",
        async () => {
          await goto(coach.page, `/d/${slug}/classrooms/${classId}/settings`);
          await choose(coach.page, "接任主教练", pupils[39].username);
          await coach.page.getByRole("button", { name: "交接", exact: true })
            .click();
          await write(
            coach.page,
            "POST",
            `${base()}/transfer`,
            () =>
              coach.page.getByRole("button", { name: "确认", exact: true })
                .click(),
          );
          const room = await fixture<
            {
              data: {
                primary_coach_id: string;
                membership: { role: string };
                manages_domain: boolean;
              };
            }
          >("GET", base(), teacher.token);
          assertEquals(room.data.primary_coach_id, pupils[39].id);
          assertEquals(room.data.membership.role, "coach");
          assertEquals(room.data.manages_domain, false);
          await login(successor.page, pupils[39]);
          await goto(
            successor.page,
            `/d/${slug}/classrooms/${classId}/members`,
          );
          await remove(successor.page, slug, classId, teacher);
          await remove(successor.page, slug, classId, pupils[38]);
          for (const page of [coach.page, assistant.page]) {
            const denied = await page.request.get(
              `${UI_URL}/api/v1${assignment(remediationId)}/matrix`,
            );
            assertEquals(denied.status(), 404);
            await goto(page, `/d/${slug}/assignments/${remediationId}`);
            await expect(page.getByRole("table", { name: "学生成绩矩阵" }))
              .toBeHidden();
            await expect(page.getByRole("textbox", { name: "作业反馈正文" }))
              .toBeHidden();
          }
          await goto(successor.page, `/d/${slug}/assignments/${remediationId}`);
          await expect(
            successor.page.getByRole("button", {
              name: `${pupils[0].username} ${number} 100 · 已达标`,
              exact: true,
            }),
          ).toBeVisible();
          await goto(successor.page, `/d/${slug}/assignments/${taskId}`);
          await expect(
            successor.page.getByText(`助教反馈 ${suffix}`, { exact: true }),
          ).toBeVisible();
        },
      );
      failed = false;
    } finally {
      await Promise.all(
        sessions.map((session, index) =>
          teardownBrowser(
            session,
            failed,
            `workspace-classroom-matrix-${index}`,
          )
        ),
      );
    }
  },
});
