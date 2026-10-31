/// <reference lib="dom" />
/** 私有学校邀请注册与不可变代码批注；注册、评测和批注均经过真实页面。 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.13";
import { expect } from "npm:playwright@1.62.1/test";
import { createCodingProblemFixture } from "../../fixtures/coding-problem.ts";
import { domainAnswerKey } from "../../../noj-ui/utils/domain-problems.ts";
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
type Setting = {
  key: string;
  effective_value: unknown;
  updated_at: string | null;
};

async function fixture<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await api(method, path, { token, body, headers });
  assertEquals(
    response.status >= 200 && response.status < 300,
    true,
    `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`,
  );
  return response.body as T;
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

async function write(
  page: Page,
  method: string,
  path: string,
  action: () => Promise<unknown>,
) {
  const [response] = await Promise.all([
    page.waitForResponse((result) =>
      new URL(result.url()).pathname === path &&
      result.request().method() === method
    ),
    action(),
  ]);
  const body = await response.json();
  assertEquals(response.ok(), true, JSON.stringify(body));
  return body;
}

async function login(page: Page, username: string) {
  await gotoPage(page, "/login");
  await page.getByPlaceholder("请输入用户名或邮箱").fill(username);
  await page.getByPlaceholder("至少 8 位，需包含大小写字母和数字").fill(
    TEST_PASSWORD,
  );
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

async function consent(page: Page) {
  const response = await page.request.get(`${UI_URL}/api/v1/auth/me`);
  assertEquals(response.status(), 200);
  const identity = await response.json();
  if (collectPendingConsents(identity.data.legal).length) {
    await page.getByRole("button", { name: "我已知悉并同意", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "政策更新通知" }))
      .toBeHidden();
  }
  return identity.data as { id: string; username: string; is_admin: boolean };
}

/** 草稿恢复提供代码输入；正式上传、版本绑定与结果显示仍走真实编辑器和 Judge。 */
async function submit(
  page: Page,
  slug: string,
  reference: string,
  actor: string,
  problem: { reference: { problem_id: string }; version_id: string },
  code: string,
  score: number,
) {
  const key = `noj:draft:${
    domainAnswerKey(
      actor,
      slug,
      problem.reference.problem_id,
      problem.version_id,
      "python3",
    )
  }`;
  await page.evaluate(({ key, code }) => {
    localStorage.setItem(key, JSON.stringify({ code, answers: {} }));
  }, { key, code });
  await gotoPage(page, `/d/${slug}/problems/${reference}`);
  // 题目页同时有页头 CTA 和正文 CTA；两者指向同一真实作答入口。
  await page.getByRole("link", { name: "开始编码", exact: true }).first()
    .click();
  await page.locator(".monaco-editor").first().waitFor({ timeout: 30_000 });
  const created = await write(
    page,
    "POST",
    `/api/v1/domains/${slug}/submissions`,
    () =>
      page.getByRole("toolbar", { name: "代码工具栏" }).getByRole("button", {
        name: "提交评测",
        exact: true,
      }).click(),
  );
  const id = created.data.id as string;
  await page.getByRole("link", { name: "查看评测", exact: true }).click();
  await page.waitForURL((url) =>
    url.pathname === `/d/${slug}/submissions/${id}`
  );
  // DomainSubmissionResult 使用结果状态标题（如“通过”/“评测完成”），
  // 分数是独立指标胶囊，不再挂在旧的“评测结果”标题下。
  // 分数数值与单位是相邻的独立节点；定位格式化后的数值节点。
  await expect(page.getByText(score.toFixed(1), { exact: true }).first())
    .toBeVisible({
      timeout: 60_000,
    });
  await expect(page.getByText(code, { exact: true })).toBeVisible();
  return id;
}

