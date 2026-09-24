/**
 * 品牌语义色 → ANSI 映射（Task 8 / spec R5）。
 *
 * **单一事实来源**：`dev-docs/design/noj-design-tokens.md` 的「CLI / 终端」section。
 * 本模块只是那份文档的代码表示，两者必须同步；新增语义色先改文档再改这里。
 *
 * **开/关判定只复用 `util/color.ts:resolveColor`**：`NO_COLOR`、`LOG_COLOR`、
 * `--color=auto|always|never`、非 TTY 自动关色这四条规则已经在 `resolveColor`
 * 实现并测试；本模块再抄一份必然漂移（例如只认 `NO_COLOR` 而漏掉 TTY 探测）。
 * 因此 `createTheme` 只把 `resolveColor` 的结果固化成一个不可变 `Theme`。
 *
 * 不持有任何模块级可变状态（AGENTS.md §8.2 多副本约束）：主题由调用方现场创建。
 */

import { type ColorMode, RESET, resolveColor } from "../util/color.ts";

/** 语义色 token（与设计 Token 文档的 `--c-*` 一一对应）。 */
export type SemanticToken =
  | "success"
  | "warning"
  | "error"
  | "info"
  | "primary"
  | "signal"
  | "muted"
  | "secondary";

/** 状态符号种类（语义色的子集）。 */
export type StatusKind = "success" | "warning" | "error" | "info";

/** 语义 token → 设计文档中的 CSS 变量名（防漂移用，也便于报错定位）。 */
export const SEMANTIC_TOKEN_NAMES: Readonly<Record<SemanticToken, string>> = {
  success: "--c-success-text",
  warning: "--c-warning-text",
  error: "--c-error-text",
  info: "--c-info-text",
  primary: "--c-primary",
  signal: "--c-signal",
  muted: "--c-text-muted",
  secondary: "--c-text-secondary",
};

/**
 * 语义 token → ANSI SGR 前景/样式码。
 *
 * 终端无法承载 hex，且前景/背景由用户终端决定，故亮/暗两套 hex 收敛到同一个
 * 16 色槽位（选择标准：浅色与深色终端都可读）。取值与配对理由见设计 Token
 * 文档「CLI / 终端」表；`theme_test.ts` 断言与文档一致。
 */
export const SEMANTIC_ANSI: Readonly<Record<SemanticToken, string>> = {
  success: "\x1b[32m", // 绿色
  warning: "\x1b[33m", // 黄色
  error: "\x1b[31m", // 红色
  info: "\x1b[36m", // 青色
  primary: "\x1b[34m", // 品牌蓝（蓝黑墨）
  signal: "\x1b[92m", // 评测信号绿（亮绿）
  muted: "\x1b[90m", // 弱化文字（亮黑）
  secondary: "\x1b[2m", // 次要文字（dim）
};

/** 状态符号（ASCII 无法区分时靠符号区分语义，色盲友好）。 */
export const STATUS_SYMBOL: Readonly<Record<StatusKind, string>> = {
  success: "✓",
  warning: "!",
  error: "✗",
  info: "ℹ",
};

/** 已判定好开关的语义色主题。 */
export interface Theme {
  /** 是否着色；等于 `resolveColor(mode, stream)`。 */
  readonly enabled: boolean;
  /** 创建时的颜色模式（诊断/透传用）。 */
  readonly mode: ColorMode;
  /** 创建时探测的输出流（诊断/透传用）。 */
  readonly stream: "stdout" | "stderr";
  /** 用语义色包裹一段文本；关色或空串时原样返回（无孤立转义）。 */
  color(token: SemanticToken, text: string): string;
  /** 状态符号 + 空格 + 文本；仅符号着色。 */
  status(kind: StatusKind, text: string): string;
  /** 取某状态对应的符号（不着色）。 */
  symbol(kind: StatusKind): string;
}

/**
 * 创建语义色主题。
 *
 * @param mode `--color` 的值（默认 `auto`）。
 * @param stream 目标流；stdout 与 stderr **分别**探测 TTY（默认 stdout）。
 */
export function createTheme(
  mode: ColorMode,
  stream: "stdout" | "stderr" = "stdout",
): Theme {
  // 唯一开关决策点：绝不在此重复 NO_COLOR/TTY 判断。
  const enabled = resolveColor(mode, stream);
  const color = (token: SemanticToken, text: string): string => {
    // 空串不着色：否则会留下一个只有 SGR 的孤立片段。
    if (!enabled || text === "") return text;
    return `${SEMANTIC_ANSI[token]}${text}${RESET}`;
  };
  return {
    enabled,
    mode,
    stream,
    color,
    // StatusKind 是 SemanticToken 的子集，同名同色。
    status: (kind, text) => `${color(kind, STATUS_SYMBOL[kind])} ${text}`,
    symbol: (kind) => STATUS_SYMBOL[kind],
  };
}
