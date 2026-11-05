/**
 * 文件级耗时基线与真实测试文件的一致性检查。
 *
 * 2026-11-04 评审：基线里长期留着 5 个已删除的测试文件，而消费方
 * （noj-core/scripts/test-launcher.ts）从不核对条目指向的文件是否还在——
 * 分片计划看起来有历史依据，实际混入了假数据。这里在门禁里直接对账。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";

const BASELINE_PATH = new URL(
  "../dev-docs/engineering/test-duration-baseline.json",
  import.meta.url,
);
const CORE_ROOT = new URL("../noj-core/", import.meta.url);

interface Baseline {
  version: number;
  generatedAt: string;
  source: string;
  files: Record<string, number>;
}

Deno.test("test-duration-baseline: 每个条目都指向仍存在的测试文件", async () => {
  const baseline = JSON.parse(
    await Deno.readTextFile(BASELINE_PATH),
  ) as Baseline;
  const missing: string[] = [];
  for (const file of Object.keys(baseline.files)) {
    try {
      if (!(await Deno.stat(new URL(file, CORE_ROOT))).isFile) {
        missing.push(file);
      }
    } catch {
      missing.push(file);
    }
  }
  assertEquals(
    missing,
    [],
    `耗时基线包含已不存在的测试文件（请同步更新 dev-docs/engineering/test-duration-baseline.json）：${
      missing.join(", ")
    }`,
  );
});

Deno.test("test-duration-baseline: 结构与耗时合法", async () => {
  const baseline = JSON.parse(
    await Deno.readTextFile(BASELINE_PATH),
  ) as Baseline;
  assertEquals(baseline.version, 1);
  assert(baseline.generatedAt.length > 0, "缺少 generatedAt");
  assert(baseline.source.length > 0, "缺少 source");
  assert(Object.keys(baseline.files).length > 0, "files 为空");
  for (const [file, duration] of Object.entries(baseline.files)) {
    assert(
      Number.isFinite(duration) && duration >= 0,
      `${file} 的耗时非法：${duration}`,
    );
  }
});
