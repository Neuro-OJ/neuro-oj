import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  api,
  e2eTest,
  getAdminToken,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

interface Account {
  id: string;
  email: string;
  token: string;
}
interface Cell {
  status: string;
  score: number | null;
  accepted: boolean;
  source_submission_id: string | null;
}

// 只封装传输和状态断言；错误响应原样留在失败信息中，不重试授权失败。
async function request<T>(
  method: string,
  path: string,
  token: string | undefined,
  status: number,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await api(method, `/api/v1${path}`, {
    token,
    body,
    headers,
  });
  assertEquals(
    response.status,
    status,
    `${method} ${path}: ${JSON.stringify(response.body)}`,
  );
  return response.body as T;
}

async function account(label: string, suffix: string): Promise<Account> {
  const username = `${label}_${suffix}`;
  const email = `${username}@test.com`;
  const token = await registerUser(username, email, TEST_PASSWORD);
  const me = await request<{ data: { id: string } }>(
    "GET",
    "/auth/me",
    token,
    200,
  );
  return { id: me.data.id, email, token };
}

async function invite(
  path: string,
  inviter: string,
  recipient: Account,
) {
  const invitation = await request<{ data: { token: string } }>(
    "POST",
    `${path}/invitations`,
    inviter,
    201,
    { email: recipient.email },
  );
  await request(
    "POST",
    "/domain-invitations/accept",
    recipient.token,
    200,
    { token: invitation.data.token },
  );
}

async function assignment(
  slug: string,
  classroomId: string,
  bindingId: string,
  coach: string,
  title: string,
) {
  const draft = await request<{ data: { id: string; revision: number } }>(
    "POST",
    `/domains/${slug}/classrooms/${classroomId}/assignments`,
    coach,
    201,
    {
      title,
      deadline_at: new Date(Date.now() + 3_600_000).toISOString(),
      items: [{ binding_id: bindingId, requirement: "accepted" }],
    },
  );
  await request(
    "POST",
    `/domains/${slug}/assignments/${draft.data.id}/publish`,
    coach,
    200,
    {},
    {
      "If-Match": String(draft.data.revision),
      "Idempotency-Key": crypto.randomUUID(),
    },
  );
  const published = await request<{ data: { items: { id: string }[] } }>(
    "GET",
    `/domains/${slug}/assignments/${draft.data.id}`,
    coach,
    200,
  );
  return { id: draft.data.id, itemId: published.data.items[0].id };
}

async function progress(slug: string, assignmentId: string, token: string) {
  const response = await request<
    { data: { updating: boolean; cells: Cell[] } }
  >(
    "GET",
    `/domains/${slug}/assignments/${assignmentId}/progress`,
    token,
    200,
  );
  assertEquals(response.data.updating, false);
  assertEquals(response.data.cells.length, 1);
  return response.data.cells[0];
}

