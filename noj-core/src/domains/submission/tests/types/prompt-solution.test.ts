import { assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@^1";
import { decodeBase64 } from "@std/encoding/base64";
import {
  assertSubmissionLanguage,
  buildJudgeTask,
  buildPromptSolutionModule,
  LANGUAGE_EXT_MAP,
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

/** 从生成的模块源码中取出 Base64 负载并解码回原文。 */
function decodePromptFromModule(source: string): string {
  const m = source.match(/b64decode\("([A-Za-z0-9+/=]*)"\)/);
  if (!m) throw new Error("模块中未找到 Base64 负载");
  return new TextDecoder().decode(decodeBase64(m[1]));
}

Deno.test("prompt-solution: 模块暴露 get_prompt 并可无损还原提示词", () => {
  const prompt = '系统：你是助手。\n"""三引号"""\\反斜杠\n\'单引号\' 😀';
  const source = buildPromptSolutionModule(prompt);
  assertMatch(source, /^def get_prompt\(\) -> str:$/m);
  assertEquals(decodePromptFromModule(source), prompt);
});

Deno.test("prompt-solution: 选手文本不会以源码形式出现在模块中（防注入）", () => {
  const prompt = '")\nimport os\nos.system("id")\n#';
  const source = buildPromptSolutionModule(prompt);
  assertEquals(source.includes("os.system"), false);
  assertEquals(decodePromptFromModule(source), prompt);
});

Deno.test("prompt-solution: 空提示词生成合法模块", () => {
  assertEquals(decodePromptFromModule(buildPromptSolutionModule("")), "");
});

Deno.test("prompt-solution: buildJudgeTask 把 prompt 提交包装为 python3 main.py", () => {
  const task = buildJudgeTask({
    submission_id: "s1",
    problem_id: "p1",
    user_id: "u1",
    priority: "medium",
    runtime_config: RUNTIME_CONFIG,
    language: "prompt",
    code: "请总结：{text}",
    file_name: "prompt.md",
  });
  assertEquals(task.language, "python3");
  assertEquals(task.file_name, "main.py");
  assertEquals(decodePromptFromModule(task.code), "请总结：{text}");
});

Deno.test("prompt-solution: buildJudgeTask 对代码提交保持原样", () => {
  const task = buildJudgeTask({
    submission_id: "s1",
    problem_id: "p1",
    user_id: "u1",
    priority: "medium",
    runtime_config: RUNTIME_CONFIG,
    language: "python3",
    code: "print(1)",
    file_name: "main.py",
  });
  assertEquals(task.language, "python3");
  assertEquals(task.code, "print(1)");
  assertEquals(task.file_name, "main.py");
});

Deno.test("prompt-solution: assertSubmissionLanguage 按提交模式校验语言", () => {
  const langs = Object.keys(LANGUAGE_EXT_MAP);
  assertSubmissionLanguage("prompt", "prompt", langs);
  assertSubmissionLanguage("code", "python3", langs);
  assertThrows(
    () => assertSubmissionLanguage("prompt", "python3", langs),
    BadRequestError,
    "该题目要求提交提示词",
  );
  assertThrows(
    () => assertSubmissionLanguage("code", "prompt", langs),
    BadRequestError,
    "不支持的语言",
  );
});
