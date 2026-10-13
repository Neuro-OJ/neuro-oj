import { deleteProblemFixtures } from "../../../../../tests/helper.ts";
/**
 * 真实 PostgreSQL 并发/锁协议验证（tracking #12、#30；2026-10-11 复审问题 1、5）。
 *
 * PGlite 是单连接内存库，无法验证行锁排队与互斥，因此这些用例只在设置了
 * `DATABASE_URL` 时运行（`ignore: !HAS_PG`）。本文件关闭 preload 事务包装
 * （并发用例必须各自持锁），所有夹具在用例结束时显式清理。
 *
 * 原生连接一律走 `tests/helper/pg-raw-connection.ts`：裸 `postgres(DATABASE_URL)`
 * 不带 `TEST_SCHEMA` 的 search_path，会在分片/独立 schema 下操作另一套表
 * （2026-10-11 复审问题 5，"可绑定检查 + 插入引用"必须在同一真实事务内）。
 *
 * 验证的协议（Handbook §2.5、§5.1）：
 * 1. **存储删除守卫**：登记行锁、引用检查与物理删除在同一事务内完成，
 *    "检查无引用 → 新引用建立 → 对象被删"的窗口不存在；
 * 2. **上传预约互斥**：物理上传之前先写 reservation，删除守卫见未过期 reservation
 *    即拒绝（409）；"删除在途 + 并发重传同一内容"绝不产生 `ready` + 物理缺失；
 * 3. **锁顺序 题目 → 竞赛 → 提交 → 尝试 → revision**：结果写入对题目取共享锁、
 *    策略切换对策略宿主取更新锁，二者互斥，后到的策略重算不会用旧候选覆盖新投影。
 */
import { DEFAULT_DOMAIN_ID } from "../../../../shared/workspace/types.ts";
import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq, sql } from "drizzle-orm";
import { unwrapRows } from "../../../../shared/base/sql-rows.ts";
import {
  createRawClient,
  withRawTransaction,
} from "../../../../../tests/helper/pg-raw-connection.ts";
import {
  disableTestTransactionForFile,
  getDb,
} from "../../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  educationOutbox,
  evaluationAttempts,
  problemBindingHistory,
  problems,
  problemVersions,
  storageObjectReservations,
  storageObjects,
  submissions,
  submissionVersionResults,
} from "../../../../shared/db/schema.ts";
import {
  assertStorageObjectBindable,
  deleteStorageObject,
  getStorageObject,
  registerReadyStorageObject,
  registerStreamedStorageObject,
  reserveStorageObjectUpload,
  StorageObjectMissingError,
  StorageUploadInFlightError,
} from "../../../system/services/storage/registry.ts";
import {
  getStorageProvider,
  setStorageProviderForTest,
} from "../../../system/services/storage/factory.ts";
import { LocalStorageProvider } from "../../../system/services/storage/local.ts";
import { applyAttemptResult } from "../../services/versioning/result-write.ts";
import { setProblemEffectiveVersionPolicy } from "../../services/versioning/effective-policy.ts";
import { bindMainProblemForTest } from "../_versioning-fixtures.ts";

const HAS_PG = !!Deno.env.get("DATABASE_URL");
if (HAS_PG) disableTestTransactionForFile();

const tempStorageDir = Deno.makeTempDirSync({ prefix: "noj-lock-order-" });
setStorageProviderForTest(new LocalStorageProvider(tempStorageDir));

const db = getDb();
const now = new Date().toISOString();

/**
 * 可在物理 `delete()` 上挂闸门的 provider：让删除事务停在"已持登记行锁、正在删
 * 物理文件"的位置，从而确定性地复现"删除在途 + 并发重传"的竞争窗口。
 *
 * 只有显式 `armGate()` 后才阻塞；未挂闸门时行为与 `LocalStorageProvider` 一致。
 */
class GatedDeleteProvider extends LocalStorageProvider {
  private gate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;
  /** 进入物理删除阶段时回调（测试据此确认删除已持锁并执行到物理删除）。 */
  onPhysicalDelete: (() => void) | null = null;

