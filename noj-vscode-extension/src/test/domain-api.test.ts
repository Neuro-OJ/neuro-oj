import assert from "node:assert/strict";
import test from "node:test";
import { NeuroOjApi, type HttpRequest } from "../api";

test("共享题代码提交与读取始终使用目标域，不使用源域", async () => {
  const requests: HttpRequest[] = [];
  const api = new NeuroOjApi(
    "https://noj.example.com",
    5000,
    async (request) => {
      requests.push(request);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ data: { id: "submission", status: "pending" } }),
      };
    },
  );
  api.setToken("token");
  await api.submitDomainCode(
    "school",
    "main:1001",
    "print(1)",
    "solution.py",
    "version-1",
  );
  await api.domainSubmission("school", "submission");
  assert.equal(requests[0].url.pathname, "/api/v1/domains/school/submissions");
  assert.deepEqual(JSON.parse(String(requests[0].body!)), {
    problem_ref: "main:1001",
    version_id: "version-1",
    language: "python3",
    code: "print(1)",
    file_name: "solution.py",
  });
  assert.equal(
    requests[1].url.pathname,
    "/api/v1/domains/school/submissions/submission",
  );
});
test("域题库和默认版本读取使用显式域契约", async () => {
  const requests: HttpRequest[] = [];
  const api = new NeuroOjApi(
    "https://noj.example.com",
    5000,
    async (request) => {
      requests.push(request);
      const value = request.url.search
        ? {
            items: [
              {
                reference: { display_ref: "main:1001" },
                title: "共享题",
                kind: "ai",
              },
            ],
            total: 1,
          }
        : { version_id: "version", version: 3, content: { title: "共享题" } };
      return { status: 200, headers: {}, body: JSON.stringify(value) };
    },
  );
  api.setToken("token");
  const list = await api.domainProblems("school");
  assert.equal(list[0].display_id, "main:1001");
  assert.equal((await api.domainProblem("school", list[0].id)).version, 3);
  assert.equal(
    requests[1].url.pathname,
    "/api/v1/domains/school/problems/main%3A1001",
  );
});

test("模板携带所见版本，版本沿革使用同一目标域并分页", async () => {
  const requests: HttpRequest[] = [];
  const api = new NeuroOjApi(
    "https://noj.example.com",
    5000,
    async (request) => {
      requests.push(request);
      const value = request.url.pathname.endsWith("/template")
        ? { data: { version_id: "v1", template_content: "# template" } }
        : { items: [], total: 0, page: 2, limit: 20, answer_version_id: "v1" };
      return { status: 200, headers: {}, body: JSON.stringify(value) };
    },
  );
  api.setToken("token");
  assert.equal(
    (await api.domainTemplate("school", "main:1001", "v1")).template_content,
    "# template",
  );
  await api.domainVersions("school", "main:1001", 2);
  assert.equal(
    requests[0].url.pathname,
    "/api/v1/domains/school/problems/main%3A1001/template",
  );
  assert.equal(requests[0].url.searchParams.get("version_id"), "v1");
  assert.equal(requests[1].url.searchParams.get("page"), "2");
});

test("submitDomainArtifact 发送 multipart/form-data 且表单字段位于文件之前", async () => {
  let captured: HttpRequest | undefined;
  const api = new NeuroOjApi(
    "https://noj.example.com",
    5000,
    async (request) => {
      captured = request;
      return {
        status: 201,
        headers: {},
        body: JSON.stringify({ data: { id: "zip-sub-1", status: "pending" } }),
      };
    },
  );
  api.setToken("token");

  const created = await api.submitDomainArtifact(
    "school",
    "main:2001",
    Buffer.from("PK\x03\x04dummy"),
    "bundle.zip",
    "ver-2",
  );
  assert.equal(created.id, "zip-sub-1");
  assert.equal(captured?.url.pathname, "/api/v1/domains/school/submissions");
  assert.match(
    captured?.headers["Content-Type"] ?? "",
    /^multipart\/form-data; boundary=/,
  );
  const bodyStr = Buffer.isBuffer(captured?.body)
    ? captured.body.toString("utf8")
    : (captured?.body ?? "");
  const refIdx = bodyStr.indexOf('name="problem_ref"');
  const verIdx = bodyStr.indexOf('name="version_id"');
  const fileIdx = bodyStr.indexOf('name="file"');
  assert.ok(refIdx >= 0 && verIdx > refIdx && fileIdx > verIdx);
});

test("selfTest 与 feedback 接口按域调用并在 404 时优雅回退", async () => {
  const requests: HttpRequest[] = [];
  const api = new NeuroOjApi(
    "https://noj.example.com",
    5000,
    async (request) => {
      requests.push(request);
      if (request.url.pathname.endsWith("/self-tests")) {
        return {
          status: 201,
          headers: {},
          body: JSON.stringify({
            data: { id: "st_1", status: "pending", problem_id: "p1" },
          }),
        };
      }
      if (request.url.pathname.endsWith("/self-tests/st_1")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: {
              id: "st_1",
              problem_id: "p1",
              file_name: "submission.py",
              status: "finished",
              result_status: "AC",
              score: 10000,
              output: "ok",
              output_truncated: false,
              details: null,
              time_ms: 12,
              memory_kb: 256,
            },
          }),
        };
      }
      if (request.url.pathname.endsWith("/submissions/s1/feedback")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ data: { score: 95, max_score: 100 } }),
        };
      }
      return {
        status: 404,
        headers: {},
        body: JSON.stringify({ error: "Not Found" }),
      };
    },
  );
  api.setToken("token");

  const created = await api.createDomainSelfTest("school", "main:1001", {
    code: "print(1)",
    version_id: "v1",
  });
  assert.equal(created.id, "st_1");
  const detail = await api.domainSelfTest("school", "st_1");
  assert.equal(detail.score, 10000);
  assert.deepEqual(await api.domainSubmissionFeedback("school", "s1"), {
    score: 95,
    max_score: 100,
  });
  assert.equal(await api.domainSelfTestFeedback("school", "st_1"), null);
});
