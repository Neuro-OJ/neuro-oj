// 题目包脚手架：生成一道新题的最小可评测骨架（`noj problems init`）。
//
// 设计目标：让出题人从「可评测的最小骨架」起步，而不是从空目录 + 记忆规范起步。
// 生成的内容**严格对齐** noj-docs 的题目包与质量规范：
//   - problem.json：format_version=1、必填字段齐备、无占位符（除 LLM 题的 provider 占位）
//   - evaluate.py：标准 details.cases 输出、隐藏用例不泄露输入/期望/实际、
//     运行期异常上抛（不吞异常 → judge 收尾为 error）
//   - template.py：入口保持 NotImplementedError（质量规范：模板 MUST NOT 含可满分实现）
//   - visible.jsonl / hidden.jsonl：样例即测试（可见不计分）+ 隐藏用例计分
//
// 刻意**不**做的事情：
//   - 不生成参考实现（reference_solution.py）——那属于出题人思考的核心产物，
//     脚手架给不出来；README 会提示需要自行补齐用于自测。
//   - 不生成「已通过全部测试」的代码——那正是质量规范禁止的。

import { join } from "node:path";

/** 脚手架选项。 */
export interface ProblemInitOptions {
  /** 题目 slug（目录名）；必须是小写字母/数字/短横线。 */
  slug: string;
  /** 题目标题；缺省用 slug。 */
  title?: string;
  /** 题型：U（客观题）/ P（编程题）。缺省 P。 */
  type?: "U" | "P";
  /** 难度。缺省 medium。 */
  difficulty?: "easy" | "medium" | "hard";
  /** 目标根目录（缺省 data/problems-src）。 */
  root?: string;
}

/** slug 合法性问题（供 CLI 报错）。 */
export class InvalidSlugError extends Error {}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * slug 最大长度。
 *
 * slug 会成为目录名与 `data/packages/<slug>.zip` 文件名，多数文件系统的单段
 * 上限是 255 字节；留出 `.zip` 与父目录余量后取 64，避免落到 `ENAMETOOLONG`
 * 这类难以归因的系统错误。
 */
const SLUG_MAX_LENGTH = 64;

/**
 * 默认资源限制——**单一事实源**。
 *
 * `problem.json`（真正生效的判分参数）与 `statement.md`（选手唯一可见的说明）
 * 都由这里取值，避免出现「题面写 5000ms、实际按 30000ms 判」这类默认即失真的
 * 骨架。改这里即同时改两处。
 */
const DEFAULT_LIMITS = {
  evaluatorTimeLimitMs: 30000,
  solutionCallTimeoutMs: 5000,
  memoryLimitMb: 256,
} as const;

/**
 * 校验 slug：必须是小写字母/数字/短横线，且不以短横线开头/结尾。
 *
 * 约束理由：slug 会作为目录名与包文件名，含大写/空格/路径分隔符会带来
 * 跨平台与打包问题；同时保持与既有题目（如 `decoding-sampler`）一致。
 */
export function validateSlug(slug: string): void {
  if (!slug) {
    throw new InvalidSlugError("题目 slug 不能为空");
  }
  if (slug.length > SLUG_MAX_LENGTH) {
    throw new InvalidSlugError(
      `题目 slug 过长：${slug.length} 字符（上限 ${SLUG_MAX_LENGTH}）`,
    );
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new InvalidSlugError(
      `题目 slug 非法：${slug}（仅允许小写字母、数字与单个短横线，且不以短横线开头/结尾）`,
    );
  }
}

/**
 * 默认输出根：`<noj-core>/data/problems-src`。
 *
 * 与 `noj.ts` 的 `SRC_DIR` 用同一套推导（`NOJ_PROJECT_ROOT` → 模块目录上一级），
 * **不用 `Deno.cwd()`**：从仓库根执行 `deno run -A noj-core/scripts/noj.ts ...`
 * 时 cwd 是仓库根，会把骨架写到 `<repo>/data/problems-src/`，而 `problems build`
 * 只读 `<noj-core>/data/problems-src/`，产物永远不会被发现。
 */
function defaultProblemSrcDir(): string {
  const projectRoot = Deno.env.get("NOJ_PROJECT_ROOT") ??
    join(import.meta.dirname ?? ".", "..");
  return join(projectRoot, "data", "problems-src");
}

