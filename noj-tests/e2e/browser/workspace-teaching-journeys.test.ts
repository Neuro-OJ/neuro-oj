/// <reference lib="dom" />
/**
 * 真实教学浏览器旅程。账号、角色和题目版本通过 API 准备；建域、建班、邀请、
 * 发布、作答、反馈、求助、矩阵及补题使用页面操作，不以 API 成功代替 Web 验收。
 */
import { assertEquals } from "jsr:@std/assert@^1.0.13";
import { expect } from "npm:playwright@1.62.1/test";
import { collectPendingConsents } from "../../../noj-ui/utils/legalConsent.ts";
import {
  api,
  apiGet,
  getAdminToken,
  registerUser,
  TEST_PASSWORD,
} from "../helper.ts";
import {
  BROWSER_E2E,
  gotoPage as navigatePage,
  launchBrowser,
  teardownBrowser,
  UI_URL,
} from "./browser.ts";

type Page = import("npm:playwright@1.62.1").Page;

/** 完成水合再操作 SSR 表单，避免填入的 DOM 值被初始客户端模型覆盖。 */
async function ready(page: Page) {
  await page.waitForFunction(() =>
    Boolean(
      (document.querySelector("#__nuxt") as Element & { __vue_app__?: unknown })
        ?.__vue_app__,
    )
  );
}
async function gotoPage(page: Page, path: string) {
  await navigatePage(page, path);
  await ready(page);
}

async function login(page: Page, account: string, password: string) {
  await gotoPage(page, "/login");
  await page.getByPlaceholder("请输入用户名或邮箱").fill(account);
  await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
    password,
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
  await gotoPage(page, "/workspaces");
  const identity = await page.request.get(`${UI_URL}/api/v1/auth/me`);
  assertEquals(identity.status(), 200);
  const actor = await identity.json();
  if (collectPendingConsents(actor.data.legal).length) {
    await page.getByRole("button", { name: "我已知悉并同意", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "政策更新通知" }))
      .toBeHidden();
  }
}

