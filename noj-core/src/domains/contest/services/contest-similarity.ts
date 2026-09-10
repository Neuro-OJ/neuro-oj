/**
 * 竞赛代码相似度检测（防作弊线索发现）。
 *
 * ## 为什么独立成文件
 *
 * `contest-anti-cheat.ts` 处理的是「来源 IP → 账号关联」，本文件处理的是
 * 「源代码 → 结构相似度」：数据来源、算法与失败模式都不同，且算法部分是
 * 纯函数（不碰数据库），独立成文件便于单独单测，也避免把数百行 token
 * 处理逻辑塞进风控查询文件。
 *
 * ## 算法
 *
 * token 归一化 → winnowing 指纹 → Jaccard 相似度，即 MOSS 一类的
 * 「结构近似」检测，而不是语义等价检测：
 *
 * 1. `normalizeCode()`：剥注释与字符串字面量 → 分词 → 标识符按首次出现
 *    顺序改写为 `v1..vN`（语言关键字与高频标准库符号除外）。
 * 2. `fingerprint()`：对 token 流取 k-gram 哈希，再用 winnowing 选出每个
 *    长度为 w 的窗口内最小的哈希作为指纹（Schleimer/Wilkerson/Aiken 2003）。
 * 3. `similarity()`：两个指纹集合的 Jaccard 系数。
 *
 * 不使用 AST：本功能只需要「找出值得人工复核的提交对」，不需要精确到语法
 * 结构；纯 TS 实现零第三方依赖、对竞赛中临时启用的语言也能工作，且对改名、
 * 注释、空白鲁棒。取舍与已知边界见 `normalizeCode()` 的注释。
 *
 * ## 输出口径
 *
 * 只输出「互相高度相似的提交对」作为人工复核线索：不做自动判罚、不返回
 * 源代码本身（只返回提交标识、用户、题目、语言、相似度与指纹统计）。
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { submissions, users } from "../../../shared/db/schema.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import { assertContestExists } from "./contest-anti-cheat.ts";

/** 默认相似度阈值：指纹 Jaccard ≥ 该值即视为「高度相似」候选对。 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.8;

/** 单次查询返回的相似对上限（路由层用它校验 `limit` 参数）。 */
export const MAX_SIMILAR_PAIR_LIMIT = 200;

/**
 * k-gram 的 k：连续 k 个 token 构成一个指纹单元。
 * 取 5 的理由：语句级结构（如 `for i in range ( n )`）约 5-7 个 token，
 * k 太大（≥10）会让短解法完全无法产生指纹，k 太小（≤3）则常见的
 * `= 0 ;`、`( )` 这类片段会大量互相碰撞、抬高误报。
 */
const DEFAULT_K = 5;

/**
 * winnowing 窗口 w：每个长度为 w 的 k-gram 哈希窗口保留一个最小值。
 * 取 4 的理由：论文经验值与 MOSS 同类工具常用区间（4-7）的下沿；
 * w 越大指纹越稀疏、抗噪越强但灵敏度越低。w=4 时保证「任意长度
 * ≥ k + w - 1 = 8 个 token 的公共片段必定产生至少一个公共指纹」。
 */
const DEFAULT_WINDOW = 4;

/**
 * 默认参与计算的提交数上限（超出即报错，见 findSimilarSubmissions）。
 *
 * 取值依据（本地实测，单桶、全部同题同语言）：
 * - 100 份普通规模提交（约 37 token）≈ 10ms；
 * - 200 份病态提交（每份撞满 6000 token 上限且内容两两相同）≈ 1.8s / 50MB；
 * - 400 份同样的病态提交 ≈ 7.0s / 110MB。
 *
 * 计算在请求线程内同步执行，会阻塞同一 Deno isolate 的其它请求，因此默认值
 * 取 200（病态情形仍在 2s 内），把「整场竞赛」的大规模分析引导到 problem_id
 * 逐题进行。需要更大范围时由调用方显式提高 maxSubmissions。
 */
const DEFAULT_MAX_SIMILARITY_SUBMISSIONS = 200;

/** 默认返回的相似对上限。 */
const DEFAULT_PAIR_LIMIT = 50;