function problemJson(
  opts: Required<
    Pick<ProblemInitOptions, "slug" | "title" | "type" | "difficulty">
  >,
): string {
  const manifest = {
    format_version: 1,
    type: opts.type,
    title: opts.title,
    difficulty: opts.difficulty,
    // 必须使用已种子化的题目标签（seed-system.ts 的 seedTags），否则首次导入会
    // 打印「标签不存在，已忽略」，出题人以为标签生效了实际没有。
    tags: ["入门"],
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        time_limit_ms: DEFAULT_LIMITS.evaluatorTimeLimitMs,
        memory_limit_mb: DEFAULT_LIMITS.memoryLimitMb,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: DEFAULT_LIMITS.solutionCallTimeoutMs,
        memory_limit_mb: DEFAULT_LIMITS.memoryLimitMb,
      },
    },
    template: "template.py",
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function statementMarkdown(title: string): string {
  return `# ${title}

## 题目描述

（在此描述题目背景与要求。**选手只能看到本文件**，因此所有判分依据的规则都必须在此写清。）

## 输入格式

\`solve\` 的 \`input_str\` 参数格式：

\`\`\`json
{"a": 1, "b": 2}
\`\`\`

## 输出格式

返回一行 JSON 文本：

\`\`\`json
{"sum": 3}
\`\`\`

## 示例

### 示例 1

输入：

\`\`\`json
{"a": 1, "b": 2}
\`\`\`

输出：

\`\`\`json
{"sum": 3}
\`\`\`

## 数据范围与限制

- （写明取值范围与边界）
- 评测总时限：${DEFAULT_LIMITS.evaluatorTimeLimitMs}ms（与 \`problem.json\` 的
  \`runtime_config.evaluator.time_limit_ms\` 一致——改限制时两处都要改）
- 单次 \`solve\` 调用超时：${DEFAULT_LIMITS.solutionCallTimeoutMs}ms
- 内存限制：${DEFAULT_LIMITS.memoryLimitMb}MB

## 评分

- 正式得分**只来自隐藏用例**，各用例等权，满分 **100** 分。
- 判定标准：（写明比较方式与容差，例如「逐字段精确相等」或「绝对误差 ≤ 1e-9」）
- 题面示例会作为可见用例运行并展示调试信息，但**不计分**。
`;
}

function templatePy(): string {
  return `#!/usr/bin/env python3
"""选手模板（starter code）。

你需要实现 \`solve(input_str)\`：解析输入并按题面规则返回结果 JSON 文本。

注意：模板必须保持**未实现**状态——质量规范要求模板不得包含可通过全部
测试的完整实现，以避免「空提交蒙分」。
"""

from __future__ import annotations


def solve(input_str: str) -> str:
    """入口函数：由 noj_solution_sdk.host 调用。

    @param input_str 输入 JSON 文本（字段见题面「输入格式」）
    @return 结果 JSON 文本（形如 {"sum": 3}）
    """
    # TODO: 解析 input_str（json.loads），按题面规则计算结果并返回 JSON 文本
    raise NotImplementedError("请实现 solve 函数")
`;
}

