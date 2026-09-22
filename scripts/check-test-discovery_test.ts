/**
 * 测试文件可发现性检查的单元测试。
 *
 * 这些用例覆盖两类失败：
 * 1. 判定函数对文件名模式的处理（含不该匹配的负例）；
 * 2. 端到端扫描能真正报出「含 Deno.test 但不被发现」的文件（而不是空转）。
 */

import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  checkTestDiscovery,
  findUndiscoverableTests,
  hasFileLevelTest,
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

Deno.test(
  "checkTestDiscovery: 扫描 noj-cli 中不可发现的测试（2026-09-21 补盲区）",
  async () => {
    // noj-cli 此前不在扫描根内，其中的不可发现测试永远不会被本门禁抓到。
    // 用夹具在 noj-cli 路径下放一个不可发现文件，验证 checkTestDiscovery 会扫描它。
    const root = await Deno.makeTempDir({ prefix: "noj-discovery-cli-" });
    try {
      await Deno.mkdir(`${root}/noj-cli/src/util`, { recursive: true });
      await Deno.writeTextFile(
        `${root}/noj-cli/src/util/undiscovered.ts`,
        `Deno.test("cli", () => {});\n`,
      );
      const found = await checkTestDiscovery(root);
      assert(
        found.some((f) => f.file === "noj-cli/src/util/undiscovered.ts"),
        `noj-cli 下的不可发现测试必须被报出，实际：${JSON.stringify(found)}`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

// ── 2026-09-21 修复：缩进块里的 Deno.test 逃逸 ──
// 触发条件：Deno.test 位于 for/if/try 等控制流块内（非函数体）。
Deno.test("hasFileLevelTest: 识别控制流块内的 Deno.test", () => {
  // 顶层调用
  assert(hasFileLevelTest(`Deno.test("a", () => {});`));
  // for 块内（缩进）——此前被"剔除所有缩进行"的启发式漏掉
  assert(
    hasFileLevelTest(
      `for (const c of ["a", "b"]) {\n  Deno.test(\`case \${c}\`, () => {});\n}\n`,
    ),
  );
  // if 块内
  assert(
    hasFileLevelTest(`if (x) {\n  Deno.test("a", () => {});\n}\n`),
  );
  // 函数体内（测试工厂）→ 不算文件级
  assertEquals(
    hasFileLevelTest(
      `export function e2eTest(name, fn) {\n  Deno.test({ name, fn });\n}\n`,
    ),
    false,
  );
  // 箭头函数体内 → 不算
  assertEquals(
    hasFileLevelTest(
      `const helper = () => {\n  Deno.test("x", () => {});\n};\n`,
    ),
    false,
  );
  // 注释/字符串里的 Deno.test 不算
  assertEquals(hasFileLevelTest(`// Deno.test("x", () => {});\n`), false);
  assertEquals(
    hasFileLevelTest(`const s = 'Deno.test("x", () => {})';\n`),
    false,
  );
});

// ── 2026-09-22 评审修复：启发式双向失准的反例 ──
// 评审实测：方法简写/class 方法内的 Deno.test 被误判为"文件级"（会把合法测试
// 工厂报红），而 IIFE 里的真实测试被漏判（放过永不执行的测试）。
Deno.test("hasFileLevelTest: 方法简写/class 方法内的调用不算文件级（防误红）", () => {
  assertEquals(
    hasFileLevelTest(
      `const suite = { register(name) {\n  Deno.test(name, () => {});\n} };\n`,
    ),
    false,
    "对象方法简写体应视为函数体内",
  );
  assertEquals(
    hasFileLevelTest(
      `class Suite {\n  add(name: string) {\n    Deno.test(name, () => {});\n  }\n}\n`,
    ),
    false,
    "class 方法体应视为函数体内",
  );
  assertEquals(
    hasFileLevelTest(
      `const s = {\n  run(name: string): void {\n    Deno.test(name, () => {});\n  },\n};\n`,
    ),
    false,
    "带返回类型注解的方法体应视为函数体内",
  );
});

Deno.test("hasFileLevelTest: IIFE 内调用必须被视为执行（防漏判）", () => {
  assert(
    hasFileLevelTest(`(() => {\n  Deno.test("x", () => {});\n})();\n`),
    "IIFE 内的测试会在加载时执行，文件若不可发现即为漏判",
  );
  assert(
    hasFileLevelTest(
      `(function () {\n  Deno.test("x", () => {});\n}).call(null);\n`,
    ),
    ".call 形式的立即调用同样应被视为执行",
  );
  // while/for 等控制流仍不算函数体
  assert(
    hasFileLevelTest(`while (x) {\n  Deno.test("a", () => {});\n}\n`),
  );
  assert(
    hasFileLevelTest(
      `switch (x) {\n  case 1:\n    Deno.test("a", () => {});\n}\n`,
    ),
  );
  assert(
    hasFileLevelTest(`try {\n  Deno.test("a", () => {});\n} catch {}\n`),
  );
});

Deno.test("findUndiscoverableTests: 控制流块中的测试文件会被报出", async () => {
  const root = await Deno.makeTempDir({ prefix: "test-discovery-" });
  try {
    await Deno.mkdir(`${root}/noj-core/tests/routes`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/noj-core/tests/routes/health.ts`,
      `for (const c of ["a", "b"]) {\n  Deno.test(\`case \${c}\`, () => {});\n}\n`,
    );
    const found = await findUndiscoverableTests(root, "noj-core");
    assert(
      found.some((f) => f.file.endsWith("tests/routes/health.ts")),
      `控制流块内的测试文件必须被报出，实际 ${JSON.stringify(found)}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("findUndiscoverableTests: 真实仓库的 helper.ts 测试工厂不被误报", async () => {
  // 防回归：helper.ts 的 e2eTest() 在函数体内，必须继续被视为工厂而跳过
  const found = await findUndiscoverableTests(".", "noj-tests");
  assertEquals(
    found.some((f) => f.file.endsWith("e2e/helper.ts")),
    false,
    `helper.ts 是测试工厂，不应被报为不可发现，实际 ${JSON.stringify(found)}`,
  );
});
