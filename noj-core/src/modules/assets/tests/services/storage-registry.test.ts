/**
 * 存储对象登记与引用守卫删除测试（Handbook §2.5）。
 *
 * 重点验证「上传补偿不误删共享对象」：本地 provider 是内容寻址，同一字节内容会得到
 * 同一 URL，因此删除必须经过引用守卫，而不能直接 `storage.delete()`。
 */
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { ensureDefaultWorkspace } from "../../../../domains/workspace/index.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  problemDraftObjects,
  problems,
  storageObjectReservations,
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
  registerStreamedStorageObject,
  releaseStorageObjectUploadReservation,
  reserveStorageObjectUpload,
  StorageObjectDeletedError,
  StorageObjectMissingError,
  StorageUploadInFlightError,
  uploadStorageObjectWithReservation,
  verifyStorageObject,
} from "../../services/registry.ts";
import {
  getStorageProvider,
  setStorageProviderForTest,
} from "../../storage/factory.ts";
import { LocalStorageProvider } from "../../storage/local.ts";
import type { StorageObjectStat } from "../../storage/types.ts";

const now = new Date().toISOString();

/** 某个存储 URL 当前的预约行数（用于断言预约已消费/清理）。 */
async function countReservations(storageUrl: string): Promise<number> {
  const rows = await getDb().select().from(storageObjectReservations).where(
    eq(storageObjectReservations.storage_url, storageUrl),
  );
  return rows.length;
}

/** 构造一个与 `putStream()` 对接的字节流。 */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as unknown as BlobPart]).stream();
}

/**
 * 模拟"后端明确报告对象不存在"的 provider：`stat` 返回 `exists:false`。
 *
 * 与 `UnreachableStatProvider`（抛错=无法确认）不同，这里后端**确认缺失**，
 * 因此流式复核必须拒绝登记与绑定（问题 7 的要求 2）。
 */
class MissingStatProvider extends LocalStorageProvider {
  override stat(_url: string): Promise<StorageObjectStat> {
    return Promise.resolve({
      exists: false,
      sizeBytes: null,
      lastModified: null,
    });
  }
}

/**
 * 模拟"后端不可达/无权限"的 provider：`stat` 抛错（而非返回 `exists:false`）。
 *
 * Handbook §2.5 / tracking #13：`stat` 异常表示**无法确认**，不能被当成不存在，
 * 更不能据此把登记行永久写成 `deleted` / `missing`。
 */
class UnreachableStatProvider extends LocalStorageProvider {
  constructor(dir: string, private readonly error: Error) {
    super(dir);
  }

