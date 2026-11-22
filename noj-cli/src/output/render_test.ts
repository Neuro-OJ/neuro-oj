import { assertEquals } from "@std/assert";
import {
  displayWidth,
  emitHuman,
  emitJson,
  isJsonMode,
  renderStatus,
  renderTable,
} from "./render.ts";

/** 记录一次调用的 stdout / stderr 片段，供逐字节断言输出**去向**。 */
function capture(extra: { jsonMode?: boolean } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (s: string) => stdout.push(s),
      stderr: (s: string) => stderr.push(s),
      ...extra,
    },
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}

// ---------- emitJson：机器通道只允许合法 JSON ----------

Deno.test("emitJson: 只输出 indent=2 的 JSON 加恰好一个换行，无装饰", () => {
  const value = { name: "deploy", flags: ["--json", null, true], n: 3 };
  const c = capture();
  emitJson(value, c.io);
  // 逐字节等于 JSON.stringify 的规范形式 + 单个换行
  assertEquals(c.out(), JSON.stringify(value, null, 2) + "\n");
  // 恰好一个换行：不以两个换行结尾
  assertEquals(c.out().endsWith("\n\n"), false);
  // 机器通道不含 ANSI/前缀，也不写 stderr
  assertEquals(c.out().includes("\x1b["), false);
  assertEquals(c.err(), "");
  // 可被 JSON.parse 直接消费，且语义无损
  assertEquals(JSON.parse(c.out()), value);
});

Deno.test("emitJson: 顶层 undefined 退化为 null，仍是合法 JSON", () => {
  const c = capture();
  emitJson(undefined, c.io);
  assertEquals(c.out(), "null\n");
  assertEquals(JSON.parse(c.out()), null);
});

Deno.test("emitJson: 数组与标量同样逐字节合法", () => {
  for (const value of [[1, 2, 3], "text", 0, false, null]) {
    const c = capture();
    emitJson(value, c.io);
    assertEquals(c.out(), JSON.stringify(value, null, 2) + "\n");
    assertEquals(JSON.parse(c.out()), value);
  }
});

// ---------- emitHuman：JSON 模式改道 stderr ----------

Deno.test("emitHuman: 非 JSON 模式写 stdout，不触碰 stderr", () => {
  const c = capture({ jsonMode: false });
  emitHuman("部署完成\n", c.io);
  assertEquals(c.out(), "部署完成\n");
  assertEquals(c.err(), "");
});

Deno.test("emitHuman: JSON 模式绝不写 stdout，改走 stderr", () => {
  const c = capture({ jsonMode: true });
  emitHuman("正在启动容器…\n", c.io);
  assertEquals(c.out(), "", "JSON 模式 stdout 必须保持为空");
  assertEquals(c.err(), "正在启动容器…\n");
});

Deno.test("emitHuman: 缺省 jsonMode 视为非 JSON 模式（写 stdout）", () => {
  const c = capture();
  emitHuman("hello", c.io);
  assertEquals(c.out(), "hello");
  assertEquals(c.err(), "");
});

// ---------- isJsonMode：只认独立 --json 旗标 ----------

Deno.test("isJsonMode: 独立 --json 命中（含混在其它参数中）", () => {
  assertEquals(isJsonMode(["--json"]), true);
  assertEquals(
    isJsonMode(["deploy", "up", "--json", "--dir", "/opt/noj"]),
    true,
  );
  assertEquals(isJsonMode(["--dir", "/opt/noj", "--json"]), true);
  assertEquals(isJsonMode(["--json", "--json"]), true);
});

Deno.test("isJsonMode: 未出现 --json 一律为假", () => {
  assertEquals(isJsonMode([]), false);
  assertEquals(isJsonMode(["deploy", "up"]), false);
  assertEquals(isJsonMode(["status"]), false);
  assertEquals(isJsonMode(["--jsonx"]), false);
  assertEquals(isJsonMode(["-j"]), false);
  assertEquals(isJsonMode(["--JSON"]), false, "大小写敏感");
});

