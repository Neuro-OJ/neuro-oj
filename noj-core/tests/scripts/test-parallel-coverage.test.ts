/**
 * 并行分片覆盖守卫。
 *
 * 背景（2026-09-21）：`test-parallel.ts` 的分片目录集合声称与 CI 的
 * `core-<domain>` job 「一致」，但实际漏掉了 `observability` / `admin` 两个
 * domain，以及 `tests/` 顶层的 security-headers / types_safety /
 * defensive-patterns / smoke / scripts 等文件。它们**从不在并行路径执行**，
 * 却没有任何信号——是「三条测试路径行为不一致」里最隐蔽的一类。
 *
 * 本测试直接对照文件系统，断言 `tests/` 与 `src/domains/<domain>/tests` 下的每个
 * 测试文件都至少被一个分片覆盖（性能基准单独登记豁免）。新增 domain 或顶层
 * 测试文件而忘了登记分片时，这里会失败。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  isCoveredByShards,
  isPerfExcluded,
  SHARDS,
} from "../../scripts/test-parallel-shards.ts";

const CORE_ROOT = new URL("../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** 递归收集 `noj-core` 下会被 Deno 运行器发现的测试文件（仓库相对路径）。 */
async function collectTestFiles(): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set([
    "node_modules",
    ".deno_cache",
    ".deno_cov_cache",
    ".test-cache",
    ".test-storage",
    ".git",
    ".output",
    "coverage",
    "drizzle",
    "bin",
    "dist",
  ]);
  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        if (skinnySkip(entry.name)) continue;
        await walk(`${dir}/${entry.name}`);
        continue;
      }
      if (!entry.isFile) continue;
      if (!/(_test|\.test)\.ts$/.test(entry.name)) continue;
      const abs = `${dir}/${entry.name}`;
      const rel = abs.slice(CORE_ROOT.length + 1);
      if (
        rel.startsWith("tests/") || /^src\/domains\/[^/]+\/tests\//.test(rel)
      ) {
        out.push(rel);
      }
    }
  }
  function skinnySkip(name: string): boolean {
    return skip.has(name);
  }
  await walk(CORE_ROOT);
  return out.sort();
}

Deno.test("shards: 每个 domain 的 tests 目录都被某个分片覆盖", () => {
  // 显式断言 observability / admin 在列（防止回归到 2026-09-21 前的遗漏）。
  for (const domain of ["observability", "admin"]) {
    const covered = SHARDS.some((s) =>
      s.dirs.some((d) => d.startsWith(`src/domains/${domain}/tests`))
    );
    assert(covered, `domain ${domain} 的测试未被任何分片覆盖`);
  }
});

Deno.test("shards: 目录级不重叠（同一目录不得被两分片执行）", () => {
  // `tests/00_migrate_test.ts` 是**有意**同时出现在两个分片：每个分片在自己的
  // schema 内需要执行一次迁移，故作为直接文件路径重复是允许的。真正要防的是
  // **目录**级重叠——同一目录被两个分片扫描会让其中的测试在同一 schema 语义下
  // 跑两遍（既浪费，也可能掩盖隔离问题）。
  const dirSeen = new Map<string, string>();
  for (const shard of SHARDS) {
    for (const dir of shard.dirs) {
      if (dir.endsWith(".ts")) continue; // 直接文件路径：允许 00_migrate 的重复
      const prev = dirSeen.get(dir);
      assert(
        prev === undefined,
        `目录 ${dir} 同时出现在分片 ${prev} 与 ${shard.name}`,
      );
      dirSeen.set(dir, shard.name);
    }
  }
});

Deno.test("shards: 直接文件路径的重复仅限于迁移入口", () => {
  const fileSeen = new Map<string, string>();
  const duplicated: string[] = [];
  for (const shard of SHARDS) {
    for (const dir of shard.dirs) {
      if (!dir.endsWith(".ts")) continue;
      const prev = fileSeen.get(dir);
      if (prev !== undefined) duplicated.push(dir);
      fileSeen.set(dir, shard.name);
    }
  }
  assertEquals(
    duplicated,
    ["tests/00_migrate_test.ts"],
    "仅迁移入口允许在两个分片重复（每分片需各自迁移）",
  );
});

Deno.test(
  "shards: tests/ 与 domains/*/tests 下每个测试文件都被覆盖（非 perf）",
  async () => {
    const files = await collectTestFiles();
    assert(
      files.length > 100,
      `收集到的测试文件过少，扫描规则可能失效：${files.length}`,
    );
    const uncovered = files.filter(
      (f) => !isCoveredByShards(f) && !isPerfExcluded(f),
    );
    assertEquals(
      uncovered,
      [],
      `以下测试文件不在任何并行分片内（永不执行）：\n${
        uncovered.map((f) => "  - " + f).join("\n")
      }`,
    );
  },
);

Deno.test("shards: 性能基准按登记豁免（而非被静默遗漏）", () => {
  // 反向证据：perf 文件确实存在于文件系统，但被显式排除。
  assert(isPerfExcluded("tests/perf/search_bench.test.ts"));
  assert(isPerfExcluded("src/domains/search/tests/perf/search_bench.test.ts"));
  assert(!isPerfExcluded("tests/security-headers.test.ts"));
});

Deno.test("shards: isCoveredByShards 前缀语义正确", () => {
  assert(isCoveredByShards("tests/routes/health.test.ts"), "目录前缀应覆盖");
  assert(isCoveredByShards("tests/00_migrate_test.ts"), "直接路径应覆盖");
  assert(
    !isCoveredByShards("src/domains/unknown/tests/x.test.ts"),
    "未登记路径不应被覆盖",
  );
});