/**
 * 单份提交参与分析的源码字符上限。
 * 理由：题面允许 100KB 代码，但结构特征在前 2 万字符内已充分体现；截断可把
 * 「内存 × CPU」同时压住（查询层还会用 SQL substr 避免把整份代码取回内存）。
 * 截断点可能落在 token 中间，代价是丢掉最后一个不完整 token，可忽略。
 */
const DEFAULT_MAX_RAW_CODE_CHARS = 20_000;

/** 单份提交参与分析的 token 上限，作用同 DEFAULT_MAX_RAW_CODE_CHARS。 */
const DEFAULT_MAX_TOKENS = 6_000;

/** 字符串字面量的占位 token；加入保护集合，不参与标识符改写。 */
const STRING_TOKEN = "__noj_str__";

/** 语言关键字与保留字：不参与标识符改写，保留真实结构信号。 */
const C_LIKE_KEYWORDS: readonly string[] = [
  "alignas",
  "alignof",
  "and",
  "asm",
  "assert",
  "async",
  "auto",
  "await",
  "bool",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "constexpr",
  "continue",
  "crate",
  "decltype",
  "default",
  "defer",
  "delete",
  "do",
  "double",
  "dyn",
  "elif",
  "else",
  "enum",
  "explicit",
  "export",
  "extends",
  "extern",
  "false",
  "final",
  "finally",
  "float",
  "fn",
  "for",
  "foreach",
  "friend",
  "from",
  "func",
  "function",
  "go",
  "goto",
  "if",
  "impl",
  "implements",
  "import",
  "in",
  "inline",
  "instanceof",
  "int",
  "interface",
  "internal",
  "is",
  "lambda",
  "let",
  "long",
  "loop",
  "map",
  "match",
  "mod",
  "move",
  "mut",
  "namespace",
  "new",
  "nil",
  "noexcept",
  "not",
  "nullptr",
  "of",
  "operator",
  "or",
  "package",
  "private",
  "protected",
  "protocol",
  "pub",
  "public",
  "range",
  "readonly",
  "ref",
  "register",
  "return",
  "select",
  "short",
  "signed",
  "sizeof",
  "static",
  "static_cast",
  "struct",
  "super",
  "switch",
  "template",
  "this",
  "throw",
  "throws",
  "trait",
  "true",
  "try",
  "type",
  "typedef",
  "typename",
  "typeof",
  "union",
  "unsafe",
  "unsigned",
  "use",
  "using",
  "var",
  "virtual",
  "void",
  "volatile",
  "where",
  "while",
  "with",
  "yield",
];

/** Python 关键字与保留字。 */
const PYTHON_KEYWORDS: readonly string[] = [
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
  "match",
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
];

/** SQL 关键字（竞赛中偶尔出现 SQL 类题目）。 */
const SQL_KEYWORDS: readonly string[] = [
  "add",
  "all",
  "alter",
  "and",
  "as",
  "asc",
  "avg",
  "between",
  "by",
  "case",
  "cast",
  "column",
  "count",
  "create",
  "delete",
  "desc",
  "distinct",
  "drop",
  "else",
  "end",
  "exists",
  "foreign",
  "from",
  "full",
  "group",
  "having",
  "in",
  "index",
  "inner",
  "insert",
  "into",
  "is",
  "join",
  "key",
  "left",
  "like",
  "limit",
  "max",
  "min",
  "not",
  "null",
  "offset",
  "on",
  "or",
  "order",
  "outer",
  "primary",
  "references",
  "right",
  "select",
  "set",
  "sum",
  "table",
  "then",
  "union",
  "unique",
  "update",
  "values",
  "when",
  "where",
];

/**
 * 高频标准库/内建符号保护清单。
 *
 * 取舍：**刻意保持精简**。保护的符号越多，归一化就越接近「把所有标识符
 * 拉平成同一个 token」，反而丢失区分度（两份毫不相干的解法会因骨架雷同而
 * 互相误报）——这是本算法最容易踩的坑。这里只覆盖各语言最高频的少数符号。
 */
