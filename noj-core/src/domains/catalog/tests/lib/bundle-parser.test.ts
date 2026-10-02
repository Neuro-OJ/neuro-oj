/**
 * bundle-parser 单元测试。
 *
 * 使用 fflate zipSync 构造测试 zip（与生产代码同一依赖）。
 */

import { assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@^1";
import { unzipSync, zipSync } from "fflate";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import {
  inspectEvaluationPackage,
  MAX_ZIP_ENTRIES,
  parseBundleZip,
  stripMetadataEntries,
} from "../../services/bundle-parser.ts";

function makeZip(files: Record<string, Uint8Array | string>): Uint8Array {
  const record: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    record[name] = typeof content === "string"
      ? new TextEncoder().encode(content)
      : content;
  }
  return zipSync(record, { level: 6 });
}

const MANIFEST = JSON.stringify({
  format_version: 1,
  title: "测试题",
  difficulty: "easy",
  type: "P",
  runtime_config: {
    evaluator: {
      image: "noj-evaluator-python",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
    },
    solution: {
      image: "noj-solution-python",
      call_timeout_ms: 5000,
      memory_limit_mb: 512,
    },
  },
});

function validBundle(): Uint8Array {
  return makeZip({
    "problem.json": MANIFEST,
    "statement.md":
      "# 测试题\n\n## 样例输入 1\n```\n1 2\n```\n\n## 样例输出 1\n```\n3\n```\n",
    "evaluate.py": "print('evaluator')",
    "visible.jsonl": '{"input": "1 2", "output": "3"}\n',
    "hidden.jsonl": '{"input": "3 4", "output": "7"}\n',
  });
}

Deno.test("parseBundleZip: 合法包解析成功", () => {
  const parsed = parseBundleZip(validBundle());
  assertEquals(parsed.manifest.title, "测试题");
  assertEquals(
    parsed.statement,
    "# 测试题\n\n## 样例输入 1\n```\n1 2\n```\n\n## 样例输出 1\n```\n3\n```\n",
  );
  assertEquals(Object.keys(parsed.entries).length, 5);
});

Deno.test("parseBundleZip: 缺 problem.json 被拒", () => {
  const zip = makeZip({
    "evaluate.py": "print('evaluator')",
    "visible.jsonl": "x",
  });
  const err = assertThrows(
    () => parseBundleZip(zip),
    BadRequestError,
  );
  assertMatch(err.message, /problem\.json/);
});

Deno.test("parseBundleZip: 根级缺 evaluate.py 被拒", () => {
  const zip = makeZip({
    "problem.json": MANIFEST,
    "evaluator/evaluate.py": "print('x')",
  });
  const err = assertThrows(
    () => parseBundleZip(zip),
    BadRequestError,
  );
  assertMatch(err.message, /evaluate\.py/);
});

Deno.test("parseBundleZip: 路径穿越条目被拒", () => {
  const zip = makeZip({
    "problem.json": MANIFEST,
    "evaluate.py": "print('x')",
    "../escape.txt": "evil",
  });
  const err = assertThrows(
    () => parseBundleZip(zip),
    BadRequestError,
  );
  assertMatch(err.message, /路径穿越/);
});

Deno.test("parseBundleZip: 条目数超过上限被拒", () => {
  const files: Record<string, string> = {
    "problem.json": MANIFEST,
    "evaluate.py": "print('x')",
  };
  for (let i = 0; i <= MAX_ZIP_ENTRIES; i++) {
    files[`f${i}.txt`] = "x";
  }
  const zip = makeZip(files);
  const err = assertThrows(
    () => parseBundleZip(zip),
    BadRequestError,
  );
  assertMatch(err.message, /条目数/);
});

Deno.test("parseBundleZip: 单文件超过 64 MiB 上限被拒", () => {
  // 64MiB 可压缩数据：zipSync 打包耗时可控，filter 预检基于 originalSize 早期拒绝
  const big = new Uint8Array(64 * 1024 * 1024 + 1); // 全 0 → deflate 压缩率高
  const zip = makeZip({
    "problem.json": MANIFEST,
    "evaluate.py": "print('x')",
    "big.bin": big,
  });
  const err = assertThrows(
    () => parseBundleZip(zip),
    BadRequestError,
  );
  assertMatch(err.message, /单文件上限/);
});

