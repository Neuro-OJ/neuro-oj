// 归一化：剥离注释与字符串字面量、分词、标识符位置化改写。

import { DEFAULT_MAX_RAW_CODE_CHARS, STRING_TOKEN } from "./lexicon.ts";
import { resolveProfile } from "./lexicon.ts";
import type { LanguageProfile } from "./lexicon.ts";

/** 判断 token 是否为标识符（首字符为字母/下划线/$）。 */
function isIdentifierToken(token: string): boolean {
  return /^[\p{L}_$]/u.test(token);
}

/**
 * 跳过一段引号包围的字面量，返回结束引号之后的下标。
 * 处理反斜杠转义；遇到换行视为未闭合字符串，停在换行处（保留行结构）。
 */
function skipQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === "\n") return i;
    i++;
  }
  return source.length;
}

function stripCommentsAndLiterals(
  source: string,
  profile: LanguageProfile,
): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const lineComment = profile.lineComments.find((marker) =>
      source.startsWith(marker, i)
    );
    if (lineComment) {
      const end = source.indexOf("\n", i);
      if (end === -1) break;
      i = end;
      continue;
    }
    const blockComment = profile.blockComments.find(([open]) =>
      source.startsWith(open, i)
    );
    if (blockComment) {
      const end = source.indexOf(blockComment[1], i + blockComment[0].length);
      i = end === -1 ? source.length : end + blockComment[1].length;
      out += " ";
      continue;
    }
    const tripleQuote = profile.tripleQuotes.find((quote) =>
      source.startsWith(quote, i)
    );
    if (tripleQuote) {
      // 三引号字符串按文档字符串处理：整体剥除且不留占位符。理由：Python 中
      // 它绝大多数是文档字符串，新增/删除文档字符串不该拉低相似度；若留占位符，
      // 反而会给 token 流插入一个额外 token，凭空制造差异。
      const end = source.indexOf(tripleQuote, i + tripleQuote.length);
      i = end === -1 ? source.length : end + tripleQuote.length;
      out += " ";
      continue;
    }
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipQuoted(source, i, ch);
      out += ` ${STRING_TOKEN} `;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 分词：标识符 / 数字 / 其余单字符符号各成一个 token。
 *
 * 符号不再做多字符合并（`==` 与 `<=` 都是两个 token）：符号的分词结果与
 * 空格习惯无关，天然对 `a==b` 与 `a == b` 这类格式差异免疫。
 */
function tokenize(source: string): string[] {
  const matches = source.match(
    /0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[\p{L}_$][\p{L}\p{N}_$]*|[^\s]/gu,
  );
  return matches ?? [];
}

/**
 * 把用户自定义标识符改写为按「首次出现顺序」编号的 `v1..vN`。
 *
 * ## 取舍（重要）
 *
 * 做的是**位置化改写**：第 1 个出现的自定义标识符记为 `v1`、第 2 个记为
 * `v2`，之后同一标识符的所有出现都映射到同一个 `vN`。于是：
 *
 * - 只改变量名的抄袭（含 `i/j/k` → `a/b/c`、`n` → `count`）归一化后 token
 *   流完全一致，相似度接近 1.0——这是本功能最核心的召回场景。
 * - 保留「同一变量被反复使用」的结构信号，比「所有标识符拉平成同一个
 *   token」保留更多区分度，后者会让两份无关解法因骨架雷同而误报。
 * - 数字字面量**不**归一化：常量往往是区分不同实现的关键信号（`range(10)`
 *   与 `range(1000)` 不该被视作同一份代码）。代价是「只改常量」的抄袭会
 *   被低估，但这属于少数情形，且改常量后通常也改了其它部分。
 *
 * 已知边界：位置化改写对**在代码前部新增一个标识符**敏感——后续标识符的
 * 编号整体后移，会让插入点之后区域的指纹失配，导致相似度被低估（漏报）。
 * 换成「按名字排序编号」或「全部拉平」都会引入更大的误报风险，因此保留
 * 位置化改写，并把该边界记在这里供后续调优（例如引入局部对齐）时参考。
 */
function canonicalizeIdentifiers(
  tokens: readonly string[],
  keywords: ReadonlySet<string>,
): string[] {
  const mapping = new Map<string, string>();
  let nextIndex = 0;
  return tokens.map((token) => {
    if (!isIdentifierToken(token) || keywords.has(token)) return token;
    let canonical = mapping.get(token);
    if (!canonical) {
      nextIndex += 1;
      canonical = `v${nextIndex}`;
      mapping.set(token, canonical);
    }
    return canonical;
  });
}

/**
 * 做了什么：
 * - 剥离注释（按语言的 `//`、`#`、`--`、`%`、`/* *\/`、`{ }` 等）与字符串/
 *   字符字面量（统一替换为占位符，字面量内容差异不影响判定）；
 * - Python 三引号字符串整体剥除（多数是文档字符串，新增/删除它不算改代码，
 *   因此连占位符都不留）；
 * - 压掉所有空白与换行差异（分词天然忽略空白）；
 * - 用户自定义标识符按首次出现顺序位置化改写为 `v1..vN`。
 *
 * 没做什么（刻意保留区分度）：
 * - 不做常量折叠/替换，数字与字符串占位符保持原样位置；
 * - 不排序 token、不丢弃关键字，`for`/`while`/`if` 等结构信号全部保留；
 * - 不做类型推断、控制流归一化或死代码消除（无 AST/编译器，成本远超收益）；
 * - 不做标识符「语义」归并（`count` 与 `total` 不会被视作同一变量）。
 *
 * @returns 规范 token 序列；空/仅注释/`null` 输入返回空数组。
 */
export function normalizeCode(
  code: string | null | undefined,
  language: string | null | undefined,
): string[] {
  const raw = (code ?? "").slice(0, DEFAULT_MAX_RAW_CODE_CHARS);
  if (!raw.trim()) return [];
  const profile = resolveProfile(language);
  const stripped = stripCommentsAndLiterals(raw, profile);
  return canonicalizeIdentifiers(tokenize(stripped), profile.keywords);
}