  armGate(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  openGate(): void {
    this.releaseGate?.();
    this.releaseGate = null;
  }

  override async delete(url: string): Promise<void> {
    this.onPhysicalDelete?.();
    if (this.gate) await this.gate;
    await super.delete(url);
  }
}

/** 极短等待；仅用于让被阻塞的事务进入 PostgreSQL 锁队列。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 构造与 `putStream()` 对接的字节流（流式上传路径）。 */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes as unknown as BlobPart]).stream();
}

/** 轮询等待条件成立（避免用固定 sleep 猜锁时序）。 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待并发条件超时");
    await sleep(10);
  }
}

async function seedProblem(id: string, number: number): Promise<string> {
  const versionId = `${id}-v1`;
  await db.insert(problems).values({
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
  await db.insert(problemVersions).values({
    id: versionId,
    problem_id: id,
    version: 1,
    origin: "published",
    content: { kind: "ai", title: id, description: "d", samples: [] },
    published_at: now,
  });
  await db.update(problems).set({ latest_version_id: versionId }).where(
    eq(problems.id, id),
  );
  return versionId;
}

async function cleanupProblem(id: string): Promise<void> {
  await db.delete(educationOutbox).where(eq(educationOutbox.problem_id, id));
  await db.delete(submissionVersionResults).where(
    eq(submissionVersionResults.problem_id, id),
  );
  await db.delete(evaluationAttempts).where(
    eq(evaluationAttempts.problem_id, id),
  );
  await db.delete(submissions).where(eq(submissions.problem_id, id));
  const bindings = await db.select({ id: domainProblemBindings.id }).from(
    domainProblemBindings,
  ).where(eq(domainProblemBindings.problem_id, id));
  for (const binding of bindings) {
    await db.delete(problemBindingHistory).where(
      eq(problemBindingHistory.binding_id, binding.id),
    );
  }
  await db.delete(domainProblemBindings).where(
    eq(domainProblemBindings.problem_id, id),
  );
  await db.update(problems).set({
    latest_version_id: null,
    // 策略可能已被切换为 exact(X)：先解开对版本的外键引用再删版本
    required_version_id: null,
    effective_version_mode: "any",
  }).where(eq(problems.id, id));
  await db.delete(problemVersions).where(eq(problemVersions.problem_id, id));
  await deleteProblemFixtures(eq(problems.id, id));
}

/** 清理存储夹具：预约行、登记行、引用该对象的提交。 */
async function cleanupStorageObject(storageUrl: string): Promise<void> {
  await db.delete(storageObjectReservations).where(
    eq(storageObjectReservations.storage_url, storageUrl),
  );
  await db.delete(submissions).where(
    eq(submissions.artifact_storage_url, storageUrl),
  );
  await db.delete(storageObjects).where(
    eq(storageObjects.storage_url, storageUrl),
  );
}

/**
 * 本文件关闭了 preload 事务包装，失败中断可能留下夹具；按题号自愈清理，
 * 保证重复运行/失败重跑不会因唯一约束或残留状态而误报。
 */
async function cleanupByNumber(number: number): Promise<void> {
  const rows = await db.select({ id: problems.id }).from(problems).where(
    eq(problems.number, number),
  );
  for (const row of rows) await cleanupProblem(row.id);
}

