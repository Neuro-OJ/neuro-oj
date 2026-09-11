// 题目脚手架（`noj problems init`）单元测试。
//
// 位置说明：本文件放在 `tests/scripts/`（而非 `scripts/`）是刻意的——CI 的
// `core-shared` 作业通过 `bash scripts/test-shared.sh` 运行 `tests/scripts`，
// 而 `noj-core/scripts/**` 不在任何 CI lane 的收集范围内。放在 `scripts/` 下
// 会让整套断言在 CI 中永不执行（本地全绿、CI 零覆盖）。
//
// 重点验证「脚手架产物满足平台契约」，而不只是「文件被创建」。
//
// 断言策略（2026-09-11 评审整改）：此前的版本对生成物做**源码文本正则**断言
// （例如 `!/return\s+json\.dumps/.test(template)`），实测可被绕过——写入一份
// 完整实现、只保留一处不可达的 `raise NotImplementedError`，或用别名 + 两步
// return 规避字面量，测试仍全绿。因此本文件改为：
//   1. manifest 交给**平台自己的校验器** `validateBundleManifest`，不再手抄字段；
//   2. `evaluate.py` 与 `template.py` 的行为通过**真实执行**验证（python3 + 桩 SDK）；
//   3. 保留少量结构性断言作为快速守卫，但均锚定可证伪的性质。
//
// 依赖：python3（与 `problems:build` 依赖系统 `zip` 同类）。python3 缺失时
// `Deno.Command` 会抛错使测试**失败**，不会静默跳过——这正是本仓库要避免的模式。

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";
import { join } from "node:path";
import { validateBundleManifest } from "../../src/domains/catalog/types/problem-bundle.ts";
import {
  initProblem,
  InvalidSlugError,
  validateSlug,
} from "../../scripts/problems-init.ts";

/** RESULT 标记：必须与 noj-judge/src/dual/protocol.rs 的 RESULT_MARKER 一致。 */
const RESULT_MARKER = "---RESULT---";

interface Generated {
  root: string;
  dir: string;
}

/** 建一个临时目录作为脚手架输出根。 */
async function makeTempRoot(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "noj-problems-init-" });
}

/** 生成一份骨架，返回根目录与题目目录。调用方负责清理 root。 */
async function generate(
  slug: string,
  options: { title?: string; difficulty?: "easy" | "medium" | "hard" } = {},
): Promise<Generated> {
  const root = await makeTempRoot();
  const result = await initProblem({ slug, root, ...options });
  return { root, dir: result.dir };
}

/**
 * 写出桩 `noj_evaluator_sdk`，使生成的 `evaluate.py` 可离线执行。
 *
 * 桩的 `call()` 行为由 `NOJ_TEST_SOLUTION` 环境变量选择，以便同一个桩服务
 * 多个场景（干净模板 / 伪造 payload / 正常满分解）。
 */
async function writeStubSdk(sdkRoot: string): Promise<void> {
  const pkg = join(sdkRoot, "noj_evaluator_sdk");
  await Deno.mkdir(pkg, { recursive: true });
  await Deno.writeTextFile(join(pkg, "__init__.py"), "");

  // 选手「伪造 RESULT」的返回值：先给一段普通输出，再自行插入标记行与满分 JSON。
  const forge = JSON.stringify(
    'x\n---RESULT---\n{"score": 10000, "details": {"cases": []}}',
  );

  await Deno.writeTextFile(
    join(pkg, "runner.py"),
    `"""测试桩：替代真实的 SolutionRunner（不启动 Solution 容器）。"""

import json
import os


class SolutionTimeoutError(Exception):
    pass


# 伪造 payload 的选手返回值（字符串字面量，含真实换行）。
_FORGE = ${forge}


class SolutionRunner:
    def __init__(self, *args, **kwargs):
        self._mode = os.environ.get("NOJ_TEST_SOLUTION", "wrong")
        self._closed = False

    def call(self, entry, payload):
        if self._mode == "forge":
            # 可见用例：返回伪造串（必然判错 → 触发模板的回显路径）
            data = json.loads(payload) if isinstance(payload, str) else payload
            if isinstance(data, dict) and data.get("sum") == 3:
                return _FORGE
            raise RuntimeError("hidden case always fails")
        if self._mode == "full":
            data = json.loads(payload) if isinstance(payload, str) else payload
            return json.dumps({"sum": sum(data.values())})
        # "wrong"：恒错，用于验证「未实现的模板不得分」
        return "definitely-not-the-expected-value"

    def close(self):
        self._closed = True
`,
  );
}