  override stat(_url: string): Promise<StorageObjectStat> {
    return Promise.reject(this.error);
  }
}

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
  await ensureDefaultWorkspace();
  await getDb().insert(problems).values({
    domain_id: DEFAULT_DOMAIN_ID,
    id,
    title: id,
    description: "d",
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

Deno.test("storage registry: stat 异常不得当成不存在（#13）", async () => {
  const provider = useTempStorage();
  const bytes = new TextEncoder().encode("still-here");
  const url = await provider.put("unreachable", bytes);
  const byteSize = bytes.byteLength;
  await registerReadyStorageObject({
    storageUrl: url,
    sha256: "h",
    byteSize,
  });

  // 后端不可达：核实必须抛错，且不得把真实存在的对象写成 missing。
  setStorageProviderForTest(
    new UnreachableStatProvider(tempStorageDir, new Error("ETIMEDOUT")),
  );
  await assertRejects(() => verifyStorageObject(url), Error, "ETIMEDOUT");
  assertEquals((await getStorageObject(url))?.state, "ready");

  // 删除同样必须抛错并回滚，绝不写 deleted（此前会永久谎称已删除）。
  await assertRejects(() => deleteStorageObject(url), Error, "ETIMEDOUT");
  assertEquals((await getStorageObject(url))?.state, "ready");

  // 403（无权限）与超时同样属于"无法确认"。
  setStorageProviderForTest(
    new UnreachableStatProvider(tempStorageDir, new Error("AccessDenied: 403")),
  );
  await assertRejects(() => verifyStorageObject(url), Error, "AccessDenied");
  await assertRejects(() => deleteStorageObject(url), Error, "AccessDenied");
  assertEquals((await getStorageObject(url))?.state, "ready");

  // 后端恢复后对象仍在，核实为 ready
  const restored = useTempStorage();
  const statAfter = await restored.stat(url);
  assertEquals(statAfter.exists, true);
  assertEquals(statAfter.sizeBytes, byteSize);
  assertEquals(await verifyStorageObject(url), "ready");
});

Deno.test("storage registry: 明确的 NotFound 仍然写 missing/deleted", async () => {
  const provider = useTempStorage();
  // 明确不存在（provider 返回 exists:false，不抛错）→ 允许进入 missing / deleted
  const ghost = "noj-storage://local/YWJzZW50?checksum_sha256=abc";
  await registerReadyStorageObject({ storageUrl: ghost });
  assertEquals(await verifyStorageObject(ghost), "missing");
  assertEquals((await getStorageObject(ghost))?.state, "missing");
  assertEquals((await deleteStorageObject(ghost)).outcome, "missing");
  assertEquals((await getStorageObject(ghost))?.state, "deleted");
  assertEquals((await provider.stat(ghost)).exists, false);
});

Deno.test("storage registry: 崩溃遗留的 deleting 可续做删除（#14）", async () => {
  const provider = useTempStorage();
  const url = await provider.put(
    "crashed-delete",
    new TextEncoder().encode("crashed"),
  );
  await registerReadyStorageObject({ storageUrl: url });
  // 模拟"进程在标记 deleting 后崩溃"：状态卡在 deleting，对象仍在后端。
  await getDb().update(storageObjects).set({ state: "deleting" }).where(
    eq(storageObjects.storage_url, url),
  );
  assertEquals((await provider.stat(url)).exists, true);

  // 下一次删除必须续做而不是返回 referenced：能拿到行锁说明上一次删除已崩溃。
  assertEquals((await deleteStorageObject(url)).outcome, "deleted");
  assertEquals((await provider.stat(url)).exists, false);
  assertEquals((await getStorageObject(url))?.state, "deleted");
});

Deno.test("storage registry: 删除后重传相同内容恢复 ready 并可绑定（#14）", async () => {
  const provider = useTempStorage();
  const bytes = new TextEncoder().encode("reupload-bytes");
  const first = await provider.put("reupload", bytes);
  await registerReadyStorageObject({ storageUrl: first, sha256: "same" });
  assertEquals((await deleteStorageObject(first)).outcome, "deleted");
  await assertRejects(() => assertStorageObjectBindable(first));

  // 内容寻址：重传相同字节得到同一 URL；重传必须**先写预约再物理上传**，
  // 上传成功后携带自己的预约登记，才能把 deleted 恢复 ready（不能永久粘 deleted）。
  const again = await provider.put("reupload", bytes);
  assertEquals(again, first);
  const reservation = await reserveStorageObjectUpload({ storageUrl: again });
  await registerReadyStorageObject({
    storageUrl: again,
    sha256: "same",
    byteSize: bytes.byteLength,
    reservationId: reservation.reservation_id,
  });
  assertEquals((await getStorageObject(again))?.state, "ready");
  await assertStorageObjectBindable(again);
  assertEquals((await provider.stat(again)).exists, true);
  // 预约已被消费：不留下永久阻塞删除的残留
  assertEquals(await countReservations(again), 0);
});

Deno.test("storage registry: 未过期上传预约阻止删除（409），过期残留清理后放行", async () => {
  const provider = useTempStorage();
  const bytes = new TextEncoder().encode("reservation-guard");
  const url = await provider.put("resv-guard", bytes);

  const reservation = await reserveStorageObjectUpload({ storageUrl: url });
  assertEquals(reservation.storage_url, url);

  // 有在途上传预约：删除必须可重试地拒绝，且不得删物理文件、不得进入 deleted。
  await assertRejects(
    () => deleteStorageObject(url),
    StorageUploadInFlightError,
  );
  assertEquals((await provider.stat(url)).exists, true);
  assertEquals((await getStorageObject(url))?.state, "unknown");

  // 上传成功并携带自己的预约登记：状态 ready + 预约被消费。
  await registerReadyStorageObject({
    storageUrl: url,
    sha256: "rh",
    byteSize: bytes.byteLength,
    reservationId: reservation.reservation_id,
  });
  assertEquals((await getStorageObject(url))?.state, "ready");
  assertEquals(await countReservations(url), 0);

  // crash 遗留的过期预约不得永久阻塞删除：视为无效并清理。
  await reserveStorageObjectUpload({ storageUrl: url, ttlMs: -1000 });
  assertEquals(await countReservations(url), 1);
  assertEquals((await deleteStorageObject(url)).outcome, "deleted");
  assertEquals(await countReservations(url), 0);
  assertEquals((await getStorageObject(url))?.state, "deleted");
});

Deno.test("storage registry: 无本人未过期预约不得把 deleted 恢复 ready", async () => {
  const provider = useTempStorage();
  const bytes = new TextEncoder().encode("no-reservation-recovery");
  const url = await provider.put("no-resv", bytes);
  await registerReadyStorageObject({ storageUrl: url });
  assertEquals((await deleteStorageObject(url)).outcome, "deleted");

  // 物理重传成功，但没有本次上传的预约：不得凭"此前上传成功"恢复 ready
  // （删除可能已把文件删掉，恢复就是 ready + 物理缺失的幽灵记录）。
  await provider.put("no-resv", bytes);
  await assertRejects(
    () => registerReadyStorageObject({ storageUrl: url }),
    StorageObjectDeletedError,
  );
  assertEquals((await getStorageObject(url))?.state, "deleted");
  await assertRejects(() => assertStorageObjectBindable(url));

  // 过期预约同样不算"自己的"：不得用它恢复 ready。
  const expired = await reserveStorageObjectUpload({
    storageUrl: url,
    ttlMs: -1,
  });
  await assertRejects(
    () =>
      registerReadyStorageObject({
        storageUrl: url,
        reservationId: expired.reservation_id,
      }),
    StorageObjectDeletedError,
  );
  assertEquals((await getStorageObject(url))?.state, "deleted");

  // 正确路径：有效期内先 reserve → 物理上传 → 携带自己的预约登记 → ready 且文件在。
  const mine = await reserveStorageObjectUpload({ storageUrl: url });
  await registerReadyStorageObject({
    storageUrl: url,
    reservationId: mine.reservation_id,
  });
  assertEquals((await getStorageObject(url))?.state, "ready");
  await assertStorageObjectBindable(url);
  assertEquals((await provider.stat(url)).exists, true);
});

Deno.test("storage registry: 上传失败释放预约后删除可继续", async () => {
  const provider = useTempStorage();
  const url = await provider.put("released", new TextEncoder().encode("rel"));
  const reservation = await reserveStorageObjectUpload({ storageUrl: url });
  await assertRejects(
    () => deleteStorageObject(url),
    StorageUploadInFlightError,
  );

  // 物理上传失败：释放自己的预约，对象不得因残留预约永久卡死。
  await releaseStorageObjectUploadReservation(reservation.reservation_id);
  assertEquals(await countReservations(url), 0);
  assertEquals((await deleteStorageObject(url)).outcome, "deleted");
});

Deno.test("storage registry: 补偿不得把已删除对象恢复 ready", async () => {
  const provider = useTempStorage();
  const bytes = new TextEncoder().encode("compensate-deleted");
  const url = await provider.put("compensate", bytes);
  await registerReadyStorageObject({ storageUrl: url });
  assertEquals((await deleteStorageObject(url)).outcome, "deleted");

  // 上传补偿路径：对象已删除时不得反手登记成 ready（那会在文件缺失时谎称可用）。
  assertEquals(
    (await compensateUploadedObject({ storageUrl: url })).outcome,
    "deleted",
  );
  assertEquals((await getStorageObject(url))?.state, "deleted");
  assertEquals((await provider.stat(url)).exists, false);

  // 补偿时携带自己的预约：预约同样必须被释放，不留阻塞删除的残留。
  const reservation = await reserveStorageObjectUpload({
    storageUrl: url,
    ttlMs: -1,
  });
  assertEquals(
    (await compensateUploadedObject({
      storageUrl: url,
      reservationId: reservation.reservation_id,
    })).outcome,
    "deleted",
  );
  assertEquals(await countReservations(url), 0);
});

Deno.test("storage registry: 流式复核可把 deleted 恢复 ready——连续两次重传都成功（问题 7）", async () => {
  const provider = useTempStorage();
  // 非 zip 内容（contentType 缺省）→ 与 artifact 流式上传一致
  const bytes = new TextEncoder().encode("streamed-artifact-bytes");
  const url = await provider.putStream(
    "artifacts/x.zip",
    streamOf(bytes),
    "application/zip",
  );
  await registerReadyStorageObject({ storageUrl: url });
  assertEquals((await deleteStorageObject(url)).outcome, "deleted");
  assertEquals((await provider.stat(url)).exists, false);
  await assertRejects(() => assertStorageObjectBindable(url));

  // 复审实测：同一 ZIP 内容寻址 → 同一 URL；流式重传把字节写回，但登记行仍是
  // deleted。修复前这里永远不会恢复 ready，"重试即可"不成立；现在靠持锁 stat 复核。
  for (let attempt = 0; attempt < 2; attempt++) {
    const again = await provider.putStream(
      "artifacts/x.zip",
      streamOf(bytes),
      "application/zip",
    );
    assertEquals(again, url);
    // 上传完成、尚未复核：登记行仍是 deleted（不得凭"写回成功"自动 ready）
    assertEquals((await getStorageObject(url))?.state, "deleted");

    await registerStreamedStorageObject({ storageUrl: url });
    const row = await getStorageObject(url);
    assertEquals(row?.state, "ready");
    assertEquals(row?.byte_size, bytes.byteLength);
    // 服务端元数据取自 URL 内嵌 checksum
    assertEquals(row?.sha256, url.split("checksum_sha256=")[1]);
    await assertStorageObjectBindable(url);
    assertEquals((await provider.stat(url)).exists, true);

    // 每轮结束回到 deleted，验证第二轮同样成立
    assertEquals((await deleteStorageObject(url)).outcome, "deleted");
  }
});

Deno.test("storage registry: 流式复核 stat 确认缺失 → 拒绝绑定且不置 ready（问题 7）", async () => {
  const provider = useTempStorage();
  const bytes = new TextEncoder().encode("streamed-missing");
  const url = await provider.putStream(
    "artifacts/y.zip",
    streamOf(bytes),
    "application/zip",
  );
  await registerReadyStorageObject({ storageUrl: url });
  assertEquals((await deleteStorageObject(url)).outcome, "deleted");

  // 字节被重新写回（物理文件存在），但后端报告不存在 → 不得登记 ready
  const again = await provider.putStream(
    "artifacts/y.zip",
    streamOf(bytes),
    "application/zip",
  );
  assertEquals(again, url);
  setStorageProviderForTest(new MissingStatProvider(tempStorageDir));
  await assertRejects(
    () => registerStreamedStorageObject({ storageUrl: url }),
    StorageObjectMissingError,
  );
  assertEquals((await getStorageObject(url))?.state, "deleted");
  await assertRejects(() => assertStorageObjectBindable(url));
});

Deno.test("storage registry: 流式复核 stat 抛错不得改写登记状态（#13 同源）", async () => {
  const provider = useTempStorage();
  const bytes = new TextEncoder().encode("streamed-unreachable");
  const url = await provider.putStream(
    "artifacts/z.zip",
    streamOf(bytes),
    "application/zip",
  );
  await registerReadyStorageObject({ storageUrl: url });
  assertEquals((await deleteStorageObject(url)).outcome, "deleted");

  setStorageProviderForTest(
    new UnreachableStatProvider(tempStorageDir, new Error("ETIMEDOUT")),
  );
  await assertRejects(
    () => registerStreamedStorageObject({ storageUrl: url }),
    Error,
    "ETIMEDOUT",
  );
  // "无法确认"不等于"不存在"：不得把登记行改成 ready，也不得拒绑定以外的副作用
  assertEquals((await getStorageObject(url))?.state, "deleted");
});

Deno.test("storage registry: 首次流式上传复核直接登记 ready", async () => {
  useTempStorage();
  const bytes = new TextEncoder().encode("streamed-first-upload");
  const provider = await getStorageProvider();
  const url = await provider.putStream(
    "artifacts/first.zip",
    streamOf(bytes),
    "application/zip",
  );
  assertEquals(await getStorageObject(url), null);
  await registerStreamedStorageObject({ storageUrl: url });
  const row = await getStorageObject(url);
  assertEquals(row?.state, "ready");
  assertEquals(row?.sha256, url.split("checksum_sha256=")[1]);
  assertEquals(row?.byte_size, bytes.byteLength);
});

Deno.test("storage registry: 带预约上传（reserve→put→ready）URL 可预测且预约被消费", async () => {
  const provider = useTempStorage();
  const bytes = new TextEncoder().encode("upload-with-reservation");
  const { storageUrl } = await uploadStorageObjectWithReservation({
    key: "callers-may-pass-any-key",
    bytes,
    contentType: "application/zip",
  });

  // 内容寻址：predict（urlForUpload）与真正 put() 必须给出同一个 URL
  assertEquals(storageUrl, await provider.put("ignored-key", bytes));
  const row = await getStorageObject(storageUrl);
  assertEquals(row?.state, "ready");
  assertEquals(row?.byte_size, bytes.byteLength);
  assertEquals(await countReservations(storageUrl), 0);
  await assertStorageObjectBindable(storageUrl);
  assertEquals((await provider.stat(storageUrl)).exists, true);
});

Deno.test("storage registry: 带预约上传可把 deleted 对象重新登记为 ready", async () => {
  const provider = useTempStorage();
  const bytes = new TextEncoder().encode("reupload-with-reservation");
  const url = await provider.put("reup-resv", bytes);
  await registerReadyStorageObject({ storageUrl: url });
  assertEquals((await deleteStorageObject(url)).outcome, "deleted");
  assertEquals((await provider.stat(url)).exists, false);

  // 重传同一内容：reserve（删除前锁定 URL）→ put → 登记 ready，物理文件重建
  const { storageUrl } = await uploadStorageObjectWithReservation({
    key: "reup-resv",
    bytes,
  });
  assertEquals(storageUrl, url);
  assertEquals((await getStorageObject(url))?.state, "ready");
  assertEquals((await provider.stat(url)).exists, true);
  assertEquals(await countReservations(url), 0);
});

Deno.test("storage registry: 带预约上传后仍有引用时补偿不误删共享对象", async () => {
  const provider = useTempStorage();
  const bytes = new TextEncoder().encode("shared-with-reservation");
  const { storageUrl } = await uploadStorageObjectWithReservation({
    key: "shared-resv",
    bytes,
  });
  await seedProblem("sr-resv-prob", 910002);
  await getDb().insert(problemDraftObjects).values({
    problem_id: "sr-resv-prob",
    role: "support_package",
    path: "package.zip",
    storage_url: storageUrl,
  });

  // 后续事务失败 → 补偿：有引用时保留字节，只解绑
  const outcome = await compensateUploadedObject({ storageUrl });
  assertEquals(outcome.outcome, "referenced");
  assertEquals((await provider.stat(storageUrl)).exists, true);
  assertEquals((await getStorageObject(storageUrl))?.state, "ready");
  await getDb().delete(problemDraftObjects).where(
    eq(problemDraftObjects.problem_id, "sr-resv-prob"),
  );
  await getDb().delete(problems).where(eq(problems.id, "sr-resv-prob"));
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