const BUILTIN_IDENTIFIERS: readonly string[] = [
  "ArrayList",
  "Array",
  "Arrays",
  "BufferedReader",
  "Collections",
  "Console",
  "HashMap",
  "HashSet",
  "Integer",
  "JSON",
  "List",
  "Math",
  "Object",
  "Scanner",
  "String",
  "StringBuilder",
  "System",
  "append",
  "begin",
  "ceil",
  "cin",
  "console",
  "cout",
  "empty",
  "end",
  "endl",
  "enumerate",
  "fabs",
  "filter",
  "float",
  "floor",
  "forEach",
  "free",
  "getline",
  "input",
  "int",
  "join",
  "length",
  "len",
  "log",
  "main",
  "malloc",
  "map",
  "max",
  "max_element",
  "memcpy",
  "memset",
  "min",
  "min_element",
  "nextInt",
  "nextLine",
  "null",
  "out",
  "parseInt",
  "pop",
  "pop_back",
  "print",
  "printf",
  "println",
  "push",
  "push_back",
  "puts",
  "range",
  "readline",
  "require",
  "reverse",
  "round",
  "scanf",
  "setprecision",
  "size",
  "slice",
  "sort",
  "sorted",
  "split",
  "sqrt",
  "std",
  "stdin",
  "stdout",
  "str",
  "strip",
  "sum",
  "sys",
  "to_string",
  "toString",
  "trim",
  "undefined",
  "upper_bound",
  "lower_bound",
  "vector",
  "write",
  "zip",
];

/** 归一化后仍保持原样输出的 token（占位符 + 常量字面量）。 */
const PROTECTED_TOKENS = new Set<string>([
  STRING_TOKEN,
  "true",
  "false",
  "null",
  "undefined",
  "None",
  "True",
  "False",
  "NULL",
  "nil",
  "nullptr",
  "self",
  "cls",
]);

/** 语言注释/字符串轮廓。 */
interface LanguageProfile {
  /** 行注释起始符，按优先级排列。 */
  lineComments: readonly string[];
  /** 块注释起始/结束符对。 */
  blockComments: readonly (readonly [string, string])[];
  /** 多行字符串（如 Python 文档字符串）分隔符。 */
  tripleQuotes: readonly string[];
  /** 不参与标识符改写的关键字集合。 */
  keywords: ReadonlySet<string>;
}

const PYTHON_KEYWORD_SET = new Set([
  ...PYTHON_KEYWORDS,
  ...PROTECTED_TOKENS,
  ...BUILTIN_IDENTIFIERS,
]);
const C_LIKE_KEYWORD_SET = new Set([
  ...C_LIKE_KEYWORDS,
  ...PROTECTED_TOKENS,
  ...BUILTIN_IDENTIFIERS,
]);
const SQL_KEYWORD_SET = new Set([...SQL_KEYWORDS, ...PROTECTED_TOKENS]);
const GENERIC_KEYWORD_SET = new Set([
  ...C_LIKE_KEYWORDS,
  ...PYTHON_KEYWORDS,
  ...PROTECTED_TOKENS,
  ...BUILTIN_IDENTIFIERS,
]);

const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
  "c-like": {
    lineComments: ["//"],
    blockComments: [["/*", "*/"]],
    tripleQuotes: [],
    keywords: C_LIKE_KEYWORD_SET,
  },
  python: {
    lineComments: ["#"],
    blockComments: [],
    tripleQuotes: ['"""', "'''"],
    keywords: PYTHON_KEYWORD_SET,
  },
  hash: {
    lineComments: ["#"],
    blockComments: [],
    tripleQuotes: [],
    keywords: GENERIC_KEYWORD_SET,
  },
  dash: {
    lineComments: ["--"],
    blockComments: [],
    tripleQuotes: [],
    keywords: GENERIC_KEYWORD_SET,
  },
  percent: {
    lineComments: ["%"],
    blockComments: [],
    tripleQuotes: [],
    keywords: GENERIC_KEYWORD_SET,
  },
  pascal: {
    lineComments: ["//"],
    blockComments: [["(*", "*)"], ["{", "}"]],
    tripleQuotes: [],
    keywords: GENERIC_KEYWORD_SET,
  },
  sql: {
    lineComments: ["--"],
    blockComments: [["/*", "*/"]],
    tripleQuotes: [],
    keywords: SQL_KEYWORD_SET,
  },
  none: {
    lineComments: [],
    blockComments: [],
    tripleQuotes: [],
    keywords: PROTECTED_TOKENS,
  },
};

