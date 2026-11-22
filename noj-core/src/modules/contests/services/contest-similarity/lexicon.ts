// 纯数据：各语言关键字、内置标识符、保护 token 与语言注释/关键字轮廓表。

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
export const DEFAULT_K = 5;

/**
 * winnowing 窗口 w：每个长度为 w 的 k-gram 哈希窗口保留一个最小值。
 * 取 4 的理由：论文经验值与 MOSS 同类工具常用区间（4-7）的下沿；
 * w 越大指纹越稀疏、抗噪越强但灵敏度越低。w=4 时保证「任意长度
 * ≥ k + w - 1 = 8 个 token 的公共片段必定产生至少一个公共指纹」。
 */
export const DEFAULT_WINDOW = 4;

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
export const DEFAULT_MAX_SIMILARITY_SUBMISSIONS = 200;

/** 默认返回的相似对上限。 */
export const DEFAULT_PAIR_LIMIT = 50;

/**
 * 单份提交参与分析的源码字符上限。
 * 理由：题面允许 100KB 代码，但结构特征在前 2 万字符内已充分体现；截断可把
 * 「内存 × CPU」同时压住（查询层还会用 SQL substr 避免把整份代码取回内存）。
 * 截断点可能落在 token 中间，代价是丢掉最后一个不完整 token，可忽略。
 */
export const DEFAULT_MAX_RAW_CODE_CHARS = 20_000;

/** 单份提交参与分析的 token 上限，作用同 DEFAULT_MAX_RAW_CODE_CHARS。 */
export const DEFAULT_MAX_TOKENS = 6_000;

/**
 * 可比较代码的**原始长度**下限（SQL 侧过滤用）。
 *
 * 判定依据：一次完整公共片段至少需要 `k + window - 1 = 8` 个 token 才能留下指纹
 * （见文件头的 winnowing 说明）。一个 token 在源码里通常 ≥2 字符，故 32 字符是
 * 「8 个 token」的保守下界——它只会排除 `print(1)`、`x = 1` 这类调试残留，
 * 不会排除任何结构完整的合法解法。
 *
 * 该过滤的意义：候选上限按**可比较提交**计数，而不是按原始行数计数，
 * 从而消除「额度被垃圾提交占满 → 真雷同对被挤出窗口 → 却报告没有雷同」的静默漏报。
 */
export const MIN_PAIRABLE_CODE_CHARS = 32;

/** 字符串字面量的占位 token；加入保护集合，不参与标识符改写。 */
export const STRING_TOKEN = "__noj_str__";

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
export interface LanguageProfile {
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
export function resolveProfile(
  language: string | null | undefined,
): LanguageProfile {
  const key = (language ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const profileName = LANGUAGE_ALIASES[key];
  return LANGUAGE_PROFILES[profileName ?? "c-like"] ??
    LANGUAGE_PROFILES["c-like"]!;
}