Deno.test({
  name: "pg lock: 删除与绑定互斥——已删对象不可能被新引用绑定（#12）",
  ignore: !HAS_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = await getStorageProvider();
    const url = await provider.put(
      `locks/${crypto.randomUUID()}`,
      new TextEncoder().encode("lock-guard"),
    );
    await registerReadyStorageObject({
      storageUrl: url,
      sha256: "h",
      byteSize: 10,
    });
    const problemId = `pg-lock-p1-${crypto.randomUUID().slice(0, 8)}`;
    await cleanupByNumber(986001);
    const versionId = await seedProblem(problemId, 986001);

    // A：显式持有登记行锁，让"删除"与"绑定"都停在锁外并进入 FIFO 队列
    const barrier = createRawClient();
    await barrier`BEGIN`;
    await barrier`SELECT storage_url FROM storage_objects WHERE storage_url = ${url} FOR UPDATE`;

    let deleteSettled = false;
    let bindSettled = false;
    const deletePromise = withRawTransaction(async (tx) => {
      const outcome = await deleteStorageObject(url, tx);
      deleteSettled = true;
      return outcome;
    });
    // 预期失败的并发 Promise 必须先安装拒绝处理，否则可能触发 uncaught rejection。
    const deleteGuard = deletePromise.catch(() => {});
    await sleep(150);
    // B：模拟真实绑定路径（断言可绑定 + 同一真实事务插入引用）
    const bindPromise = withRawTransaction(async (tx) => {
      await assertStorageObjectBindable(url, tx);
      await tx.insert(submissions).values({
        id: `pg-lock-bind-${crypto.randomUUID()}`,
        user_id: "0",
        problem_id: problemId,
        language: "python3",
        code: "",
        artifact_storage_url: url,
        submitted_version_id: versionId,
        version_origin: "known",
        status: "pending",
        created_at: now,
      });
      bindSettled = true;
      return "bound";
    });
    const bindGuard = bindPromise.catch(() => {});

    await sleep(250);
    // 锁被 A 持有：删除与绑定都必须阻塞（证明二者争用同一登记行锁）
    assertEquals(deleteSettled, false);
    assertEquals(bindSettled, false);

    await barrier`COMMIT`;
    await barrier.end();

    const deleteOutcome = await deletePromise;
    assertEquals(deleteOutcome.outcome, "deleted");
    // 排队在后的绑定必须失败：对象已 deleted，不能建立新引用
    await assertRejects(() => bindPromise, Error, "不能建立新引用");
    await deleteGuard;
    await bindGuard;

    // 物理对象已删除，且没有任何提交引用它
    assertEquals((await provider.stat(url)).exists, false);
    assertEquals(
      (await db.select().from(submissions).where(
        eq(submissions.artifact_storage_url, url),
      )).length,
      0,
    );
    await cleanupStorageObject(url);
    await cleanupProblem(problemId);
  },
});

Deno.test({
  name:
    "pg lock: 删除执行期间重传并绑定——绝不出现 ready 但物理缺失（复审问题 1）",
  ignore: !HAS_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = new GatedDeleteProvider(tempStorageDir);
    setStorageProviderForTest(provider);
    const bytes = new TextEncoder().encode("delete-during-reupload");
    const url = await provider.put(
      `locks/${crypto.randomUUID()}`,
      bytes,
    );
    await registerReadyStorageObject({
      storageUrl: url,
      sha256: "h",
      byteSize: bytes.byteLength,
    });
    assertEquals((await provider.stat(url)).exists, true);

    const problemId = `pg-lock-p3-${crypto.randomUUID().slice(0, 8)}`;
    await cleanupByNumber(986003);
    const versionId = await seedProblem(problemId, 986003);

    // 删除执行到"已持登记行锁 + 即将物理删除"并被闸门卡住
    provider.armGate();
    let deleteReachedPhysical = false;
    provider.onPhysicalDelete = () => {
      deleteReachedPhysical = true;
    };
    const deletePromise = withRawTransaction((tx) =>
      deleteStorageObject(url, tx)
    );
    const deleteGuard = deletePromise.catch(() => {});
    await waitFor(() => deleteReachedPhysical);

    // 并发重传：reserve 必须先于物理上传，且与删除争用同一登记行锁
    let reserved = false;
    let putDone = false;
    const uploadPromise = withRawTransaction(async (tx) => {
      const reservation = await reserveStorageObjectUpload(
        { storageUrl: url },
        tx,
      );
      reserved = true;
      const again = await provider.put(`locks/${crypto.randomUUID()}`, bytes);
      putDone = true;
      assertEquals(again, url);
      await registerReadyStorageObject({
        storageUrl: url,
        sha256: "h",
        byteSize: bytes.byteLength,
        reservationId: reservation.reservation_id,
      }, tx);
      await assertStorageObjectBindable(url, tx);
      await tx.insert(submissions).values({
        id: `pg-lock-reup-${crypto.randomUUID()}`,
        user_id: "0",
        problem_id: problemId,
        language: "python3",
        code: "",
        artifact_storage_url: url,
        submitted_version_id: versionId,
        version_origin: "known",
        status: "pending",
        created_at: now,
      });
      return reservation;
    });
    const uploadGuard = uploadPromise.catch(() => {});

    await sleep(250);
    // 修复点：删除事务持锁期间，重传的预约与物理上传都不能发生
    // （旧实现先 put 后取锁，正是这一步把文件写回去，随后被删除删掉）。
    assertEquals(reserved, false, "重传预约必须等删除事务释放登记行锁");
    assertEquals(putDone, false, "物理上传必须等删除事务结束");

    provider.openGate();
    assertEquals((await deletePromise).outcome, "deleted");
    await deleteGuard;
    const reservation = await uploadPromise;
    await uploadGuard;
    assertEquals(reserved, true);
    assertEquals(putDone, true);

    // 最终状态：要么 ready 且物理存在（本次分支：删除先完成，重传随后重建），
    // 要么 deleted；绝不出现 ready + 物理缺失。
    const row = await getStorageObject(url);
    assertEquals(row?.state, "ready");
    assertEquals((await provider.stat(url)).exists, true);
    assertEquals(
      (await db.select().from(submissions).where(
        eq(submissions.artifact_storage_url, url),
      )).length,
      1,
    );
    assertEquals(
      (await db.select().from(storageObjectReservations).where(
        eq(storageObjectReservations.storage_url, url),
      )).length,
      0,
    );
    assertEquals(reservation.storage_url, url);

    await cleanupStorageObject(url);
    await cleanupProblem(problemId);
  },
});