/**
 * 语言别名 → 轮廓名。
 *
 * 键为「小写且仅保留字母」的语言名（`c++17` → `c`、`python3` → `python`），
 * 这样新增语言版本号时不必改表。未登记的语言回退到 `c-like`
 * （见 `resolveProfile()` 的注释）。
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  ada: "dash",
  bash: "hash",
  c: "c-like",
  cc: "c-like",
  cilk: "c-like",
  clojure: "none",
  cobol: "c-like",
  coffeescript: "hash",
  cpp: "c-like",
  crystal: "hash",
  cs: "c-like",
  csharp: "c-like",
  cxx: "c-like",
  dart: "c-like",
  elixir: "hash",
  erlang: "percent",
  fsharp: "none",
  go: "c-like",
  golang: "c-like",
  groovy: "c-like",
  haskell: "dash",
  java: "c-like",
  javascript: "c-like",
  js: "c-like",
  json: "c-like",
  julia: "hash",
  kotlin: "c-like",
  kt: "c-like",
  lisp: "none",
  lua: "dash",
  matlab: "percent",
  mysql: "sql",
  node: "c-like",
  nodejs: "c-like",
  objc: "c-like",
  objectivec: "c-like",
  ocaml: "none",
  octave: "percent",
  pascal: "pascal",
  perl: "hash",
  php: "c-like",
  plsql: "sql",
  postgresql: "sql",
  powershell: "hash",
  py: "python",
  python: "python",
  python3: "python",
  r: "hash",
  rb: "hash",
  ruby: "hash",
  rust: "c-like",
  scala: "c-like",
  scheme: "none",
  sh: "hash",
  shell: "hash",
  sql: "sql",
  swift: "c-like",
  ts: "c-like",
  tsx: "c-like",
  typescript: "c-like",
  vb: "none",
  vbnet: "none",
  verilog: "c-like",
  vhdl: "dash",
  zig: "c-like",
};

/**
 * 解析语言对应的注释/关键字轮廓。
 *
 * 未登记的语言回退到 `c-like`：它只会多剥 `//`、`/* *\/` 两种注释，不会
 * 破坏 token 流；反过来（对未知语言假定 `#` 是注释）会把 C 系语言的预处理
 * 指令当注释删掉，风险更大，因此回退方向刻意选 `c-like`。
 */
function resolveProfile(language: string | null | undefined): LanguageProfile {
  const key = (language ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const profileName = LANGUAGE_ALIASES[key];
  return LANGUAGE_PROFILES[profileName ?? "c-like"] ??
    LANGUAGE_PROFILES["c-like"]!;
}

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

/**
 * 剥离注释与字符串字面量，保留其余源码文本。
 *
 * 单趟状态扫描（而不是「先剥注释再剥字符串」两趟正则）：两趟做法在
 * `char *s = "http://x";` 这类代码上会把字符串里的 `//` 当注释，从而误删
 * 真实代码；单趟扫描从根本上避免这种交叉误判。
 */
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
 * 归一化源码为「规范 token 序列」。
 *
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

/** 32 位 FNV-1a，用于把 token 字符串压成定长数值。 */
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash = Math.imul(hash ^ token.charCodeAt(i), 16777619) >>> 0;
  }
  return hash;
}

/**
 * 计算第 `start` 个 token 起始的 k-gram 指纹值。
 *
 * 组合两个 32 位哈希（FNV-1a 与 djb2）成 ≤ 2^53-1 的整数：单用 32 位时
 * 按生日界估算，数十万指纹量级下会有可观碰撞，从而把无关提交的相似度
 * 略微抬高；组合后碰撞概率可忽略，同时保持数字键的集合运算速度。
 */
function hashKGram(
  hashes: readonly number[],
  start: number,
  k: number,
): number {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = start; i < start + k; i++) {
    const value = hashes[i]!;
    fnv = Math.imul(fnv ^ value, 16777619) >>> 0;
    djb = (Math.imul(djb, 33) ^ value) >>> 0;
  }
  // 2^32-1 左移 21 位后仍小于 Number.MAX_SAFE_INTEGER，无精度损失。
  return fnv * 2097152 + (djb >>> 11);
}

