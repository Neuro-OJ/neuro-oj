/**
 * restore-drill-verify.ts 的业务验收脚本测试。
 *
 * 以子进程运行验收脚本，面向本地 mock API（Deno.serve）验证：
 * 登录、题目导入（zip 魔数）、题目读取、支持包下载、真实评测轮询与汇总输出。
 */

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const scriptPath =
  new URL("./restore-drill-verify.ts", import.meta.url).pathname;

interface StepLine {
  step: string;
  status: string;
  detail?: string;
}

Deno.test("恢复演练业务验收：全链路通过", async () => {
  let receivedZip: Uint8Array | null = null;
  let pollCount = 0;

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/api/v1/auth/login" && req.method === "POST") {
      return new Response(
        JSON.stringify({ data: { username: "drill_admin" } }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "noj:token=drill-jwt; HttpOnly; Path=/; SameSite=Lax",
          },
        },
      );
    }
    if (path === "/api/v1/problems/import-bundle" && req.method === "POST") {
      const form = await req.formData();
      const file = form.get("file");
      assert(file instanceof File, "import-bundle 应收到 file 字段");
      assert(
        (file as File).name.endsWith(".zip"),
        "导入文件应为 .zip",
      );
      receivedZip = new Uint8Array(await (file as File).arrayBuffer());
      return new Response(
        JSON.stringify({ data: { problem: { id: "drill-problem-1" } } }),
        { status: 201 },
      );
    }
    if (path === "/api/v1/problems" && req.method === "GET") {
      return new Response(
        JSON.stringify({ data: [{ id: "drill-problem-1" }] }),
        {
          status: 200,
        },
      );
    }
    if (path === "/api/v1/problems/drill-problem-1" && req.method === "GET") {
      return new Response(JSON.stringify({ data: { id: "drill-problem-1" } }), {
        status: 200,
      });
    }
    if (path === "/api/v1/problems/drill-problem-1/support-package") {
      assert(
        (req.headers.get("Cookie") ?? "").includes("noj:token=drill-jwt"),
        "支持包下载应携带会话 Cookie",
      );
      // 最小 zip：PK 头 + 尾部字节。
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
      });
    }
    if (path === "/api/v1/problems/drill-problem-1/self-test") {
      return new Response(JSON.stringify({ data: { id: "st-1" } }), {
        status: 201,
      });
    }
    if (path === "/api/v1/self-tests/st-1") {
      pollCount++;
      return new Response(
        JSON.stringify({
          data: {
            id: "st-1",
            status: pollCount >= 1 ? "finished" : "judging",
            result_status: pollCount >= 1 ? "finished" : null,
            score: pollCount >= 1 ? 100 : 0,
          },
        }),
        { status: 200 },
      );
    }
    if (path === "/api/v1/auth/register") {
      return new Response(JSON.stringify({ data: {} }), { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };

  const server = Deno.serve({ port: 0, handler });
  const port = (server.addr as Deno.NetAddr).port;
  try {
    // 减慢自测轮询对测试的影响：脚本内部固定 5s 间隔，这里直接跑通一次轮询。
    const command = new Deno.Command("deno", {
      args: ["run", "-A", "--no-check", scriptPath],
      env: {
        DRILL_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
        DRILL_ADMIN_USER: "drill_admin",
        DRILL_ADMIN_PASSWORD: "Drill-Recover-2026",
        DRILL_EVALUATOR_IMAGE: "noj-evaluator-python",
        DRILL_SOLUTION_IMAGE: "noj-solution-python",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const lines = new TextDecoder().decode(output.stdout).trim().split("\n");
    const steps = lines.map((l) => JSON.parse(l) as StepLine);
    const summary = steps.find((s) => s.step === "summary");
    assert(summary, "应输出 summary 行");
    assert(
      summary.status === "passed",
      `全链路应通过，实际步骤：${JSON.stringify(steps)}`,
    );
    assert(output.code === 0, "业务验收通过时进程应以 0 退出");

    const stepNames = steps.map((s) => s.step);
    for (
      const name of [
        "login",
        "problem_import",
        "problem_read",
        "attachment_download",
        "evaluation",
      ]
    ) {
      assert(
        stepNames.includes(name),
        `缺少验收步骤 ${name}，实际：${stepNames.join(",")}`,
      );
    }
    assert(
      receivedZip !== null && receivedZip[0] === 0x50 &&
        receivedZip[1] === 0x4b,
      "导入的题目包应为合法 zip（PK 头）",
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("恢复演练业务验收：登录失败立即失败", async () => {
  const handler = (_req: Request): Response =>
    new Response("unauthorized", { status: 401 });
  const server = Deno.serve({ port: 0, handler });
  const port = (server.addr as Deno.NetAddr).port;
  try {
    const command = new Deno.Command("deno", {
      args: ["run", "-A", "--no-check", scriptPath],
      env: {
        DRILL_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
        DRILL_ADMIN_USER: "drill_admin",
        DRILL_ADMIN_PASSWORD: "wrong",
        DRILL_EVALUATOR_IMAGE: "noj-evaluator-python",
        DRILL_SOLUTION_IMAGE: "noj-solution-python",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    assert(output.code !== 0, "登录失败时验收脚本应非零退出");
    const lines = new TextDecoder().decode(output.stdout).trim().split("\n");
    const steps = lines.map((l) => JSON.parse(l) as StepLine);
    const login = steps.find((s) => s.step === "login");
    assert(login?.status === "failed", "登录步骤应标记 failed");
    assert(
      !steps.some((s) => s.step === "summary" && s.status === "passed"),
      "不应输出通过的 summary",
    );
  } finally {
    await server.shutdown();
  }
});