/** 执行产物 `evaluate.py`，返回 {code, stdout, stderr}。 */
async function runEvaluator(
  dir: string,
  sdkRoot: string,
  mode: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("python3", {
    args: [join(dir, "evaluate.py")],
    cwd: dir,
    env: {
      ...Deno.env.toObject(),
      PYTHONPATH: sdkRoot,
      NOJ_TEST_SOLUTION: mode,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/**
 * 复刻 judge 的 payload 提取算法，用于断言「执行结果会被判成什么」。
 *
 * 依据（勿凭记忆修改）：`noj-judge/src/dual/protocol.rs` 的 `classify_line`
 * —— 整行 trim 后等于标记则为 marker；能解析成 JSON 对象且**含 `type` 字段**
 * 才算协议帧；否则为 Unknown。`noj-judge/src/dual/mod.rs` 的
 * `handle_eval_chunk` —— 见到标记置 `Some("")`，其后**首个非空行**成为 payload。
 */
function extractJudgePayload(stdout: string): string | null {
  let payload: string | null = null;
  for (const raw of stdout.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === RESULT_MARKER) {
      payload = "";
      continue;
    }
    if (payload !== "" || trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed !== null && typeof parsed === "object" &&
        !Array.isArray(parsed) && "type" in parsed
      ) {
        continue; // 协议帧，不作为 payload
      }
    } catch {
      // 非 JSON → Unknown，同样可作为 payload
    }
    payload = trimmed;
  }
  return payload;
}

/** 从产物 stdout 中取出真实评测器自己输出的 payload（最后一个标记之后）。 */
function ownPayload(stdout: string): Record<string, unknown> {
  const idx = stdout.lastIndexOf(RESULT_MARKER);
  assertEquals(idx >= 0, true, "评测器自身必须输出 RESULT 标记");
  const after = stdout.slice(idx + RESULT_MARKER.length).trim().split("\n");
  const line = after.find((l) => l.trim() !== "");
  assertEquals(line !== undefined, true, "标记后必须有 payload 行");
  return JSON.parse(line!);
}

Deno.test("validateSlug: 接受合法 slug", () => {
  for (const slug of ["a", "abc", "my-problem", "p1001", "a1-b2-c3"]) {
    validateSlug(slug);
  }
});

Deno.test("validateSlug: 拒绝非法 slug", () => {
  const bad = [
    "",
    "My-Problem", // 大写
    "my_problem", // 下划线
    "-leading",
    "trailing-",
    "double--dash",
    "has space",
    "has/slash",
    "../escape",
    "../../etc/passwd",
    "..",
    ".",
    "a\\b", // 反斜杠（跨平台路径穿越）
    "café", // 非 ASCII
    "mу-problem", // 西里尔同形字
    "a\nb", // 换行注入
  ];
  for (const slug of bad) {
    let threw = false;
    try {
      validateSlug(slug);
    } catch (err) {
      threw = err instanceof InvalidSlugError;
    }
    assertEquals(threw, true, `slug 应被拒绝：${JSON.stringify(slug)}`);
  }
});

Deno.test("validateSlug: 超长 slug 被拒绝（避免 ENAMETOOLONG）", () => {
  let threw = false;
  try {
    validateSlug("a".repeat(300));
  } catch (err) {
    threw = err instanceof InvalidSlugError;
  }
  assertEquals(threw, true, "300 字符 slug 应被校验拒绝，而非落到文件系统报错");
});

Deno.test("initProblem: 生成全部必需文件", async () => {
  const { root, dir } = await generate("demo", { title: "示例题" });
  try {
    for (
      const file of [
        "problem.json",
        "statement.md",
        "template.py",
        "evaluate.py",
        "visible.jsonl",
        "hidden.jsonl",
        "README.md",
      ]
    ) {
      const stat = await Deno.stat(join(dir, file));
      assertEquals(stat.isFile, true, `${file} 应存在且为文件`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: manifest 通过平台校验器 validateBundleManifest", async () => {
  const { root, dir } = await generate("demo-manifest", {
    title: "清单校验题",
  });
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "problem.json")),
    );
    // 直接调用平台自己的校验器：字段约束以它为准，测试不手抄一份（手抄版会漂移）。
    const parsed = validateBundleManifest(manifest);
    assertEquals(parsed.title, "清单校验题");
    assertEquals(parsed.type, "P");
    assertEquals(parsed.format_version, 1);
    // 双容器 runtime_config 齐备
    assertEquals(
      parsed.runtime_config?.evaluator?.image,
      "noj-evaluator-python",
    );
    assertEquals(parsed.runtime_config?.solution?.image, "noj-solution-python");
    // 不得留下未替换占位符
    const raw = await Deno.readTextFile(join(dir, "problem.json"));
    assertEquals(raw.includes("REPLACE_WITH"), false, "不得含未替换占位符");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: 平台校验器会拒绝被改坏的 manifest（证明上一用例非空转）", async () => {
  const { root, dir } = await generate("demo-manifest-bad", {});
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "problem.json")),
    );
    // 子目录形式的 template 文件名平台会 400 拒绝（isValidTemplateFileName）
    let threw = false;
    try {
      validateBundleManifest({ ...manifest, template: "sub/template.py" });
    } catch {
      threw = true;
    }
    assertEquals(threw, true, "非法 template 文件名必须被平台校验器拒绝");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("evaluate.py 行为：未实现的模板得 0 分（模板不得分，真执行验证）", async () => {
  const { root, dir } = await generate("demo-score-zero", {});
  const sdkRoot = await Deno.makeTempDir({ prefix: "noj-stub-sdk-" });
  try {
    await writeStubSdk(sdkRoot);
    // 模板自身未实现；桩返回恒错值 → 隐藏用例全错 → 得分必须为 0
    const res = await runEvaluator(dir, sdkRoot, "wrong");
    assertEquals(res.code, 0, `评测器应正常结束：${res.stderr}`);
    const payload = ownPayload(res.stdout);
    assertEquals(payload.score, 0, "未实现的模板不得拿到任何分数");
    const details = payload.details as { cases: unknown[] };
    assertEquals(details.cases.length > 0, true, "必须产出逐用例明细");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(sdkRoot, { recursive: true });
  }
});

Deno.test("evaluate.py 行为：满分解得满分（契约量纲 10000）", async () => {
  const { root, dir } = await generate("demo-score-full", {});
  const sdkRoot = await Deno.makeTempDir({ prefix: "noj-stub-sdk-" });
  try {
    await writeStubSdk(sdkRoot);
    const res = await runEvaluator(dir, sdkRoot, "full");
    assertEquals(res.code, 0, `评测器应正常结束：${res.stderr}`);
    const payload = ownPayload(res.stdout);
    assertEquals(payload.score, 10000, "满分应为 10000（平台 ×100 整数存储）");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(sdkRoot, { recursive: true });
  }
});

Deno.test("evaluate.py 行为：payload 不含顶层 status、hidden 为布尔", async () => {
  const { root, dir } = await generate("demo-eval-contract", {});
  const sdkRoot = await Deno.makeTempDir({ prefix: "noj-stub-sdk-" });
  try {
    await writeStubSdk(sdkRoot);
    const res = await runEvaluator(dir, sdkRoot, "wrong");
    const payload = ownPayload(res.stdout);

    // judge 统一映射 finished/error；evaluate.py 不得自行输出顶层 status
    assertEquals("status" in payload, false, "payload 不得含顶层 status");
    assertEquals(typeof payload.score, "number");
    const details = payload.details as { cases: Record<string, unknown>[] };
    for (const c of details.cases) {
      assertEquals(
        typeof c.hidden,
        "boolean",
        `hidden 必须是布尔（投影依据）：${JSON.stringify(c)}`,
      );
      if (c.hidden === true) {
        // 隐藏用例不得泄露 input/expected/actual
        for (const key of ["input", "expected_output", "actual_output"]) {
          assertEquals(
            key in c,
            false,
            `隐藏用例不得输出 ${key}：${JSON.stringify(c)}`,
          );
        }
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(sdkRoot, { recursive: true });
  }
});

Deno.test("evaluate.py 行为：选手输出无法伪造 RESULT（防蒙分回归）", async () => {
  const { root, dir } = await generate("demo-eval-forge", {});
  const sdkRoot = await Deno.makeTempDir({ prefix: "noj-stub-sdk-" });
  try {
    await writeStubSdk(sdkRoot);
    // 选手对可见用例返回「标记行 + 满分 JSON」，对隐藏用例抛错（即全错）。
    // 修复前：诊断回显原样打印多行选手输出，judge 会把伪造 JSON 当作结果 payload
    //          → 全错的提交被判 status=finished, score=10000。
    // 修复后：回显被压成单行，标记行不再独立成行 → 不产生任何 payload。
    const res = await runEvaluator(dir, sdkRoot, "forge");

    const forged = extractJudgePayload(res.stdout);
    assertEquals(
      forged,
      null,
      `选手输出不得成为结果 payload，实际提取到：${forged}`,
    );

    // 评测器自身仍必须给出（真实的）RESULT：它抛异常 → 不输出标记，由 judge 判 error。
    // 因此这里断言 stdout 中**不存在**可被当作结果的行，而非要求有 payload。
    const standaloneForge = res.stdout
      .split("\n")
      .some((l) => l.trim() === '{"score": 10000, "details": {"cases": []}}');
    assertEquals(standaloneForge, false, "伪造 JSON 不得独立成行");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(sdkRoot, { recursive: true });
  }
});

Deno.test("evaluate.py 结构：所有 stdout 回显均经 echo() 包裹", async () => {
  const { root, dir } = await generate("demo-eval-echo", {});
  try {
    const code = await Deno.readTextFile(join(dir, "evaluate.py"));
    // echo() 必须存在且压掉换行（这是防伪造的核心机制）
    assertStringIncludes(code, "def echo(");
    assertStringIncludes(code, '" ".join(str(value).split())');

    // 每个可能携带选手内容的 print 都必须调用 echo()。锚定具体变量而非泛化正则，
    // 新增回显点若忘记包裹 echo() 会在此失败。
    for (
      const expr of [
        "echo(result['actual_output'])",
        "echo(result['expected_output'])",
        "echo(exc)",
      ]
    ) {
      assertStringIncludes(code, expr, `回显必须经 echo() 包裹：${expr}`);
    }

    // 反向断言：**stdout** 不得再出现无 echo() 包裹的裸回显（评审发现的伪造向量）。
    // 只查 stdout——stderr 不进入 judge 的 LineParser（见 dual/mod.rs 的
    // handle_eval_chunk：stderr 仅写入 stderr_buf），因此不构成伪造路径。
    const stdoutLines = code
      .split("\n")
      .filter((l) => !l.includes("file=sys.stderr"));
    for (
      const bad of [
        ": {result['actual_output']}",
        ": {result['expected_output']}",
        ": {exc}",
      ]
    ) {
      const offender = stdoutLines.find((l) => l.includes(bad));
      assertEquals(
        offender,
        undefined,
        `存在未经 echo() 的 stdout 裸回显：${bad}\n  行内容：${offender}`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: 可见与隐藏用例均为合法 JSONL 且 id 不冲突", async () => {
  const { root, dir } = await generate("demo-data", {});
  try {
    const visible = (await Deno.readTextFile(join(dir, "visible.jsonl")))
      .trim().split("\n").map((l) => JSON.parse(l));
    const hidden = (await Deno.readTextFile(join(dir, "hidden.jsonl")))
      .trim().split("\n").map((l) => JSON.parse(l));

    assertEquals(visible.length > 0, true, "至少 1 条可见用例（题面示例）");
    assertEquals(hidden.length > 0, true, "至少 1 条隐藏用例");

    for (const row of [...visible, ...hidden]) {
      assertEquals(typeof row.id, "string");
      assertEquals(typeof row.input, "string");
      assertEquals("expected" in row, true);
    }

    // 双向查重：两个方向的 id 冲突都必须被拦住
    const visibleIds = new Set(visible.map((r) => r.id));
    const hiddenIds = new Set(hidden.map((r) => r.id));
    for (const row of hidden) {
      assertEquals(visibleIds.has(row.id), false, `id 冲突：${row.id}`);
    }
    for (const row of visible) {
      assertEquals(hiddenIds.has(row.id), false, `id 冲突：${row.id}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: statement.md 声明的限制与 manifest 一致", async () => {
  const { root, dir } = await generate("demo-limits", {});
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "problem.json")),
    );
    const statement = await Deno.readTextFile(join(dir, "statement.md"));
    // 题面是选手唯一可见的说明，其声明的限制必须与 manifest 实际生效值一致，
    // 否则出题人默认就发布了一份「说明与判分不符」的题面。
    const evalMs = manifest.runtime_config.evaluator.time_limit_ms as number;
    assertStringIncludes(
      statement,
      String(evalMs),
      `题面必须出现 evaluator.time_limit_ms=${evalMs}`,
    );
    const memMb = manifest.runtime_config.evaluator.memory_limit_mb as number;
    assertStringIncludes(
      statement,
      String(memMb),
      `题面必须出现 memory_limit_mb=${memMb}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: statement.md 与 visible.jsonl 的示例一致", async () => {
  const { root, dir } = await generate("demo-stmt", {});
  try {
    const statement = await Deno.readTextFile(join(dir, "statement.md"));
    const firstVisible = JSON.parse(
      (await Deno.readTextFile(join(dir, "visible.jsonl"))).trim().split(
        "\n",
      )[0],
    );
    const input = JSON.parse(firstVisible.input);
    assertStringIncludes(statement, `"a": ${input.a}`);
    assertStringIncludes(statement, `"sum": ${firstVisible.expected.sum}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: 拒绝覆盖已存在的非空目录（保护出题人工作）", async () => {
  const { root } = await generate("existing", {});
  try {
    // 第二次生成到同一目录必须失败，而不是静默覆盖
    await assertRejects(
      () => initProblem({ slug: "existing", root }),
      Error,
      "已存在且非空",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: 已存在同名『文件』时给出明确错误而非原始系统错误", async () => {
  const root = await makeTempRoot();
  try {
    // 目标路径被普通文件占位（而非目录）
    await Deno.writeTextFile(join(root, "blocker"), "occupied");
    let message = "";
    try {
      await initProblem({ slug: "blocker", root });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assertEquals(
      message.includes("已存在"),
      true,
      `应给出可读的占用提示，实际：${message}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: 拒绝写入符号链接指向的目录（不越出 --dir）", async () => {
  const root = await makeTempRoot();
  const outside = await Deno.makeTempDir({ prefix: "noj-outside-" });
  try {
    // root/linked -> outside（指向 root 之外的目录）
    await Deno.symlink(outside, join(root, "linked"));
    await assertRejects(
      () => initProblem({ slug: "linked", root }),
      Error,
    );
    // 关键性质：不得在链接目标里落下任何文件
    const entries = [...Deno.readDirSync(outside)];
    assertEquals(
      entries.length,
      0,
      `不得通过符号链接写到 --dir 之外，实际写入：${
        entries.map((e) => e.name).join(",")
      }`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("initProblem: 拒绝非法 slug 与非法题型/难度", async () => {
  const root = await makeTempRoot();
  try {
    await assertRejects(
      () => initProblem({ slug: "Bad Slug", root }),
      InvalidSlugError,
    );
    await assertRejects(
      () => initProblem({ slug: "ok", type: "X" as unknown as "P", root }),
      Error,
      "题型非法",
    );
    await assertRejects(
      () =>
        initProblem({
          slug: "ok2",
          difficulty: "impossible" as unknown as "medium",
          root,
        }),
      Error,
      "难度非法",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("initProblem: 自定义标题与难度被写入 manifest", async () => {
  const { root, dir } = await generate("demo-custom", {
    title: "自定义标题",
    difficulty: "easy",
  });
  try {
    const manifest = JSON.parse(
      await Deno.readTextFile(join(dir, "problem.json")),
    );
    assertEquals(manifest.title, "自定义标题");
    assertEquals(manifest.difficulty, "easy");

    const statement = await Deno.readTextFile(join(dir, "statement.md"));
    assertStringIncludes(statement, "# 自定义标题");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
