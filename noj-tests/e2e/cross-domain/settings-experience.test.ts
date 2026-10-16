import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  api,
  e2eTest,
  getAdminToken,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "../helper.ts";

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
interface Invitation {
  id: string;
  token: string;
  code: string;
  expires_at: string;
}
interface Section {
  values: Record<string, unknown>;
  revision: string;
}

e2eTest(
  "[e2e/settings-experience] 页级保存、三种邀请、全题型目录及域/实例队列",
  async () => {
    await waitForServer();
    const admin = await getAdminToken(), suffix = Date.now().toString(36);
    const students = await Promise.all([0, 1, 2].map(async (index) => {
      const username = `settings_${suffix}_${index}`,
        email = `${username}@test.com`;
      return {
        username,
        email,
        token: await registerUser(username, email, TEST_PASSWORD),
      };
    }));
    const sectionPath = "/admin/instance/settings/creation";
    const { data: initial } = await request<{ data: Section }>(
      "GET",
      sectionPath,
      admin,
      200,
    );
    await request("PATCH", sectionPath, students[0].token, 403, {
      values: initial.values,
    }, { "If-Match": initial.revision });
    await request("PATCH", sectionPath, admin, 428, { values: initial.values });
    await request("PATCH", sectionPath, admin, 400, {
      values: { ...initial.values, domain_creation_limit: -1 },
    }, { "If-Match": initial.revision });
    const { data: afterFailure } = await request<{ data: Section }>(
      "GET",
      sectionPath,
      admin,
      200,
    );
    assertEquals(afterFailure, initial);
    const { data: saved } = await request<{ data: Section }>(
      "PATCH",
      sectionPath,
      admin,
      200,
      { values: initial.values },
      { "If-Match": initial.revision },
    );
    assertNotEquals(saved.revision, initial.revision);
    await request(
      "PATCH",
      sectionPath,
      admin,
      409,
      { values: initial.values },
      { "If-Match": initial.revision },
    );

    const slugs = [`settings-a-${suffix}`, `settings-b-${suffix}`];
    for (const slug of slugs) {
      await request("POST", "/domains", admin, 201, {
        slug,
        name: `设置验收 ${slug}`,
        preset: "education",
      });
    }
    const a = `/domains/${slugs[0]}`, b = `/domains/${slugs[1]}`;
    const createInvite = async (path: string, input: unknown) =>
      (await request<{ data: Invitation }>(
        "POST",
        `${path}/invitations`,
        admin,
        201,
        input,
      )).data;
    const accept = (credential: string, token: string, status = 200) =>
      request("POST", "/domain-invitations/accept", token, status, {
        token: credential,
      });
    const general = await createInvite(a, { mode: "general", max_uses: 2 });
    assert(
      Math.abs(Date.parse(general.expires_at) - Date.now() - 7 * 86400000) <
        10000,
    );
    await accept(general.code.toLowerCase(), students[0].token);
    await accept(general.token, students[0].token);
    await accept(general.token, students[1].token);
    await accept(general.code, students[2].token, 404);
    const directory = await request<
      {
        data: Array<
          {
            id: string;
            used_count: number;
            token?: unknown;
            code_hash?: unknown;
          }
        >;
      }
    >("GET", `${a}/invitations`, admin, 200);
    assertEquals(
      directory.data.find((row) => row.id === general.id)?.used_count,
      2,
    );
    assert(
      directory.data.every((row) =>
        row.token === undefined && row.code_hash === undefined
      ),
    );

    const email = await createInvite(b, {
      mode: "email",
      email: students[0].email,
    });
    await accept(email.code, students[1].token, 404);
    await accept(email.token, students[0].token);
    const once = await createInvite(b, { mode: "once" });
    await accept(once.code, students[1].token);
    await accept(once.token, students[1].token);
    await accept(once.code, students[2].token, 404);
    const revoked = await createInvite(b, { mode: "general" });
    await request("DELETE", `${b}/invitations/${revoked.id}`, admin, 200);
    await request("POST", "/auth/domain-invitation", undefined, 404, {
      code: revoked.code,
    });

    const classroom = (await request<{ data: { id: string } }>(
      "POST",
      `${a}/classrooms`,
      admin,
      201,
      { name: "邀请与提交验收班" },
    )).data;
    const classInvite = await createInvite(`${a}/classrooms/${classroom.id}`, {
      mode: "general",
    });
    await accept(classInvite.code, students[0].token);
    const classView = await request<{ data: unknown }>(
      "GET",
      `${a}/classrooms/${classroom.id}`,
      students[0].token,
      200,
    );
    assert(classView.data);
    await request(
      "GET",
      `${b}/classrooms/${classroom.id}`,
      students[0].token,
      404,
    );

    // 短码注册走原账号事务，不能把“加入已有账号”权限变成平台开户能力。
    const registrationInvite = await createInvite(b, { mode: "general" });
    const username = `settings_join_${suffix}`;
    await request("POST", "/auth/register", undefined, 201, {
      username,
      email: `${username}@test.com`,
      password: TEST_PASSWORD,
      invitation_token: registrationInvite.code,
      accepted_legal: true,
    });
    const accessPath = "/admin/instance/settings/access";
    const { data: access } = await request<{ data: Section }>(
      "GET",
      accessPath,
      admin,
      200,
    );
    const { data: closed } = await request<{ data: Section }>(
      "PATCH",
      accessPath,
      admin,
      200,
      {
        values: { ...access.values, instance_registration_mode: "admin_only" },
      },
      { "If-Match": access.revision },
    );
    try {
      const preview = await request<{ data: { can_register: boolean } }>(
        "POST",
        "/auth/domain-invitation",
        undefined,
        200,
        { code: registrationInvite.code },
      );
      assertEquals(preview.data.can_register, false);
      await request("POST", "/auth/register", undefined, 403, {
        username: `${username}_blocked`,
        email: `${username}_blocked@test.com`,
        password: TEST_PASSWORD,
        invitation_token: registrationInvite.code,
        accepted_legal: true,
      });
    } finally {
      await request(
        "PATCH",
        accessPath,
        admin,
        200,
        { values: access.values },
        { "If-Match": closed.revision },
      );
    }

    const created = await request<
      { problem_id: string; number: number; draft_revision: number }
    >("POST", `${a}/problems`, admin, 201, {
      title: "统一列表客观题",
      description: "计算 1+1",
      is_objective: true,
      visibility: "public",
    });
    const problemPath = `${a}/problems/${created.number}`;
    const draft = await request<{ revision: number }>(
      "PUT",
      `${problemPath}/draft`,
      admin,
      200,
      {
        content: {
          kind: "objective",
          title: "统一列表客观题",
          description: "计算 1+1",
          samples: [],
          questions: [{
            key: "sum",
            sort_order: 0,
            type: "single",
            prompt: "1+1=?",
            options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
            answer: ["A"],
            explanation: "相加为二",
          }],
        },
      },
      { "If-Match": String(created.draft_revision) },
    );
    const version = await request<{ version_id: string }>(
      "POST",
      `${problemPath}/publish`,
      admin,
      200,
      { change_note: "提交与邀请 API 验收" },
      { "If-Match": String(draft.revision) },
    );
    const submitted = await request<{ data: { submission_id: string } }>(
      "POST",
      `${problemPath}/objective-submissions`,
      students[0].token,
      201,
      { version_id: version.version_id, answers: { sum: ["A"] } },
    );
    const list = await request<
      {
        data: Array<
          { id: string; kind: string; answers?: unknown; code?: unknown }
        >;
        pagination: { total: number };
      }
    >(
      "GET",
      `${a}/submissions?username=${students[0].username}&kind=objective`,
      students[1].token,
      200,
    );
    assertEquals(list.pagination.total, 1);
    assertEquals(list.data[0].id, submitted.data.submission_id);
    assertEquals(list.data[0].kind, "objective");
    assertEquals(list.data[0].answers, undefined);
    assertEquals(list.data[0].code, undefined);
    const summary = await request<
      { data: { answers?: unknown; can_view_answers: boolean } }
    >(
      "GET",
      `${a}/objective-submissions/${submitted.data.submission_id}`,
      students[1].token,
      200,
    );
    assertEquals(summary.data.answers, undefined);
    assertEquals(summary.data.can_view_answers, false);
    await request(
      "GET",
      `${b}/objective-submissions/${submitted.data.submission_id}`,
      students[1].token,
      404,
    );

    for (const path of [`${a}/queue`, "/instance/queue"]) {
      const queue = await request<
        {
          pending: unknown[];
          judging: unknown[];
          stats: { pending_count: number };
          scope: string;
        }
      >("GET", path, students[0].token, 200);
      assert(Array.isArray(queue.pending) && Array.isArray(queue.judging));
      assertEquals(typeof queue.stats.pending_count, "number");
      assertEquals(
        queue.scope,
        path === "/instance/queue" ? "instance" : "domain",
      );
    }
    await request("GET", `${a}/queue`, students[2].token, 404);
  },
);
