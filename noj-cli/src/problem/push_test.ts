import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { UsageError } from "../util/args.ts";
import type { PromptIO } from "../tui/io.ts";
import { parseProblemArgs } from "./command.ts";
import {
  extractLoginToken,
  normalizeServer,
  parsePushTarget,
  pushBundle,
  type PushDeps,
  PushError,
  pushErrorHint,
} from "./push.ts";

/** 记录请求并按 URL 后缀返回预设响应的 fake fetch。 */
function fakeFetch(
  routes: Record<string, (init: RequestInit) => Response>,
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    return Promise.resolve(routes[key]!(init ?? {}));
  };
  return { fetch: fn as typeof fetch, calls };
}

function json(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** 按顺序应答的 fake IO。 */
function fakeIO(answers: string[]): PromptIO & { secrets: number } {
  const queue = [...answers];
  return {
    secrets: 0,
    write() {},
    readLine: () => Promise.resolve(queue.shift() ?? ""),
    readSecret() {
      this.secrets++;
      return Promise.resolve(queue.shift() ?? "");
    },
  };
}

const bundle = { name: "demo.zip", data: new Uint8Array([0x50, 0x4b, 3, 4]) };
const imported = {
  data: {
    id: "uuid-1",
    display_id: "P13",
    title: "中文数字转写",
    published: null,
  },
};

Deno.test("parseProblemArgs: push 的位置参数是目录/zip，支持 --server/--publish", () => {
  const args = parseProblemArgs([
    "push",
    "pkg/demo.zip",
    "--server",
    "https://noj.example.com",
    "--publish",
  ]);
  assertEquals(args.sub, "push");
  assertEquals(args.dir, "pkg/demo.zip");
  assertEquals(args.slug, undefined);
  assertEquals(args.server, "https://noj.example.com");
  assertEquals(args.publish, true);
});

Deno.test("normalizeServer: 非本机地址必须 HTTPS；去掉末尾斜杠", () => {
  assertEquals(
    normalizeServer("https://noj.example.com/"),
    "https://noj.example.com",
  );
  assertEquals(
    normalizeServer("http://localhost:3000"),
    "http://localhost:3000",
  );
  assertEquals(
    normalizeServer("http://127.0.0.1:3000/"),
    "http://127.0.0.1:3000",
  );
  assertThrows(
    () => normalizeServer("http://noj.example.com"),
    UsageError,
    "HTTPS",
  );
  assertThrows(() => normalizeServer("ftp://noj.example.com"), UsageError);
  assertThrows(() => normalizeServer("noj.example.com"), UsageError);
});

Deno.test("extractLoginToken: 直连 core 取响应体，经网页代理取 Set-Cookie", () => {
  assertEquals(
    extractLoginToken({ data: { token: "jwt-body" } }, null),
    "jwt-body",
  );
  // Nitro 代理会删掉响应体里的 token，只写 HttpOnly Cookie
  assertEquals(
    extractLoginToken(
      { data: { user: {} } },
      "noj:token=jwt-cookie; Path=/; HttpOnly; noj:session=%7B%7D; Path=/",
    ),
    "jwt-cookie",
  );
  assertEquals(extractLoginToken({ data: {} }, "other=1; Path=/"), null);
});

Deno.test("pushBundle: 用 NOJ_TOKEN 直接导入，不带 problem_id，默认不发布", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/v1/problems/import-bundle": () => json(200, imported),
  });
  const result = await pushBundle(
    { server: "https://noj.example.com/", bundle, publish: false },
    { fetch, io: null, envToken: "tok" },
  );
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0]!.url,
    "https://noj.example.com/api/v1/problems/import-bundle",
  );
  assertEquals(
    (calls[0]!.init.headers as Record<string, string>).Authorization,
    "Bearer tok",
  );
  const form = calls[0]!.init.body as FormData;
  assertEquals((form.get("file") as File).name, "demo.zip");
  assertEquals(form.has("problem_id"), false);
  assertEquals(form.has("publish"), false);
  assertEquals(result.display_id, "P13");
  assertEquals(result.edit_url, "https://noj.example.com/problems/P13/edit");
});

Deno.test("pushBundle: --publish 附带 publish=true", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/v1/problems/import-bundle": () =>
      json(200, { data: { ...imported.data, published: { version: 1 } } }),
  });
  const result = await pushBundle(
    { server: "https://noj.example.com", bundle, publish: true },
    { fetch, io: null, envToken: "tok" },
  );
  assertEquals((calls[0]!.init.body as FormData).get("publish"), "true");
  assertEquals(result.published?.version, 1);
});

Deno.test("pushBundle: 无令牌且非交互时报用法错误，不发请求", async () => {
  const { fetch, calls } = fakeFetch({});
  await assertRejects(
    () =>
      pushBundle(
        { server: "https://noj.example.com", bundle, publish: false },
        { fetch, io: null },
      ),
    UsageError,
    "NOJ_TOKEN",
  );
  assertEquals(calls.length, 0);
});