function evaluatePy(): string {
  return `#!/usr/bin/env python3
"""评测入口（NOJ 双容器）。

协议契约（noj-docs/docs/standards/test-data.md）：
- 运行在 Evaluator 容器，通过 SolutionRunner 与 Solution 容器（选手代码）交互；
- 输出 \`---RESULT---\` 标记行 + JSON \`{score, details}\`，不输出顶层 status；
- \`details.cases[]\` 每项含 \`case_id\` / \`status\` / 布尔 \`hidden\`；
  隐藏用例**不得**输出 input/expected/actual。

评分：正式分数**只来自隐藏用例**（等权）；可见用例参与评测但不计分，仅用于调试。
满分 100.00 → score 字段为 10000（平台以 ×100 整数存储）。

运行期异常必须**上抛**：不输出 RESULT，由 judge 收尾为 error，
避免「评测脚本吞异常 → finished 但 0 分」掩盖真实故障。

诊断回显安全约束（**勿改回直接插值**）：judge 以「标记行 + 紧随其后的一行 JSON」
作为结果 payload，且不校验该 JSON 的来源。若把选手控制的输出（返回值、异常文本）
原样多行回显，选手只要在返回值里塞入标记行与伪造的 score，就能让**全部用例都错**
的提交被判满分。因此所有回显一律经 \`echo()\` 压成单行。
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

from noj_evaluator_sdk.runner import SolutionRunner, SolutionTimeoutError

DATA_DIR = Path(__file__).parent
VISIBLE_PATH = DATA_DIR / "visible.jsonl"
HIDDEN_PATH = DATA_DIR / "hidden.jsonl"

FULL_SCORE = 100.0

# 诊断回显的单行长度上限（避免选手用超长输出刷屏或挤掉关键日志）。
MAX_ECHO_CHARS = 500


def echo(value: Any) -> str:
    """把任意值压成单行、限长，供诊断输出安全回显。

    安全性：压掉所有换行后，回显内容**不可能**自成一行标记或 payload，
    从而无法伪造评测结果。
    """
    flat = " ".join(str(value).split())
    if len(flat) > MAX_ECHO_CHARS:
        return flat[:MAX_ECHO_CHARS] + "…（已截断）"
    return flat


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    """加载 jsonl 数据（不存在时返回空列表）。"""
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def compare(raw_output: Any, expected: Any) -> tuple[bool, str]:
    """判定单个用例，返回 (是否通过, 失败原因)。

    TODO: 按题面「判定标准」实现比较逻辑（含容差处理）。
    """
    actual_text = raw_output if isinstance(raw_output, str) else json.dumps(
        raw_output, ensure_ascii=False
    )
    try:
        # 允许选手在结果前打印调试信息：取最后一行非空内容
        lines = [ln for ln in str(actual_text).splitlines() if ln.strip()]
        actual = json.loads(lines[-1]) if lines else None
    except json.JSONDecodeError as exc:
        return False, f"输出不是合法 JSON：{exc}"

    if actual == expected:
        return True, ""
    return False, "结果与期望不一致"


def run_case(
    runner: SolutionRunner,
    case: dict[str, Any],
    *,
    hidden: bool,
) -> dict[str, Any]:
    """执行单个用例，返回 case 结果（已按可见性裁剪字段）。"""
    started = time.perf_counter()
    try:
        raw_output = runner.call("solve", case["input"])
    except SolutionTimeoutError:
        # 交由评测机识别为调用超时，不吞掉以继续消耗总时限。
        raise
    except Exception as exc:  # noqa: BLE001 — 运行期错误必须上抛给 judge
        print(f"  [!] Solution 调用异常: {echo(exc)}")
        raise

    elapsed_ms = max(0, round((time.perf_counter() - started) * 1000))
    # compare() 的第二个返回值是失败原因，供出题人自行诊断/扩展使用；
    # 不写入 details.cases（该键不在平台投影白名单内，见下方说明）。
    passed, _reason = compare(raw_output, case["expected"])

    result: dict[str, Any] = {
        "case_id": case["id"],
        "status": "Accepted" if passed else "WrongAnswer",
        # hidden 是提交结果投影判断可见/隐藏的唯一依据（布尔）
        "hidden": hidden,
        # visibility 供前端读取（UI 只认该字段，见 noj-ui/utils/submissionCaseResults.ts）；
        # 与 1001 样例题一致，两个字段都给。
        "visibility": "hidden" if hidden else "visible",
        "time_ms": elapsed_ms,
    }
    if not hidden:
        actual_text = raw_output if isinstance(raw_output, str) else json.dumps(
            raw_output, ensure_ascii=False
        )
        result.update(
            {
                "input": case["input"],
                "expected_output": json.dumps(case["expected"], ensure_ascii=False),
                "actual_output": str(actual_text).strip(),
            }
        )
    # 注意：**不要**给用例加 \`message\` / \`scored\` 字段。
    # 平台的结果投影按白名单裁剪（noj-core/src/domains/submission/mq/consumer.ts 的
    # JUDGE_CASE_ALLOWED_KEYS），白名单外的键会被静默丢弃——写了也不会到达任何客户端，
    # 只会让人误以为「失败原因已展示」。可见用例的差异由 expected_output /
    # actual_output 直接对比得出；需要整体说明时用 details.summary（在白名单内）。
    return result


def main() -> None:
    runner = SolutionRunner()
    visible_cases = load_jsonl(VISIBLE_PATH)
    hidden_cases = load_jsonl(HIDDEN_PATH)

    if not hidden_cases:
        raise RuntimeError("隐藏用例为空，无法评分（包内缺少 hidden.jsonl）")

    print("=" * 56)
    print("评测开始")
    print("=" * 56)

    case_results: list[dict[str, Any]] = []

    print(f"\\n[VISIBLE] {len(visible_cases)} 条（不计分，仅调试）")
    for case in visible_cases:
        result = run_case(runner, case, hidden=False)
        case_results.append(result)
        print(f"  {case['id']}: {result['status']}")
        if result["status"] != "Accepted":
            # 回显必须全部经 echo()：actual_output 完全由选手控制，
            # 原样多行回显可伪造 RESULT（见文件头「诊断回显安全约束」）。
            print(f"     期望: {echo(result['expected_output'])}")
            print(f"     实际: {echo(result['actual_output'])}")

    print(f"\\n[HIDDEN] {len(hidden_cases)} 条（正式评分）")
    hidden_passed = 0
    for case in hidden_cases:
        result = run_case(runner, case, hidden=True)
        case_results.append(result)
        ok = result["status"] == "Accepted"
        hidden_passed += 1 if ok else 0
        print(f"  {case['id']}: {'PASS' if ok else 'FAIL'}")

    score = FULL_SCORE * hidden_passed / len(hidden_cases) if hidden_cases else 0.0

    print("\\n" + "-" * 56)
    print(f"隐藏用例通过: {hidden_passed}/{len(hidden_cases)}")
    print(f"得分: {score:.2f}/{FULL_SCORE}")

    # details 只写平台投影白名单内的键（JUDGE_DETAIL_ALLOWED_KEYS）：
    # cases / score / summary / score_content / score_format / hidden_provided。
    # 其余键会被静默丢弃。summary 是白名单里唯一的自由文本出口。
    payload = {
        "score": int(round(score * 100)),
        "details": {
            "cases": case_results,
            "summary": (
                f"隐藏用例 {hidden_passed}/{len(hidden_cases)} 通过；"
                f"可见用例 {len(visible_cases)} 条（不计分，仅调试）"
            ),
        },
    }
    print("---RESULT---")
    print(json.dumps(payload, ensure_ascii=False))

    runner.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — 顶层不吞异常：不输出 RESULT，judge 收尾为 error
        print(f"评测异常终止: {exc}", file=sys.stderr)
        raise
`;
}

