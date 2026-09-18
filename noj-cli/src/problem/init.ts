/**
 * 题目骨架生成（#514）。
 *
 * 与 `noj-core/scripts/problems-init.ts` 的 `initProblem` 行为对齐：
 * slug 校验、符号链接拒绝、非空目录拒绝覆盖、写入失败回滚。
 *
 * ⚠️ 这是**刻意的第二份实现**（issue #514 决策：`noj-cli` 不依赖主仓库导入映射）。
 * 修改时必须同步 `noj-core/scripts/problems-init.ts`。
 */
import { join } from "@std/path";

/** slug 允许的字符：小写字母/数字/连字符，3-64 位，首尾非连字符。 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** 校验 slug。 */
export function validateSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `非法 slug：${slug}（要求 3-64 位小写字母/数字/连字符，首尾非连字符）`,
    );
  }
}

/** init 选项。 */
export interface ProblemInitOptions {
  slug: string;
  title?: string;
  type?: string;
  difficulty?: string;
  root?: string;
}

/** init 结果。 */
export interface ProblemInitResult {
  dir: string;
  files: string[];
}

/** 生成 problem.json 内容。 */
function problemJson(options: {
  slug: string;
  title: string;
  type: string;
  difficulty: string;
}): string {
  return JSON.stringify(
    {
      format_version: 1,
      title: options.title,
      difficulty: options.difficulty,
      type: options.type,
      runtime_config: {
        evaluator: {
          image: "noj/evaluator-python:1",
          command: "python3 /workspace/evaluate.py",
          time_limit_ms: 1000,
          memory_limit_mb: 256,
        },
        solution: {
          image: "noj/solution-python:1",
          call_timeout_ms: 5000,
          memory_limit_mb: 256,
        },
      },
    },
    null,
    2,
  ) + "\n";
}

const STATEMENT = (title: string) =>
  `# ${title}

## 题目描述

（在此填写题面）

## 输入格式

## 输出格式

## 样例

\`\`\`
输入: 1 2
输出: 3
\`\`\`
`;

const TEMPLATE_PY = `def solve(a: int, b: int) -> int:
    # 请在此实现你的解法
    raise NotImplementedError
`;

const EVALUATE_PY =
  `"""评测脚本：读取 visible.jsonl / hidden.jsonl，比对输出并打分。"""

import json
import sys


def main() -> None:
    score = 0.0
    details = {"cases": []}
    # TODO: 接入 noj_evaluator_sdk.runner.SolutionRunner 以调用选手代码
    print("---RESULT---")
    print(json.dumps({"score": score, "details": details}))


if __name__ == "__main__":
    main()
`;

function readmeMarkdown(title: string): string {
  return [
    `# ${title}`,
    "",
    "## 待办",
    "",
    "- [ ] 填写 statement.md 题面",
    "- [ ] 实现 evaluate.py 判分逻辑",
    "- [ ] 补齐 visible.jsonl / hidden.jsonl 用例",
    "- [ ] 确认 template.py 不含可直接满分的实现",
    "- [ ] 运行 noj-cli problem lint . 校验",
    "- [ ] 运行 noj-cli problem pack . 打包",
    "",
  ].join("\n");
}

/**
 * 生成题目骨架。
 *
 * 安全与保护措施（与 core 侧一致）：
 * 1. 已存在的**符号链接**一律拒绝——避免写入链接目标（越出 --dir）；
 * 2. 已存在的**普通文件**给出可读错误；
 * 3. 已存在的**非空目录**拒绝覆盖，保护出题人已有工作；
 * 4. 写入失败时回滚，避免留下「半成品目录」。
 */
export async function initProblemScaffold(
  opts: ProblemInitOptions,
): Promise<ProblemInitResult> {
  validateSlug(opts.slug);

  const type = opts.type ?? "P";
  if (type !== "U" && type !== "P") {
    throw new Error(`题型非法：${type}（仅允许 U / P）`);
  }
  const difficulty = opts.difficulty ?? "medium";
  if (!["easy", "medium", "hard"].includes(difficulty)) {
    throw new Error(`难度非法：${difficulty}（仅允许 easy / medium / hard）`);
  }

  const root = opts.root ?? "problems";
  const dir = join(root, opts.slug);
  const title = opts.title?.trim() || opts.slug;

  let existing: Deno.FileInfo | undefined;
  try {
    existing = await Deno.lstat(dir);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  let createdDir = false;
  if (existing) {
    if (existing.isSymlink) {
      throw new Error(
        `目标路径已存在且为符号链接：${dir}（拒绝写入链接目标）`,
      );
    }
    if (!existing.isDirectory) {
      throw new Error(`目标路径已存在且不是目录：${dir}`);
    }
    let empty = true;
    for await (const _ of Deno.readDir(dir)) {
      empty = false;
      break;
    }
    if (!empty) {
      throw new Error(`目标目录已存在且非空：${dir}`);
    }
  } else {
    await Deno.mkdir(dir, { recursive: true });
    createdDir = true;
  }

  const files: Array<[string, string]> = [
    ["problem.json", problemJson({ slug: opts.slug, title, type, difficulty })],
    ["statement.md", STATEMENT(title)],
    ["template.py", TEMPLATE_PY],
    ["evaluate.py", EVALUATE_PY],
    ["visible.jsonl", ""],
    ["hidden.jsonl", ""],
    ["README.md", readmeMarkdown(title)],
  ];

  const written: string[] = [];
  try {
    for (const [name, content] of files) {
      const target = join(dir, name);
      await Deno.writeTextFile(target, content, { createNew: true });
      written.push(target);
    }
  } catch (err) {
    for (const target of written) await Deno.remove(target).catch(() => {});
    if (createdDir) await Deno.remove(dir, { recursive: true }).catch(() => {});
    throw err;
  }

  return { dir, files: files.map(([name]) => name) };
}
