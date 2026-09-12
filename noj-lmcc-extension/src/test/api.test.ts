import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiError,
  type HttpRequest,
  type HttpResponse,
  NeuroOjApi,
  normalizeServerUrl,
} from "../api";

function json(status: number, value: unknown): HttpResponse {
  return { status, body: JSON.stringify(value), headers: {} };
}

test("normalizeServerUrl 规范化尾部斜杠并拒绝凭据", () => {
  assert.equal(
    normalizeServerUrl(" https://noj.example.com/// "),
    "https://noj.example.com",
  );
  assert.throws(() => normalizeServerUrl("\\"), /格式无效/);
  assert.throws(() => normalizeServerUrl("ftp://noj.example.com"), /HTTP/);
  assert.throws(
    () => normalizeServerUrl("https://user:pass@noj.example.com"),
    /账号或密码/,
  );
});

test("login 使用公开登录端点且不携带 Authorization", async () => {
  let captured: HttpRequest | undefined;
  const api = new NeuroOjApi(
    "https://noj.example.com",
    5000,
    async (request) => {
      captured = request;
      return json(200, {
        data: { user: { id: "u1", username: "alice" }, token: "jwt" },
      });
    },
  );

  const result = await api.login("alice", "secret", "123456");
  assert.equal(result.token, "jwt");
  assert.equal(captured?.url.pathname, "/api/v1/auth/login");
  assert.equal(captured?.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(captured?.body ?? "{}"), {
    login: "alice",
    password: "secret",
    code: "123456",
  });
});

test("submitCode 携带 Bearer 令牌并使用公开提交 DTO", async () => {
  let captured: HttpRequest | undefined;
  const api = new NeuroOjApi(
    "https://noj.example.com",
    5000,
    async (request) => {
      captured = request;
      return json(201, { data: { id: "s1", status: "judging" } });
    },
  );
  api.setToken("jwt-token");

  await api.submitCode("p1", "print('ok')", "submission.py");
  assert.equal(captured?.headers.Authorization, "Bearer jwt-token");
  assert.deepEqual(JSON.parse(captured?.body ?? "{}"), {
    problem_id: "p1",
    language: "python3",
    code: "print('ok')",
    file_name: "submission.py",
  });
});

test("currentUser 读取 auth/me 的扁平 data 响应", async () => {
  const api = new NeuroOjApi("https://noj.example.com", 5000, async () =>
    json(200, { data: { id: "u1", username: "alice", permissions: [] } }),
  );
  api.setToken("jwt");

  const user = await api.currentUser();
  assert.equal(user.username, "alice");
});

test("checkConnection 不携带已有令牌", async () => {
  let captured: HttpRequest | undefined;
  const api = new NeuroOjApi(
    "https://noj.example.com",
    5000,
    async (request) => {
      captured = request;
      return json(200, { data: [], total: 0, page: 1, limit: 1 });
    },
  );
  api.setToken("server-a-token");

  await api.checkConnection();
  assert.equal(captured?.headers.Authorization, undefined);
  assert.equal(captured?.url.pathname, "/api/v1/problems");
});

test("listProblems 翻页并排除客观题与产物题", async () => {
  const requests: string[] = [];
  const api = new NeuroOjApi(
    "https://noj.example.com",
    5000,
    async (request) => {
      requests.push(request.url.search);
      const page = request.url.searchParams.get("page");
      if (page === "1") {
        return json(200, {
          data: [
            {
              id: "p1",
              display_id: "P1",
              title: "代码题",
              difficulty: "easy",
              is_objective: false,
              submission_mode: "code",
            },
            {
              id: "p2",
              display_id: "P2",
              title: "客观题",
              difficulty: "easy",
              is_objective: true,
              submission_mode: "code",
            },
          ],
          total: 3,
        });
      }
      return json(200, {
        data: [
          {
            id: "p3",
            display_id: "P3",
            title: "产物题",
            difficulty: "hard",
            is_objective: false,
            submission_mode: "artifact",
          },
        ],
        total: 3,
      });
    },
  );
  api.setToken("jwt");

  const problems = await api.listProblems();
  assert.deepEqual(
    problems.map((problem) => problem.id),
    ["p1"],
  );
  assert.deepEqual(requests, [
    "?page=1&limit=100&type=P",
    "?page=2&limit=100&type=P",
  ]);
});

test("API 错误保留服务端错误码与请求编号", async () => {
  const api = new NeuroOjApi("https://noj.example.com", 5000, async () =>
    json(400, {
      error: "需要两步验证码",
      code: "TFA_REQUIRED",
      request_id: "req-1",
    }),
  );

  await assert.rejects(
    () => api.login("alice", "secret"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, "TFA_REQUIRED");
      assert.equal(error.requestId, "req-1");
      assert.equal(error.message, "需要两步验证码");
      return true;
    },
  );
});
