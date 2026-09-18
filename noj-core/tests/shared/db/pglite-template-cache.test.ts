/**
 * PGlite 模板缓存回归测试（覆盖两个已复现缺陷）。
 *
 * 背景：`ensurePGliteTemplateCached()` 维护三个产物 —— 模板 `.tgz`、内容 hash
 * `.hash`、同步指纹 `.schema`；`createPGliteInstanceFromTemplate()` 是**同步**加载
 * 路径，只认指纹，指纹缺失/过期即静默回退慢速 DDL 路径。两个缺陷都表现为
 * "调用方看到模板就绪，实际 fast path 已失效"。
 *
 * 缺陷 1：hash 命中且模板存在时提前 return，跳过了指纹写入 —— 删掉 sidecar 后
 * 重跑准备脚本不会重建它。
 * 缺陷 2：同步指纹只覆盖 `schema-ddl.ts`，异步 hash 还覆盖两个种子源码 ——
 * 只改种子时指纹不变，模板被判为未过期，fast path 静默加载旧种子数据。
 *
 * 测试全程使用临时缓存目录（`PGLITE_TEMPLATE_CACHE_DIR`），不触碰开发者真实
 * `.test-cache`；为避免触发耗时的完整模板构建（需真实 dump PGlite 数据目录），
 * 用例在临时目录里预置 `hash + 模板 + 指纹` 三个产物，使其走 hash 命中分支。
 */

import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@^1";
import {
  computePGliteTemplateHash,
  computeSchemaFingerprintSync,
  ensurePGliteTemplateCached,
  pgliteTemplateInputFiles,
  pgliteTemplatePaths,
} from "../../../src/shared/db/connection.ts";

/** 模板缓存目录注入开关（与服务实现约定一致） */
const CACHE_DIR_ENV = "PGLITE_TEMPLATE_CACHE_DIR";

/**
 * 在临时缓存目录中运行断言，结束后恢复原环境变量并删除临时目录。
 *
 * 缓存目录是运行时读取的（`pgliteTemplatePaths()` 每次解析 env），因此这里
 * 不需要在模块加载前设置；这也正是"三个产物不会错配到不同目录"的实现基础。
 */
async function withTempCacheDir(
  fn: (paths: ReturnType<typeof pgliteTemplatePaths>) => Promise<void>,
): Promise<void> {
  const saved = Deno.env.get(CACHE_DIR_ENV);
  const dir = await Deno.makeTempDir({ prefix: "noj-pglite-template-test-" });
  Deno.env.set(CACHE_DIR_ENV, dir);
  try {
    await fn(pgliteTemplatePaths());
  } finally {
    if (saved === undefined) Deno.env.delete(CACHE_DIR_ENV);
    else Deno.env.set(CACHE_DIR_ENV, saved);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** 读取文件内容；不存在时返回 null（区分"缺失"与"空文件"） */
function readIfExists(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

Deno.test({
  name:
    "pglite 模板缓存: hash 命中但 sidecar 缺失时仍重建同步指纹（缺陷 1 回归，不重跑模板构建）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withTempCacheDir(async (paths) => {
      // 预置"新鲜缓存"：模板 + 与当前输入匹配的 hash，但不放 sidecar
      const expectedHash = await computePGliteTemplateHash();
      await Deno.writeTextFile(paths.hash, expectedHash);
      await Deno.writeFile(
        paths.template,
        new TextEncoder().encode("fake-tgz"),
      );
      assertEquals(
        readIfExists(paths.fingerprint),
        null,
        "前置条件：sidecar 不存在",
      );

      // 修复前：hash 命中 + 模板存在 → 提前 return，sidecar 不会被重建
      const returned = await ensurePGliteTemplateCached();

      assertStrictEquals(returned, paths.template, "应返回模板路径");
      assertEquals(
        readIfExists(paths.fingerprint),
        computeSchemaFingerprintSync(),
        "hash 命中路径也必须补齐同步指纹 sidecar",
      );
      // 反向断言：模板未被重建（证明走的是 hash 命中分支，而不是全量重建）
      assertEquals(
        new TextDecoder().decode(Deno.readFileSync(paths.template)),
        "fake-tgz",
        "hash 命中时不应重新构建模板",
      );
    });
  },
});

