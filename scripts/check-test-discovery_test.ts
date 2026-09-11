/**
 * 测试文件可发现性检查的单元测试。
 *
 * 这些用例覆盖两类失败：
 * 1. 判定函数对文件名模式的处理（含不该匹配的负例）；
 * 2. 端到端扫描能真正报出「含 Deno.test 但不被发现」的文件（而不是空转）。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import {
  checkTestDiscovery,
  findUndiscoverableTests,
  isDiscoverable,
} from "./check-test-discovery.ts";

Deno.test("isDiscoverable: 接受 Deno 运行器的常见命名", () => {
  for (
    const name of [
      "health.test.ts",
      "health_test.ts",
      "noj-cli.test.ts",
      "foo_test_extra.ts",
      "test.ts",
      "a.test.tsx",
    ]
  ) {
    assertEquals(isDiscoverable(name), true, `应可发现：${name}`);
  }
});

Deno.test("isDiscoverable: 拒绝不会被发现的命名", () => {
  for (const name of ["health.ts", "helper.ts", "foo-test.ts", "cases.ts"]) {
    assertEquals(isDiscoverable(name), false, `不应可发现：${name}`);
  }
});

Deno.test("check-test-discovery: 仓库当前无可发现性问题", async () => {
  const found = await checkTestDiscovery(".");
  assertEquals(
    found,
    [],
    `不应存在不可发现的测试文件，实际：${
      found.map((f) => `${f.file}(${f.testCount})`).join(", ")
    }`,
  );
});

Deno.test("check-test-discovery: 能报出夹具中的不可发现测试（非空转）", async () => {
  const root = await Deno.makeTempDir({ prefix: "noj-discovery-" });
  try {
    await Deno.mkdir(`${root}/mod/tests`, { recursive: true });
    // ① 含顶层 Deno.test 且命名不可发现 → 必须报出
    await Deno.writeTextFile(
      `${root}/mod/tests/undiscovered.ts`,
      `Deno.test("x", () => {});\n`,
    );
    // ② 命名合规 → 不报
    await Deno.writeTextFile(
      `${root}/mod/tests/ok.test.ts`,
      `Deno.test("y", () => {});\n`,
    );
    // ③ 不可发现但**没有** Deno.test（普通模块）→ 不报
    await Deno.writeTextFile(
      `${root}/mod/tests/plain.ts`,
      `export const x = 1;\n`,
    );
    // ④ 测试工厂：Deno.test 在导出函数体内 → 不报（它不是测试文件）
    await Deno.writeTextFile(
      `${root}/mod/tests/factory.ts`,
      `export function e2eTest(name: string, fn: () => void) {\n` +
        `  Deno.test({ name, fn });\n}\n`,
    );
    // ⑤ 不在扫描范围的目录 → 不报
    await Deno.mkdir(`${root}/mod/node_modules`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/mod/node_modules/vendored.ts`,
      `Deno.test("z", () => {});\n`,
    );

    const found = await findUndiscoverableTests(root, "mod");
    assertEquals(found.length, 1, `应只报 1 个，实际 ${JSON.stringify(found)}`);
    assertEquals(found[0]!.file, "mod/tests/undiscovered.ts");
    assertEquals(found[0]!.testCount, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
