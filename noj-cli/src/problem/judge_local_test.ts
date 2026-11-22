/**
 * `problem test` 单元测试：断言解析、任务构造、支持包构建与退出码。
 *
 * 真实 Docker 评测由 CI 的模板验收任务覆盖；这里用一个假的 noj-judge 脚本
 * 验证 CLI 与 `run-local` 的进程协议和退出码约定，不依赖 Docker。
 */
import {
    assert,
    assertEquals,
    assertRejects,
    assertStringIncludes,
    assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { unzipSync } from "fflate";
import { validateBundleManifest } from "../../../noj-core/src/modules/problems/types/problem-bundle.ts";
import { shouldExclude } from "./pack.ts";
import {
    buildLlmTask,
    buildSupportPackage,
    checkExpectation,
    judgeObjective,
    JudgeUnavailableError,
    mockGatewayUrl,
    oiLanguageFor,
    parseExpectation,
    parseExpectFile,
    parseSolutionArg,
    prepareSubmission,
    probeJudge,
    stderrSummary,
} from "./judge-local.ts";
import { evaluateExpectations, resolveLlmMode } from "./test-command.ts";
import { parseProblemArgs, runProblem } from "./command.ts";
import { UsageError } from "../util/args.ts";

Deno.test("parseExpectation: 支持五种比较符与边界", () => {
    assertEquals(parseExpectation("good=100"), {
        name: "good",
        op: "=",
        value: 100,
        raw: "good=100",
    });
    assertEquals(parseExpectation("p>=50.5").op, ">=");
    assertEquals(parseExpectation("w<60").op, "<");
    assertThrows(() => parseExpectation("good"));
    assertThrows(() => parseExpectation("good=101"));
    assertThrows(() => parseExpectation("go od=1"));
});

Deno.test("checkExpectation: = 容忍浮点误差，其余严格比较", () => {
    assert(checkExpectation(99.999, parseExpectation("g=100")));
    assert(!checkExpectation(99.9, parseExpectation("g=100")));
    assert(checkExpectation(59.99, parseExpectation("w<60")));
    assert(!checkExpectation(60, parseExpectation("w<60")));
    assert(checkExpectation(60, parseExpectation("w<=60")));
    assert(checkExpectation(0.01, parseExpectation("w>0")));
});

Deno.test("parseExpectFile: 字符串断言与数字简写", () => {
    const list = parseExpectFile('{"good": 100, "wrong": "<60", "p": ">= 10"}');
    assertEquals(list.map((e) => e.raw), ["good=100", "wrong<60", "p>=10"]);
    assertThrows(() => parseExpectFile("[]"));
    assertThrows(() => parseExpectFile('{"a": true}'));
});

Deno.test("parseSolutionArg: 名称缺省取文件名，@ 后缀可改名", () => {
    assertEquals(parseSolutionArg("sol/good.py", "/w"), {
        name: "good",
        path: "/w/sol/good.py",
    });
    assertEquals(parseSolutionArg("/a/x.py@best", "/w").name, "best");
    assertThrows(() => parseSolutionArg("/a/x.py@bad name", "/w"));
});

Deno.test("parseProblemArgs: test 子命令选项", () => {
    const a = parseProblemArgs([
        "test",
        "./p",
        "--solution",
        "a.py",
        "--solution",
        "b.py@bee",
        "--expect",
        "a=100",
        "--judge-bin",
        "/bin/j",
        "--allow-network",
        "--network",
        "noj-eval-net",
        "--no-llm-mock",
        "--json",
    ]);
    assertEquals(a.dir, "./p");
    assertEquals(a.solutions, ["a.py", "b.py@bee"]);
    assertEquals(a.expects, ["a=100"]);
    assertEquals(a.judgeBin, "/bin/j");
    assertEquals(a.allowNetwork, true);
    assertEquals(a.network, "noj-eval-net");
    assertEquals(a.llmMock, false);
});

Deno.test("resolveLlmMode: 默认 mock，真实网关必须显式联网并带 token", () => {
    const base = parseProblemArgs(["test"]);
    assertEquals(resolveLlmMode(base).kind, "mock");
    assertThrows(
        () =>
            resolveLlmMode({ ...base, llmGateway: "http://g", llmToken: "t" }),
        UsageError,
    );
    assertThrows(
        () =>
            resolveLlmMode({
                ...base,
                llmGateway: "http://g",
                allowNetwork: true,
            }),
        UsageError,
    );
    assertEquals(
        resolveLlmMode({
            ...base,
            llmGateway: "http://g",
            llmToken: "t",
            allowNetwork: true,
        }).kind,
        "gateway",
    );
});

Deno.test("shouldExclude: 根级 submissions/ 目录（参考解答）不进包", () => {
    assertEquals(shouldExclude("submissions/good.py"), true);
    assertEquals(shouldExclude("submissions/expect.json"), true);
    assertEquals(shouldExclude("data/visible.jsonl"), false);
});

async function writeTree(root: string, files: Record<string, string>) {
    for (const [name, content] of Object.entries(files)) {
        const path = join(root, name);
        await Deno.mkdir(join(path, ".."), { recursive: true });
        await Deno.writeTextFile(path, content);
    }
}

Deno.test("buildSupportPackage: 剥离元数据与参考解答，保留评测文件", async () => {
    const dir = await Deno.makeTempDir();
    try {
        await writeTree(dir, {
            "problem.json": '{"format_version":3,"kind":"ai","title":"t"}',
            "statement.md": "# t",
            "evaluate.py": "print(1)",
            "template.py": "def solve(): raise NotImplementedError",
            "data/hidden.jsonl": "{}",
            // 非根级的 submission* 目录不属于参考解答，pack 会保留，支持包也必须保留
            "data/submission-files/input.txt": "input",
            "submissions/good.py": "def solve(): return 1",
        });
        const names = Object.keys(unzipSync(await buildSupportPackage(dir)))
            .sort();
        assertEquals(names, [
            "data/hidden.jsonl",
            "data/submission-files/input.txt",
            "evaluate.py",
            "template.py",
        ]);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("prepareSubmission: 代码题生成生产同款 JudgeTask", async () => {
    const dir = await Deno.makeTempDir();
    try {
        await writeTree(dir, {
            "good.py": "def solve(a, b):\n    return a + b\n",
        });
        const manifest = validateBundleManifest({
            format_version: 3,
            kind: "ai",
            title: "t",
        });
        const { task, artifact } = await prepareSubmission(dir, manifest, {
            name: "good",
            path: join(dir, "good.py"),
        }, { kind: "mock" });
        assertEquals(artifact, undefined);
        assertEquals(task.language, "python3");
        assertEquals(task.submission_mode, "code");
        assertEquals(task.judge_type, "dual");
        assertEquals(task.evaluation_protocol_version, 3);
        assertEquals(task.task_kind, "submission");
        assertEquals(task.attempt_id, task.run_id);
        assertStringIncludes(task.code, "return a + b");
        // 未声明 llm 的题目不注入 LLM 字段
        assertEquals(task.llm, undefined);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("prepareSubmission: 界面题复用 core 的参数注入", async () => {
    const dir = await Deno.makeTempDir();
    try {
        await writeTree(dir, {
            "template.py": "def answer():\n    return prompt\n",
            "params.json": '{"prompt": "你好"}',
        });
        const manifest = validateBundleManifest({
            format_version: 3,
            kind: "ai",
            title: "t",
            submission_mode: "ui",
        });
        const { task } = await prepareSubmission(dir, manifest, {
            name: "p",
            path: join(dir, "params.json"),
        }, { kind: "none" });
        assertEquals(task.language, "python3");
        assertStringIncludes(task.code, 'prompt = PARAMS["prompt"]');
        assertStringIncludes(task.code, "def answer():");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("prepareSubmission: prediction 题以预测文件作为 artifact", async () => {
    const dir = await Deno.makeTempDir();
    try {
        await writeTree(dir, { "pred.csv": "id,label\n1,0\n" });
        const manifest = validateBundleManifest({
            format_version: 3,
            kind: "ai",
            title: "t",
            submission_mode: "prediction",
        });
        const { task, artifact } = await prepareSubmission(dir, manifest, {
            name: "pred",
            path: join(dir, "pred.csv"),
        }, { kind: "mock" });
        assertEquals(task.submission_mode, "prediction");
        assertEquals(task.file_name, "pred.csv");
        assertEquals(task.code, "");
        assertEquals(new TextDecoder().decode(artifact), "id,label\n1,0\n");
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("prepareSubmission: prediction 题复用生产上传校验（拒绝目录与 zip）", async () => {
    const dir = await Deno.makeTempDir();
    try {
        await writeTree(dir, {
            "pred.zip": "PK\u0003\u0004xx",
            "preddir/a.csv": "id\n1\n",
        });
        const manifest = validateBundleManifest({
            format_version: 3,
            kind: "ai",
            title: "t",
            submission_mode: "prediction",
        });
        await assertRejects(() =>
            prepareSubmission(dir, manifest, {
                name: "zip",
                path: join(dir, "pred.zip"),
            }, { kind: "none" })
        );
        await assertRejects(
            () =>
                prepareSubmission(dir, manifest, {
                    name: "dir",
                    path: join(dir, "preddir"),
                }, { kind: "none" }),
            Error,
            "单个预测文件",
        );
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("buildLlmTask: mock 网关携带题目声明的模型别名", () => {
    const manifest = validateBundleManifest({
        format_version: 3,
        kind: "ai",
        title: "t",
        llm: { max_calls: 5, models: ["default", "fast"] },
    });
    // 声明 llm 时 evaluator 网络被平台缺省开启（run-local 默认会再关闭）
    assertEquals(
        (manifest.runtime_config as { evaluator: { network?: unknown } })
            .evaluator.network,
        { enabled: true },
    );
    const mock = buildLlmTask(manifest, { kind: "mock" })!;
    // 预算经 mock 网关查询串传给 SDK
    assertEquals(mock.gateway_url, "mock://echo?max_calls=5");
    assertEquals(mock.allowed_models, ["default", "fast"]);
    assertEquals(buildLlmTask(manifest, { kind: "none" }), undefined);
});

Deno.test("mockGatewayUrl: 无预算时为纯 mock 地址", () => {
    assertEquals(mockGatewayUrl(undefined), "mock://echo");
    assertEquals(
        mockGatewayUrl({ max_calls: 3, max_tokens: 1000 }),
        "mock://echo?max_calls=3&max_tokens=1000",
    );
});

Deno.test("oiLanguageFor / stderrSummary", () => {
    assertEquals(oiLanguageFor("a.c"), "c");
    assertEquals(oiLanguageFor("a.cpp"), "cc");
    assertThrows(() => oiLanguageFor("a.py"));
    assertEquals(stderrSummary("out\n--- STDERR ---\na\n\nb\n"), "a\nb");
    assertEquals(stderrSummary("no stderr"), "");
});

Deno.test("evaluateExpectations: 执行失败的解答不满足任何断言", () => {
    const base = {
        path: "/x",
        status: "finished",
        time_ms: 1,
        wall_ms: 1,
        stderr: "",
        notes: [],
    };
    const results = evaluateExpectations([
        { ...base, name: "good", score: 100, error: null },
        { ...base, name: "bad", score: 0, error: "boom" },
    ], [parseExpectation("good=100"), parseExpectation("bad=0")]);
    assertEquals(results.map((r) => r.pass), [true, false]);
    assertEquals(results[1]!.actual, null);
});

Deno.test("judgeObjective: 用 core 的 judgePaper 判分", async () => {
    const dir = await Deno.makeTempDir();
    try {
        await writeTree(dir, {
            "questions.json": JSON.stringify([
                {
                    key: "q1",
                    type: "single",
                    prompt: "1+1?",
                    options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
                    answer: ["A"],
                },
                { type: "judge", prompt: "天是蓝的", answer: [true] },
            ]),
            "half.json": '{"q1": ["A"], "2": [false]}',
        });
        const r = await judgeObjective(dir, {
            name: "half",
            path: join(dir, "half.json"),
        });
        assertEquals(r.score, 50);
        assertEquals(r.error, null);
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

/** 假 noj-judge：源码含 `return a + b` 得满分，否则 0 分。 */
async function fakeJudge(dir: string): Promise<string> {
    const path = join(dir, "fake-judge.sh");
    await Deno.writeTextFile(
        path,
        `#!/bin/sh
[ "$1" = "run-local" ] || exit 2
if [ "$2" = "--help" ]; then echo "用法: noj-judge run-local --task <task.json>"; exit 0; fi
shift
while [ $# -gt 0 ]; do
  case "$1" in --task) TASK="$2"; shift ;; esac
  shift
done
if grep -q "crash_evaluator" "$TASK"; then
  echo '{"result":{"status":"SE","score":0,"output":"","details":{}},"wall_ms":1,"notes":[],"error":"评测平台错误（status=SE），不是正式得分"}'
  exit 0
fi
if grep -q "return a + b" "$TASK"; then SCORE=10000; else SCORE=0; fi
echo '{"result":{"status":"finished","score":'$SCORE',"output":"","details":{}},"wall_ms":1,"notes":[]}'
`,
    );
    await Deno.chmod(path, 0o755);
    return path;
}

async function aiProblem(root: string): Promise<string> {
    const dir = join(root, "p");
    await writeTree(dir, {
        "problem.json": '{"format_version":3,"kind":"ai","title":"A+B"}',
        "evaluate.py": "print('---RESULT---')",
        "submissions/good.py": "def solve(a, b):\n    return a + b\n",
        "submissions/wrong.py": "def solve(a, b):\n    return 0\n",
        "submissions/expect.json": '{"good": "=100", "wrong": "<60"}',
    });
    return dir;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
    const log = console.log, error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
        return await fn();
    } finally {
        console.log = log;
        console.error = error;
    }
}

Deno.test("problem test: expect.json 全部满足时退出码 0", async () => {
    const root = await Deno.makeTempDir();
    try {
        const dir = await aiProblem(root);
        const code = await quiet(() =>
            runProblem(
                parseProblemArgs(["test", dir, "--judge-bin", "PLACEHOLDER"]),
            ).catch((e) => e)
        );
        // 占位二进制不存在 → 用法错误（UsageError，由 cli.ts 映射为退出码 2）
        assert(code instanceof UsageError);
        const judge = await fakeJudge(root);
        assertEquals(
            await quiet(() =>
                runProblem(
                    parseProblemArgs(["test", dir, "--judge-bin", judge]),
                )
            ),
            0,
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("problem test: 断言不满足时退出码 1（负例）", async () => {
    const root = await Deno.makeTempDir();
    try {
        const dir = await aiProblem(root);
        const judge = await fakeJudge(root);
        assertEquals(
            await quiet(() =>
                runProblem(
                    parseProblemArgs([
                        "test",
                        dir,
                        "--judge-bin",
                        judge,
                        "--expect",
                        "wrong=100",
                    ]),
                )
            ),
            1,
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("problem test: lint 失败即停，退出码 1", async () => {
    const root = await Deno.makeTempDir();
    try {
        const dir = join(root, "p");
        await writeTree(dir, {
            "problem.json": '{"format_version":3,"kind":"ai","title":"t"}',
            "submissions/good.py": "",
        });
        assertEquals(
            await quiet(() =>
                runProblem(
                    parseProblemArgs(["test", dir, "--judge-bin", "/nope"]),
                )
            ),
            1,
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("problem test: 用法错误（无解答 / 断言引用未知解答 / 单独 --network）", async () => {
    const root = await Deno.makeTempDir();
    try {
        const dir = await aiProblem(root);
        await assertRejects(
            () =>
                quiet(() =>
                    runProblem(
                        parseProblemArgs(["test", dir, "--expect", "nope=1"]),
                    )
                ),
            UsageError,
        );
        await assertRejects(
            () =>
                quiet(() =>
                    runProblem(
                        parseProblemArgs(["test", dir, "--network", "x"]),
                    )
                ),
            UsageError,
        );
        const empty = join(root, "empty");
        await writeTree(empty, {
            "problem.json": '{"format_version":3,"kind":"ai","title":"t"}',
            "evaluate.py": "",
        });
        await assertRejects(
            () => quiet(() => runProblem(parseProblemArgs(["test", empty]))),
            UsageError,
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("probeJudge: 旧版 judge（忽略参数）被拒绝，且探测时 Redis 不可达", async () => {
    const root = await Deno.makeTempDir();
    try {
        const envFile = join(root, "env.txt");
        const old = join(root, "old-judge.sh");
        // 模拟旧版：不认识 run-local，直接当 Worker 启动并记录拿到的 Redis/Docker 地址
        await Deno.writeTextFile(
            old,
            `#!/bin/sh\necho "$REDIS_URL $JUDGE_DOCKER_HOST" > "${envFile}"\necho "worker started"\n`,
        );
        await Deno.chmod(old, 0o755);
        await assertRejects(() => probeJudge(old), JudgeUnavailableError);
        const seen = await Deno.readTextFile(envFile);
        assertStringIncludes(seen, "redis://127.0.0.1:1/0");
        assertStringIncludes(seen, "/nonexistent/");
        await probeJudge(await fakeJudge(root));
        await assertRejects(
            () => probeJudge(join(root, "missing")),
            JudgeUnavailableError,
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("problem test: 平台错误（evaluator 崩溃）不计为 0 分，断言失败退出 1", async () => {
    const root = await Deno.makeTempDir();
    try {
        const dir = await aiProblem(root);
        await Deno.writeTextFile(
            join(dir, "submissions/crash.py"),
            "# crash_evaluator\n",
        );
        await Deno.writeTextFile(
            join(dir, "submissions/expect.json"),
            '{"good": "=100", "crash": "=0"}',
        );
        const judge = await fakeJudge(root);
        assertEquals(
            await quiet(() =>
                runProblem(
                    parseProblemArgs(["test", dir, "--judge-bin", judge]),
                )
            ),
            1,
        );
    } finally {
        await Deno.remove(root, { recursive: true });
    }
});