/**
 * winnowing 指纹：对 token 流取 k-gram 哈希，再在每个长度 w 的滑动窗口内
 * 保留最小哈希（同值取最右，与论文一致）。
 *
 * 该选择策略给出论文中的保证：两份代码若存在长度 ≥ k + w - 1 的公共
 * token 片段，则其指纹集合必有交集——这正是「改写变量名后仍能命中」的
 * 理论基础。窗口最小值用单调队列维护，整体 O(n)。
 *
 * @param tokens 规范 token 序列（`normalizeCode()` 的输出）。
 * @param k k-gram 长度，默认 5，必须 ≥ 1。
 * @param window 窗口长度，默认 4，必须 ≥ 1。
 * @returns 去重后的指纹值数组；token 数 < k（或 < window）时按论文取全局
 *   最小哈希作为唯一指纹；无可用 k-gram 时返回空数组。
 */
export function fingerprint(
  tokens: readonly string[],
  k: number = DEFAULT_K,
  window: number = DEFAULT_WINDOW,
): number[] {
  if (!Number.isInteger(k) || k < 1) {
    throw new BadRequestError("k 必须为不小于 1 的整数");
  }
  if (!Number.isInteger(window) || window < 1) {
    throw new BadRequestError("window 必须为不小于 1 的整数");
  }
  const gramCount = tokens.length - k + 1;
  if (gramCount <= 0) return [];
  const tokenHashes = tokens.map(hashToken);
  const gramHashes: number[] = new Array(gramCount);
  for (let i = 0; i < gramCount; i++) {
    gramHashes[i] = hashKGram(tokenHashes, i, k);
  }
  const effectiveWindow = Math.min(window, gramCount);
  const selected = new Set<number>();
  const queue: number[] = [];
  for (let i = 0; i < gramCount; i++) {
    const current = gramHashes[i]!;
    // `>=` 让同值哈希保留最右侧下标，与论文的 tie-break 一致。
    while (
      queue.length > 0 && gramHashes[queue[queue.length - 1]!]! >= current
    ) {
      queue.pop();
    }
    queue.push(i);
    if (queue[0]! <= i - effectiveWindow) queue.shift();
    if (i >= effectiveWindow - 1) selected.add(gramHashes[queue[0]!]!);
  }
  return [...selected];
}

/** 相似度计算可接受的指纹集合形态。 */
export type FingerprintSet = readonly number[] | ReadonlySet<number>;

/** 把数组形态的指纹转成集合（已是集合则原样返回）。 */
function toFingerprintSet(value: FingerprintSet): ReadonlySet<number> {
  return value instanceof Set ? value : new Set(value);
}

/**
 * 两个指纹集合的 Jaccard 相似度：|A ∩ B| / |A ∪ B|。
 *
 * 任一侧为空集合时返回 0（而不是 1）：空指纹代表「代码为空/过短，无法
 * 比较」，若返回 1 会让所有空提交互判 100% 相似，制造大量假线索。
 * 计算时遍历较小集合，复杂度 O(min(|A|, |B|))。
 */
export function similarity(a: FingerprintSet, b: FingerprintSet): number {
  const setA = toFingerprintSet(a);
  const setB = toFingerprintSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let shared = 0;
  for (const value of small) {
    if (large.has(value)) shared++;
  }
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** 参与相似度计算的提交（由查询层或测试直接构造）。 */
export interface SimilarityCandidate {
  /** 对外提交标识（`submissions.public_id`）。 */
  submission_id: string;
  user_id: string;
  problem_id: string;
  language: string;
  /** 源代码；`null`/空串代表无法比较（会被跳过）。 */
  code: string | null;
  /** 可选的提交时间（ISO 8601），用于确定 A/B 先后与展示。 */
  created_at?: string | null;
  /** 可选的提交者用户名，仅用于展示。 */
  username?: string | null;
}

/** 一对高度相似的提交。 */
export interface SimilarSubmissionPair {
  /** 较早提交的一方（`created_at` 缺失时按提交标识排序）。 */
  submission_a_id: string;
  user_a_id: string;
  username_a: string | null;
  submitted_at_a: string | null;
  submission_b_id: string;
  user_b_id: string;
  username_b: string | null;
  submitted_at_b: string | null;
  problem_id: string;
  language: string;
  /** Jaccard 相似度，保留 4 位小数；阈值比较使用未舍入的原值。 */
  similarity: number;
  /** 公共指纹数 / 两侧指纹数：供人工判断证据强度。 */
  shared_fingerprints: number;
  fingerprint_count_a: number;
  fingerprint_count_b: number;
}

/** `detectSimilarPairs()` 的可选项。 */
export interface DetectSimilarPairsOptions {
  /** 相似度阈值，取值 (0, 1]，默认 0.8。 */
  threshold?: number;
  /** 返回的对数上限，默认 50；超出部分按相似度降序截断。 */
  limit?: number;
  /** k-gram 长度，默认 5。 */
  k?: number;
  /** winnowing 窗口，默认 4。 */
  window?: number;
  /** 单份提交参与分析的 token 上限，默认 6000。 */
  maxTokens?: number;
  /** 是否跳过「同一用户的两次提交」配对，默认 true。 */
  skipSameUser?: boolean;
}

/** 纯函数检测结果（含统计信息）。 */
interface DetectSimilarPairsResult {
  pairs: SimilarSubmissionPair[];
  /** 命中阈值的总对数（未受 limit 截断）。 */
  total: number;
  /** 参与比较的分桶数（题目 × 语言）。 */
  buckets: number;
}

/** 解析并校验阈值。 */
function resolveThreshold(threshold: number | undefined): number {
  if (threshold === undefined) return DEFAULT_SIMILARITY_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new BadRequestError("threshold 必须为大于 0 且不超过 1 的小数");
  }
  return threshold;
}