Deno.test({
  name: "pg lock: 未过期上传预约阻止删除且不删物理文件（复审问题 1）",
  ignore: !HAS_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = new GatedDeleteProvider(tempStorageDir);
    setStorageProviderForTest(provider);
    const bytes = new TextEncoder().encode("reservation-guard-pg");
    const url = await provider.put(
      `locks/${crypto.randomUUID()}`,
      bytes,
    );
    await registerReadyStorageObject({
      storageUrl: url,
      sha256: "h",
      byteSize: bytes.byteLength,
    });

    // 上传事务：预约已插入但事务未提交（物理上传在途）
    let reserved = false;
    let releaseReserve!: () => void;
    const holdReservation = new Promise<void>((resolve) => {
      releaseReserve = resolve;
    });
    const uploadPromise = withRawTransaction(async (tx) => {
      const reservation = await reserveStorageObjectUpload(
        { storageUrl: url },
        tx,
      );
      reserved = true;
      await holdReservation;
      return reservation;
    });
    const uploadGuard = uploadPromise.catch(() => {});
    await waitFor(() => reserved);

    // 删除必须阻塞在预约事务持有的登记行锁上
    let deleteSettled = false;
    const deletePromise = withRawTransaction(async (tx) => {
      const outcome = await deleteStorageObject(url, tx);
      deleteSettled = true;
      return outcome;
    });
    const deleteGuard = deletePromise.catch(() => {});
    await sleep(250);
    assertEquals(deleteSettled, false, "删除必须等预约事务提交");

    // 预约提交后删除看到未过期预约 → 拒绝（409），不得删文件、不得进入 deleted
    releaseReserve();
    const reservation = await uploadPromise;
    await uploadGuard;
    await assertRejects(() => deletePromise, StorageUploadInFlightError);
    await deleteGuard;
    assertEquals((await provider.stat(url)).exists, true);
    const [row] = await db.select().from(storageObjects).where(
      eq(storageObjects.storage_url, url),
    );
    assertEquals(row.state, "ready");

    // 上传完成并消费自己的预约后，删除可继续
    await registerReadyStorageObject({
      storageUrl: url,
      reservationId: reservation.reservation_id,
    });
    assertEquals((await deleteStorageObject(url)).outcome, "deleted");
    assertEquals((await provider.stat(url)).exists, false);

    await cleanupStorageObject(url);
  },
});