async function openStudentReview(
  page: Page,
  slug: string,
  assignmentId: string,
  id: string,
) {
  // 投影是异步生成；只等待真实来源 ID，不写入成绩或教学进度。
  await expect.poll(async () => {
    const response = await page.request.get(
      `${UI_URL}/api/v1/domains/${slug}/assignments/${assignmentId}/progress`,
    );
    if (response.status() === 409) return null;
    assertEquals(response.status(), 200);
    return (await response.json()).data.cells[0]?.source_submission_id;
  }, { timeout: 20_000 }).toBe(id);
  await gotoPage(page, `/d/${slug}/assignments/${assignmentId}`);
  await page.getByRole("button", { name: "查看原提交", exact: true }).click();
  const panel = page.getByRole("dialog", { name: / · / });
  await expect(
    panel.getByText(`原提交 ${id} · 批注保留在这份代码上`, { exact: true }),
  )
    .toBeVisible();
  await expect(panel.getByRole("list", { name: "原提交代码" })).toBeVisible();
  return panel;
}

Deno.test({
  name:
    "[ui/private-registration-annotations] 邀请新账号进入单域学校，原代码批注与新提交隔离",
  ignore: !BROWSER_E2E,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const suffix = `${Date.now().toString(36)}${
      crypto.randomUUID().slice(0, 4)
    }`;
    const slug = `web-private-${suffix}`, school = `邀请学校 ${suffix}`;
    const teacherName = `private_teacher_${suffix}`,
      teacherEmail = `${teacherName}@test.com`;
    const studentName = `private_student_${suffix}`,
      studentEmail = `${studentName}@test.com`;
    const wrong = "def solve(input_str):\n    return '0'\n";
    const correct =
      "def solve(input_str):\n    return str(sum(map(int, input_str.split())))\n";
    const originalNote = `批注 ${suffix}：此处还没有计算两个数的和。`;
    const editedNote = `修改 ${suffix}：解析输入后返回两数之和。`;
    const retainedNote = `保留 ${suffix}：此建议只对应第一份代码。`;
    const archiveNote = `归档反馈 ${suffix}：这条批注对应修改后的第二份代码。`;
    const admin = await getAdminToken();
    const teacherToken = await registerUser(
      teacherName,
      teacherEmail,
      TEST_PASSWORD,
    );
    await fixture("POST", "/api/v1/domains", admin, {
      slug,
      name: school,
      preset: "education",
    });
    const domainPath = `/api/v1/domains/${slug}`;
    const invitation = await fixture<{ data: { token: string } }>(
      "POST",
      `${domainPath}/invitations`,
      admin,
      { email: teacherEmail },
    );
    await fixture("POST", "/api/v1/domain-invitations/accept", teacherToken, {
      token: invitation.data.token,
    });
    const teacherId = (await fixture<{ data: { id: string } }>(
      "GET",
      "/api/v1/auth/me",
      teacherToken,
    )).data.id;
    await fixture("POST", `${domainPath}/transfer`, admin, {
      user_id: teacherId,
    });
    const classroom = await fixture<{ data: { id: string } }>(
      "POST",
      `${domainPath}/classrooms`,
      teacherToken,
      { name: `代码批注班 ${suffix}` },
    );
    const classroomId = classroom.data.id;
    const studentInvite = await fixture<{ data: { token: string } }>(
      "POST",
      `${domainPath}/classrooms/${classroomId}/invitations`,
      teacherToken,
      { email: studentEmail },
    );
    const sourceId = await createCodingProblemFixture();
    const source = await fixture<{ data: { number: number } }>(
      "GET",
      `/api/v1/problems/${sourceId}`,
      admin,
    );
    const binding = await fixture<{
      data: { binding: { id: string }; reference: { display_ref: string } };
    }>(
      "POST",
      `${domainPath}/problem-bindings`,
      admin,
      { source_ref: `main:${source.data.number}` },
    );
    const reference = binding.data.reference.display_ref;
    const problem = await fixture<
      { reference: { problem_id: string }; version_id: string }
    >(
      "GET",
      `${domainPath}/problems/${reference}`,
      teacherToken,
    );
    const settings = (await fixture<{ data: Setting[] }>(
      "GET",
      "/api/v1/admin/system/settings",
      admin,
    )).data;
    const policyValues: Record<string, unknown> = {
      instance_registration_mode: "invite",
      allow_domain_registration_invites: true,
      instance_access: "authenticated",
    };
    async function setPolicy(key: string, value: unknown) {
      const current = (await fixture<{ data: Setting[] }>(
        "GET",
        "/api/v1/admin/system/settings",
        admin,
      )).data
        .find((setting) => setting.key === key)!;
      await fixture(
        "PUT",
        `/api/v1/admin/system/settings/${key}`,
        admin,
        { value },
        current.updated_at
          ? { "If-Match": `"${current.updated_at}"` }
          : undefined,
      );
    }
    const teacher = await launchBrowser(), student = await launchBrowser();
    let failed = true,
      studentId = "",
      assignmentId = "",
      firstId = "",
      secondId = "";
    async function step(name: string, action: () => Promise<void>) {
      assertEquals(await t.step(name, action), true, name);
    }
    try {
      for (const [key, value] of Object.entries(policyValues)) {
        await setPolicy(key, value);
      }
      await step(
        "新学生凭班级邀请在Web注册、验证邮箱并进入唯一学校",
        async () => {
          await gotoPage(
            student.page,
            `/register#invitation=${studentInvite.data.token}`,
          );
          await expect(student.page.getByPlaceholder("请输入邮箱地址"))
            .toHaveValue(studentEmail);
          await expect(student.page.getByPlaceholder("请输入邮箱地址"))
            .toBeDisabled();
          await student.page.getByPlaceholder("3-30 位字母、数字或下划线").fill(
            studentName,
          );
          await student.page.getByPlaceholder(
            "至少 8 位，需包含大小写字母和数字",
          ).fill(TEST_PASSWORD);
          await student.page.getByPlaceholder("再次输入密码").fill(
            TEST_PASSWORD,
          );
          await student.page.getByRole("checkbox", {
            name: "同意服务条款与隐私政策",
          }).check();
          const registered = await write(
            student.page,
            "POST",
            "/api/v1/auth/register",
            () =>
              student.page.getByRole("button", { name: "注册", exact: true })
                .click(),
          );
          await student.page.waitForURL((url) =>
            url.pathname === "/verify-email" &&
            url.searchParams.get("registered") === "1"
          );
          assertEquals(
            new URL(student.page.url()).searchParams.get("redirect"),
            `/d/${slug}`,
          );
          // E2E 提供实际一次性令牌，打开与邮箱验证链接相同的页面，不直接调用验证 API。
          const verification = registered.data
            .email_verification_token as string;
          assertEquals(typeof verification, "string");
          await gotoPage(
            student.page,
            `/verify-email?token=${encodeURIComponent(verification)}&redirect=${
              encodeURIComponent(`/d/${slug}`)
            }`,
          );
          await expect(student.page.getByText("邮箱验证成功", { exact: false }))
            .toBeVisible();
          await student.page.getByRole("link", {
            name: "进入空间",
            exact: true,
          }).click();
          await student.page.waitForURL((url) => url.pathname === `/d/${slug}`);
          const identity = await consent(student.page);
          studentId = identity.id;
          assertEquals(identity.username, studentName);
          assertEquals(identity.is_admin, false);
          const spaces = await student.page.request.get(
            `${UI_URL}/api/v1/me/domains`,
          );
          assertEquals(spaces.status(), 200);
          assertEquals(
            new Set(
              (await spaces.json()).data.map((space: { slug: string }) =>
                space.slug
              ),
            ),
            new Set([slug, "main"]),
          );
          await expect(student.page.getByTestId("domain-identity")).toHaveText(
            `${studentName}@${slug}`,
          );
          await expect(
            student.page.getByRole("button", { name: "切换空间", exact: true }),
          ).toHaveCount(0);
          const room = await student.page.request.get(
            `${UI_URL}${domainPath}/classrooms/${classroomId}`,
          );
          assertEquals(room.status(), 200);
          assertEquals((await room.json()).data.membership.role, "student");
          await student.page.getByRole("button", {
            name: "用户菜单",
            exact: true,
          }).click();
          await student.page.getByRole("menuitem", {
            name: "登出",
            exact: true,
          }).click();
          await student.page.getByRole("button", {
            name: "确认登出",
            exact: true,
          }).click();
          await expect(student.page.locator('a[href^="/login"]').first())
            .toBeVisible();
          await login(student.page, studentName);
          await student.page.waitForURL((url) => url.pathname === `/d/${slug}`);
          await expect(student.page.getByTestId("domain-identity")).toHaveText(
            `${studentName}@${slug}`,
          );
          await expect(
            student.page.getByRole("button", { name: "切换空间", exact: true }),
          ).toHaveCount(0);
        },
      );
      await step(
        "普通教师准备作业，新学生通过页面提交错误代码并获得真实零分",
        async () => {
          const draft = await fixture<
            { data: { id: string; revision: number } }
          >(
            "POST",
            `${domainPath}/classrooms/${classroomId}/assignments`,
            teacherToken,
            {
              title: `原代码反馈 ${suffix}`,
              deadline_at: new Date(Date.now() + 3_600_000).toISOString(),
              items: [{
                binding_id: binding.data.binding.id,
                requirement: "accepted",
              }],
            },
          );
          assignmentId = draft.data.id;
          await fixture(
            "POST",
            `${domainPath}/assignments/${assignmentId}/publish`,
            teacherToken,
            {},
            {
              "If-Match": String(draft.data.revision),
              "Idempotency-Key": crypto.randomUUID(),
            },
          );
          firstId = await submit(
            student.page,
            slug,
            reference,
            studentId,
            problem,
            wrong,
            0,
          );
          const panel = await openStudentReview(
            student.page,
            slug,
            assignmentId,
            firstId,
          );
          await expect(
            panel.getByRole("button", { name: "保存行批注", exact: true }),
          ).toHaveCount(0);
        },
      );
      await step("教师查看原代码、撰写批注，学生在原提交页面读取", async () => {
        await login(teacher.page, teacherName);
        await gotoPage(teacher.page, `/d/${slug}/assignments/${assignmentId}`);
        await consent(teacher.page);
        await teacher.page.getByRole("table", { name: "学生成绩矩阵" })
          .getByRole("button", {
            name: `${studentName} ${reference} 0 · 未达标`,
            exact: true,
          }).click();
        const panel = teacher.page.getByRole("dialog", {
          name: / · /,
        });
        // 模拟其他页面请求完成后发布同一账号的新资料，不能被误判为切换账号。
        const identity = await teacher.page.request.get(
          `${UI_URL}/api/v1/auth/me`,
        );
        assertEquals(identity.status(), 200);
        const refreshedUserId = await teacher.page.evaluate((current) => {
          const root = document.querySelector("#__nuxt") as Element & {
            __vue_app__: {
              $nuxt: { payload: { state: Record<string, unknown> } };
            };
          };
          const state = root.__vue_app__.$nuxt.payload.state;
          const previous = state["$sauth:user"] as { id: string };
          state["$sauth:user"] = current;
          return previous.id;
        }, (await identity.json()).data);
        assertEquals(refreshedUserId, teacherId);
        await panel.locator("div.divide-y > button").filter({
          hasText: /^0 分/,
        }).click();
        await expect(panel.getByRole("list", { name: "原提交代码" }))
          .toContainText("return '0'");
        await panel.getByRole("spinbutton", { name: "批注起始行" }).fill("1");
        await panel.getByRole("spinbutton", { name: "批注结束行" }).fill("2");
        await panel.getByRole("textbox", { name: "行批注正文", exact: true })
          .fill(originalNote);
        const path =
          `${domainPath}/classrooms/${classroomId}/submissions/submission/${firstId}/annotations`;
        const note = await write(
          teacher.page,
          "POST",
          path,
          () =>
            panel.getByRole("button", { name: "保存行批注", exact: true })
              .click(),
        );
        assertEquals(note.data.submission_id, firstId);
        assertEquals(note.data.start_line, 1);
        assertEquals(note.data.end_line, 2);
        assertEquals(note.data.author_id, teacherId);
        await expect(panel.getByText(originalNote, { exact: true }))
          .toBeVisible();
        const studentPanel = await openStudentReview(
          student.page,
          slug,
          assignmentId,
          firstId,
        );
        await expect(studentPanel.getByText(originalNote, { exact: true }))
          .toBeVisible();
      });
      await step("教师修改并撤回批注，学生重读可见范围同步更新", async () => {
        const panel = teacher.page.getByRole("dialog", {
          name: / · /,
        });
        await panel.getByRole("button", { name: "修改", exact: true }).click();
        await panel.getByRole("textbox", { name: "修改行批注正文" }).fill(
          editedNote,
        );
        const annotationsPath =
          `${domainPath}/classrooms/${classroomId}/submissions/submission/${firstId}/annotations`;
        const update = teacher.page.waitForResponse((response) =>
          response.request().method() === "PATCH" &&
          new URL(response.url()).pathname.startsWith(`${annotationsPath}/`)
        );
        await panel.getByRole("button", { name: "保存修改", exact: true })
          .click();
        assertEquals((await update).status(), 200);
        await expect(panel.getByText(editedNote, { exact: true }))
          .toBeVisible();
        let studentPanel = await openStudentReview(
          student.page,
          slug,
          assignmentId,
          firstId,
        );
        await expect(studentPanel.getByText(editedNote, { exact: true }))
          .toBeVisible();
        await expect(studentPanel.getByText(originalNote, { exact: true }))
          .toHaveCount(0);
        await panel.getByRole("button", { name: "撤回", exact: true }).click();
        const withdrawal = teacher.page.waitForResponse((response) =>
          response.request().method() === "PATCH" &&
          new URL(response.url()).pathname.startsWith(`${annotationsPath}/`)
        );
        await teacher.page.getByRole("dialog", {
          name: "撤回行批注",
          exact: true,
        }).getByRole("button", { name: "确认", exact: true }).click();
        assertEquals((await withdrawal).status(), 200);
        await expect(panel.getByText(editedNote, { exact: true })).toHaveCount(
          0,
        );
        studentPanel = await openStudentReview(
          student.page,
          slug,
          assignmentId,
          firstId,
        );
        await expect(studentPanel.getByText(editedNote, { exact: true }))
          .toHaveCount(0);
        await panel.getByRole("textbox", { name: "行批注正文", exact: true })
          .fill(retainedNote);
        await write(
          teacher.page,
          "POST",
          annotationsPath,
          () =>
            panel.getByRole("button", { name: "保存行批注", exact: true })
              .click(),
        );
        studentPanel = await openStudentReview(
          student.page,
          slug,
          assignmentId,
          firstId,
        );
        await expect(studentPanel.getByText(retainedNote, { exact: true }))
          .toBeVisible();
      });
      await step(
        "新代码经Judge获得满分，不继承旧批注，原提交仍保留反馈",
        async () => {
          secondId = await submit(
            student.page,
            slug,
            reference,
            studentId,
            problem,
            correct,
            10,
          );
          assertNotEquals(secondId, firstId);
          const panel = await openStudentReview(
            student.page,
            slug,
            assignmentId,
            secondId,
          );
          await expect(panel.getByRole("list", { name: "原提交代码" }))
            .toContainText("sum(map(int, input_str.split()))");
          await expect(panel.getByText(retainedNote, { exact: true }))
            .toHaveCount(0);
          await expect(panel.locator("article")).toHaveCount(0);
          await gotoPage(
            teacher.page,
            `/d/${slug}/classrooms/${classroomId}/students/${studentId}`,
          );
          await teacher.page.locator("div.divide-y > button").filter({
            hasText: reference,
          }).filter({
            has: teacher.page.getByText(/(?:^| · )0 分$/),
          }).click();
          const original = teacher.page.getByRole("dialog", {
            name: "原提交与教学批注",
          });
          await expect(
            original.getByText(`原提交 ${firstId} · 批注保留在这份代码上`, {
              exact: true,
            }),
          ).toBeVisible();
          await expect(original.getByText(retainedNote, { exact: true }))
            .toBeVisible();
        },
      );
      await step(
        "教师通过Web归档班级，双方重读旧作业成绩和原代码批注",
        async () => {
          await gotoPage(
            teacher.page,
            `/d/${slug}/assignments/${assignmentId}`,
          );
          await teacher.page.getByRole("table", { name: "学生成绩矩阵" })
            .getByRole("button", {
              name: `${studentName} ${reference} 10 · 已达标`,
              exact: true,
            }).click();
          let panel = teacher.page.getByRole("dialog", {
            name: / · /,
          });
          await panel.locator("div.divide-y > button").filter({
            hasText: /10 分/,
          }).click();
          await expect(
            panel.getByText(`原提交 ${secondId} · 批注保留在这份代码上`, {
              exact: true,
            }),
          ).toBeVisible();
          await panel.getByRole("textbox", { name: "行批注正文", exact: true })
            .fill(archiveNote);
          await write(
            teacher.page,
            "POST",
            `${domainPath}/classrooms/${classroomId}/submissions/submission/${secondId}/annotations`,
            () =>
              panel.getByRole("button", { name: "保存行批注", exact: true })
                .click(),
          );
          await gotoPage(
            teacher.page,
            `/d/${slug}/classrooms/${classroomId}/settings`,
          );
          await teacher.page.getByRole("button", {
            name: "归档此班级并保留历史",
            exact: true,
          }).click();
          const archived = await write(
            teacher.page,
            "POST",
            `${domainPath}/classrooms/${classroomId}/archive`,
            () =>
              teacher.page.getByRole("button", { name: "确认", exact: true })
                .click(),
          );
          assertEquals(archived.data.status, "archived");
          await expect(
            teacher.page.getByText(
              "当前只能读取班级设置，无权修改配置",
              { exact: true },
            ),
          ).toBeVisible();
          const ownPanel = await openStudentReview(
            student.page,
            slug,
            assignmentId,
            secondId,
          );
          await expect(ownPanel.getByText(archiveNote, { exact: true }))
            .toBeVisible();
          await expect(ownPanel.getByText("10 · 已达标", { exact: true }))
            .toBeVisible();
          await gotoPage(
            teacher.page,
            `/d/${slug}/assignments/${assignmentId}`,
          );
          await teacher.page.getByRole("table", { name: "学生成绩矩阵" })
            .getByRole("button", {
              name: `${studentName} ${reference} 10 · 已达标`,
              exact: true,
            }).click();
          panel = teacher.page.getByRole("dialog", { name: / · / });
          await panel.locator("div.divide-y > button").filter({
            hasText: /10 分/,
          }).click();
          await expect(panel.getByText(archiveNote, { exact: true }))
            .toBeVisible();
          await expect(
            panel.getByRole("button", { name: "保存行批注", exact: true }),
          ).toHaveCount(0);
          await expect(panel.getByRole("button", { name: "修改", exact: true }))
            .toHaveCount(0);
        },
      );
      failed = false;
    } finally {
      for (const key of Object.keys(policyValues)) {
        await setPolicy(
          key,
          settings.find((setting) => setting.key === key)!.effective_value,
        );
      }
      const restored = (await fixture<{ data: Setting[] }>(
        "GET",
        "/api/v1/admin/system/settings",
        admin,
      )).data;
      for (const key of Object.keys(policyValues)) {
        assertEquals(
          restored.find((setting) => setting.key === key)!.effective_value,
          settings.find((setting) => setting.key === key)!.effective_value,
          `恢复实例政策 ${key}`,
        );
      }
      await teardownBrowser(
        teacher,
        failed,
        `private-annotations-teacher-${suffix}`,
      );
      await teardownBrowser(
        student,
        failed,
        `private-registration-student-${suffix}`,
      );
    }
  },
});
