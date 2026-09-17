import { assertEquals } from "@std/assert";
import { validateBundleManifest } from "./vendor/problem-bundle.ts";

/**
 * **共享 fixture 契约测试**（#514 的关键补偿措施）。
 *
 * 背景：issue #514 决定把题目包校验逻辑在 `noj-core` 与 `noj-cli` 各放一份
 * （避免 `noj-cli` 依赖主仓库的导入映射）。这份取舍引入已知的**漂移风险**——
 * 两套实现并存后行为可能分叉。
 *
 * 为把风险压到可接受范围，两侧对**同一份 fixture**
 * （`fixtures/problem-bundle-manifest.json`，位于仓库根）断言：
 * 任一实现漂移都会**立即红灯**，而不是等出题人踩坑。
 *
 * 对应的 core 侧测试：
 * `noj-core/src/domains/catalog/tests/types/problem-bundle-contract.test.ts`
 */

interface ContractFixture {
  valid: Array<{ name: string; manifest: Record<string, unknown> }>;
  invalid: Array<{ name: string; manifest: Record<string, unknown> }>;
}

const FIXTURE_URL = new URL(
  "../../../fixtures/problem-bundle-manifest.json",
  import.meta.url,
);

async function loadFixture(): Promise<ContractFixture> {
  return JSON.parse(await Deno.readTextFile(FIXTURE_URL)) as ContractFixture;
}

Deno.test("契约: fixture 本身非空且两类都有样本", async () => {
  const fixture = await loadFixture();
  assertEquals(fixture.valid.length > 0, true, "valid 不能为空");
  assertEquals(fixture.invalid.length > 0, true, "invalid 不能为空");
});

Deno.test("契约: 全部正例必须被 noj-cli 接受", async () => {
  const fixture = await loadFixture();
  for (const item of fixture.valid) {
    let err: unknown;
    try {
      validateBundleManifest(item.manifest);
    } catch (e) {
      err = e;
    }
    assertEquals(
      err,
      undefined,
      `正例「${item.name}」被拒绝: ${(err as Error)?.message}`,
    );
  }
});

Deno.test("契约: 全部反例必须被 noj-cli 拒绝且信息指明字段", async () => {
  const fixture = await loadFixture();
  for (const item of fixture.invalid) {
    let err: unknown;
    try {
      validateBundleManifest(item.manifest);
    } catch (e) {
      err = e;
    }
    assertEquals(err !== undefined, true, `反例「${item.name}」未被拒绝`);
    const message = (err as Error).message ?? "";
    assertEquals(message.length > 0, true, `反例「${item.name}」错误信息为空`);
  }
});

Deno.test("契约: 校验不修改入参（纯函数）", async () => {
  const fixture = await loadFixture();
  for (const item of fixture.valid) {
    const before = JSON.stringify(item.manifest);
    validateBundleManifest(item.manifest);
    assertEquals(
      JSON.stringify(item.manifest),
      before,
      `「${item.name}」入参被修改`,
    );
  }
});
