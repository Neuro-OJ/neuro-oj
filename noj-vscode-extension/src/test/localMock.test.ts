import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  buildLocalJudgeTask,
  runPythonMockTrack,
  startLocalLlmMockServer,
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

test("buildLocalJudgeTask 生成包含 mock 网关配置的同构任务", () => {
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
        "req = urllib.request.Request(",
        "    os.environ['OPENAI_BASE_URL'] + '/chat/completions',",
        "    data=json.dumps({'messages': [{'role': 'user', 'content': 'ping'}]}).encode(),",
        "    headers={'Content-Type': 'application/json'},",
        ")",
        "with urllib.request.urlopen(req) as resp:",
        "    data = json.loads(resp.read().decode())",
        "reply = data['choices'][0]['message']['content']",
        "result = {",
        "    'status': 'AC' if reply == 'mocked-answer' else 'WA',",
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
    assert.equal(feedback.traces.length, 1);
    assert.equal(feedback.traces[0].responsePreview, "mocked-answer");
    assert.equal(feedback.metering?.callCount, 1);
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