Deno.test({
  name:
    "pg lock: 流式重传在登记行锁内 stat 复核后可恢复 ready 并绑定（问题 7）",
  ignore: !HAS_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = new GatedDeleteProvider(tempStorageDir);
    setStorageProviderForTest(provider);
    const bytes = new TextEncoder().encode("streamed-reupload-pg");
    const url = await provider.putStream(
      `artifacts/${crypto.randomUUID()}.zip`,
      streamOf(bytes),
      "application/zip",
    );
    await registerReadyStorageObject({
      storageUrl: url,
      sha256: "h",
      byteSize: bytes.byteLength,
    });
    // 正常删除：登记 deleted 且物理文件消失
    assertEquals((await deleteStorageObject(url)).outcome, "deleted");
    assertEquals((await provider.stat(url)).exists, false);
    await assertRejects(() => assertStorageObjectBindable(url));

    const problemId = `pg-lock-p4-${crypto.randomUUID().slice(0, 8)}`;
    await cleanupByNumber(986004);
    const versionId = await seedProblem(problemId, 986004);

    // 复审实测的"连续两次重传都失败"：修复前 putStream 写回字节后登记行仍是 deleted，
    // assertStorageObjectBindable 永远拒绝；现在持锁 stat 复核把 ready 恢复回来。
    for (let attempt = 0; attempt < 2; attempt++) {
      const again = await provider.putStream(
        `artifacts/${crypto.randomUUID()}.zip`,
        streamOf(bytes),
        "application/zip",
      );
      assertEquals(again, url, "内容寻址：同一 ZIP 必须得到同一 URL");
      assertEquals((await getStorageObject(url))?.state, "deleted");

      await withRawTransaction(async (tx) => {
        await registerStreamedStorageObject({ storageUrl: url }, tx);
        await assertStorageObjectBindable(url, tx);
        await tx.insert(submissions).values({
          id: `pg-lock-stream-${crypto.randomUUID()}`,
          user_id: "0",
          problem_id: problemId,
          language: "python3",
          code: "",
          artifact_storage_url: url,
          submitted_version_id: versionId,
          version_origin: "known",
          status: "pending",
          created_at: now,
        });
      });

      assertEquals((await getStorageObject(url))?.state, "ready");
      assertEquals((await getStorageObject(url))?.byte_size, bytes.byteLength);
      assertEquals((await provider.stat(url)).exists, true);
      assertEquals(
        (await db.select().from(submissions).where(
          eq(submissions.artifact_storage_url, url),
        )).length,
        1,
      );

      // 解绑后再次删除（回到 deleted），验证下一轮同样成立
      await db.delete(submissions).where(
        eq(submissions.artifact_storage_url, url),
      );
      assertEquals((await deleteStorageObject(url)).outcome, "deleted");
      assertEquals((await provider.stat(url)).exists, false);
    }

    await cleanupStorageObject(url);
    await cleanupProblem(problemId);
  },
});

