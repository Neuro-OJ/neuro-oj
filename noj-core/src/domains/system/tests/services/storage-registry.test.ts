/**
 * 存储对象登记与引用守卫删除测试（Handbook §2.5）。
 *
 * 重点验证「上传补偿不误删共享对象」：本地 provider 是内容寻址，同一字节内容会得到
 * 同一 URL，因此删除必须经过引用守卫，而不能直接 `storage.delete()`。
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  problemDraftObjects,
  problems,
  storageObjects,
} from "../../../../shared/db/schema.ts";
import {
  assertStorageObjectBindable,
  collectStorageReferences,
  compensateUploadedObject,
  deleteStorageObject,
  getStorageObject,
  registerLegacyStorageObject,
  registerReadyStorageObject,
  verifyStorageObject,
} from "../../services/storage/registry.ts";
import {
  getStorageProvider,
  setStorageProviderForTest,
} from "../../services/storage/factory.ts";
import { LocalStorageProvider } from "../../services/storage/local.ts";

const now = new Date().toISOString();

/**
 * 本地 provider 的存储根目录由 `SUPPORT_PACKAGE_DIR` 决定（构造函数无参数），
 * 因此在模块加载时指向一次性临时目录，避免污染仓库的 data/storage。
 */
const tempStorageDir = Deno.makeTempDirSync({ prefix: "noj-registry-" });

/** 每个用例重置 provider 单例（同一临时目录，内容寻址互不干扰）。 */
function useTempStorage(): LocalStorageProvider {
  const provider = new LocalStorageProvider(tempStorageDir);
  setStorageProviderForTest(provider);
  return provider;
}

async function seedProblem(id: string, number: number): Promise<void> {
  await getDb().insert(problems).values({
    id,
    title: id,
    description: "d",
    type: "P",
    number,
    owner_id: "0",
    difficulty: "easy",
    judge_type: "dual",
    created_at: now,
    updated_at: now,
  });
}

Deno.test("storage registry: 新上传登记为 ready 且幂等", async () => {
  const provider = useTempStorage();
  const url = await provider.put("pkg", new TextEncoder().encode("hello"));
  await registerReadyStorageObject({
    storageUrl: url,
    sha256: "h1",
    byteSize: 5,
  });
  await registerReadyStorageObject({
    storageUrl: url,
    sha256: "h1",
    byteSize: 5,
  });
  const row = await getStorageObject(url);
  assertEquals(row?.state, "ready");
  assertEquals(row?.sha256, "h1");
  assertEquals(row?.byte_size, 5);
});

Deno.test("storage registry: 存量登记为 unknown，核实后升级为 ready/missing", async () => {
  const provider = useTempStorage();
  const url = await provider.put("pkg2", new TextEncoder().encode("abc"));
  await registerLegacyStorageObject(url);
  assertEquals((await getStorageObject(url))?.state, "unknown");
  assertEquals(await verifyStorageObject(url), "ready");
  assertEquals((await getStorageObject(url))?.state, "ready");

  const ghost = "noj-storage://local/Z2hvc3Q=?checksum_sha256=deadbeef";
  await registerLegacyStorageObject(ghost);
  assertEquals(await verifyStorageObject(ghost), "missing");
  assertEquals((await getStorageObject(ghost))?.state, "missing");
});

Deno.test("storage registry: deleting/deleted 状态不能建立新引用", async () => {
  const provider = useTempStorage();
  const url = await provider.put("pkg3", new TextEncoder().encode("abc"));
  await registerReadyStorageObject({ storageUrl: url });
  await deleteStorageObject(url);
  assertEquals((await getStorageObject(url))?.state, "deleted");
  await assertRejects(() => assertStorageObjectBindable(url));

  // 未登记的存量对象可以绑定（历史引用必须继续可用）
  const legacy = await provider.put("pkg4", new TextEncoder().encode("xyz"));
  await assertStorageObjectBindable(legacy);
  assertEquals((await getStorageObject(legacy))?.state, "unknown");
});

Deno.test("storage registry: 有引用时拒绝物理删除（上传补偿不误删）", async () => {
  const provider = useTempStorage();
  const url = await provider.put(
    "shared",
    new TextEncoder().encode("shared-bytes"),
  );
  await registerReadyStorageObject({ storageUrl: url });
  await seedProblem("sr-prob", 910001);
  await getDb().insert(problemDraftObjects).values({
    problem_id: "sr-prob",
    role: "support_package",
    path: "package.zip",
    storage_url: url,
  });

  const references = await collectStorageReferences(url);
  assertEquals(references.draft_refs, 1);
  assertEquals(references.total, 1);

  // 补偿路径：登记后尝试删除 → 因仍被草稿引用而保留对象
  const outcome = await compensateUploadedObject({ storageUrl: url });
  assertEquals(outcome.outcome, "referenced");
  const stillThere = await provider.stat(url);
  assertEquals(stillThere.exists, true);
  assertEquals((await getStorageObject(url))?.state, "ready");
});

Deno.test("storage registry: 无引用时删除对象并标记 deleted", async () => {
  const provider = useTempStorage();
  const url = await provider.put("orphan", new TextEncoder().encode("orphan"));
  await registerReadyStorageObject({ storageUrl: url });
  const outcome = await deleteStorageObject(url);
  assertEquals(outcome.outcome, "deleted");
  assertEquals((await provider.stat(url)).exists, false);
  const row = await getStorageObject(url);
  assertEquals(row?.state, "deleted");
  // 幂等：再次删除仍返回 deleted
  assertEquals((await deleteStorageObject(url)).outcome, "deleted");
});

Deno.test("storage registry: 对象不存在时删除返回 missing 且登记为 deleted", async () => {
  useTempStorage();
  const ghost = "noj-storage://local/bWlzc2luZw==?checksum_sha256=abc";
  await registerReadyStorageObject({ storageUrl: ghost });
  assertEquals((await deleteStorageObject(ghost)).outcome, "missing");
  assertEquals((await getStorageObject(ghost))?.state, "deleted");
});

Deno.test("storage registry: stat 对 local provider 返回大小", async () => {
  const provider = useTempStorage();
  const url = await provider.put("sized", new Uint8Array([1, 2, 3, 4]));
  const stat = await provider.stat(url);
  assertEquals(stat.exists, true);
  assertEquals(stat.sizeBytes, 4);
  const missing = await provider.stat(
    "noj-storage://local/bm90LWhlcmU=?checksum_sha256=0",
  );
  assertEquals(missing.exists, false);
  // 清理：JSDoc 提到 provider 单例，测试结束不影响其他用例
  assertEquals(
    await getStorageProvider() instanceof LocalStorageProvider,
    true,
  );
  await getDb().delete(storageObjects).where(
    eq(storageObjects.state, "deleted"),
  );
});