Deno.test({
  name:
    "pglite 模板缓存: 指纹过期时刷新为当前输入的指纹（缺陷 1 回归，含陈旧 sidecar）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withTempCacheDir(async (paths) => {
      await Deno.writeTextFile(paths.hash, await computePGliteTemplateHash());
      await Deno.writeFile(
        paths.template,
        new TextEncoder().encode("fake-tgz"),
      );
      await Deno.writeTextFile(paths.fingerprint, "1:stale:0");

      await ensurePGliteTemplateCached();

      assertEquals(
        readIfExists(paths.fingerprint),
        computeSchemaFingerprintSync(),
        "陈旧指纹必须被刷新，否则 fast path 会静默加载旧模板",
      );
    });
  },
});

Deno.test({
  name:
    "pglite 模板缓存: 同步指纹与异步 hash 覆盖同一输入文件集合（缺陷 2 回归）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const inputs = pgliteTemplateInputFiles();
    assert(inputs.length >= 3, "至少覆盖 schema-ddl + RBAC 种子 + 社区种子");

    // 清单本身即单一事实源；这里断言"输入集合里确实包含两个种子文件"，
    // 并顺手确认清单文件都存在（读不到就会让指纹计算抛错而非静默降级）。
    const allFilesExist = inputs.every((f) => {
      try {
        Deno.statSync(f);
        return true;
      } catch {
        return false;
      }
    });
    assert(allFilesExist, `输入清单存在不可读文件：${inputs.join(", ")}`);
    assert(
      inputs.some((f) => f.endsWith("seed-rbac.ts")),
      "RBAC 种子必须参与指纹（否则改种子不会让模板失效）",
    );
    assert(
      inputs.some((f) => f.endsWith("community-seed.ts")),
      "社区种子必须参与指纹（否则改种子不会让模板失效）",
    );
    assert(
      inputs.some((f) => f.endsWith("schema-ddl.ts")),
      "schema-ddl.ts 必须参与指纹",
    );
  },
});

Deno.test({
  name:
    "pglite 模板缓存: 种子文件内容变化会同时改变同步指纹与异步 hash（缺陷 2 回归，临时副本）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const inputs = pgliteTemplateInputFiles();
    const seedFile = inputs.find((f) => f.endsWith("community-seed.ts"));
    assert(seedFile, "未找到社区种子输入文件");
    const original = await Deno.readTextFile(seedFile);

    const fingerprintBefore = computeSchemaFingerprintSync();
    const hashBefore = await computePGliteTemplateHash();

    // 就地扰动真实种子文件，断言后立即恢复（内容按字节还原，测试不改变仓库状态）。
    // 不能用临时副本：输入清单是模块内常量，指向真实源码路径。
    try {
      await Deno.writeTextFile(seedFile, `${original}\n// 回归测试临时扰动\n`);
      const fingerprintAfter = computeSchemaFingerprintSync();
      const hashAfter = await computePGliteTemplateHash();

      assert(
        fingerprintAfter !== fingerprintBefore,
        "仅改动种子文件时同步指纹必须变化（修复前：指纹只看 schema-ddl.ts，保持不变 → 静默加载旧种子）",
      );
      assert(
        hashAfter !== hashBefore,
        "仅改动种子文件时异步 hash 必须变化",
      );
    } finally {
      await Deno.writeTextFile(seedFile, original);
    }

    // 恢复后两个指纹都应回到原值，确认恢复是干净的
    assertEquals(
      await Deno.readTextFile(seedFile),
      original,
      "种子文件必须按字节还原",
    );
    assertEquals(computeSchemaFingerprintSync(), fingerprintBefore);
    assertEquals(await computePGliteTemplateHash(), hashBefore);
  },
});
