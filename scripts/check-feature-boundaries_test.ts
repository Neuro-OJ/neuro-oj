/**
 * 功能边界门禁自测（core 重构阶段 2.4）。
 *
 * 用临时目录构造最小 `noj-core/src` 树，覆盖四条规则的违规与合法用例。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { checkFeatureBoundaries } from "./check-feature-boundaries.ts";

type Fixture = Record<string, string>;

async function withFixture(
  fixture: Fixture,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "feature-boundaries-" });
  try {
    for (const [path, content] of Object.entries(fixture)) {
      const full = `${root}/${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(full, content);
    }
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const BASE = "noj-core/src";

/** 取某条规则的违规描述，便于断言。 */
function describe(
  violations: { rule: string; file: string; target: string }[],
) {
  return violations.map((v) => `${v.rule}:${v.file}->${v.target}`);
}

Deno.test("check-feature-boundaries: features/ 不存在时通过并报告扫描数", async () => {
  await withFixture({
    [`${BASE}/shared/db.ts`]: "export const db = 1;\n",
    [`${BASE}/features.ts`]: "export const FEATURES = [];\n",
  }, async (root) => {
    const report = await checkFeatureBoundaries(root);
    assertEquals(report.setupError, null);
    assertEquals(report.violations, []);
    assertEquals(report.scannedFiles, 2);
    assertEquals(report.featureCount, 0);
  });
});

Deno.test("check-feature-boundaries: src 缺失时自检失败", async () => {
  await withFixture({}, async (root) => {
    const report = await checkFeatureBoundaries(root);
    assert(report.setupError !== null);
  });
});

Deno.test("check-feature-boundaries: src 下无生产文件时自检失败", async () => {
  await withFixture({
    [`${BASE}/features/problems/problems_test.ts`]: "export const x = 1;\n",
    [`${BASE}/modules/platform/tests/helper.ts`]: 'import "../../x.ts";\n',
  }, async (root) => {
    const report = await checkFeatureBoundaries(root);
    assert(report.setupError !== null);
    assertEquals(report.scannedFiles, 0);
  });
});

Deno.test("check-feature-boundaries: 规则1 跨功能深引用违规", async () => {
  await withFixture({
    [`${BASE}/features/a/index.ts`]: "export const a = 1;\n",
    [`${BASE}/features/b/index.ts`]: "export const b = 1;\n",
    [`${BASE}/features/b/service.ts`]: "export const deep = 1;\n",
    [`${BASE}/features/a/service.ts`]:
      'import { deep } from "../b/service.ts";\nexport const use = deep;\n',
  }, async (root) => {
    const report = await checkFeatureBoundaries(root);
    assertEquals(describe(report.violations), [
      "跨功能深引用:features/a/service.ts->features/b/service.ts",
    ]);
    assert(report.violations[0]!.hint.includes("src/features/b/index.ts"));
  });
});

Deno.test("check-feature-boundaries: 规则2 底座反向依赖违规", async () => {
  await withFixture({
    [`${BASE}/shared/db.ts`]:
      'import { a } from "../features/a/index.ts";\nimport type { F } from "../features.ts";\nexport const db = a;\nexport type X = F;\n',
    [`${BASE}/features/a/index.ts`]: "export const a = 1;\n",
    [`${BASE}/features.ts`]:
      'import { a } from "./features/a/index.ts";\nexport const FEATURES = [a];\n',
  }, async (root) => {
    const report = await checkFeatureBoundaries(root);
    assertEquals(describe(report.violations), [
      "底座反向依赖:shared/db.ts->features/a/index.ts",
      "底座反向依赖:shared/db.ts->features.ts",
    ]);
  });
});

