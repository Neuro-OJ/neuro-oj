import { assertEquals } from "jsr:@std/assert@^1.0.13";
import { api, registerUser, TEST_PASSWORD } from "../helper.ts";

export interface ClassroomJourneyAccount {
  id: string;
  username: string;
  email: string;
  token: string;
}
/** 只准备先已注册账号；教师 CSV 入口不创建平台账号。 */
export async function classroomJourneyAccount(
  username: string,
): Promise<ClassroomJourneyAccount> {
  const email = `${username}@test.com`,
    token = await registerUser(username, email, TEST_PASSWORD);
  const { data } = await classroomJourneyFixture<
    { data: { id: string; is_admin: boolean } }
  >("GET", "/auth/me", token);
  assertEquals(data.is_admin, false);
  return { id: data.id, username, email, token };
}
export async function classroomJourneyFixture<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  revision?: number,
  idempotencyKey?: string,
): Promise<T> {
  const result = await api(method, `/api/v1${path}`, {
    token,
    body,
    headers: {
      ...(revision === undefined ? {} : { "If-Match": String(revision) }),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
  });
  assertEquals(
    result.status >= 200 && result.status < 300,
    true,
    `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`,
  );
  return result.body as T;
}
export async function classroomJourneyJoin(
  slug: string,
  admin: string,
  actor: ClassroomJourneyAccount,
) {
  const { data } = await classroomJourneyFixture<{ data: { token: string } }>(
    "POST",
    `/domains/${slug}/invitations`,
    admin,
    { email: actor.email },
  );
  await classroomJourneyFixture(
    "POST",
    "/domain-invitations/accept",
    actor.token,
    { token: data.token },
  );
}
export async function classroomJourneyProblem(
  slug: string,
  admin: string,
  title: string,
) {
  const created = await classroomJourneyFixture<
    { number: number; draft_revision: number }
  >("POST", `/domains/${slug}/problems`, admin, {
    title,
    description: "班级补题验收：选择正确选项。",
    is_objective: true,
  });
  const path = `/domains/${slug}/problems/${created.number}`;
  const saved = await classroomJourneyFixture<{ revision: number }>(
    "PUT",
    `${path}/draft`,
    admin,
    {
      content: {
        kind: "objective",
        title,
        description: "班级补题验收：选择正确选项。",
        samples: [],
        questions: [{
          key: "answer",
          sort_order: 0,
          type: "single",
          prompt: "请选择正确答案。",
          options: [
            { key: "A", text: "正确选项" },
            { key: "B", text: "待改进选项" },
          ],
          answer: ["A"],
          explanation: "正确选项为 A。",
        }],
      },
    },
    created.draft_revision,
  );
  await classroomJourneyFixture("POST", `${path}/publish`, admin, {
    change_note: "独立班级浏览器验收夹具",
  }, saved.revision);
  const published = await classroomJourneyFixture<{ binding_id: string }>(
    "GET",
    path,
    admin,
  );
  return { number: created.number, bindingId: published.binding_id };
}
