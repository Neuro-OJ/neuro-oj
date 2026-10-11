import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@^1";
import {
  assertSubmissionLanguage,
  buildJudgeTask,
  buildUiSolutionScript,
  LANGUAGE_EXT_MAP,
  parseUiValues,
  submissionModeForLanguage,
} from "../../index.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import type { RuntimeConfig } from "../../../catalog/index.ts";

const RUNTIME_CONFIG: RuntimeConfig = {
  evaluator: {
    image: "noj-evaluator-python",
    command: "python3 /workspace/evaluate.py",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
  },
  solution: {
    image: "noj-solution-python",
    call_timeout_ms: 2000,
    memory_limit_mb: 512,
  },
};

const baseTask = {
  submission_id: "s1",
  problem_id: "p1",
  user_id: "u1",
  priority: "medium" as const,
  submission_mode: "code" as const,
  runtime_config: RUNTIME_CONFIG,
};

Deno.test("ui-solution: parseUiValues 接受对象并拒绝非对象/非法字段名", () => {
  assertEquals(parseUiValues('{"prompt":"hi","temperature":0.2}'), {
    prompt: "hi",
    temperature: 0.2,
  });
  assertThrows(() => parseUiValues("not json"), BadRequestError, "合法的 JSON");
  assertThrows(() => parseUiValues("[1,2]"), BadRequestError, "JSON 对象");
  assertThrows(() => parseUiValues("null"), BadRequestError, "JSON 对象");
  assertThrows(
    () => parseUiValues('{"1bad":1}'),
    BadRequestError,
    "字段名非法",
  );
  assertThrows(() => parseUiValues('{"_x":1}'), BadRequestError, "字段名非法");
  assertThrows(() => parseUiValues('{"a-b":1}'), BadRequestError, "字段名非法");
});

Deno.test("ui-solution: 生成的脚本先注入参数再接模板，且不泄露原文", () => {
  const values = { prompt: '")\nimport os\nos.system("id")\n#', n: 3 };
  const script = buildUiSolutionScript(
    values,
    "def solve(x):\n    return prompt",
  );
  assertEquals(script.includes("os.system"), false);
  assertStringIncludes(script, 'prompt = PARAMS["prompt"]');
  assertStringIncludes(script, 'n = PARAMS["n"]');
  assertEquals(
    script.indexOf("PARAMS = ") < script.indexOf("def solve"),
    true,
    "参数必须注入在模板之前",
  );
});

Deno.test("ui-solution: Python 关键字字段只保留在 PARAMS 中", () => {
  const script = buildUiSolutionScript({ class: 1, ok: 2 }, "");
  assertEquals(script.includes("class = PARAMS"), false);
  assertStringIncludes(script, 'ok = PARAMS["ok"]');
});

Deno.test("ui-solution: 生成的脚本能被真实 Python 执行并读到参数", async () => {
  const values = { prompt: '你好 """三引号""" \\ 反斜杠 😀', n: 3 };
  const script = buildUiSolutionScript(
    values,
    "def solve(x):\n    return prompt + str(n) + str(PARAMS['n'])\n",
  ) + "\nimport sys\nsys.stdout.write(solve(''))\n";
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/main.py`;
    await Deno.writeTextFile(file, script);
    const out = await new Deno.Command("python3", {
      args: ["-I", file],
      stdout: "piped",
    }).output();
    assertEquals(new TextDecoder().decode(out.stdout), values.prompt + "33");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ui-solution: buildJudgeTask 把 ui 提交包装为 python3 main.py", () => {
  const task = buildJudgeTask({
    ...baseTask,
    language: "ui",
    code: '{"prompt":"hi"}',
    script_template: "print(prompt)",
    file_name: "params.json",
  });
  assertEquals(task.language, "python3");
  assertEquals(task.file_name, "main.py");
  assertStringIncludes(task.code, 'prompt = PARAMS["prompt"]');
  assertStringIncludes(task.code, "print(prompt)");
  assertEquals("script_template" in task, false, "模板不进入 JudgeTask");
});

Deno.test("ui-solution: 缺少脚本模板或参数非法时拒绝构造任务", () => {
  assertThrows(
    () => buildJudgeTask({ ...baseTask, language: "ui", code: "{}" }),
    BadRequestError,
    "缺少脚本模板",
  );
  assertThrows(
    () =>
      buildJudgeTask({
        ...baseTask,
        language: "ui",
        code: "oops",
        script_template: "",
      }),
    BadRequestError,
    "合法的 JSON",
  );
});

Deno.test("ui-solution: 提交模式与语言互相校验", () => {
  const langs = Object.keys(LANGUAGE_EXT_MAP);
  assertEquals(submissionModeForLanguage("ui"), "ui");
  assertEquals(submissionModeForLanguage("python3"), "code");
  assertSubmissionLanguage("ui", "ui", langs);
  assertThrows(
    () => assertSubmissionLanguage("ui", "python3", langs),
    BadRequestError,
    "language=ui",
  );
  assertThrows(
    () => assertSubmissionLanguage("code", "ui", langs),
    BadRequestError,
    "不支持的语言",
  );
});
