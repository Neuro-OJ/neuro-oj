import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  parseEnvFile,
  readEnvFile,
  serializeEnvFile,
  writeEnvFileAtomic,
} from "./env-file.ts";

/** 创建隔离临时目录。 */
async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "noj-env-file-" });
}

/** 列出目录内条目名（排序，便于断言残留）。 */
async function listNames(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names.sort();
}

Deno.test("env-file: 解析基本键值，忽略注释与空行", () => {
  const entries = parseEnvFile("# 头注释\n\nA=1\n   \n#B=2\nC=\n");
  assertEquals(entries.get("A"), "1");
  assertEquals(entries.get("C"), "");
  // 注释行（即使含 `=`）不产生键
  assertEquals(entries.has("B"), false);
  assertEquals(entries.has("#B"), false);
  assertEquals(entries.size, 2);
});

Deno.test("env-file: 只在首个 = 处分割，值内 = 保留", () => {
  const entries = parseEnvFile(
    "DATABASE_URL=postgres://u:p@h:5432/db?sslmode=disable\n",
  );
  assertEquals(
    entries.get("DATABASE_URL"),
    "postgres://u:p@h:5432/db?sslmode=disable",
  );
});

Deno.test("env-file: 成对引号剥一层（单/双），不匹配则原样保留", () => {
  const entries = parseEnvFile(
    [
      'D="hello world"',
      "S='single'",
      "MISMATCH=\"abc'",
      'UNTERMINATED="abc',
      'EMPTY=""',
      "SINGLE=a'b'",
      "",
    ].join("\n"),
  );
  assertEquals(entries.get("D"), "hello world");
  assertEquals(entries.get("S"), "single");
  assertEquals(entries.get("MISMATCH"), "\"abc'");
  assertEquals(entries.get("UNTERMINATED"), '"abc');
  assertEquals(entries.get("EMPTY"), "");
  assertEquals(entries.get("SINGLE"), "a'b'");
});

Deno.test("env-file: CRLF 与行尾空白不污染值", () => {
  const entries = parseEnvFile('A=1\r\nB="x y"\r\nC=spaced   \r\n');
  assertEquals(entries.get("A"), "1");
  assertEquals(entries.get("B"), "x y");
  assertEquals(entries.get("C"), "spaced");
});

Deno.test("env-file: 键必须在行首且紧随 =（前缀匹配），重复键取首个", () => {
  const entries = parseEnvFile(
    "#KEY=commented\nXKEY=nope\nKEY=first\nKEY=second\n KEY=indented\n",
  );
  assertEquals(entries.get("KEY"), "first");
  assertEquals(entries.get("XKEY"), "nope");
  // 行首有空格的不是 KEY
  assertEquals(entries.has(" KEY"), true);
});

Deno.test("env-file: serialize 保留注释/空行/顺序，就地更新匹配键", () => {
  const original = "# 头部\n\nA=1\n# 中部\nB=2\n\n# 尾部\n";
  const out = serializeEnvFile(new Map([["A", "9"]]), original);
  assertEquals(out, "# 头部\n\nA=9\n# 中部\nB=2\n\n# 尾部\n");
});

Deno.test("env-file: serialize 追加新键到末尾（保留结尾换行）", () => {
  const original = "A=1\n# c\n";
  const out = serializeEnvFile(new Map([["A", "1"], ["B", "2"]]), original);
  assertEquals(out, "A=1\n# c\nB=2\n");
});

Deno.test("env-file: serialize 替换每一处重复行且不追加", () => {
  const out = serializeEnvFile(new Map([["A", "9"]]), "A=1\nA=2\nB=3\n");
  assertEquals(out, "A=9\nA=9\nB=3\n");
});

Deno.test("env-file: serialize 不碰注释行与内嵌键，改为追加", () => {
  const out = serializeEnvFile(new Map([["A", "9"]]), "#A=1\nXA=2\n");
  assertEquals(out, "#A=1\nXA=2\nA=9\n");
});

