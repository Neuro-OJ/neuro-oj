/**
 * 提示词题（`submission_mode = "prompt"`）的提交适配。
 *
 * 选手只在网页上编辑提示词文本，不写代码。为了复用现有的双容器评测链路
 * （judge 只认识 Python Solution 模块），核心在构造评测任务时把提示词
 * 包装成一个固定的 Python 模块注入 Solution 容器：
 *
 * ```python
 * PROMPT: str = ...        # 选手提交的提示词原文
 * def get_prompt() -> str: # Evaluator 通过 runner.call("get_prompt") 取回
 * ```
 *
 * 数据库 `submissions.code` 中保存的是**提示词原文**（language = "prompt"），
 * 包装只发生在 `buildJudgeTask` 内——正式提交、自测、重测与 sweeper 补投
 * 共用同一入口，无需在各调用点分别处理。
 */

import { encodeBase64 } from "@std/encoding/base64";
import { BadRequestError } from "../../../shared/base/errors.ts";

/** 提示词提交在 `submissions.language` 中的语言标识。 */
export const PROMPT_LANGUAGE = "prompt";

/** 提示词提交在 `submissions.file_name` 中的默认文件名（仅用于展示）。 */
export const PROMPT_FILE_NAME = "prompt.md";

/** 提示词包装后注入 Solution 容器时使用的语言与文件名。 */
export const PROMPT_WRAPPED_LANGUAGE = "python3";
export const PROMPT_WRAPPED_FILE_NAME = "main.py";

/**
 * 把提示词原文包装成 Solution 模块源码。
 *
 * 提示词以 UTF-8 → Base64 的形式嵌入，避免选手文本中的引号、反斜杠、
 * 三引号等内容破坏 Python 字面量（即代码注入）。孤立代理项等非法
 * Unicode 由 `TextEncoder` 替换为 U+FFFD，保证解码必然成功。
 */
export function buildPromptSolutionModule(prompt: string): string {
  const encoded = encodeBase64(new TextEncoder().encode(prompt));
  return [
    '"""NOJ 提示词题 Solution 模块：由平台根据选手提交的提示词自动生成。"""',
    "",
    "import base64 as _b64",
    "",
    `PROMPT: str = _b64.b64decode("${encoded}").decode("utf-8")`,
    "",
    "",
    "def get_prompt() -> str:",
    '    """返回选手提交的提示词原文。"""',
    "    return PROMPT",
    "",
  ].join("\n");
}

/**
 * 校验提交语言与题目提交模式是否匹配。
 *
 * - prompt 题只接受 `language = "prompt"`
 * - 其他题目不接受 `"prompt"`，且语言必须在 `supportedLanguages` 内
 *
 * @throws {BadRequestError} 语言与提交模式不匹配或不受支持
 */
export function assertSubmissionLanguage(
  submissionMode: string,
  language: string,
  supportedLanguages: readonly string[],
): void {
  if (submissionMode === "prompt") {
    if (language !== PROMPT_LANGUAGE) {
      throw new BadRequestError("该题目要求提交提示词（language=prompt）");
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
 * `language = "prompt"` → `prompt`，其余 → `code`；artifact 提交走独立入口，不经此函数。
 */
export function submissionModeForLanguage(
  language: string,
): "code" | "prompt" {
  return language === PROMPT_LANGUAGE ? "prompt" : "code";
}