Deno.test("isJsonMode: --json=... 形式不支持（有意决策，须显式拒绝）", () => {
  // `--json` 在本仓既有解析里就是裸旗标；发明 `=值` 形式会引入
  // 「--json=false 反而开了 JSON」这类静默误判，故一律不识别。
  assertEquals(isJsonMode(["--json=true"]), false);
  assertEquals(isJsonMode(["--json=false"]), false);
  assertEquals(isJsonMode(["--json=1"]), false);
});

// ---------- 回归：混合序列后 stdout 仍可被 jq/JSON.parse 消费 ----------

Deno.test("回归: JSON 模式下人类日志 + JSON 混排，stdout 仍是纯 JSON", () => {
  const c = capture({ jsonMode: true });
  emitHuman("读取配置…\n", c.io);
  emitHuman("启动服务…\n", c.io);
  emitJson({ state: "running", services: ["core", "ui"] }, c.io);
  emitHuman("完成\n", c.io);
  const expected = { state: "running", services: ["core", "ui"] };
  // stdout 只含那一个 JSON 文档
  assertEquals(JSON.parse(c.out()), expected);
  assertEquals(c.out(), JSON.stringify(expected, null, 2) + "\n");
  // 人类文本全部落在 stderr，且顺序保留
  assertEquals(c.err(), "读取配置…\n启动服务…\n完成\n");
});

// ---------- 真实进程回归：不经注入，直接观察进程级 stdout/stderr ----------

/** 子进程驱动脚本：只用公开 API，JSON 模式由 isJsonMode 现场推出。 */
const DRIVER = [
  "const { emitHuman, emitJson, isJsonMode } = await import(Deno.args[0]);",
  "const jsonMode = isJsonMode(Deno.args.slice(1));",
  'emitHuman("human-log\\n", { jsonMode });',
  "emitJson({ ok: true, jsonMode });",
].join("\n");