Deno.test({
  name:
    "pg lock: 流式复核与删除并发——终态只能是 ready+存在或 deleted+缺失（问题 7）",
  ignore: !HAS_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const provider = new LocalStorageProvider(tempStorageDir);
    setStorageProviderForTest(provider);
    const bytes = new TextEncoder().encode("streamed-race-pg");
    const url = await provider.putStream(
      `artifacts/${crypto.randomUUID()}.zip`,
      streamOf(bytes),
      "application/zip",
    );
    await registerReadyStorageObject({
      storageUrl: url,
      sha256: "h",
      byteSize: bytes.byteLength,
    });
    const problemId = `pg-lock-p5-${crypto.randomUUID().slice(0, 8)}`;
    await cleanupByNumber(986005);
    const versionId = await seedProblem(problemId, 986005);

    // A：持登记行锁，让"删除"与"流式复核+绑定"都停在锁外排队
    const barrier = createRawClient();
    await barrier`BEGIN`;
    await barrier`SELECT storage_url FROM storage_objects WHERE storage_url = ${url} FOR UPDATE`;

    let deleteSettled = false;
    const deletePromise = withRawTransaction(async (tx) => {
      const outcome = await deleteStorageObject(url, tx);
      deleteSettled = true;
      return outcome;
    });
    const deleteGuard = deletePromise.catch(() => {});
    await sleep(120);

    // 并发流式重传：物理写回不需要登记行锁（这正是旧实现踩的坑：写回成功但登记
    // 永远不恢复）。流式复核 + 绑定则必须排在删除之后。
    const again = await provider.putStream(
      `artifacts/${crypto.randomUUID()}.zip`,
      streamOf(bytes),
      "application/zip",
    );
    assertEquals(again, url);
    assertEquals((await provider.stat(url)).exists, true);

    const bindPromise = withRawTransaction(async (tx) => {
      await registerStreamedStorageObject({ storageUrl: url }, tx);
      await assertStorageObjectBindable(url, tx);
      await tx.insert(submissions).values({
        id: `pg-lock-stream-${crypto.randomUUID()}`,
        user_id: "0",
        problem_id: problemId,
        language: "python3",
        code: "",
        artifact_storage_url: url,
        submitted_version_id: versionId,
        version_origin: "known",
        status: "pending",
        created_at: now,
      });
      return "bound";
    });
    const bindGuard = bindPromise.catch(() => {});

    await sleep(200);
    assertEquals(deleteSettled, false, "删除必须等 A 释放登记行锁");

    await barrier`COMMIT`;
    await barrier.end();

    // FIFO：删除先拿到锁 → 物理删掉刚写回的字节 → deleted；
    // 随后流式复核的 stat 确认缺失 → 拒绝绑定。绝不出现 ready + 物理缺失。
    assertEquals((await deletePromise).outcome, "deleted");
    await deleteGuard;
    await assertRejects(() => bindPromise, StorageObjectMissingError);
    await bindGuard;
    assertEquals((await getStorageObject(url))?.state, "deleted");
    assertEquals((await provider.stat(url)).exists, false);
    assertEquals(
      (await db.select().from(submissions).where(
        eq(submissions.artifact_storage_url, url),
      )).length,
      0,
    );

    // 重试即可成功（不是"永久无法重提"）：写回 + 持锁复核 + 绑定 → ready 且物理存在
    const retryUrl = await provider.putStream(
      `artifacts/${crypto.randomUUID()}.zip`,
      streamOf(bytes),
      "application/zip",
    );
    assertEquals(retryUrl, url);
    await withRawTransaction(async (tx) => {
      await registerStreamedStorageObject({ storageUrl: url }, tx);
      await assertStorageObjectBindable(url, tx);
      await tx.insert(submissions).values({
        id: `pg-lock-stream-${crypto.randomUUID()}`,
        user_id: "0",
        problem_id: problemId,
        language: "python3",
        code: "",
        artifact_storage_url: url,
        submitted_version_id: versionId,
        version_origin: "known",
        status: "pending",
        created_at: now,
      });
    });
    assertEquals((await getStorageObject(url))?.state, "ready");
    assertEquals((await provider.stat(url)).exists, true);

    await cleanupStorageObject(url);
    await cleanupProblem(problemId);
  },
});