Deno.test("pushBundle: 交互登录（含两步验证），令牌取自代理的 Set-Cookie", async () => {
  let loginAttempts = 0;
  const { fetch, calls } = fakeFetch({
    "/api/v1/auth/login": (init) => {
      loginAttempts++;
      const body = JSON.parse(String(init.body));
      if (!body.code) {
        return json(400, { error: "需要两步验证码", code: "TFA_REQUIRED" });
      }
      assertEquals(body, {
        login: "alice",
        password: "s3cret",
        code: "123456",
      });
      return json(200, { data: { user: {} } }, {
        "set-cookie": "noj:token=jwt-from-cookie; Path=/; HttpOnly",
      });
    },
    "/api/v1/problems/import-bundle": () => json(200, imported),
  });
  const io = fakeIO(["alice", "s3cret", "123456"]);
  const deps: PushDeps = { fetch, io };
  await pushBundle({
    server: "https://noj.example.com",
    bundle,
    publish: false,
  }, deps);

  assertEquals(loginAttempts, 2);
  assertEquals(io.secrets, 1, "密码必须走不回显输入");
  assertEquals(
    (calls.at(-1)!.init.headers as Record<string, string>).Authorization,
    "Bearer jwt-from-cookie",
  );
});

Deno.test("pushBundle: 平台错误保留错误码，并给出可操作提示", async () => {
  const { fetch } = fakeFetch({
    "/api/v1/problems/import-bundle": () =>
      json(428, {
        error: "保存草稿必须携带 If-Match",
        code: "DRAFT_REVISION_REQUIRED",
      }),
  });
  const err = await assertRejects(
    () =>
      pushBundle(
        { server: "https://noj.example.com", bundle, publish: false },
        { fetch, io: null, envToken: "tok" },
      ),
    PushError,
  );
  assertEquals(err.status, 428);
  assertEquals(pushErrorHint(err)?.includes("number"), true);
  assertEquals(
    pushErrorHint(new PushError("x", 401))?.includes("NOJ_TOKEN"),
    true,
  );
  assertEquals(pushErrorHint(new PushError("x", 500)), null);
});

Deno.test("pushBundle --problem: 解析题号、携带草稿 revision 写入目标题目", async () => {
  const TARGET = "11111111-2222-4333-8444-555555555555";
  const { fetch, calls } = fakeFetch({
    "/api/v1/problems/P12": () => json(200, { data: { id: TARGET } }),
    [`/api/v1/problems/${TARGET}/draft`]: () =>
      json(200, { data: { revision: 7 } }),
    "/api/v1/problems/import-bundle": () =>
      json(200, { data: { id: TARGET, display_id: "P12", published: null } }),
  });
  const result = await pushBundle(
    {
      server: "https://noj.example.com",
      bundle,
      publish: true,
      problem: "P12",
    },
    { fetch, io: null, envToken: "tok" },
  );
  const upload = calls.at(-1)!;
  const form = upload.init.body as FormData;
  assertEquals(form.get("problem_id"), TARGET);
  assertEquals(form.get("expected_revision"), "7");
  assertEquals(form.get("publish"), "true");
  assertEquals(
    (upload.init.headers as Record<string, string>)["If-Match"],
    "7",
  );
  assertEquals(result.edit_url, "https://noj.example.com/problems/P12/edit");
});

Deno.test("pushBundle --problem: 返回了别的题目时报错（不能悄悄新建）", async () => {
  const TARGET = "11111111-2222-4333-8444-555555555555";
  const { fetch } = fakeFetch({
    [`/api/v1/problems/${TARGET}/draft`]: () =>
      json(200, { data: { revision: 1 } }),
    "/api/v1/problems/import-bundle": () =>
      json(200, { data: { id: "another-id", display_id: "P99" } }),
  });
  await assertRejects(
    () =>
      pushBundle(
        {
          server: "https://noj.example.com",
          bundle,
          publish: false,
          problem: TARGET,
        },
        { fetch, io: null, envToken: "tok" },
      ),
    PushError,
    "不属于目标题目",
  );
});

Deno.test("parseProblemArgs: push 支持 --problem", () => {
  assertEquals(
    parseProblemArgs(["push", "pkg", "--problem", "P12"]).problem,
    "P12",
  );
});

Deno.test("parsePushTarget: 路径=题号 表示更新；文件名自带的 = 不误判", () => {
  assertEquals(parsePushTarget("a.zip"), { path: "a.zip" });
  assertEquals(parsePushTarget("pkg/b.zip=P12"), {
    path: "pkg/b.zip",
    problem: "P12",
  });
  assertEquals(
    parsePushTarget("x=11111111-2222-4333-8444-555555555555"),
    { path: "x", problem: "11111111-2222-4333-8444-555555555555" },
  );
  assertEquals(parsePushTarget("weird=name.zip"), { path: "weird=name.zip" });
});

Deno.test("parseProblemArgs: push 收集全部位置参数作为目标", () => {
  assertEquals(
    parseProblemArgs([
      "push",
      "a.zip",
      "b.zip=P12",
      "c",
      "--server",
      "https://x.dev",
    ]).targets,
    ["a.zip", "b.zip=P12", "c"],
  );
});
