/**
 * `deno compile` 导入安全门禁的自测。
 *
 * 门禁守护的是"只在生产二进制里出现"的缺陷（源码运行与单元测试都看不到），
 * 因此这里既测**真实仓库通过**，也测**违规能被抓**、以及解析器本身没失效。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  ALLOWED_NON_LITERAL,
  COMPILE_TARGET_ROOTS,
  findNonLiteralDynamicImports,
  isLiteralSpecifier,
  maskComments,
  verifyCompileSafeImports,
} from "./verify-compile-safe-imports.ts";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/** 构造一个具备全部扫描目录的临时仓库根，再放入被测文件。 */
async function makeFixtureRoot(
  files: Record<string, string> = {},
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "compile-safe-" });
  for (const targetRoot of COMPILE_TARGET_ROOTS) {
    await Deno.mkdir(`${root}/${targetRoot}`, { recursive: true });
    await Deno.writeTextFile(`${root}/${targetRoot}/index.ts`, "export {};\n");
  }
  for (const [path, content] of Object.entries(files)) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
  return root;
}

Deno.test("compile-safe-imports: 真实仓库通过且确实扫到了动态导入", () => {
  const { errors, stats } = verifyCompileSafeImports(REPO_ROOT);
  assertEquals(errors, []);
  assertEquals(stats.violations, 0);
  assert(stats.scanned_files > 100, `扫描文件数异常：${stats.scanned_files}`);
  assert(
    stats.dynamic_imports > 0,
    "扫描目录内应存在动态导入（storage factory / content-review provider），否则规则可能已失效",
  );
});

Deno.test("compile-safe-imports: 变量说明符被拦截", async () => {
  const root = await makeFixtureRoot({
    "noj-core/src/domains/system/services/bad.ts":
      `const modPath = "./email-providers/aliyun.ts";\n` +
      `const mod = await import(modPath);\n`,
  });
  try {
    const { errors, stats } = verifyCompileSafeImports(root);
    assertEquals(stats.violations, 1);
    assert(
      errors.some((e) =>
        e.includes("noj-core/src/domains/system/services/bad.ts:2")
      ),
      `错误应指向违规行：${errors.join(" | ")}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("compile-safe-imports: 字面量（含多行）动态导入放行", async () => {
  const root = await makeFixtureRoot({
    "noj-core/src/domains/system/services/ok.ts":
      `const a = await import("./email-providers/mock.ts");\n` +
      `const b: any = await import(\n  "npm:tencentcloud-sdk-nodejs-cms@^4.1.71"\n);\n` +
      `const c = await import(\`./email-providers/disabled.ts\`);\n`,
  });
  try {
    const { errors, stats } = verifyCompileSafeImports(root);
    assertEquals(errors, []);
    assertEquals(stats.violations, 0);
    assertEquals(stats.dynamic_imports, 3);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("compile-safe-imports: 测试文件不受约束", async () => {
  const root = await makeFixtureRoot({
    "noj-core/src/domains/system/tests/services/bad.test.ts":
      `const p = "./x.ts";\nawait import(p);\n`,
  });
  try {
    const { errors } = verifyCompileSafeImports(root);
    assertEquals(errors, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("compile-safe-imports: 扫描目录漂移会失败而非静默通过", async () => {
  const root = await Deno.makeTempDir({ prefix: "compile-safe-empty-" });
  try {
    const { errors } = verifyCompileSafeImports(root);
    assertEquals(errors.length, COMPILE_TARGET_ROOTS.length);
    assert(errors.every((e) => e.includes("扫描目录不存在")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("compile-safe-imports: 注释中的调用与 import.meta 不误报", () => {
  const source = `// await import(p)\n/* await import(q); */\n` +
    `const u = "https://example.com/x";\n` +
    `const meta = import.meta.dirname;\n`;
  assertEquals(findNonLiteralDynamicImports(source), []);
  assertEquals(
    maskComments(`// hidden\ncode;`),
    `${" ".repeat("// hidden".length)}\ncode;`,
  );
});

Deno.test("compile-safe-imports: isLiteralSpecifier 边界", () => {
  assert(isLiteralSpecifier(`"./a.ts"`));
  assert(isLiteralSpecifier(`'./a.ts'`));
  assert(isLiteralSpecifier("`./a.ts`"));
  assert(isLiteralSpecifier(`\n  "npm:x@^1"\n`));
  assert(!isLiteralSpecifier("`./a/${x}.ts`"));
  assert(!isLiteralSpecifier("modPath"));
  assert(!isLiteralSpecifier(`"./a.ts`));
  assert(!isLiteralSpecifier(`cond ? "./a.ts" : "./b.ts"`));
  assertEquals(Object.keys(ALLOWED_NON_LITERAL), []);
});
