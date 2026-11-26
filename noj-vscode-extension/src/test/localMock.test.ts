import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  buildLocalJudgeTask,
  buildPythonMockEnv,
  DEFAULT_EVALUATOR_IMAGE,
  DEFAULT_SOLUTION_IMAGE,
  isApprovedJudgeImage,
  isValidOiRuntimeConfig,
  loadLocalOiRuntimeConfig,
  runLocalJudgeTrack,
  runPythonMockTrack,
  startLocalLlmMockServer,
  validateOiRuntimeConfig,
} from "../localMock";

function postJson(
  url: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

test("startLocalLlmMockServer 支持规则匹配、流式响应与 Trace 记录", async () => {
  const server = await startLocalLlmMockServer({
    defaultReply: "fallback-reply",
    rules: [{ match: "hello", reply: "world-from-rule", model: "mock-r1" }],
  });
  try {
    const res1 = await postJson(`${server.baseUrl}/chat/completions`, {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "say hello please" }],
    });
    assert.equal(res1.status, 200);
    const json1 = JSON.parse(res1.body) as {
      model: string;
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(json1.model, "mock-r1");
    assert.equal(json1.choices[0].message.content, "world-from-rule");

    const res2 = await postJson(`${server.baseUrl}/chat/completions`, {
      stream: true,
      messages: [{ role: "user", content: "other" }],
    });
    assert.equal(res2.status, 200);
    assert.match(res2.body, /fallback-reply/);
    assert.match(res2.body, /\[DONE\]/);

    const traces = server.getTraces();
    assert.equal(traces.length, 2);
    assert.equal(traces[0].model, "mock-r1");
    assert.ok(traces[0].promptTokens > 0);
    assert.ok(traces[0].completionTokens > 0);
  } finally {
    await server.close();
  }
});

test("buildLocalJudgeTask 生成包含 mock 网关配置的同构任务（对齐 noj-judge 契约）", () => {
  const task = buildLocalJudgeTask({
    code: "print(1)",
    fileName: "submission.py",
    submissionMode: "code",
    judgeType: "dual",
  });
  assert.equal(task.language, "python3");
  assert.equal(task.judge_type, "dual");
  assert.deepEqual(
    (task.llm as Record<string, unknown>).gateway_url,
    "mock://echo",
  );

  const runtime = task.runtime_config as {
    evaluator: Record<string, unknown>;
    solution: Record<string, unknown>;
  };
  assert.equal(runtime.evaluator.image, DEFAULT_EVALUATOR_IMAGE);
  assert.ok(String(runtime.evaluator.image).startsWith("noj-"));
  assert.equal(typeof runtime.evaluator.command, "string");
  assert.equal(runtime.evaluator.command, "python3 evaluate.py");
  assert.equal(typeof runtime.evaluator.time_limit_ms, "number");
  assert.equal(typeof runtime.evaluator.memory_limit_mb, "number");

  assert.equal(runtime.solution.image, DEFAULT_SOLUTION_IMAGE);
  assert.ok(String(runtime.solution.image).startsWith("noj-"));
  assert.equal(typeof runtime.solution.call_timeout_ms, "number");
  assert.equal(runtime.solution.call_timeout_ms, 10000);
  assert.equal("time_limit_ms" in runtime.solution, false);
  assert.equal(typeof runtime.solution.memory_limit_mb, "number");

  // 合法的自定义或题目 runtime_config 镜像应优先采用；非受信前缀镜像自动回退默认值
  assert.equal(isApprovedJudgeImage("python"), false);
  assert.equal(isApprovedJudgeImage("ghcr.io/neuro-oj/noj-evaluator:v1"), true);
  const customTask = buildLocalJudgeTask({
    code: "print(2)",
    fileName: "submission.py",
    evaluatorImage: "python",
    runtimeConfig: {
      evaluator: { image: "registry.local/noj-evaluator-gpu:2.0" },
      solution: { image: "noj-solution-torch:1.0" },
    },
  });
  const customRuntime = customTask.runtime_config as {
    evaluator: Record<string, unknown>;
    solution: Record<string, unknown>;
  };
  assert.equal(
    customRuntime.evaluator.image,
    "registry.local/noj-evaluator-gpu:2.0",
  );
  assert.equal(customRuntime.solution.image, "noj-solution-torch:1.0");
});

