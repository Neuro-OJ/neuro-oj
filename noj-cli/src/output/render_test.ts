import { assertEquals } from "@std/assert";
import { emitHuman, emitJson, isJsonMode } from "./render.ts";

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
