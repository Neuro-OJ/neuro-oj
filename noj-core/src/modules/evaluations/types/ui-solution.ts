/**
 * 界面提交（`submission_mode = "ui"`）的参数校验与脚本生成。
 *
 * 题包自带 `ui.html`，选手在界面里填写参数；前端把参数收集为 JSON 对象并以
 * `language = "ui"` 提交（`submissions.code` 保存 JSON 原文，便于历史对比与回滚）。
 * 构造评测任务时，核心把参数注入题目的脚本模板，生成最终 Python 脚本交给 judge
 * 运行——judge 看到的始终是普通的 `python3` 代码，后端评测流程不变：
 *
 * ```python
 * PARAMS = {...}                 # 界面传来的参数（Base64 嵌入，不会破坏源码）
 * prompt = PARAMS["prompt"]      # 每个合法标识符字段同时展开为同名模块级变量
 * ...                            # 之后是出题人写的脚本模板（template.py）
 * ```
 */

import { encodeBase64 } from "@std/encoding/base64";
import { BadRequestError } from "../../../shared/base/errors.ts";

/** 界面提交在 `submissions.language` 中的语言标识。 */
export const UI_LANGUAGE = "ui";

/** 界面提交在 `submissions.file_name` 中的默认文件名（仅用于展示）。 */
export const UI_FILE_NAME = "params.json";

/** 参数字段名：合法的 Python 标识符，且不以下划线开头（避免覆盖内部名称）。 */
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Python 关键字（作为变量名赋值会语法错误，这类字段只保留在 `PARAMS` 中）。 */
const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/** 参数字段数量上限（防止构造超大对象）。 */
export const MAX_UI_FIELDS = 100;

/**
 * 解析并校验界面提交的参数 JSON。
 *
 * 必须是 JSON 对象；字段名只允许字母开头的字母数字下划线组合（与 `PARAMS` 键、
 * 模块级变量名一致），字段数不超过 {@link MAX_UI_FIELDS}。值本身不限制类型，
 * 由脚本模板自行校验。
 *
 * @throws {BadRequestError} 不是合法 JSON 对象或字段名非法
 */
export function parseUiValues(code: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(code);
  } catch {
    throw new BadRequestError("界面参数必须是合法的 JSON");
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
  ) {
    throw new BadRequestError("界面参数必须是 JSON 对象");
  }
  const keys = Object.keys(parsed);
  if (keys.length > MAX_UI_FIELDS) {
    throw new BadRequestError(`界面参数字段不能超过 ${MAX_UI_FIELDS} 个`);
  }
  for (const key of keys) {
    if (!FIELD_NAME_RE.test(key)) {
      throw new BadRequestError(
        `界面参数字段名非法：${key}（仅允许字母开头的字母、数字、下划线）`,
      );
    }
  }
  return parsed as Record<string, unknown>;
}

/**
 * 把界面参数注入脚本模板，生成最终提交给 judge 的 Python 脚本。
 *
 * 参数以 UTF-8 → Base64 嵌入，字段值中的引号、反斜杠、三引号都不会破坏源码。
 *
 * @param values 已通过 {@link parseUiValues} 校验的参数
 * @param scriptTemplate 出题人的脚本模板（题包 `template.py`）
 */
export function buildUiSolutionScript(
  values: Record<string, unknown>,
  scriptTemplate: string,
): string {
  const encoded = encodeBase64(
    new TextEncoder().encode(JSON.stringify(values)),
  );
  const lines = [
    '"""NOJ 界面题脚本：参数由平台根据选手在界面中的填写注入，之后是出题人的脚本模板。"""',
    "",
    "import base64 as _noj_b64",
    "import json as _noj_json",
    "",
    `PARAMS = _noj_json.loads(_noj_b64.b64decode("${encoded}").decode("utf-8"))`,
  ];
  for (const key of Object.keys(values)) {
    if (!PYTHON_KEYWORDS.has(key)) lines.push(`${key} = PARAMS["${key}"]`);
  }
  lines.push("", "# ── 以下为题目脚本模板 ──", scriptTemplate);
  return lines.join("\n");
}

/** 生成的脚本注入 judge 时使用的语言与文件名（judge 只认识 Python 源码）。 */
export const UI_WRAPPED_LANGUAGE = "python3";
export const UI_WRAPPED_FILE_NAME = "main.py";

/**
 * 校验提交语言与题目提交模式是否匹配。
 *
 * - ui 题只接受 `language = "ui"`
 * - 其他题目不接受 `"ui"`，且语言必须在 `supportedLanguages` 内
 *
 * @throws {BadRequestError} 语言与提交模式不匹配或不受支持
 */
export function assertSubmissionLanguage(
  submissionMode: string,
  language: string,
  supportedLanguages: readonly string[],
): void {
  if (submissionMode === "ui") {
    if (language !== UI_LANGUAGE) {
      throw new BadRequestError("该题目要求通过界面提交参数（language=ui）");
    }
    return;
  }
  if (!supportedLanguages.includes(language)) {
    throw new BadRequestError(`不支持的语言: ${language}`);
  }
}

/**
 * 按提交语言推断本次源码提交的提交模式（用于与题目版本的 `submission_mode` 比对）。
 *
 * `language = "ui"` → `ui`，其余 → `code`；artifact 提交走独立入口，不经此函数。
 */
export function submissionModeForLanguage(language: string): "code" | "ui" {
  return language === UI_LANGUAGE ? "ui" : "code";
}