/** 在真实子进程里跑驱动脚本，捕获进程级 stdout/stderr 字节。 */
async function runDriver(
  jsonMode: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const dir = await Deno.makeTempDir({ prefix: "noj-render-" });
  try {
    const driverPath = dir + "/driver.ts";
    await Deno.writeTextFile(driverPath, DRIVER);
    const renderUrl = new URL("./render.ts", import.meta.url).href;
    const args = ["run", "-A", "--quiet", driverPath, renderUrl];
    if (jsonMode) args.push("--json");
    const result = await new Deno.Command(Deno.execPath(), {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const decoder = new TextDecoder();
    return {
      code: result.code,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("真实进程: --json 时 stdout 逐字节为合法 JSON，人类日志在 stderr", async () => {
  const r = await runDriver(true);
  assertEquals(r.code, 0, r.stderr);
  const expected = { ok: true, jsonMode: true };
  assertEquals(r.stdout, JSON.stringify(expected, null, 2) + "\n");
  assertEquals(JSON.parse(r.stdout), expected);
  assertEquals(r.stderr.includes("human-log"), true, "人类日志应改道 stderr");
});

Deno.test("真实进程: 非 --json 时人类日志与 JSON 同走 stdout，stderr 干净", async () => {
  const r = await runDriver(false);
  assertEquals(r.code, 0, r.stderr);
  assertEquals(r.stdout.startsWith("human-log"), true);
  assertEquals(r.stdout.includes('"ok": true'), true);
  assertEquals(r.stderr, "");
});

// ---------- Task 8：表格渲染（品牌排版） ----------

Deno.test("displayWidth: ASCII 记 1 列、CJK 全角记 2 列、组合记号 0 列", () => {
  assertEquals(displayWidth("abc"), 3);
  assertEquals(displayWidth(""), 0);
  assertEquals(displayWidth("中文"), 4);
  assertEquals(displayWidth("中a"), 3);
  assertEquals(displayWidth("，。！"), 6, "全角标点同样是 2 列");
  assertEquals(displayWidth("A\u0301"), 1, "组合变音符不占列");
  assertEquals(displayWidth("\x1b[32m"), 0, "ANSI 转义不占列");
});

Deno.test("renderTable: 列按最宽单元格对齐（含 CJK，按显示宽度）", () => {
  const out = renderTable([["名称", "状态"], ["核心", "运行中"]]);
  const lines = out.split("\n").filter((l: string) => l !== "");
  assertEquals(lines.length, 2);
  // 未 trim 的每行显示宽度一致（尾随填充也在内）
  assertEquals(displayWidth(lines[0]!), displayWidth(lines[1]!));
  // 第二列起点在**显示列**上对齐：每行前导「单元格 + 间距」都是 6 列
  for (const line of lines) {
    const idx = line.indexOf("  ");
    assertEquals(idx >= 0, true);
    assertEquals(
      displayWidth(line.slice(0, idx + 2)),
      6,
      `列起点未对齐: ${line}`,
    );
  }
  // 若按 UTF-16 长度 padEnd（错误实现），"核心" 会被填成 2 个空格而错位；
  // 这里显式断言没有那 2 个多余空格。
  assertEquals(lines[1]!.startsWith("核心  运行中"), true);
});

Deno.test("renderTable: 纯 ASCII 表逐字节正确", () => {
  const out = renderTable([["name", "status"], ["core", "running"]]);
  assertEquals(out, "name  status \ncore  running\n");
});

Deno.test("renderTable: maxWidth 约束下每一行的显示宽度都 ≤ 该值", () => {
  const rows = [
    ["组件", "状态", "备注"],
    ["noj-core", "running", "正常"],
    ["noj-ui", "exited", "意外退出，详见日志"],
  ];
  const wide = renderTable(rows);
  const wideMax = Math.max(
    ...wide.split("\n").map((l: string) => displayWidth(l)),
  );
  for (const maxWidth of [wideMax, 40, 24, 12, 6]) {
    const out = renderTable(rows, { maxWidth });
    const lines = out.split("\n").filter((l: string) => l !== "");
    assertEquals(lines.length >= 3, true);
    for (const line of lines) {
      assertEquals(
        displayWidth(line) <= maxWidth,
        true,
        `maxWidth=${maxWidth} 时超宽(${displayWidth(line)}): ${
          JSON.stringify(line)
        }`,
      );
    }
  }
  // 窄化确实发生了，而不是忽略 maxWidth 原样输出
  assertEquals(
    Math.max(
      ...renderTable(rows, { maxWidth: 24 }).split("\n").map(displayWidth),
    ) <
      wideMax,
    true,
  );
});

Deno.test("renderTable: 超宽单元格以 … 截断（可观测的降级标记）", () => {
  const out = renderTable([["core", "running"]], { maxWidth: 8 });
  assertEquals(out.includes("…"), true, "截断必须留下可见标记: " + out);
  for (const line of out.split("\n")) {
    assertEquals(displayWidth(line) <= 8, true);
  }
});

Deno.test("renderTable: 极窄宽度（小于最小可行宽）仍不超宽、不抛错", () => {
  const rows = [["a", "b", "c"], ["d", "e", "f"]];
  for (const maxWidth of [1, 2, 3]) {
    const out = renderTable(rows, { maxWidth });
    for (const line of out.split("\n")) {
      assertEquals(displayWidth(line) <= maxWidth, true);
    }
  }
});

Deno.test("renderTable: 空表与无列行返回空串，不抛错", () => {
  assertEquals(renderTable([]), "");
  assertEquals(renderTable([[]]), "");
  assertEquals(renderTable([], { maxWidth: 10 }), "");
  assertEquals(renderTable([[]], { maxWidth: 10 }), "");
});

Deno.test("renderTable: 行长不齐按缺列补空串，不抛错", () => {
  const out = renderTable([["a", "b"], ["c"]]);
  const lines = out.split("\n").filter((l: string) => l !== "");
  assertEquals(lines.length, 2);
  assertEquals(displayWidth(lines[0]!), displayWidth(lines[1]!));
});

Deno.test("renderTable: 单元格内换行按多行渲染，列仍对齐", () => {
  const out = renderTable([["a\nb", "c"]]);
  const lines = out.split("\n").filter((l: string) => l !== "");
  assertEquals(lines.length, 2);
  assertEquals(lines[0]!.trimEnd(), "a  c");
  assertEquals(lines[1]!.trimEnd(), "b");
});

Deno.test("renderTable: --json 模式绝不写 stdout，改道 stderr", () => {
  const c = capture({ jsonMode: true });
  renderTable([["a", "b"]], { io: c.io });
  assertEquals(c.out(), "", "JSON 模式 stdout 必须保持为空");
  assertEquals(c.err().includes("a"), true, "人类表格应改道 stderr");
});

Deno.test("renderTable: 非 JSON 模式写 stdout，不触碰 stderr", () => {
  const c = capture();
  renderTable([["a", "b"]], { io: c.io });
  assertEquals(c.out(), "a  b\n");
  assertEquals(c.err(), "");
});

Deno.test("renderTable: 空表在 --json 模式下也不写任何流", () => {
  const c = capture({ jsonMode: true });
  renderTable([], { io: c.io });
  assertEquals(c.out(), "");
  assertEquals(c.err(), "");
});

// ---------- Task 8：状态符号渲染 ----------

Deno.test("renderStatus: 四种状态符号与语义色配对", () => {
  const cases = [
    ["success", "✓ 部署完成"],
    ["warning", "! 磁盘使用率偏高"],
    ["error", "✗ 构建失败"],
    ["info", "ℹ 正在同步"],
  ] as const;
  for (const [kind, expected] of cases) {
    assertEquals(
      renderStatus(kind, expected.slice(2), { color: "never" }),
      expected + "\n",
    );
  }
});

Deno.test("renderStatus: 关色时输出中不含任何 ANSI 转义", () => {
  for (const kind of ["success", "warning", "error", "info"] as const) {
    const out = renderStatus(kind, "内容", { color: "never" });
    assertEquals(
      out.includes("\x1b["),
      false,
      `${kind} 关色仍带 ANSI: ${JSON.stringify(out)}`,
    );
  }
  // NO_COLOR 非空压过 always：实际字符串同样不得含转义
  const c = capture();
  withEnv({ NO_COLOR: "1", LOG_COLOR: undefined }, () => {
    renderStatus("error", "失败", { color: "always", io: c.io });
  });
  assertEquals(c.out().includes("\x1b["), false);
  assertEquals(c.out(), "✗ 失败\n");
});

Deno.test("renderStatus: 开色时符号被语义色包裹、正文不着色", () => {
  // 必须显式清掉 NO_COLOR（本仓/CI 环境可能预设 NO_COLOR=1，它压过 always）。
  withEnv({ NO_COLOR: undefined, LOG_COLOR: undefined }, () => {
    const out = renderStatus("error", "构建失败", { color: "always" });
    assertEquals(out.includes("\x1b["), true);
    assertEquals(out, "\x1b[31m✗\x1b[0m 构建失败\n");
    // reset 紧邻符号（"\x1b[31m" 5 字符 + 符号 1 字符）：正文不得被整行染色
    assertEquals(out.indexOf("\x1b[0m"), "\x1b[31m✗".length);
  });
});

Deno.test("renderStatus: --json 模式写 stderr 而非 stdout", () => {
  const c = capture({ jsonMode: true });
  renderStatus("success", "完成", { color: "never", io: c.io });
  assertEquals(c.out(), "");
  assertEquals(c.err(), "✓ 完成\n");
});

Deno.test("renderStatus: 多行文本只在首行带符号，其余保持缩进对齐", () => {
  const out = renderStatus("error", "第一行\n第二行", { color: "never" });
  const lines = out.trimEnd().split("\n");
  assertEquals(lines.length, 2);
  assertEquals(lines[0], "✗ 第一行");
  assertEquals(lines[1], "  第二行");
});

/** 快照并恢复给定 env（同 util/color_test.ts 做法）。 */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev = new Map(Object.keys(env).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}