/** 解析并对齐 limit（0 与负数视为无意义输入，交由调用方校验）。 */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAIR_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new BadRequestError("limit 必须为不小于 1 的整数");
  }
  return Math.min(limit, MAX_SIMILAR_PAIR_LIMIT);
}

/** 保留 4 位小数，避免浮点尾数泄漏到 API 响应。 */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** 分桶键：同一题目 + 同一语言才有比较意义。 */
function bucketKey(candidate: SimilarityCandidate): string {
  return `${candidate.problem_id}\u0000${candidate.language}`;
}

/** 按「较早提交在前」的确定性顺序排列一对候选。 */
function orderPair(
  left: SimilarityCandidate,
  right: SimilarityCandidate,
): [SimilarityCandidate, SimilarityCandidate] {
  const leftAt = left.created_at ?? "";
  const rightAt = right.created_at ?? "";
  if (leftAt !== rightAt) {
    return leftAt < rightAt ? [left, right] : [right, left];
  }
  return left.submission_id <= right.submission_id
    ? [left, right]
    : [right, left];
}

/**
 * 在给定提交集合内找出互相高度相似的提交对（纯函数，不访问数据库）。
 *
 * 流程：按「题目 × 语言」分桶 → 桶内逐对比较指纹 Jaccard → 过滤阈值 →
 * 按相似度降序排序 → 截断到 `limit`。
 *
 * 两点工程取舍：
 * - 分桶而非全量对比：跨题目/跨语言的比较没有意义，分桶同时把 O(n²) 的
 *   常数压下来（n 是最大桶的规模而不是全部候选数）。
 * - 先用指纹数量上界剪枝：Jaccard ≤ min(|A|, |B|) / max(|A|, |B|)，长度
 *   差异过大的对直接跳过，省掉集合求交。
 *
 * 规模控制由调用方负责：本函数只处理已经拿到的数组，防止资源放大的职责在
 * 查询层 `findSimilarSubmissions()`（那里的 `maxSubmissions` 上限才有意义）。
 */
export function detectSimilarPairs(
  submissions: readonly SimilarityCandidate[],
  options: DetectSimilarPairsOptions = {},
): SimilarSubmissionPair[] {
  return collectSimilarPairs(submissions, options).pairs;
}