function readmeMarkdown(title: string): string {
  return `# ${title}

> 由 \`noj problems init\` 生成的**最小可评测骨架**。请按下列清单补齐后再导入平台。

## 目录

| 路径 | 说明 |
|------|------|
| \`problem.json\` | manifest（题型 / 难度 / tags / 双容器 runtime） |
| \`statement.md\` | 题面（**选手唯一可见的规则来源**，所有判分依据的规则都要写在这里） |
| \`template.py\` | 选手模板（入口保持未实现，防止空提交得分） |
| \`evaluate.py\` | 评测入口（打包后即包根级 \`evaluate.py\`） |
| \`visible.jsonl\` | 可见用例（题面示例，**不计分**，展示调试信息） |
| \`hidden.jsonl\` | 隐藏用例（**正式评分**，等权） |

## 待办清单（导入前必须完成）

- [ ] 在 \`statement.md\` 写清题目描述、输入/输出格式、**所有边界约定**与判定标准
- [ ] 实现 \`evaluate.py\` 的 \`compare()\`：按题面的判定标准与容差比较
- [ ] 补齐 \`hidden.jsonl\`：覆盖边界与极端用例（建议 ≥20 条）
- [ ] 核对 \`visible.jsonl\` 与题面示例**逐字一致**（样例即测试）
- [ ] 自备参考实现并确认能拿满分（**参考实现不入包**，仅用于自测）
- [ ] 确认 \`template.py\` 提交后**不得分**（防蒙分）
- [ ] 更新 \`problem.json\` 的 \`tags\`（建议 2–5 个；**只能用已存在的标签名**，
      未种子化的名字导入时会被忽略并打印警告。内置题目类标签见
      \`noj-core/src/domains/system/services/seed/seed-system.ts\` 的 \`seedTags()\`）
- [ ] 核对 \`problem.json\` 的 \`runtime_config\` 镜像名与**本部署的白名单**一致。
      默认写的是不带前缀的 \`noj-evaluator-python\` / \`noj-solution-python\`；
      若部署设置了 \`JUDGE_IMAGE_BASE\`（如 \`ghcr.io/neuro-oj\`），白名单里是
      **带前缀**的名字，需按实际值改写，否则导入会被 400 拒绝

## 构建与导入

\`\`\`bash
mkdir -p data/packages                       # 构建产物目录（gitignored，全新检出不存在）
deno task problems:build --id <此目录名>     # 生成 data/packages/<id>.zip
deno task problems:import                    # 导入平台
\`\`\`

> 注意：\`data/packages/\` 是 gitignored 的构建产物目录，**全新检出时并不存在**，
> 直接执行 \`problems:build\` 会因无法写入而失败。先 \`mkdir -p data/packages\`。

## 相关规范（事实来源）

- [题目包格式规范](https://github.com/Neuro-OJ/neuro-oj/blob/main/noj-docs/docs/standards/problem-bundle.md)
- [测试数据与样例规范](https://github.com/Neuro-OJ/neuro-oj/blob/main/noj-docs/docs/standards/test-data.md)
- [题目质量要求](https://github.com/Neuro-OJ/neuro-oj/blob/main/noj-docs/docs/standards/quality.md)
`;
}

