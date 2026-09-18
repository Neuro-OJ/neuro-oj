/**
 * **共享 fixture 契约测试**（#514 的关键补偿措施）。
 *
 * `noj-core` 与 `noj-cli` 各持一份题目包校验实现（issue #514 已确认的取舍）。
 * 两侧对**同一份 fixture**（`fixtures/problem-bundle-manifest.json`，仓库根）
 * 断言：任一实现漂移都会立即红灯。
 *
 * 对应的 noj-cli 侧测试：`noj-cli/src/problem/contract_test.ts`
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { validateBundleManifest } from "../../types/problem-bundle.ts";

interface ContractFixture {
  valid: Array<{ name: string; manifest: Record<string, unknown> }>;
  invalid: Array<{ name: string; manifest: Record<string, unknown> }>;
}

// 本文件位于 noj-core/src/domains/catalog/tests/types/，上溯 6 层到仓库根
const FIXTURE_URL = new URL(
  "../../../../../../fixtures/problem-bundle-manifest.json",
  import.meta.url,
);

async function loadFixture(): Promise<ContractFixture> {
  return JSON.parse(await Deno.readTextFile(FIXTURE_URL)) as ContractFixture;
}

Deno.test("契约(core): fixture 非空", async () => {
  const fixture = await loadFixture();
  assertEquals(fixture.valid.length > 0, true);
  assertEquals(fixture.invalid.length > 0, true);
});

Deno.test("契约(core): 全部正例必须被接受", async () => {
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

Deno.test("契约(core): 全部反例必须被拒绝", async () => {
  const fixture = await loadFixture();
  for (const item of fixture.invalid) {
    let err: unknown;
    try {
      validateBundleManifest(item.manifest);
    } catch (e) {
      err = e;
    }
    assertEquals(err !== undefined, true, `反例「${item.name}」未被拒绝`);
  }
});

Deno.test("契约(core): 校验不修改入参", async () => {
  const fixture = await loadFixture();
  for (const item of fixture.valid) {
    const before = JSON.stringify(item.manifest);
    validateBundleManifest(item.manifest);
    assertEquals(JSON.stringify(item.manifest), before);
  }
});
