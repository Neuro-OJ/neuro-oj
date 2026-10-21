import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { resetDbForTest } from "../../../../../tests/helpers/db.ts";
import {
  domainLimits,
  problemDraftObjects,
  problems,
  storageObjects,
} from "../../../../shared/db/schema.ts";
import { AppError, ConflictError } from "../../../../shared/base/errors.ts";
import { createUserToken } from "../../../../../tests/helper.ts";
import { verifyToken } from "../../../access/identity/index.ts";
import { userActorFromAuthenticatedId } from "../../../access/index.ts";
import {
  compensateUploadedObject,
  registerLegacyStorageObject,
  reserveStorageObjectUploadForContent,
  uploadStorageObjectWithReservation,
} from "../../index.ts";
import { reconcileDomainStorageBatch } from "../../services/domain-reconciliation.ts";
import {
  getDomainStorageUsage,
  growDomainStorageUpload,
  releaseDomainStorageObject,
  releaseDomainStorageUpload,
  reserveDomainStorageUpload,
  settleDomainStorageUpload,
} from "../../services/storage-quota.ts";
import {
  LocalStorageProvider,
  resetStorageProvider,
  setStorageProviderForTest,
} from "../../storage/mod.ts";
import { updateSetting } from "../../../platform/index.ts";
import {
  createDomain,
  ensureDefaultWorkspace,
} from "../../../access/workspace/index.ts";

async function fixture() {
  await resetDbForTest();
  const actor = await verifyToken(await createUserToken());
  await ensureDefaultWorkspace();
  await updateSetting(
    "domain_creation_policy",
    "open",
    userActorFromAuthenticatedId(actor.sub),
    undefined,
    { ipAddress: "assets-test" },
  );
  const domain = await createDomain({
    slug: "storage-school",
    name: "学校",
    preset: "education",
  }, actor.sub);
  await getDb().update(domainLimits).set({ storage_bytes: 10 }).where(
    eq(domainLimits.domain_id, domain.id),
  );
  return domain.id;
}

Deno.test({
  name: "存储容量: 崩溃后物理对象核对并释放，存量未知大小核实后纳入源域",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const domain = await fixture(), directory = await Deno.makeTempDir();
    const provider = new LocalStorageProvider(directory);
    setStorageProviderForTest(provider);
    try {
      const bytes = new Uint8Array([3, 4, 5]);
      const predicted = await reserveStorageObjectUploadForContent({
        key: "crashed-upload",
        bytes,
        ttlMs: -1,
      });
      await reserveDomainStorageUpload({
        domainId: domain,
        bytes: 3,
        storageUrl: predicted.storageUrl,
        ttlMs: -1,
      });
      await provider.put("crashed-upload", bytes);
      // 崩溃后不能仅因预约超时归零：字节仍占用，直到真实删除成功。
      assertEquals(await getDomainStorageUsage(domain), {
        used: 0,
        reserved: 3,
      });
      assertEquals((await reconcileDomainStorageBatch()).recovered, 1);
      assertEquals((await provider.stat(predicted.storageUrl)).exists, false);
      assertEquals(await getDomainStorageUsage(domain), {
        used: 0,
        reserved: 0,
      });

      const url = await provider.put(
        "legacy-object",
        new Uint8Array([8, 9, 10, 11]),
      );
      await registerLegacyStorageObject(url);
      const id = crypto.randomUUID(), now = new Date().toISOString();
      await getDb().insert(problems).values({
        id,
        domain_id: domain,
        number: 1001,
        title: "旧源题",
        description: "",
        visibility: "public",
        created_at: now,
        updated_at: now,
      });
      await getDb().insert(problemDraftObjects).values({
        problem_id: id,
        role: "support_package",
        path: "support.zip",
        storage_url: url,
      });
      const unknown = await assertRejects(
        () => reserveDomainStorageUpload({ domainId: domain, bytes: 1 }),
        ConflictError,
      );
      assertEquals(unknown.code, "DOMAIN_STORAGE_BASELINE_REQUIRED");
      const reconciled = await reconcileDomainStorageBatch();
      assertEquals(reconciled.verified, 1);
      assertEquals(reconciled.failed, 0);
      assertEquals(await getDomainStorageUsage(domain), {
        used: 4,
        reserved: 0,
      });
      // 再次执行不重复计量，也不删除已有源题引用。
      await reconcileDomainStorageBatch();
      assertEquals((await provider.stat(url)).exists, true);
      assertEquals(await getDomainStorageUsage(domain), {
        used: 4,
        reserved: 0,
      });
    } finally {
      resetStorageProvider();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "存储容量: 预约在最后容量前拒绝、幂等结算与同域对象只计一次",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const domain = await fixture(), id = crypto.randomUUID();
    const reserved = await reserveDomainStorageUpload({
      domainId: domain,
      bytes: 8,
      id,
    });
    assertEquals(
      (await reserveDomainStorageUpload({ domainId: domain, bytes: 8, id })).id,
      reserved.id,
    );
    assertEquals(await getDomainStorageUsage(domain), { used: 0, reserved: 8 });
    const error = await assertRejects(
      () => reserveDomainStorageUpload({ domainId: domain, bytes: 3 }),
      AppError,
    );
    assertEquals(error.code, "DOMAIN_STORAGE_LIMIT");
    const url = "noj-storage://local/domain-capacity-test";
    await getDb().insert(storageObjects).values({
      storage_url: url,
      byte_size: 5,
      state: "ready",
      created_at: new Date().toISOString(),
    });
    await settleDomainStorageUpload(domain, id, url);
    await settleDomainStorageUpload(domain, id, url);
    assertEquals(await getDomainStorageUsage(domain), { used: 5, reserved: 0 });
    const duplicate = await reserveDomainStorageUpload({
      domainId: domain,
      bytes: 5,
    });
    await settleDomainStorageUpload(domain, duplicate.id, url);
    assertEquals(await getDomainStorageUsage(domain), { used: 5, reserved: 0 });
    await getDb().transaction((tx) => releaseDomainStorageObject(url, tx));
    await getDb().transaction((tx) => releaseDomainStorageObject(url, tx));
    assertEquals(await getDomainStorageUsage(domain), { used: 0, reserved: 0 });
  },
});