Deno.test("env-file: serialize 空原文本生成带尾换行的行", () => {
  assertEquals(serializeEnvFile(new Map([["A", "1"]]), ""), "A=1\n");
  assertEquals(serializeEnvFile(new Map(), ""), "");
});

Deno.test("env-file: serialize 对无改动输入逐字节幂等", () => {
  const original = '# c\nA=1\nB="q"\n';
  const out = serializeEnvFile(parseEnvFile(original), original);
  assertEquals(out, original);
});

Deno.test("env-file: serialize 未改动的行保留空白/CRLF，改动行重写为规范行", () => {
  const original = 'A=1   \r\nB="q"\r\nC=3\r\n';
  // 全未改动 → 逐字节保留（CRLF 与尾随空白都不动）
  assertEquals(serializeEnvFile(parseEnvFile(original), original), original);
  // 改动的行规范化为 key=value（去尾空白、去引号），未改动的 C 行保持 CRLF
  assertEquals(
    serializeEnvFile(new Map([["A", "2"], ["B", "z"], ["C", "3"]]), original),
    "A=2\nB=z\nC=3\r\n",
  );
});

Deno.test("env-file: serialize 值内的 = 与空值原样写出", () => {
  const out = serializeEnvFile(
    new Map([["URL", "postgres://h/db?a=b"], ["E", ""]]),
    "URL=x\n",
  );
  assertEquals(out, "URL=postgres://h/db?a=b\nE=\n");
});

Deno.test("env-file: readEnvFile 读取现存文件，空文件返回空 Map", async () => {
  const dir = await makeTempDir();
  try {
    const path = join(dir, ".env.prod");
    await Deno.writeTextFile(path, "# c\nA=1\n");
    assertEquals((await readEnvFile(path)).get("A"), "1");
    await Deno.writeTextFile(path, "");
    assertEquals((await readEnvFile(path)).size, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("env-file: readEnvFile 文件缺失时抛出清晰错误", async () => {
  const dir = await makeTempDir();
  try {
    const path = join(dir, "missing.env");
    await assertRejects(
      () => readEnvFile(path),
      Error,
      "配置文件不存在",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("env-file: writeEnvFileAtomic 新建文件权限 600 且可回读", async () => {
  const dir = await makeTempDir();
  try {
    const path = join(dir, ".env.prod");
    await writeEnvFileAtomic(
      path,
      new Map([["A", "1"], ["B", "two words"]]),
    );
    assertEquals(
      (await Deno.stat(path)).mode! & 0o777,
      0o600,
    );
    const entries = await readEnvFile(path);
    assertEquals(entries.get("A"), "1");
    assertEquals(entries.get("B"), "two words");
    // 无临时文件残留
    assertEquals(await listNames(dir), [".env.prod"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("env-file: writeEnvFileAtomic 就地更新并保留注释/多余键", async () => {
  const dir = await makeTempDir();
  try {
    const path = join(dir, ".env.prod");
    await Deno.writeTextFile(path, "# 头\nA=1\nKEEP=me\n");
    await writeEnvFileAtomic(path, new Map([["A", "2"], ["NEW", "3"]]));
    const text = await Deno.readTextFile(path);
    assertEquals(text, "# 头\nA=2\nKEEP=me\nNEW=3\n");
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals(await listNames(dir), [".env.prod"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("env-file: writeEnvFileAtomic 失败时报错、不残留临时文件", async () => {
  const dir = await makeTempDir();
  try {
    // 目标父目录不存在 → 临时文件创建失败
    await assertRejects(() =>
      writeEnvFileAtomic(join(dir, "nope", ".env.prod"), new Map([["A", "1"]]))
    );
    assertEquals(await listNames(dir), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("env-file: writeEnvFileAtomic 目标是目录时报错且不残留", async () => {
  const dir = await makeTempDir();
  try {
    const blocked = join(dir, "blocked");
    await Deno.mkdir(blocked);
    await assertRejects(() =>
      writeEnvFileAtomic(blocked, new Map([["A", "1"]]))
    );
    assertEquals(await listNames(dir), ["blocked"]);
    assertEquals(await listNames(blocked), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