/** `detectSimilarPairs()` 的带统计实现（服务层复用以生成响应元信息）。 */
function collectSimilarPairs(
  submissions: readonly SimilarityCandidate[],
  options: DetectSimilarPairsOptions = {},
): DetectSimilarPairsResult {
  const threshold = resolveThreshold(options.threshold);
  const limit = resolveLimit(options.limit);
  const k = options.k ?? DEFAULT_K;
  const window = options.window ?? DEFAULT_WINDOW;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const skipSameUser = options.skipSameUser ?? true;

  interface Prepared {
    candidate: SimilarityCandidate;
    tokens: string[];
    prints: ReadonlySet<number>;
  }

  const buckets = new Map<string, Prepared[]>();
  for (const candidate of submissions) {
    const tokens = normalizeCode(candidate.code, candidate.language);
    if (tokens.length === 0) continue;
    const sliced = tokens.length > maxTokens
      ? tokens.slice(0, maxTokens)
      : tokens;
    const prints = new Set(fingerprint(sliced, k, window));
    if (prints.size === 0) continue;
    const key = bucketKey(candidate);
    const bucket = buckets.get(key);
    const prepared: Prepared = { candidate, tokens: sliced, prints };
    if (bucket) bucket.push(prepared);
    else buckets.set(key, [prepared]);
  }

  const found: SimilarSubmissionPair[] = [];
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const left = bucket[i]!;
        const right = bucket[j]!;
        if (
          skipSameUser && left.candidate.user_id === right.candidate.user_id
        ) {
          continue;
        }
        const smaller = Math.min(left.prints.size, right.prints.size);
        const larger = Math.max(left.prints.size, right.prints.size);
        if (smaller / larger < threshold) continue;
        const shared = countShared(left.prints, right.prints);
        const score = similarityFromCounts(
          shared,
          left.prints.size,
          right.prints.size,
        );
        if (score < threshold) continue;
        const [first, second] = orderPair(left.candidate, right.candidate);
        const firstPrints = first === left.candidate ? left : right;
        const secondPrints = first === left.candidate ? right : left;
        found.push({
          submission_a_id: first.submission_id,
          user_a_id: first.user_id,
          username_a: first.username ?? null,
          submitted_at_a: first.created_at ?? null,
          submission_b_id: second.submission_id,
          user_b_id: second.user_id,
          username_b: second.username ?? null,
          submitted_at_b: second.created_at ?? null,
          problem_id: first.problem_id,
          language: first.language,
          similarity: round4(score),
          shared_fingerprints: shared,
          fingerprint_count_a: firstPrints.prints.size,
          fingerprint_count_b: secondPrints.prints.size,
        });
      }
    }
  }

  found.sort((a, b) =>
    b.similarity - a.similarity ||
    a.submission_a_id.localeCompare(b.submission_a_id) ||
    a.submission_b_id.localeCompare(b.submission_b_id)
  );

  return {
    pairs: found.slice(0, limit),
    total: found.length,
    buckets: buckets.size,
  };
}

/** 统计两个指纹集合的交集大小（遍历较小集合）。 */
function countShared(
  a: ReadonlySet<number>,
  b: ReadonlySet<number>,
): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const value of small) {
    if (large.has(value)) shared++;
  }
  return shared;
}

/** 由交集大小与两侧规模还原 Jaccard（避免二次求交）。 */
function similarityFromCounts(
  shared: number,
  sizeA: number,
  sizeB: number,
): number {
  const union = sizeA + sizeB - shared;
  return union === 0 ? 0 : shared / union;
}

/** `findSimilarSubmissions()` 的可选项。 */
export interface FindSimilarSubmissionsOptions {
  /** 相似度阈值，取值 (0, 1]，默认 0.8。 */
  threshold?: number;
  /** 返回的对数上限，默认 50，硬上限 200。 */
  limit?: number;
  /** 仅分析该题目（内部 UUID，由路由层解析标识）；不传表示整个竞赛。 */
  problemId?: string;
  /**
   * 参与计算的提交数上限，默认 200（见 DEFAULT_MAX_SIMILARITY_SUBMISSIONS
   * 的实测依据）；超出即报错而不是静默截断。
   */
  maxSubmissions?: number;
  /** k-gram 长度，默认 5。 */
  k?: number;
  /** winnowing 窗口，默认 4。 */
  window?: number;
}

/** `findSimilarSubmissions()` 的返回值。 */
export interface ContestSimilarSubmissionsResult {
  /** 按相似度降序的相似提交对。 */
  data: SimilarSubmissionPair[];
  /** 命中阈值的总对数（未受 limit 截断）。 */
  total: number;
  /** 是否因 limit 截断。 */
  truncated: boolean;
  /** 实际参与计算的提交数。 */
  candidates: number;
  /** 实际参与比较的分桶数（题目 × 语言）。 */
  buckets: number;
  /** 生效的阈值。 */
  threshold: number;
  /** 本次生效的返回对数上限。 */
  limit: number;
  /** 本次生效的提交数上限。 */
  max_submissions: number;
}

