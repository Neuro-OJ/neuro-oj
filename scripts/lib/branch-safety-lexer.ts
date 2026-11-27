/**
 * 分支安全自检 · 源码词法扫描。
 *
 * 唯一职责：把源码里的**字符串字面量**取出来，同时正确跳过注释、正则字面量与
 * 模板插值。检查项 B 的全部精度都取决于这里——正则硬扒 import 会把注释里的旧
 * 路径、正则里的引号、模板里的半截路径全算进去，正是"误报让脚本被忽略"的来源。
 *
 * 这里只做词法，不认识"文件路径"或"导入语句"：语义判断在
 * `branch-safety-references.ts`。
 */

/** 一个字符串字面量（模板字符串只保留不含插值的字面量片段）。 */
export interface StringToken {
  value: string;
  /** 1 起始的行号。 */
  line: number;
  /** 字符串之前紧邻的代码片段（已剔除注释与空白），用于判定 `from` / `import(`。 */
  prefix: string;
}

/** 只保留尾部代码字符。 */
const MAX_CODE_TAIL = 24;

/** 正则字面量前面可能出现的字符（表达式起始位置）。 */
const REGEX_START_CHARS = "(,=:[!&|?{};+-*%~^<>";

/** 正则字面量前面可能出现的关键字。 */
const REGEX_START_WORDS =
  /(?:return|typeof|case|in|of|do|else|yield|await|void|delete)$/;

/**
 * 扫描源码，返回所有字符串字面量。
 *
 * 注释、正则字面量、带 `${}` 插值的模板片段都不会出现在结果里。
 */
export function scanStringTokens(source: string): StringToken[] {
  const tokens: StringToken[] = [];
  const length = source.length;
  let codeTail = "";
  let line = 1;
  let index = 0;

  while (index < length) {
    const char = source[index];

    if (char === "\n") {
      line++;
      index++;
      continue;
    }

    // 行注释：跳到行尾（换行留给下一轮，保证行号准确）。
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? length : end;
      continue;
    }

    // 块注释：整段跳过，并补齐其中跨过的行数。
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? length : end + 2;
      line += countNewlines(source, index, stop);
      index = stop;
      continue;
    }

    if (char === "'" || char === '"') {
      const read = readQuoted(source, index, line, codeTail);
      tokens.push(read.token);
      index = read.index;
      codeTail = "";
      continue;
    }

    if (char === "`") {
      const read = readTemplate(source, index, line, codeTail);
      tokens.push(...read.tokens);
      index = read.index;
      line = read.line;
      codeTail = "";
      continue;
    }

    if (char === "/") {
      // 除号与正则的区分只影响"这一行剩下的代码"，判错不会崩，只会少扫。
      if (isRegexStart(codeTail)) {
        index = skipRegex(source, index);
      } else {
        codeTail = (codeTail + "/").slice(-MAX_CODE_TAIL);
        index++;
      }
      continue;
    }

    if (!/\s/.test(char)) codeTail = (codeTail + char).slice(-MAX_CODE_TAIL);
    index++;
  }

  return tokens;
}

/** 读取一个普通引号字符串；未闭合时按行截断，避免吞掉后面的代码。 */
function readQuoted(
  source: string,
  start: number,
  startLine: number,
  prefix: string,
): { token: StringToken; index: number; line: number } {
  const quote = source[start];
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      value += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === "\n") break;
    if (char === quote) {
      index++;
      break;
    }
    value += char;
    index++;
  }
  return { token: { value, line: startLine, prefix }, index, line: startLine };
}

/**
 * 读取一个模板字符串。
 *
 * 含 `${}` 插值的模板整段丢弃：`` `${root}/foo.ts` `` 的片段无法判断真伪。
 */
function readTemplate(
  source: string,
  start: number,
  startLine: number,
  prefix: string,
): { tokens: StringToken[]; index: number; line: number } {
  const tokens: StringToken[] = [];
  let index = start + 1;
  let line = startLine;
  let chunk = "";
  let chunkLine = startLine;
  let interpolated = false;

  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      chunk += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === "`") {
      index++;
      break;
    }
    if (char === "$" && source[index + 1] === "{") {
      interpolated = true;
      chunk = "";
      const skipped = skipInterpolation(source, index + 2, line);
      index = skipped.index;
      line = skipped.line;
      chunkLine = line;
      continue;
    }
    if (char === "\n") line++;
    if (chunk === "") chunkLine = line;
    chunk += char;
    index++;
  }

  if (!interpolated && chunk !== "") {
    tokens.push({ value: chunk, line: chunkLine, prefix });
  }
  return { tokens, index, line };
}

/** 跳过 `${ ... }` 的内部，正确跨过嵌套的字符串、模板与注释。 */
function skipInterpolation(
  source: string,
  start: number,
  startLine: number,
): { index: number; line: number } {
  let depth = 1;
  let index = start;
  let line = startLine;
  while (index < source.length) {
    const char = source[index];
    if (char === "\n") {
      line++;
      index++;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      line += countNewlines(source, index, stop);
      index = stop;
      continue;
    }
    if (char === "'" || char === '"') {
      const read = readQuoted(source, index, line, "");
      index = read.index;
      continue;
    }
    if (char === "`") {
      const read = readTemplate(source, index, line, "");
      index = read.index;
      line = read.line;
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return { index: index + 1, line };
    }
    index++;
  }
  return { index, line };
}

/** 上一个代码字符是否处于"表达式起始"位置（决定 `/` 是不是正则）。 */
function isRegexStart(codeTail: string): boolean {
  if (codeTail === "") return true;
  const last = codeTail.slice(-1);
  if (REGEX_START_CHARS.includes(last)) return true;
  return REGEX_START_WORDS.test(codeTail);
}

/** 跳过正则字面量；误判时按行截断，不影响其余扫描。 */
function skipRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") return index;
    if (char === "[") inClass = true;
    if (char === "]") inClass = false;
    if (char === "/" && !inClass) {
      index++;
      break;
    }
    index++;
  }
  while (index < source.length && /[a-z]/i.test(source[index])) index++;
  return index;
}

/** 统计 [start, stop) 区间内的换行数。 */
function countNewlines(source: string, start: number, stop: number): number {
  let count = 0;
  for (let index = start; index < stop; index++) {
    if (source[index] === "\n") count++;
  }
  return count;
}