e2eTest(
  "[e2e/workspace-teaching] Public 与两个私有域：角色、自动计入、互动及共享撤销",
  async () => {
    await waitForServer();
    const suffix = `${Date.now().toString(36)}${
      crypto.randomUUID().slice(0, 4)
    }`;
    const admin = await getAdminToken();
    const ownerA = await account("ws_owner_a", suffix);
    const ownerB = await account("ws_owner_b", suffix);
    const mixed = await account("ws_mixed", suffix);
    const peer = await account("ws_peer", suffix);
    const slugA = `school-a-${suffix}`, slugB = `school-b-${suffix}`;

    // 学校负责人使用普通平台账号；不能拿平台治理 token 验证域隔离。
    for (const [slug, owner] of [[slugA, ownerA], [slugB, ownerB]] as const) {
      await request("POST", "/domains", admin, 201, {
        slug,
        name: `教学验收 ${slug}`,
        preset: "education",
      });
      await invite(`/domains/${slug}`, admin, owner);
      await request("POST", `/domains/${slug}/transfer`, admin, 200, {
        user_id: owner.id,
      });
    }
    await request("GET", `/domains/${slugB}`, ownerA.token, 404);
    await request("GET", `/domains/${slugA}`, ownerB.token, 404);
    await request("GET", `/domains/${slugA}`, undefined, 404);

    const classA = await request<{ data: { id: string } }>(
      "POST",
      `/domains/${slugA}/classrooms`,
      ownerA.token,
      201,
      { name: "A 域学生班" },
    );
    for (const student of [mixed, peer]) {
      await invite(
        `/domains/${slugA}/classrooms/${classA.data.id}`,
        ownerA.token,
        student,
      );
    }
    await invite(`/domains/${slugB}`, ownerB.token, mixed);
    await request(
      "PUT",
      `/domains/${slugB}/members/${mixed.id}/roles`,
      ownerB.token,
      200,
      { roles: ["educator"] },
    );
    const classB = await request<{ data: { id: string } }>(
      "POST",
      `/domains/${slugB}/classrooms`,
      mixed.token,
      201,
      { name: "B 域教练班" },
    );
    await invite(
      `/domains/${slugB}/classrooms/${classB.data.id}`,
      mixed.token,
      peer,
    );

    // 公共题通过真实共享草稿及显式发布建立，客观题判定不依赖 Judge 探测跳过。
    const created = await request<{
      problem_id: string;
      number: number;
      draft_revision: number;
    }>("POST", "/domains/main/problems", admin, 201, {
      title: `跨域教学客观题 ${suffix}`,
      description: "计算 1 + 1。",
      is_objective: true,
      visibility: "public",
    });
    const mainProblem = `/domains/main/problems/${created.number}`;
    const saved = await request<{ revision: number }>(
      "PUT",
      `${mainProblem}/draft`,
      admin,
      200,
      {
        content: {
          kind: "objective",
          title: `跨域教学客观题 ${suffix}`,
          description: "计算 1 + 1。",
          samples: [],
          questions: [{
            key: "sum",
            sort_order: 0,
            type: "single",
            prompt: "1 + 1 等于多少？",
            options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
            answer: ["A"],
            explanation: "两个一相加等于二。",
          }],
        },
      },
      { "If-Match": String(created.draft_revision) },
    );
    const published = await request<{ version_id: string }>(
      "POST",
      `${mainProblem}/publish`,
      admin,
      200,
      { change_note: "跨工作空间教学旅程" },
      { "If-Match": String(saved.revision) },
    );
    const sharing = await request<{ data: { revision: number } }>(
      "POST",
      `${mainProblem}/sharing`,
      admin,
      200,
      { enabled: true, scope: "all", target_domain_slugs: [] },
      { "If-Match": "0" },
    );
    const sourceRef = `main:${created.number}`;
    const bindingA = await request<{ data: { binding: { id: string } } }>(
      "POST",
      `/domains/${slugA}/problem-bindings`,
      ownerA.token,
      201,
      { source_ref: sourceRef },
    );
    const bindingB = await request<{ data: { binding: { id: string } } }>(
      "POST",
      `/domains/${slugB}/problem-bindings`,
      ownerB.token,
      201,
      { source_ref: sourceRef },
    );
    assertNotEquals(bindingA.data.binding.id, bindingB.data.binding.id);
    for (const slug of [slugA, slugB]) {
      const paper = await request<{
        reference: {
          problem_id: string;
          display_ref: string;
          is_shared: boolean;
        };
        can_edit: boolean;
        content: { questions: { answer: unknown[]; explanation: string }[] };
      }>("GET", `/domains/${slug}/problems/${sourceRef}`, mixed.token, 200);
      assertEquals(paper.reference.problem_id, created.problem_id);
      assertEquals(paper.reference.display_ref, sourceRef);
      assertEquals(paper.reference.is_shared, true);
      assertEquals(paper.can_edit, false);
      assertEquals(paper.content.questions[0].answer, []);
      assertEquals(paper.content.questions[0].explanation, "");
    }
    // 未加入任何班级的匿名访问仍可正常进入默认公共域。
    await request("GET", mainProblem, undefined, 200);

    const taskA1 = await assignment(
      slugA,
      classA.data.id,
      bindingA.data.binding.id,
      ownerA.token,
      "A 作业一",
    );
    const taskA2 = await assignment(
      slugA,
      classA.data.id,
      bindingA.data.binding.id,
      ownerA.token,
      "A 作业二",
    );
    const taskB = await assignment(
      slugB,
      classB.data.id,
      bindingB.data.binding.id,
      mixed.token,
      "B 作业",
    );
    const taskPath = `/domains/${slugA}/assignments/${taskA1.id}`;
    await request("GET", `${taskPath}/matrix`, mixed.token, 403);
    await request("GET", `${taskPath}/matrix`, peer.token, 403);
    await request(
      "GET",
      `/domains/${slugB}/assignments/${taskB.id}/matrix`,
      mixed.token,
      200,
    );
    await request(
      "GET",
      `/domains/${slugB}/assignments/${taskA1.id}`,
      mixed.token,
      404,
    );

    const answers = {
      answers: { sum: ["A"] },
      version_id: published.version_id,
    };
    const submit = async (slug: string, reference: string) => {
      const submission = await request<{
        data: { submission_id: string; score: number; domain_id: string };
      }>(
        "POST",
        `/domains/${slug}/problems/${reference}/objective-submissions`,
        mixed.token,
        201,
        answers,
      );
      // 交卷 DTO 使用百分制原分；历史及教学进度使用 ×100 整数。
      assertEquals(submission.data.score, 100);
      return { ...submission.data, id: submission.data.submission_id };
    };
    // 作业已发布后在源域和另一个学校做同一题，仍不能计入 A 域作业。
    const mainSubmission = await submit("main", String(created.number));
    const otherSubmission = await submit(slugB, sourceRef);
    for (const task of [taskA1, taskA2]) {
      const cell = await progress(slugA, task.id, mixed.token);
      assertEquals(cell.status, "not_started");
      assertEquals(cell.score, null);
      assertEquals(cell.source_submission_id, null);
    }
    await request("PUT", "/me/workspace-preference", mixed.token, 200, {
      slug: slugB,
    });
    const ownSubmission = await submit(slugA, sourceRef);
    assertNotEquals(ownSubmission.domain_id, otherSubmission.domain_id);
    assertNotEquals(ownSubmission.domain_id, mainSubmission.domain_id);
    for (const task of [taskA1, taskA2]) {
      const cell = await progress(slugA, task.id, mixed.token);
      assertEquals(cell.status, "achieved");
      assertEquals(cell.score, 10000);
      assertEquals(cell.accepted, true);
      assertEquals(cell.source_submission_id, ownSubmission.id);
    }
    await request(
      "GET",
      `/domains/${slugB}/objective-submissions/${ownSubmission.id}`,
      mixed.token,
      404,
    );
    await request(
      "GET",
      `/domains/${slugA}/objective-submissions/${ownSubmission.id}`,
      peer.token,
      404,
    );

    const feedback = await request<{ data: { id: string; body: string } }>(
      "POST",
      `${taskPath}/feedback`,
      ownerA.token,
      201,
      { body: "请写出你的计算思路。", target_user_id: mixed.id },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    const feedbackPath = `${taskPath}/feedback/${feedback.data.id}`;
    await request("GET", feedbackPath, mixed.token, 200);
    await request("GET", feedbackPath, peer.token, 404);
    await request("GET", feedbackPath, ownerB.token, 404);
    const peerFeedback = await request<{ data: { total: number } }>(
      "GET",
      `${taskPath}/feedback`,
      peer.token,
      200,
    );
    assertEquals(peerFeedback.data.total, 0);

    await request("POST", `${taskPath}/help-requests`, mixed.token, 404, {
      body: "不能把其他工作空间提交关联到本作业。",
      item_id: taskA1.itemId,
      submission: { id: otherSubmission.id, kind: "objective" },
    }, { "Idempotency-Key": crypto.randomUUID() });
    const help = await request<{ data: { id: string } }>(
      "POST",
      `${taskPath}/help-requests`,
      mixed.token,
      201,
      {
        body: "如何表达计算过程？",
        item_id: taskA1.itemId,
        submission: { id: ownSubmission.id, kind: "objective" },
      },
      { "Idempotency-Key": crypto.randomUUID() },
    );
    const helpPath = `${taskPath}/help-requests/${help.data.id}`;
    await request("GET", helpPath, peer.token, 404);
    await request("GET", helpPath, ownerB.token, 404);
    await request("POST", `${helpPath}/replies`, ownerA.token, 201, {
      body: "先列出相加的两个数，再给出结果。",
      resolve: true,
    }, { "Idempotency-Key": crypto.randomUUID() });
    const resolved = await request<{
      data: { state: string; replies: { body: string }[] };
    }>("GET", helpPath, mixed.token, 200);
    assertEquals(resolved.data.state, "resolved");
    assertEquals(resolved.data.replies.length, 1);
    assert(resolved.data.replies[0].body.includes("两个数"));

    // 实时撤销禁止新内容/执行，但成绩、本人答案和既有教学互动继续保留。
    await request("POST", `${mainProblem}/sharing`, admin, 200, {
      enabled: false,
      scope: "all",
      target_domain_slugs: [],
    }, { "If-Match": String(sharing.data.revision) });
    for (const slug of [slugA, slugB]) {
      const problemPath = `/domains/${slug}/problems/${sourceRef}`;
      await request("GET", problemPath, mixed.token, 404);
      await request("GET", `${problemPath}/template`, mixed.token, 404);
      await request("GET", `${problemPath}/versions`, mixed.token, 404);
      const list = await request<{ total: number; items: unknown[] }>(
        "GET",
        `/domains/${slug}/problems`,
        mixed.token,
        200,
      );
      assertEquals(list.total, 0);
      assertEquals(list.items, []);
      await request(
        "POST",
        `${problemPath}/objective-submissions`,
        mixed.token,
        404,
        answers,
      );
    }
    const historical = await request<{
      data: {
        resource_available: boolean;
        answers: { sum: string[] };
        result: { score: number };
        domain: { slug: string };
      };
    }>(
      "GET",
      `/domains/${slugA}/objective-submissions/${ownSubmission.id}`,
      mixed.token,
      200,
    );
    assertEquals(historical.data.resource_available, false);
    assertEquals(historical.data.domain.slug, slugA);
    assertEquals(historical.data.answers, { sum: ["A"] });
    assertEquals(historical.data.result.score, 10000);
    const unavailable = await progress(slugA, taskA1.id, mixed.token);
    assertEquals(unavailable.status, "unavailable");
    assertEquals(unavailable.score, 10000);
    await request("GET", feedbackPath, mixed.token, 200);
    await request("GET", helpPath, mixed.token, 200);
    await request("GET", mainProblem, undefined, 200);
  },
);

e2eTest(
  "[e2e/workspace-teaching] 私有学校邀请注册与管理员开户政策，结束恢复实例设置",
  async () => {
    await waitForServer();
    const admin = await getAdminToken();
    const original = await request<{
      data: { key: string; effective_value: unknown }[];
    }>("GET", "/admin/system/settings", admin, 200);
    const registrationKey = "instance_registration_mode";
    const invitationKey = "allow_domain_registration_invites";
    const originalRegistration = original.data.find((s) =>
      s.key === registrationKey
    )!;
    const originalInvitations = original.data.find((s) =>
      s.key === invitationKey
    )!;
    assertEquals(originalRegistration.effective_value, "open");
    const suffix = `${Date.now().toString(36)}${
      crypto.randomUUID().slice(0, 4)
    }`;
    const owner = await account("ws_reg_owner", suffix);
    const existing = await account("ws_existing", suffix);
    const slug = `invite-school-${suffix}`;
    await request("POST", "/domains", admin, 201, {
      slug,
      name: "邀请注册学校",
      preset: "education",
    });
    await invite(`/domains/${slug}`, admin, owner);
    await request("POST", `/domains/${slug}/transfer`, admin, 200, {
      user_id: owner.id,
    });
    const classroom = await request<{ data: { id: string } }>(
      "POST",
      `/domains/${slug}/classrooms`,
      owner.token,
      201,
      { name: "邀请注册学生班" },
    );
    const classroomPath = `/domains/${slug}/classrooms/${classroom.data.id}`;
    const newEmail = `ws_new_${suffix}@test.com`;
    const blockedEmail = `ws_blocked_${suffix}@test.com`;
    const newInvite = await request<{ data: { token: string } }>(
      "POST",
      `${classroomPath}/invitations`,
      owner.token,
      201,
      { email: newEmail },
    );
    const blockedInvite = await request<{ data: { token: string } }>(
      "POST",
      `${classroomPath}/invitations`,
      owner.token,
      201,
      { email: blockedEmail },
    );
    const registration = {
      username: `ws_new_${suffix}`,
      email: newEmail,
      password: TEST_PASSWORD,
      accepted_legal: true,
      invitation_token: newInvite.data.token,
    };
    const setPolicy = async (key: string, value: unknown) => {
      await request("PUT", `/admin/system/settings/${key}`, admin, 200, {
        value,
      });
    };
    try {
      await setPolicy(registrationKey, "invite");
      await setPolicy(invitationKey, false);
      const preview = await request<{ data: { can_register: boolean } }>(
        "POST",
        "/auth/domain-invitation",
        undefined,
        200,
        { token: newInvite.data.token },
      );
      assertEquals(preview.data.can_register, false);
      const unauthorized = await request<{ code: string }>(
        "POST",
        "/auth/register",
        undefined,
        403,
        registration,
      );
      assertEquals(unauthorized.code, "REGISTER_INVITATION_UNAUTHORIZED");
      const { invitation_token: _unused, ...withoutInvite } = registration;
      const required = await request<{ code: string }>(
        "POST",
        "/auth/register",
        undefined,
        403,
        withoutInvite,
      );
      assertEquals(required.code, "REGISTER_INVITATION_REQUIRED");

      await setPolicy(invitationKey, true);
      const allowed = await request<{
        data: {
          can_register: boolean;
          domain_slug: string;
          classroom_id: string;
        };
      }>("POST", "/auth/domain-invitation", undefined, 200, {
        token: newInvite.data.token,
      });
      assertEquals(allowed.data.can_register, true);
      assertEquals(allowed.data.domain_slug, slug);
      assertEquals(allowed.data.classroom_id, classroom.data.id);
      // 同一个此前被拒绝的邀请依然可用，注册同时完成域成员和班级学生关系。
      const registered = await request<{
        data: { email_verification_token: string };
      }>("POST", "/auth/register", undefined, 201, registration);
      await request("POST", "/auth/email/verify", undefined, 200, {
        token: registered.data.email_verification_token,
      });
      const login = await request<{ data: { token: string } }>(
        "POST",
        "/auth/login",
        undefined,
        200,
        { login: newEmail, password: TEST_PASSWORD },
      );
      const spaces = await request<{ data: { slug: string }[] }>(
        "GET",
        "/me/domains",
        login.data.token,
        200,
      );
      assertEquals(spaces.data.map((space) => space.slug), [slug]);
      const joined = await request<{
        data: { membership: { role: string }; manages_domain: boolean };
      }>("GET", classroomPath, login.data.token, 200);
      assertEquals(joined.data.membership.role, "student");
      assertEquals(joined.data.manages_domain, false);
      await request(
        "POST",
        `/domains/${slug}/classrooms`,
        login.data.token,
        403,
        {
          name: "学生不能创建班级",
        },
      );

      await setPolicy(registrationKey, "admin_only");
      const closed = await request<{ data: { can_register: boolean } }>(
        "POST",
        "/auth/domain-invitation",
        undefined,
        200,
        { token: blockedInvite.data.token },
      );
      assertEquals(closed.data.can_register, false);
      const blocked = await request<{ code: string }>(
        "POST",
        "/auth/register",
        undefined,
        403,
        {
          username: `ws_blocked_${suffix}`,
          email: blockedEmail,
          password: TEST_PASSWORD,
          accepted_legal: true,
          invitation_token: blockedInvite.data.token,
        },
      );
      assertEquals(blocked.code, "REGISTER_ADMIN_ONLY");
      // 已有账号仍能正常接受班级邀请；邀请不会接管或重置其统一账号。
      await invite(classroomPath, owner.token, existing);
      const existingLogin = await request<{ data: { token: string } }>(
        "POST",
        "/auth/login",
        undefined,
        200,
        { login: existing.email, password: TEST_PASSWORD },
      );
      await request("GET", classroomPath, existingLogin.data.token, 200);
    } finally {
      // 即使旅程失败，也分别恢复两项设置；只写隔离 E2E 栈的管理 API。
      try {
        await setPolicy(registrationKey, originalRegistration.effective_value);
      } finally {
        await setPolicy(invitationKey, originalInvitations.effective_value);
      }
      const restored = await request<{
        data: { key: string; effective_value: unknown }[];
      }>("GET", "/admin/system/settings", admin, 200);
      for (const setting of [originalRegistration, originalInvitations]) {
        assertEquals(
          restored.data.find((s) => s.key === setting.key)!.effective_value,
          setting.effective_value,
        );
      }
    }
  },
);
