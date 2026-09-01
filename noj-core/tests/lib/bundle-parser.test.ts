/**
 * bundle-parser 单元测试。
 *
 * 使用 fflate zipSync 构造测试 zip（与生产代码同一依赖）。
 */

import { assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@^1";
import { unzipSync, zipSync } from "fflate";
import { BadRequestError } from "../../src/lib/errors.ts";
import {
  MAX_ZIP_ENTRIES,
  parseBundleZip,
  stripMetadataEntries,
} from "../../src/lib/bundle-parser.ts";

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