Deno.test({
  name: "存储容量: 流式增补先检查上限，失败取消释放且过期不能继续结算",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const domain = await fixture();
    const upload = await reserveDomainStorageUpload({
      domainId: domain,
      bytes: 0,
    });
    await growDomainStorageUpload(domain, upload.id, 7);
    await growDomainStorageUpload(domain, upload.id, 3);
    await assertRejects(
      () => growDomainStorageUpload(domain, upload.id, 1),
      AppError,
    );
    assertEquals(await getDomainStorageUsage(domain), {
      used: 0,
      reserved: 10,
    });
    await releaseDomainStorageUpload(domain, upload.id);
    await releaseDomainStorageUpload(domain, upload.id);
    assertEquals(await getDomainStorageUsage(domain), { used: 0, reserved: 0 });
    const stale = await reserveDomainStorageUpload({
      domainId: domain,
      bytes: 10,
      ttlMs: -1,
    });
    const fresh = await reserveDomainStorageUpload({
      domainId: domain,
      bytes: 10,
    });
    assertEquals(await getDomainStorageUsage(domain), {
      used: 0,
      reserved: 10,
    });
    await assertRejects(
      () => growDomainStorageUpload(domain, stale.id, 1),
      ConflictError,
    );
    await releaseDomainStorageUpload(domain, fresh.id);
  },
});

Deno.test({
  name: "存储容量: 真实物理上传超额前拒绝、同域复用不重计且补偿释放字节",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const domain = await fixture(),
      directory = await Deno.makeTempDir({ prefix: "noj-domain-storage-" });
    const provider = new LocalStorageProvider(directory);
    let writes = 0;
    const original = provider.put.bind(provider);
    provider.put = async (...args: Parameters<typeof original>) => {
      writes++;
      if (args[0] === "fail-upload") throw new Error("模拟存储故障");
      return await original(...args);
    };
    setStorageProviderForTest(provider);
    try {
      await getDb().update(domainLimits).set({ storage_bytes: 4 }).where(
        eq(domainLimits.domain_id, domain),
      );
      const first = await uploadStorageObjectWithReservation({
        domainId: domain,
        key: "first",
        bytes: new Uint8Array([1, 2, 3, 4]),
      });
      assertEquals(await getDomainStorageUsage(domain), {
        used: 4,
        reserved: 0,
      });
      const repeated = await uploadStorageObjectWithReservation({
        domainId: domain,
        key: "same-content",
        bytes: new Uint8Array([1, 2, 3, 4]),
      });
      assertEquals(repeated.storageUrl, first.storageUrl);
      assertEquals(await getDomainStorageUsage(domain), {
        used: 4,
        reserved: 0,
      });
      const before = writes;
      await assertRejects(
        () =>
          uploadStorageObjectWithReservation({
            domainId: domain,
            key: "over-limit",
            bytes: new Uint8Array([5]),
          }),
        AppError,
      );
      assertEquals(writes, before);
      await compensateUploadedObject({ storageUrl: first.storageUrl });
      assertEquals(await getDomainStorageUsage(domain), {
        used: 0,
        reserved: 0,
      });
      await assertRejects(
        () =>
          uploadStorageObjectWithReservation({
            domainId: domain,
            key: "fail-upload",
            bytes: new Uint8Array([6, 7]),
          }),
        Error,
        "模拟存储故障",
      );
      assertEquals(await getDomainStorageUsage(domain), {
        used: 0,
        reserved: 0,
      });
    } finally {
      resetStorageProvider();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name: "存储容量: 对象未ready不可计费，实例上限和即时降低继续约束新预约",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const domain = await fixture();
    const upload = await reserveDomainStorageUpload({
      domainId: domain,
      bytes: 8,
    });
    await assertRejects(
      () =>
        settleDomainStorageUpload(
          domain,
          upload.id,
          "noj-storage://local/not-registered",
        ),
      ConflictError,
    );
    assertEquals(await getDomainStorageUsage(domain), { used: 0, reserved: 8 });
    await releaseDomainStorageUpload(domain, upload.id);
    await getDb().update(domainLimits).set({ storage_bytes: 4 }).where(
      eq(domainLimits.domain_id, domain),
    );
    await assertRejects(
      () => reserveDomainStorageUpload({ domainId: domain, bytes: 5 }),
      AppError,
    );
    await reserveDomainStorageUpload({ domainId: domain, bytes: 4 });
  },
});