/**
 * 查询某场竞赛内互相高度相似的提交对。
 *
 * ## 取数口径
 *
 * 只取「普通代码提交」：`status = 'finished'`（评测终态，排除排队中/失败的
 * 噪声）、`artifact_storage_url IS NULL`（artifact 提交的 `code` 恒为空串，
 * 是产物而非源码，纳入只会产生空指纹）、代码去除空白后非空。
 * 同时用 SQL `substr` 只取源码前若干字符，避免把整场竞赛的代码都读进内存。
 *
 * ## 规模限制（为什么报错而不是截断）
 *
 * 相似度检测是 O(n²) 的逐对比较，必须给规模设上限。超限时**抛
 * BadRequestError**（附 `candidates` / `max_submissions` 与缩小范围的建议），
 * 而不是静默只算前 N 条：静默截断会让管理员把「没算到」误读成「没有相似
 * 提交」，而漏检在防作弊场景里的代价远高于一次明确报错。需要覆盖大场次时，
 * 用 `problemId` 逐题分析即可把规模降到上限内（默认上限的实测依据见
 * DEFAULT_MAX_SIMILARITY_SUBMISSIONS）。
 *
 * @param contestId 竞赛内部 UUID（路由层已解析标识）。
 * @param options 阈值、条数上限、题目过滤与规模上限。
 * @throws BadRequestError 参数非法，或候选提交数超过 `maxSubmissions`。
 * @throws NotFoundError 竞赛不存在。
 */
export async function findSimilarSubmissions(
  contestId: string,
  options: FindSimilarSubmissionsOptions = {},
): Promise<ContestSimilarSubmissionsResult> {
  await assertContestExists(contestId);
  const threshold = resolveThreshold(options.threshold);
  const limit = resolveLimit(options.limit);
  const maxSubmissions = Math.max(
    2,
    Math.floor(options.maxSubmissions ?? DEFAULT_MAX_SIMILARITY_SUBMISSIONS),
  );
  const conditions = [
    eq(submissions.contest_id, contestId),
    eq(submissions.status, "finished"),
    isNull(submissions.artifact_storage_url),
    // 空代码 / 纯空白代码：不能用 `length(btrim(code)) > 0`——`btrim()` 默认
    // 只去空格，`"\n"`、`"\t"` 会被判为「有代码」，凭空占用规模额度。
    sql`${submissions.code} !~ '^[[:space:]]*$'`,
  ];
  if (options.problemId) {
    conditions.push(eq(submissions.problem_id, options.problemId));
  }
  const db = getDb();
  const rows = await db.select({
    submission_id: submissions.public_id,
    user_id: submissions.user_id,
    username: users.username,
    problem_id: submissions.problem_id,
    language: submissions.language,
    created_at: submissions.created_at,
    // 只取前 DEFAULT_MAX_RAW_CODE_CHARS 个字符：相似度是线索发现，
    // 结构特征在开头已充分体现，避免整场代码全量入内存。
    code: sql<
      string
    >`substr(${submissions.code}, 1, ${DEFAULT_MAX_RAW_CODE_CHARS})`,
  }).from(submissions)
    .innerJoin(users, eq(users.id, submissions.user_id))
    .where(and(...conditions))
    .orderBy(asc(submissions.created_at))
    // 多取 1 条用于判定超限：比「先 COUNT 再查询」少一次往返，也没有竞态。
    .limit(maxSubmissions + 1);

  if (rows.length > maxSubmissions) {
    throw new BadRequestError(
      `候选提交数超过相似度检测上限（${maxSubmissions}），请使用 problem_id 逐题分析以缩小范围`,
      "SIMILARITY_SCALE_EXCEEDED",
      { candidates: rows.length, max_submissions: maxSubmissions },
    );
  }

  const candidates: SimilarityCandidate[] = rows.map((row) => ({
    submission_id: row.submission_id,
    user_id: row.user_id,
    username: row.username,
    problem_id: row.problem_id,
    language: row.language,
    created_at: row.created_at,
    code: row.code,
  }));
  const result = collectSimilarPairs(candidates, {
    threshold,
    limit,
    k: options.k,
    window: options.window,
  });
  return {
    data: result.pairs,
    total: result.total,
    truncated: result.total > result.pairs.length,
    candidates: candidates.length,
    buckets: result.buckets,
    threshold,
    limit,
    max_submissions: maxSubmissions,
  };
}