test("runPythonMockTrack 在零 Docker 模式下执行 .noj/local_eval.py 并捕获 Mock Trace", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noj-mock-py-"));
  const server = await startLocalLlmMockServer({
    defaultReply: "mocked-answer",
  });
  try {
    await fs.mkdir(path.join(dir, ".noj"), { recursive: true });
    const entry = path.join(dir, "submission.py");
    await fs.writeFile(entry, "print('hello')\n", "utf8");
    const evalScript = path.join(dir, ".noj", "local_eval.py");
    await fs.writeFile(
      evalScript,
      [
        "import json, os, urllib.request",
        "assert os.environ['OPENAI_BASE_URL'].endswith('/v1')",
        "assert not os.environ['NOJ_LLM_GATEWAY_URL'].endswith('/v1')",
        "assert os.environ['NOJ_LLM_TOKEN'] == 'noj-local-mock'",
        "assert os.environ['OPENAI_API_KEY'] == 'noj-local-mock'",
        "sdk_req = urllib.request.Request(",
        "    os.environ['NOJ_LLM_GATEWAY_URL'] + '/v1/chat/completions',",
        "    data=json.dumps({'messages': [{'role': 'user', 'content': 'ping-sdk'}]}).encode(),",
        "    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.environ['NOJ_LLM_TOKEN']},",
        ")",
        "with urllib.request.urlopen(sdk_req) as sdk_resp:",
        "    sdk_data = json.loads(sdk_resp.read().decode())",
        "req = urllib.request.Request(",
        "    os.environ['OPENAI_BASE_URL'] + '/chat/completions',",
        "    data=json.dumps({'messages': [{'role': 'user', 'content': 'ping-openai'}]}).encode(),",
        "    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.environ['OPENAI_API_KEY']},",
        ")",
        "with urllib.request.urlopen(req) as resp:",
        "    data = json.loads(resp.read().decode())",
        "reply = data['choices'][0]['message']['content']",
        "sdk_reply = sdk_data['choices'][0]['message']['content']",
        "result = {",
        "    'status': 'AC' if reply == 'mocked-answer' and sdk_reply == 'mocked-answer' else 'WA',",
        "    'score': 100,",
        "    'dimensions': [{'name': '准确性', 'score': 100}, {'name': '格式', 'score': 90}, {'name': '延迟', 'score': 95}],",
        "}",
        "print('__NOJ_RESULT__:' + json.dumps(result))",
      ].join("\n"),
      "utf8",
    );

    const feedback = await runPythonMockTrack({
      pythonBinary: process.env.PYTHON || "python3",
      title: "本地评测测试",
      entryFilePath: entry,
      workspaceRoot: dir,
      mockServer: server,
    });

    assert.equal(feedback.source, "local_mock");
    assert.equal(feedback.status, "AC");
    assert.equal(feedback.score, 100);
    assert.equal(feedback.dimensions.length, 3);
    assert.equal(feedback.traces.length, 2);
    assert.equal(feedback.traces[0].responsePreview, "mocked-answer");
    assert.equal(feedback.traces[1].responsePreview, "mocked-answer");
    assert.equal(feedback.metering?.callCount, 2);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("buildPythonMockEnv 注入无 /v1 后缀的 NOJ_LLM_GATEWAY_URL、NOJ_LLM_TOKEN 与 /v1 的 OPENAI_BASE_URL 并保留显式覆盖", () => {
  const defaultEnv = buildPythonMockEnv({
    entryFilePath: "/ws/submission.py",
    cwd: "/ws",
    mockServerBaseUrl: "http://127.0.0.1:43210/v1",
  });
  assert.equal(defaultEnv.OPENAI_BASE_URL, "http://127.0.0.1:43210/v1");
  assert.equal(defaultEnv.OPENAI_API_BASE, "http://127.0.0.1:43210/v1");
  assert.equal(defaultEnv.NOJ_LLM_GATEWAY_URL, "http://127.0.0.1:43210");
  assert.equal(defaultEnv.NOJ_LLM_TOKEN, "noj-local-mock");
  assert.equal(defaultEnv.OPENAI_API_KEY, "noj-local-mock");
  assert.equal(defaultEnv.NOJ_LLM_ALLOWED_MODELS, "mock-gpt-4o-mini");

  const overriddenEnv = buildPythonMockEnv({
    entryFilePath: "/ws/submission.py",
    cwd: "/ws",
    mockServerBaseUrl: "http://127.0.0.1:43210/v1/",
    env: {
      NOJ_LLM_TOKEN: "custom-token",
      NOJ_LLM_GATEWAY_URL: "http://custom-gateway:8001",
    },
  });
  assert.equal(overriddenEnv.NOJ_LLM_TOKEN, "custom-token");
  assert.equal(overriddenEnv.NOJ_LLM_GATEWAY_URL, "http://custom-gateway:8001");
  assert.equal(overriddenEnv.OPENAI_BASE_URL, "http://127.0.0.1:43210/v1/");
});

test("runLocalJudgeTrack 在双容器模式缺少支持包 .zip 时直接拒绝执行", async () => {
  await assert.rejects(
    () =>
      runLocalJudgeTrack({
        binary: "noj-judge",
        title: "missing-pkg",
        code: "print(1)",
        fileName: "submission.py",
        judgeType: "dual",
      }),
    /双容器本地评测需要题目的支持包（\.zip）/,
  );
});

const VALID_OI_RUNTIME_CONFIG: Record<string, unknown> = {
  backend: "native",
  languages: ["c", "cc"],
  time_limit_ms: 1000,
  memory_limit_mb: 256,
  checker: { type: "default" },
  subtasks: [
    {
      id: "sub1",
      score: 40,
      cases: [{ input: "1.in", output: "1.out" }],
    },
    {
      id: "sub2",
      score: 60,
      cases: [{ input: "2.in", output: "2.out" }],
    },
  ],
};

test("buildLocalJudgeTask 对 OI 题拒绝残缺 runtime_config 且仅在配置完整时生成合法任务", () => {
  assert.throws(
    () =>
      buildLocalJudgeTask({
        code: "int main() { return 0; }",
        fileName: "main.cpp",
        judgeType: "oi",
      }),
    /缺少完整的 runtime_config|需要完整的 runtime_config/,
  );

  assert.throws(
    () =>
      buildLocalJudgeTask({
        code: "int main() { return 0; }",
        fileName: "main.cpp",
        judgeType: "oi",
        runtimeConfig: {
          backend: "native",
          time_limit_ms: 2000,
          memory_limit_mb: 256,
          subtasks: [],
        },
      }),
    /languages|checker|subtasks/,
  );

  assert.throws(
    () =>
      buildLocalJudgeTask({
        code: "print(1)",
        fileName: "submission.py",
        judgeType: "oi",
        runtimeConfig: VALID_OI_RUNTIME_CONFIG,
      }),
    /仅支持 c\/cc 源码文件/,
  );

  assert.equal(
    isValidOiRuntimeConfig({
      ...VALID_OI_RUNTIME_CONFIG,
      checker: { type: "testlib" },
    }),
    false,
  );
  assert.equal(isValidOiRuntimeConfig(VALID_OI_RUNTIME_CONFIG), true);

  const task = buildLocalJudgeTask({
    code: "int main() { return 0; }",
    fileName: "main.cpp",
    judgeType: "oi",
    runtimeConfig: VALID_OI_RUNTIME_CONFIG,
  });
  assert.equal(task.judge_type, "oi");
  assert.equal(task.language, "cc");
  assert.equal("llm" in task, false);
  const validated = validateOiRuntimeConfig(task.runtime_config);
  assert.deepEqual(validated.languages, ["c", "cc"]);
  assert.equal(validated.checker.type, "default");
  assert.equal(validated.subtasks.length, 2);
});

test("runLocalJudgeTrack 在 OI 模式缺少完整 runtimeConfig 或支持包时拒绝启动", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noj-oi-tracka-"));
  const zipPath = path.join(dir, "oi-support.zip");
  try {
    await fs.writeFile(zipPath, Buffer.from("PK\x05\x06" + "\0".repeat(18)));

    await assert.rejects(
      () =>
        runLocalJudgeTrack({
          binary: "noj-judge",
          title: "oi-no-pkg",
          code: "int main() { return 0; }",
          fileName: "main.cpp",
          judgeType: "oi",
          runtimeConfig: VALID_OI_RUNTIME_CONFIG,
        }),
      /需要包含测试数据的支持包（\.zip）/,
    );

    await assert.rejects(
      () =>
        runLocalJudgeTrack({
          binary: "noj-judge",
          title: "oi-bad-rc",
          code: "int main() { return 0; }",
          fileName: "main.cpp",
          judgeType: "oi",
          supportPackagePath: zipPath,
        }),
      /需要完整的 runtime_config/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadLocalOiRuntimeConfig 仅加载完整合法的本地 OI runtime_config", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noj-oi-rc-load-"));
  try {
    await fs.mkdir(path.join(dir, ".noj"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".noj", "runtime-config.json"),
      JSON.stringify({ backend: "native", subtasks: [] }),
      "utf8",
    );
    assert.equal(await loadLocalOiRuntimeConfig(dir), undefined);

    await fs.writeFile(
      path.join(dir, ".noj", "runtime-config.json"),
      JSON.stringify(VALID_OI_RUNTIME_CONFIG),
      "utf8",
    );
    const loaded = await loadLocalOiRuntimeConfig(dir);
    assert.deepEqual(loaded, VALID_OI_RUNTIME_CONFIG);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