async function select(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

/** 页面写操作的响应同时作为稳定资源定位依据。 */
async function write(
  page: Page,
  method: string,
  path: string,
  action: () => Promise<unknown>,
) {
  const [result] = await Promise.all([
    page.waitForResponse((response) =>
      new URL(response.url()).pathname === path &&
      response.request().method() === method
    ),
    action(),
  ]);
  const body = await result.json();
  if (!result.ok()) {
    throw new Error(
      `页面写入失败 ${method} ${path}: ${result.status()} ${
        JSON.stringify(body)
      }`,
    );
  }
  return body;
}

async function fixture(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  revision?: number,
) {
  const result = await api(method, path, {
    token,
    body,
    ...(revision === undefined
      ? {}
      : { headers: { "If-Match": String(revision) } }),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `准备夹具失败 ${method} ${path}: ${result.status} ${
        JSON.stringify(result.body)
      }`,
    );
  }
  return result.body;
}

async function joinFixture(
  slug: string,
  email: string,
  admin: string,
  member: string,
) {
  const invited = await fixture(
    "POST",
    `/api/v1/domains/${slug}/invitations`,
    admin,
    { email },
  ) as {
    data: { token: string };
  };
  await fixture("POST", "/api/v1/domain-invitations/accept", member, {
    token: invited.data.token,
  });
}

async function objectiveFixture(slug: string, admin: string, title: string) {
  const created = await fixture(
    "POST",
    `/api/v1/domains/${slug}/problems`,
    admin,
    {
      title,
      description: "浏览器旅程用客观题：选择选项，然后正式交卷。",
      is_objective: true,
    },
  ) as { number: number; draft_revision: number };
  const path = `/api/v1/domains/${slug}/problems/${created.number}`;
  const saved = await fixture("PUT", `${path}/draft`, admin, {
    content: {
      kind: "objective",
      title,
      description: "浏览器旅程用客观题：选择选项，然后正式交卷。",
      samples: [],
      questions: [{
        key: "journey-question",
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
  }, created.draft_revision) as { revision: number };
  await fixture("POST", `${path}/publish`, admin, {
    change_note: "浏览器旅程夹具",
  }, saved.revision);
  return created.number;
}

async function publish(page: Page, slug: string, assignmentId: string) {
  await page.getByRole("button", { name: "发布作业", exact: true }).click();
  await write(
    page,
    "POST",
    `/api/v1/domains/${slug}/assignments/${assignmentId}/publish`,
    () => page.getByRole("button", { name: "确认", exact: true }).click(),
  );
  await expect(page.getByRole("button", { name: "发布作业", exact: true }))
    .toHaveCount(0);
}

Deno.test({
  name: "[ui/workspace-teaching] 私有教学闭环、跨域双标签页与窄屏矩阵",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const suffix = Date.now().toString(36);
    const slug = `web-school-${suffix}`, otherSlug = `web-team-${suffix}`;
    const domainName = `Web 教学 ${suffix}`,
      classroomName = `Web 班级 ${suffix}`;
    const title = `Web 作业 ${suffix}`,
      feedback = `反馈 ${suffix}：先检查选项，再重新练习。`;
    const question = `求助 ${suffix}：如何区分两个选项？`,
      reply = `回复 ${suffix}：阅读题面后选择 A。`;
    const teacherName = `web_teacher_${suffix}`,
      teacherEmail = `${teacherName}@test.com`;
    const studentName = `web_student_${suffix}`,
      studentEmail = `${studentName}@test.com`;
    const admin = await getAdminToken();
    const teacherToken = await registerUser(
      teacherName,
      teacherEmail,
      TEST_PASSWORD,
    );
    const studentToken = await registerUser(
      studentName,
      studentEmail,
      TEST_PASSWORD,
    );
    const identity = await apiGet("/api/v1/auth/me", teacherToken);
    assertEquals(identity.status, 200);
    const teacherId = (identity.body as { data: { id: string } }).data.id;
    const administrator = await launchBrowser(),
      teacher = await launchBrowser(),
      student = await launchBrowser();
    let failed = true,
      classroomId = "",
      assignmentId = "",
      objectiveSubmissionId = "",
      number = 0,
      otherNumber = 0;
    const errors: string[] = [];
    for (const session of [administrator, teacher, student]) {
      session.page.on("pageerror", (error) => errors.push(error.message));
    }
    // 前序失败停止依赖步骤，并让 finally 保留本次浏览器诊断。
    async function step(name: string, action: () => Promise<void>) {
      assertEquals(await t.step(name, action), true, name);
    }
    try {
      await step(
        "管理员在 Web 创建私有教学域，准备普通教师与独立题目版本",
        async () => {
          await login(
            administrator.page,
            Deno.env.get("E2E_ADMIN_EMAIL") || "e2e_admin@test.com",
            "E2eAdminChangedPass1",
          );
          await gotoPage(administrator.page, "/workspaces");
          await administrator.page.getByRole("button", {
            name: "创建空间",
            exact: true,
          }).click();
          await administrator.page.getByRole("textbox", {
            name: "空间名称",
            exact: true,
          }).fill(domainName);
          await administrator.page.getByRole("textbox", {
            name: "空间网址标识",
            exact: true,
          }).fill(slug);
          await select(administrator.page, "域类型", "教学");
          await write(
            administrator.page,
            "POST",
            "/api/v1/domains",
            () =>
              administrator.page.getByRole("button", {
                name: "创建",
                exact: true,
              }).click(),
          );
          await administrator.page.waitForURL(`${UI_URL}/d/${slug}`);
          await expect(
            administrator.page.getByRole("heading", {
              name: domainName,
              exact: true,
            }),
          ).toBeVisible();
          await joinFixture(slug, teacherEmail, admin, teacherToken);
          await fixture(
            "PUT",
            `/api/v1/domains/${slug}/members/${teacherId}/roles`,
            admin,
            { roles: ["educator"] },
          );
          number = await objectiveFixture(slug, admin, `教学客观题 ${suffix}`);
          await fixture("POST", "/api/v1/domains", admin, {
            slug: otherSlug,
            name: `另一个私有域 ${suffix}`,
            preset: "education",
          });
          await joinFixture(otherSlug, studentEmail, admin, studentToken);
          otherNumber = await objectiveFixture(
            otherSlug,
            admin,
            `另一个域客观题 ${suffix}`,
          );
        },
      );
      await step(
        "普通教师建班、生成邀请，学生通过 Web 登录接受并加入域和班级",
        async () => {
          await login(teacher.page, teacherEmail, TEST_PASSWORD);
          await gotoPage(teacher.page, `/d/${slug}/classrooms`);
          await teacher.page.getByRole("button", {
            name: "创建班级",
            exact: true,
          }).click();
          await teacher.page.getByRole("textbox", {
            name: "班级名称",
            exact: true,
          }).fill(classroomName);
          const created = await write(
            teacher.page,
            "POST",
            `/api/v1/domains/${slug}/classrooms`,
            () =>
              teacher.page.getByRole("button", {
                name: "创建并进入班级",
                exact: true,
              }).click(),
          );
          classroomId = created.data.id;
          await teacher.page.getByRole("navigation", {
            name: "班级导航",
            exact: true,
          }).getByRole("link", {
            name: "班级成员",
            exact: true,
          }).click();
          await teacher.page.getByRole("tab", {
            name: "批量导入与邀请",
            exact: true,
          }).click();
          await teacher.page.getByRole("button", { name: /指定邮箱/ }).click();
          await teacher.page.getByRole("textbox", {
            name: "受邀人邮箱",
            exact: true,
          }).fill(studentEmail);
          await teacher.page.getByRole("button", {
            name: "生成邀请",
            exact: true,
          }).click();
          const invitation = teacher.page.getByRole("textbox", {
            name: "生成的邀请链接",
            exact: true,
          });
          await expect(invitation).toHaveValue(/\/join#token=/);
          await student.page.goto(await invitation.inputValue());
          await ready(student.page);
          await student.page.getByRole("textbox", {
            name: "登录密码",
            exact: true,
          }).fill(TEST_PASSWORD);
          await student.page.getByRole("button", {
            name: "登录后接受",
            exact: true,
          }).click();
          await student.page.getByRole("button", {
            name: "接受邀请",
            exact: true,
          }).click();
          await student.page.waitForURL(
            `${UI_URL}/d/${slug}/classrooms/${classroomId}`,
          );
          await teacher.page.reload();
          await ready(teacher.page);
          await expect(
            teacher.page.getByText(studentName, { exact: true }).first(),
          ).toBeVisible();
        },
      );
      await step(
        "教师选题、预览名单并发布作业，学生实际作答与查看进度",
        async () => {
          await gotoPage(teacher.page, `/d/${slug}/classrooms/${classroomId}`);
          await teacher.page.getByRole("link", {
            name: "创建作业",
            exact: true,
          }).click();
          await teacher.page.getByRole("textbox", {
            name: "作业标题",
            exact: true,
          }).fill(title);
          await teacher.page.getByRole("textbox", {
            name: "精确题号",
            exact: true,
          }).fill(String(number));
          await teacher.page.getByRole("button", {
            name: "按题号添加",
            exact: true,
          }).click();
          await expect(
            teacher.page.getByRole("combobox", {
              name: `${number} 达标要求`,
              exact: true,
            }),
          ).toBeVisible();
          const created = await write(
            teacher.page,
            "POST",
            `/api/v1/domains/${slug}/classrooms/${classroomId}/assignments`,
            () =>
              teacher.page.getByRole("button", {
                name: "创建作业草稿",
                exact: true,
              }).click(),
          );
          assignmentId = created.data.id;
          await expect(
            teacher.page.getByRole("heading", {
              name: "发布预览",
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            teacher.page.getByText("全班学生：1 人", { exact: true }),
          ).toBeVisible();
          await publish(teacher.page, slug, assignmentId);
          await gotoPage(
            student.page,
            `/d/${slug}/assignments/${assignmentId}`,
          );
          await expect(student.page.getByText("未开始", { exact: true }))
            .toBeVisible();
          await student.page.getByRole("link", {
            name: "继续练习",
            exact: true,
          }).click();
          await student.page.waitForURL((url) =>
            url.pathname.startsWith(`/d/${slug}/problems/`)
          );
          const problemUrl = new URL(student.page.url());
          assertEquals(
            problemUrl.searchParams.get("assignment_id"),
            assignmentId,
          );
          const assignmentItemId = problemUrl.searchParams.get(
            "assignment_item_id",
          );
          assertEquals(typeof assignmentItemId, "string");
          await student.page.getByRole("checkbox", {
            name: "待改进选项",
            exact: true,
          }).check();
          await student.page.getByRole("button", { name: "交卷", exact: true })
            .click();
          const submitted = await write(
            student.page,
            "POST",
            `/api/v1/domains/${slug}/problems/${number}/objective-submissions`,
            () =>
              student.page.getByRole("button", { name: "确认", exact: true })
                .click(),
          );
          const origin = {
            assignment_id: assignmentId,
            assignment_item_id: assignmentItemId,
          };
          assertEquals(submitted.data.assignment_origin, origin);
          objectiveSubmissionId = submitted.data.submission_id;
          const history = await apiGet(
            `/api/v1/domains/${slug}/objective-submissions/${submitted.data.submission_id}`,
            studentToken,
          );
          assertEquals(history.status, 200);
          assertEquals(
            (history.body as { data: { assignment_origin: unknown } }).data
              .assignment_origin,
            origin,
          );
          await expect(
            student.page.getByText("本次成绩：0 分", { exact: true }),
          ).toBeVisible();
          await gotoPage(
            student.page,
            `/d/${slug}/assignments/${assignmentId}`,
          );
          await expect(student.page.getByText("0 · 未达标", { exact: true }))
            .toBeVisible({ timeout: 15000 });
          await teacher.page.getByRole("button", {
            name: "刷新成绩",
            exact: true,
          }).click();
          await expect(
            teacher.page.getByRole("table", { name: "学生成绩矩阵" }),
          ).toContainText(studentName);
          await expect(
            teacher.page.getByRole("button", {
              name: `${studentName} ${number} 0 · 未达标`,
              exact: true,
            }),
          ).toBeVisible();
        },
      );
      await step(
        "学生求助，教师反馈、回复并处理，学生 Web 读取反馈与回复",
        async () => {
          await student.page.getByRole("textbox", {
            name: "求助正文",
            exact: true,
          }).fill(question);
          await student.page.getByRole("button", {
            name: "向老师求助",
            exact: true,
          }).click();
          await expect(
            student.page.getByRole("button", {
              name: `${question} 待处理`,
              exact: true,
            }),
          ).toBeVisible();
          await teacher.page.reload();
          await ready(teacher.page);
          await teacher.page.getByRole("textbox", {
            name: "作业反馈正文",
            exact: true,
          }).fill(feedback);
          await teacher.page.getByRole("button", {
            name: "发送反馈",
            exact: true,
          }).click();
          await expect(teacher.page.getByText(feedback, { exact: true }))
            .toBeVisible();
          await teacher.page.getByRole("button", {
            name: `${question} 待处理`,
            exact: true,
          }).click();
          await teacher.page.getByRole("textbox", {
            name: "求助回复",
            exact: true,
          }).fill(reply);
          await teacher.page.getByRole("button", { name: "回复", exact: true })
            .click();
          await expect(teacher.page.getByText(reply, { exact: true }))
            .toBeVisible();
          await teacher.page.getByRole("button", {
            name: "标记已处理",
            exact: true,
          }).click();
          await expect(
            teacher.page.getByRole("button", {
              name: `${question} 已处理`,
              exact: true,
            }),
          ).toBeVisible();
          await student.page.reload();
          await expect(student.page.getByText(feedback, { exact: true }))
            .toBeVisible();
          await student.page.getByRole("button", {
            name: `${question} 已处理`,
            exact: true,
          }).click();
          await expect(student.page.getByText(reply, { exact: true }))
            .toBeVisible();
        },
      );
      await step(
        "教师从未达标名单生成补题、预览并发布，390px矩阵保持操作可用",
        async () => {
          await teacher.page.getByRole("button", {
            name: "为全班未达标学生布置补题",
            exact: true,
          }).click();
          const modal = teacher.page.getByRole("dialog", {
            name: "全班补题候选预览",
          });
          await expect(
            modal.getByRole("checkbox", { name: studentName, exact: true }),
          ).toBeChecked();
          await modal.getByRole("textbox", {
            name: "补题任务标题",
            exact: true,
          }).fill(`${title} 补题`);
          const created = await write(
            teacher.page,
            "POST",
            `/api/v1/domains/${slug}/assignments/${assignmentId}/remediation`,
            () =>
              modal.getByRole("button", { name: "创建补题草稿", exact: true })
                .click(),
          );
          await expect(
            teacher.page.getByRole("heading", {
              name: `${title} 补题`,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            teacher.page.getByText("指定学生：1 人", { exact: true }),
          ).toBeVisible();
          await publish(teacher.page, slug, created.data.id);
          await gotoPage(student.page, `/d/${slug}/classrooms/${classroomId}`);
          await expect(
            student.page.getByRole("heading", {
              name: `${title} 补题`,
              exact: true,
            }),
          ).toBeVisible();
          await gotoPage(
            teacher.page,
            `/d/${slug}/assignments/${assignmentId}`,
          );
          await teacher.page.setViewportSize({ width: 390, height: 844 });
          await expect(
            teacher.page.getByRole("table", { name: "学生成绩矩阵" }),
          ).toBeHidden();
          const card = teacher.page.locator("div.sm\\:hidden").filter({
            has: teacher.page.getByRole("heading", {
              name: studentName,
              exact: true,
            }),
          });
          await expect(card).toBeVisible();
          await card.getByRole("button", { name: "0 · 未达标", exact: true })
            .click();
          await expect(
            teacher.page.getByRole("dialog", { name: / · / }),
          ).toBeVisible();
          const panel = teacher.page.getByRole("dialog", {
            name: / · /,
          });
          const path =
            `/api/v1/domains/${slug}/classrooms/${classroomId}/submissions/objective/${objectiveSubmissionId}/attempts`;
          // 将监听与点击绑定在同一个 Promise.all 中，失败时也会被当前
          // step 捕获，避免先创建未被消费的 waitForResponse 悬空拒绝。
          const [response] = await Promise.all([
            teacher.page.waitForResponse((result) =>
              result.request().method() === "GET" &&
              new URL(result.url()).pathname === path
            ),
            panel.locator("div.divide-y > button").filter({
              hasText: "客观题",
            }).click(),
          ]);
          assertEquals(response.status(), 200);
          const evidence = await response.json();
          assertEquals(evidence.data.data.length, 1);
          assertEquals(evidence.data.data[0].score, 0);
          assertEquals(evidence.data.data[0].current_formal, true);
          assertEquals(evidence.data.data[0].matches_policy, true);
          await expect(panel.getByRole("heading", {
            name: "正式评测沿革",
            exact: true,
          })).toBeVisible();
          await expect(
            panel.getByText("该版本当前正式判定 · 符合当前版本策略", {
              exact: true,
            }),
          ).toBeVisible();
        },
      );
      await step(
        "同账号两个私有域标签页保留各自草稿，提交与导航归属不串域",
        async () => {
          const second = await student.context.newPage();
          await gotoPage(student.page, `/d/${slug}/problems/${number}`);
          await student.page.getByRole("checkbox", {
            name: "正确选项",
            exact: true,
          }).check();
          await gotoPage(second, `/d/${otherSlug}/problems/${otherNumber}`);
          await second.getByRole("checkbox", {
            name: "待改进选项",
            exact: true,
          }).check();
          await expect(
            student.page.getByRole("checkbox", {
              name: "正确选项",
              exact: true,
            }),
          ).toBeChecked();
          await expect(
            second.getByRole("checkbox", { name: "正确选项", exact: true }),
          ).not.toBeChecked();
          await second.getByRole("button", { name: "交卷", exact: true })
            .click();
          await write(
            second,
            "POST",
            `/api/v1/domains/${otherSlug}/problems/${otherNumber}/objective-submissions`,
            () =>
              second.getByRole("button", { name: "确认", exact: true }).click(),
          );
          await student.page.getByRole("button", { name: "交卷", exact: true })
            .click();
          await write(
            student.page,
            "POST",
            `/api/v1/domains/${slug}/problems/${number}/objective-submissions`,
            () =>
              student.page.getByRole("button", { name: "确认", exact: true })
                .click(),
          );
          await expect(
            student.page.getByText("本次成绩：100 分", { exact: true }),
          ).toBeVisible();
          await expect(second.getByText("本次成绩：0 分", { exact: true }))
            .toBeVisible();
          await student.page.getByRole("button", {
            name: "用户菜单",
            exact: true,
          }).click();
          await student.page.getByRole("menuitem", {
            name: "切换域",
            exact: true,
          }).hover();
          await student.page.getByRole("menuitem", {
            name: `另一个私有域 ${suffix} · ${otherSlug}`,
            exact: true,
          })
            .click();
          await student.page.waitForURL(`${UI_URL}/d/${otherSlug}`);
          await second.reload();
          await expect(
            second.getByText(
              `提交归属 ${otherSlug}，来源题号 ${otherNumber}。`,
              { exact: true },
            ),
          ).toBeVisible();
          await second.close();
        },
      );
      assertEquals(errors, []);
      failed = false;
    } finally {
      for (
        const [label, session] of [["administrator", administrator], [
          "teacher",
          teacher,
        ], ["student", student]] as const
      ) {
        await teardownBrowser(
          session,
          failed,
          `workspace-teaching-${label}-${suffix}`,
        );
      }
    }
  },
});