Deno.test("parseBundleZip: manifest 非法 JSON 被拒", () => {
  const zip = makeZip({
    "problem.json": "not-json{{{",
    "evaluate.py": "print('x')",
  });
  const err = assertThrows(
    () => parseBundleZip(zip),
    BadRequestError,
  );
  assertMatch(err.message, /JSON/);
});

Deno.test("stripMetadataEntries: 剥离元数据后不含 problem.json/statement.md", () => {
  const stripped = stripMetadataEntries(validBundle());
  const files = unzipSync(stripped);
  const names = Object.keys(files);
  assertEquals(names.includes("problem.json"), false);
  assertEquals(names.includes("statement.md"), false);
  assertEquals(names.includes("evaluate.py"), true);
  assertEquals(names.includes("visible.jsonl"), true);
});

const OBJECTIVE_MANIFEST = JSON.stringify({
  format_version: 1,
  title: "客观题套卷",
  is_objective: true,
  type: "U",
});

function objectiveBundle(): Uint8Array {
  return makeZip({
    "problem.json": OBJECTIVE_MANIFEST,
    "questions.json": JSON.stringify([
      {
        type: "single",
        prompt: "1+1=?",
        options: [{ key: "A", text: "2" }, { key: "B", text: "3" }],
        answer: ["A"],
      },
    ]),
    "statement.md": "# 客观题套卷",
  });
}

Deno.test("parseBundleZip: 客观题包不要求 evaluate.py 且解析 questions.json", () => {
  const parsed = parseBundleZip(objectiveBundle());
  assertEquals(parsed.manifest.is_objective, true);
  assertEquals(Array.isArray(parsed.questions), true);
  assertEquals(
    (parsed.questions as Array<{ prompt: string }>)[0].prompt,
    "1+1=?",
  );
});

Deno.test("parseBundleZip: 客观题包缺 questions.json 被拒", () => {
  const zip = makeZip({
    "problem.json": OBJECTIVE_MANIFEST,
    "statement.md": "# 客观题套卷",
  });
  const err = assertThrows(() => parseBundleZip(zip), BadRequestError);
  assertMatch(err.message, /questions\.json/);
});

Deno.test("parseBundleZip: 客观题包 questions.json 非法 JSON 被拒", () => {
  const zip = makeZip({
    "problem.json": OBJECTIVE_MANIFEST,
    "questions.json": "not-json{{{",
  });
  const err = assertThrows(() => parseBundleZip(zip), BadRequestError);
  assertMatch(err.message, /questions\.json/);
});

const OI_MANIFEST = JSON.stringify({
  format_version: 1,
  title: "A+B",
  judge_type: "oi",
  runtime_config: {
    backend: "native",
    languages: ["c", "cc"],
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    checker: { type: "testlib", path: "checker.cpp" },
    subtasks: [{
      id: "all",
      score: 100,
      cases: [{ input: "tests/1.in", output: "tests/1.out" }],
    }],
  },
});

Deno.test("parseBundleZip: OI 包允许无 evaluate.py 并校验全部引用文件", () => {
  const zip = makeZip({
    "problem.json": OI_MANIFEST,
    "checker.cpp": "int main() { return 0; }",
    "tests/1.in": "1 2\n",
    "tests/1.out": "3\n",
  });
  const parsed = parseBundleZip(zip);
  assertEquals(parsed.manifest.judge_type, "oi");
  assertEquals(parsed.entries["evaluate.py"], undefined);
});

Deno.test("parseBundleZip: OI 包缺少输入或 checker 文件时拒绝", () => {
  for (
    const files of [
      { "checker.cpp": "int main() {}", "tests/1.out": "3\n" },
      { "tests/1.in": "1 2\n", "tests/1.out": "3\n" },
    ] as Record<string, string>[]
  ) {
    const zip = makeZip({ "problem.json": OI_MANIFEST, ...files });
    assertThrows(() => parseBundleZip(zip), BadRequestError);
  }
});

Deno.test("inspectEvaluationPackage: 识别评测包条目与标准解", () => {
  const zip = makeZip({
    "evaluate.py": "print('ok')",
    "visible.jsonl": '{"input":"1","output":"1"}\n',
    "hidden.jsonl": '{"input":"2","output":"2"}\n',
    "reference_solution.py": "print('reference')",
  });
  assertEquals(inspectEvaluationPackage(zip), {
    hasEvaluator: true,
    hasVisibleCases: true,
    hasHiddenCases: true,
    referenceSolution: "reference_solution.py",
  });
});