/** 可见用例（题面示例，对应 statement.md 的示例 1）。 */
function visibleJsonl(): string {
  const rows = [
    { id: "v001", input: JSON.stringify({ a: 1, b: 2 }), expected: { sum: 3 } },
  ];
  return rows.map((row) => JSON.stringify(row) + "\n").join("");
}

/** 隐藏用例（正式评分，等权）。请按题面补齐边界用例。 */
function hiddenJsonl(): string {
  const rows = [
    { id: "h001", input: JSON.stringify({ a: 0, b: 0 }), expected: { sum: 0 } },
    {
      id: "h002",
      input: JSON.stringify({ a: -1, b: 1 }),
      expected: { sum: 0 },
    },
  ];
  return rows.map((row) => JSON.stringify(row) + "\n").join("");
}

/** 生成结果（供 CLI 打印）。 */
export interface ProblemInitResult {
  /** 题目目录绝对/相对路径。 */
  dir: string;
  /** 已写入的文件名列表。 */
  files: string[];
}

/**
 * 生成题目骨架。
 *
 * 若目标目录已存在且非空则**拒绝**（不覆盖已有题目，避免误删出题人的工作）。
 *
 * @throws InvalidSlugError slug 非法
 * @throws Error 目标目录已存在且非空
 */
export async function initProblem(
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

  const root = opts.root ?? defaultProblemSrcDir();
  const dir = join(root, opts.slug);
  const title = opts.title?.trim() || opts.slug;

  // 目标路径占用检查（不跟随符号链接）：
  // 1. 已存在的**符号链接**一律拒绝——否则 mkdir/写入会落到链接目标，
  //    把 7 个文件写到 `--dir` 之外（实测可越出，属安全问题）；
  // 2. 已存在的**普通文件**给出可读错误，而不是让 readDir 抛 NotADirectory；
  // 3. 已存在的**非空目录**拒绝覆盖，保护出题人已有的工作。
  let existing: Deno.FileInfo | undefined;
  try {
    existing = await Deno.lstat(dir);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    // 不存在 → 正常继续
  }

  // 目录是否由本次创建（回滚时据此决定是否删除）。
  let createdDir = false;

  if (existing) {
    if (existing.isSymlink) {
      throw new Error(
        `目标路径已存在且为符号链接：${dir}（拒绝写入链接目标，请换 slug 或先删除该链接）`,
      );
    }
    if (!existing.isDirectory) {
      throw new Error(
        `目标路径已存在且不是目录：${dir}（请换 slug，或先删除该文件）`,
      );
    }
    let empty = true;
    for await (const _ of Deno.readDir(dir)) {
      empty = false;
      break;
    }
    if (!empty) {
      throw new Error(
        `目标目录已存在且非空：${dir}（请换 slug，或先自行清空该目录）`,
      );
    }
    // 已存在的空目录：沿用即可（与旧行为一致），无需 mkdir。
  } else {
    // 不用 recursive：仅创建一层；并发下若已被他人创建则失败而非静默复用。
    await Deno.mkdir(dir);
    createdDir = true;
  }

  const files: Array<[string, string]> = [
    ["problem.json", problemJson({ slug: opts.slug, title, type, difficulty })],
    ["statement.md", statementMarkdown(title)],
    ["template.py", templatePy()],
    ["evaluate.py", evaluatePy()],
    ["visible.jsonl", visibleJsonl()],
    ["hidden.jsonl", hiddenJsonl()],
    ["README.md", readmeMarkdown(title)],
  ];

  // 写入失败时回滚，避免留下「半成品目录」——它会因非空而拒绝后续重跑。
  const written: string[] = [];
  try {
    for (const [name, content] of files) {
      const target = join(dir, name);
      // createNew：并发/重入下不覆盖已存在的文件。
      await Deno.writeTextFile(target, content, { createNew: true });
      written.push(target);
    }
  } catch (err) {
    for (const target of written) {
      await Deno.remove(target).catch(() => {});
    }
    if (createdDir) await Deno.remove(dir).catch(() => {});
    throw err;
  }

  return { dir, files: files.map(([name]) => name) };
}