Deno.test("check-feature-boundaries: 规则3 功能深入旧模块违规", async () => {
  await withFixture({
    [`${BASE}/features/a/index.ts`]:
      'import { x } from "../../modules/platform/services/x.ts";\nexport const a = x;\n',
    [`${BASE}/features/a/service.ts`]:
      'export * from "../../modules/access/types/t.ts";\n',
    [`${BASE}/modules/platform/index.ts`]: "export const x = 1;\n",
    [`${BASE}/modules/platform/services/x.ts`]: "export const x = 1;\n",
    [`${BASE}/modules/access/types/t.ts`]: "export type T = 1;\n",
  }, async (root) => {
    const report = await checkFeatureBoundaries(root);
    assertEquals(describe(report.violations), [
      "功能深入旧模块:features/a/index.ts->modules/platform/services/x.ts",
      "功能深入旧模块:features/a/service.ts->modules/access/types/t.ts",
    ]);
  });
});

Deno.test("check-feature-boundaries: 规则4 功能间运行时循环违规", async () => {
  await withFixture({
    [`${BASE}/features/a/index.ts`]:
      'import { b } from "../b/index.ts";\nexport const a = b;\n',
    [`${BASE}/features/b/index.ts`]:
      'import { a } from "../a/index.ts";\nexport const b = a;\n',
  }, async (root) => {
    const report = await checkFeatureBoundaries(root);
    const cycles = report.violations.filter((v) => v.rule === "功能间循环");
    assert(cycles.length >= 1);
    assert(cycles[0]!.target.includes("a -> b -> a"));
    assertEquals(report.featureCount, 2);
  });
});

Deno.test("check-feature-boundaries: type-only 引用不构成循环", async () => {
  await withFixture({
    [`${BASE}/features/a/index.ts`]:
      'import { b } from "../b/index.ts";\nexport const a = b;\n',
    [`${BASE}/features/b/index.ts`]:
      'import type { a } from "../a/index.ts";\nexport interface B { x: typeof a }\nexport const b = 1;\n',
  }, async (root) => {
    const report = await checkFeatureBoundaries(root);
    assertEquals(report.violations, []);
  });
});

Deno.test("check-feature-boundaries: 合法引用全部通过", async () => {
  await withFixture({
    [`${BASE}/features.ts`]:
      'import { a } from "./features/a/index.ts";\nimport { b } from "./features/b/index.ts";\nexport const FEATURES = [a, b];\n',
    [`${BASE}/shared/db.ts`]: "export const db = 1;\n",
    [`${BASE}/shared/feature.ts`]: "export const define = 1;\n",
    [`${BASE}/modules/platform/index.ts`]: "export const x = 1;\n",
    [`${BASE}/modules/platform/contracts/c.ts`]: "export const c = 1;\n",
    [`${BASE}/features/a/index.ts`]:
      'import { db } from "../../shared/db.ts";\nimport { define } from "../../shared/feature.ts";\nimport { deep } from "./deep.ts";\nimport { x } from "../../modules/platform/index.ts";\nimport { c } from "../../modules/platform/contracts/c.ts";\nexport const a = [db, define, deep, x, c];\n',
    [`${BASE}/features/a/deep.ts`]: "export const deep = 1;\n",
    [`${BASE}/features/b/index.ts`]: "export const b = 1;\n",
    [`${BASE}/features/b/service.ts`]:
      'import { deep } from "../a/index.ts";\nexport const s = deep;\n',
  }, async (root) => {
    const report = await checkFeatureBoundaries(root);
    assertEquals(report.violations, []);
    assertEquals(report.featureCount, 2);
    assertEquals(report.scannedFiles, 9);
  });
});

Deno.test("check-feature-boundaries: 深引用其他功能的 .mts/.tsx 文件同样违规", async () => {
  await withFixture({
    [`${BASE}/features/a/index.ts`]:
      'import { p } from "../b/private.mts";\nimport { v } from "../b/view.tsx";\nexport const a = [p, v];\n',
    [`${BASE}/features/b/index.ts`]: "export const b = 1;\n",
    [`${BASE}/features/b/private.mts`]: "export const p = 1;\n",
    [`${BASE}/features/b/view.tsx`]: "export const v = 1;\n",
  }, async (root) => {
    const report = await checkFeatureBoundaries(root);
    assertEquals(describe(report.violations), [
      "跨功能深引用:features/a/index.ts->features/b/private.mts",
      "跨功能深引用:features/a/index.ts->features/b/view.tsx",
    ]);
  });
});