Deno.test("parseBundleZip: Hydro普通题YAML与sum子任务转换", () => {
  const parsed = parseBundleZip(makeZip({
    "problem.yaml": "title: A+B\npid: P1\n",
    "problem.md": "# A+B",
    "testdata/config.yaml":
      "type: default\ntime: 1s\nmemory: 256m\nsubtasks:\n  - id: 1\n    type: sum\n    score: 100\n    cases:\n      - input: 1.in\n        output: 1.out\n",
    "testdata/1.in": "1 2",
    "testdata/1.out": "3",
  }));
  assertEquals(parsed.manifest.judge_type, "oi");
  assertEquals(parsed.statement, "# A+B");
  const rc = parsed.manifest.runtime_config as {
    languages: string[];
    subtasks: { cases: { input: string }[] }[];
  };
  assertEquals(rc.languages, ["c", "cc"]);
  assertEquals(rc.subtasks[0].cases[0].input, "testdata/1.in");
});

Deno.test("parseBundleZip: Hydro sum 多测试点按百分之一分值稳定拆分", () => {
  const parsed = parseBundleZip(makeZip({
    "problem.yaml": "title: A+B\n",
    "problem.md": "# A+B",
    "testdata/config.yaml":
      "type: default\nsubtasks:\n  - id: all\n    type: sum\n    score: 100\n    cases:\n      - input: 1.in\n        output: 1.out\n      - input: 2.in\n        output: 2.out\n      - input: 3.in\n        output: 3.out\n",
    "testdata/1.in": "1",
    "testdata/1.out": "1",
    "testdata/2.in": "2",
    "testdata/2.out": "2",
    "testdata/3.in": "3",
    "testdata/3.out": "3",
  }));
  const subtasks = (parsed.manifest.runtime_config as {
    subtasks: { score: number }[];
  }).subtasks;
  assertEquals(subtasks.map((subtask) => subtask.score), [33.34, 33.33, 33.33]);
});

Deno.test("parseBundleZip: Hydro 未指定 min 分值时也按百分之一稳定分配", () => {
  const parsed = parseBundleZip(makeZip({
    "problem.yaml": "title: A+B\n",
    "problem.md": "# A+B",
    "testdata/config.yaml":
      "type: default\nsubtasks:\n  - id: 1\n    cases:\n      - input: 1.in\n        output: 1.out\n  - id: 2\n    cases:\n      - input: 2.in\n        output: 2.out\n  - id: 3\n    cases:\n      - input: 3.in\n        output: 3.out\n",
    "testdata/1.in": "1",
    "testdata/1.out": "1",
    "testdata/2.in": "2",
    "testdata/2.out": "2",
    "testdata/3.in": "3",
    "testdata/3.out": "3",
  }));
  const subtasks = (parsed.manifest.runtime_config as {
    subtasks: { score: number }[];
  }).subtasks;
  assertEquals(subtasks.map((subtask) => subtask.score), [33.34, 33.33, 33.33]);
});

Deno.test("parseBundleZip: Hydro checker对象、额外文件和testdata前缀保持兼容", () => {
  const parsed = parseBundleZip(makeZip({
    "problem.yaml": "title: A+B\n",
    "problem.md": "# A+B",
    "testdata/config.yaml":
      "type: default\nchecker_type: testlib\nchecker:\n  file: ./chk.cc\njudge_extra_files:\n  - ./helper.h\nuser_extra_files:\n  - testdata/user.h\nsubtasks:\n  - id: 1\n    score: 100\n    cases:\n      - input: testdata/1.in\n        output: ./1.out\n",
    "testdata/chk.cc": "int main() { return 0; }",
    "testdata/helper.h": "#define HELPER 1",
    "testdata/user.h": "#define USER 1",
    "testdata/1.in": "1 2",
    "testdata/1.out": "3",
  }));
  const rc = parsed.manifest.runtime_config as {
    checker: { path?: string };
    compile_extra_files?: string[];
    checker_extra_files?: string[];
    user_extra_files?: string[];
    subtasks: {
      cases: {
        input: string;
        output: string;
        time_limit_ms?: number;
        memory_limit_mb?: number;
      }[];
    }[];
  };
  assertEquals(rc.checker.path, "testdata/chk.cc");
  assertEquals(rc.checker_extra_files, ["testdata/helper.h"]);
  assertEquals(rc.user_extra_files, ["testdata/user.h"]);
  assertEquals(rc.subtasks[0].cases[0], {
    input: "testdata/1.in",
    time_limit_ms: 1000,
    memory_limit_mb: 256,
    output: "testdata/1.out",
  });
});