Deno.test({
  name: "pg lock: 策略切换与结果写入互斥且不丢更新（#30）",
  ignore: !HAS_PG,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const problemId = `pg-lock-p2-${crypto.randomUUID().slice(0, 8)}`;
    await cleanupByNumber(986002);
    const versionId = await seedProblem(problemId, 986002);
    const submissionId = `pg-lock-sub-${crypto.randomUUID()}`;
    const attemptId = `pg-lock-att-${crypto.randomUUID()}`;
    await db.insert(submissions).values({
      id: submissionId,
      user_id: "0",
      problem_id: problemId,
      language: "python3",
      code: "print(1)",
      submitted_version_id: versionId,
      version_origin: "known",
      status: "pending",
      judge_run_id: attemptId,
      rejudge_seq: 0,
      created_at: now,
    });
    await db.insert(evaluationAttempts).values({
      id: attemptId,
      submission_id: submissionId,
      problem_id: problemId,
      problem_version_id: versionId,
      sequence: 0,
      source: "initial",
      state: "judging",
      created_at: now,
    });
    await db.update(submissions).set({ active_attempt_id: attemptId }).where(
      eq(submissions.id, submissionId),
    );
    await bindMainProblemForTest(problemId);

    // A：持有题目行更新锁（模拟"策略宿主正被修改"）
    const barrier = createRawClient();
    await barrier`BEGIN`;
    await barrier`SELECT id FROM problems WHERE id = ${problemId} FOR UPDATE`;
    const [barrierIdentity] = await barrier`SELECT pg_backend_pid() AS pid`;

    let resultSettled = false;
    let policySettled = false;
    let resultPid = 0;
    let policyPid = 0;
    // B：结果写入（对题目取共享锁 → 必须等待 A）
    const resultPromise = withRawTransaction(async (tx) => {
      resultPid = unwrapRows<{ pid: number }>(
        await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as never,
      )[0].pid;
      const outcome = await applyAttemptResult({
        attemptId,
        resultKind: "graded",
        resultStatus: "finished",
        score: 10000,
        accepted: true,
        output: "AC",
        details: {},
      }, tx);
      resultSettled = true;
      return outcome;
    });
    const resultGuard = resultPromise.catch(() => {});
    let resultBlocked = false;
    const resultDeadline = Date.now() + 5000;
    while (Date.now() < resultDeadline) {
      const [row] =
        await barrier`SELECT ${barrierIdentity.pid} = ANY(pg_blocking_pids(${resultPid})) AS blocked`;
      if (row.blocked) {
        resultBlocked = true;
        break;
      }
      await sleep(10);
    }
    // C：策略切换（对策略宿主取更新锁 → 排在 B 之后）
    const policyPromise = withRawTransaction(async (tx) => {
      policyPid = unwrapRows<{ pid: number }>(
        await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as never,
      )[0].pid;
      const result = await tx.transaction((inner) =>
        setProblemEffectiveVersionPolicy(problemId, {
          policy: { mode: "exact", version_id: versionId },
          expectedRevision: 0,
        }, inner)
      );
      policySettled = true;
      return result;
    });
    const policyGuard = policyPromise.catch(() => {});

    let policyBlocked = false;
    const policyDeadline = Date.now() + 5000;
    while (Date.now() < policyDeadline) {
      const [row] =
        await barrier`SELECT ${resultPid} = ANY(pg_blocking_pids(${policyPid})) AS blocked`;
      if (row.blocked) {
        policyBlocked = true;
        break;
      }
      await sleep(10);
    }
    const resultPendingAtBarrier = !resultSettled;
    const policyPendingAtBarrier = !policySettled;

    await barrier`COMMIT`;
    await barrier.end();

    const applied = await resultPromise;
    const policy = await policyPromise;
    await resultGuard;
    await policyGuard;
    assertEquals(
      resultBlocked,
      true,
      "结果写入必须已持域共享锁并阻塞于源题屏障",
    );
    assertEquals(policyBlocked, true, "策略切换必须阻塞于结果写入的域共享锁");
    assertEquals(resultPendingAtBarrier, true);
    assertEquals(policyPendingAtBarrier, true);
    assertEquals(applied.applied, "graded");
    assertEquals(policy.revision, 1);

    // 结果先落库，策略随后重算：exact(V1) + V1 的 AC 必须同时可见（无丢更新）
    const [row] = await db.select().from(submissions).where(
      eq(submissions.id, submissionId),
    );
    assertEquals(row.status, "finished");
    assertEquals(row.active_attempt_id, null);
    assertEquals(row.is_valid, true);
    assertEquals(row.is_accepted, true);
    assertEquals(row.effective_attempt_id, attemptId);
    // 策略 revision 写在提交行上，证明策略重算发生在结果写入之后
    assertEquals(row.global_policy_revision, 1);
    assertEquals(
      (await db.select().from(submissionVersionResults).where(
        eq(submissionVersionResults.submission_id, submissionId),
      )).length,
      1,
    );
    await cleanupProblem(problemId);
  },
});
