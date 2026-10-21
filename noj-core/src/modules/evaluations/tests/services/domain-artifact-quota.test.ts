import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { eq } from "drizzle-orm";
import { domainLimits, submissions } from "../../../../shared/db/schema.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { getRedis } from "../../../../shared/mq/connection.ts";
import { getDomainStorageUsage } from "../../../access/workspace/index.ts";
import {
  LocalStorageProvider,
  resetStorageProvider,
  setStorageProviderForTest,
} from "../../../assets/storage/mod.ts";
import {
  createDomainArtifactSubmission,
  createDomainSelfTest,
  createDomainSubmission,
} from "../../index.ts";
import { fixture, withQueue } from "../_domain-execution-fixture.ts";

function zip(size = 8) {
  const bytes = new Uint8Array(size);
  bytes.set([80, 75, 3, 4]);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}
class DownloadFailure extends LocalStorageProvider {
  override downloadUrl(_url: string): Promise<string> {
    return Promise.reject(new Error("download failed"));
  }
}

Deno.test({
  name: "域流式产物: 写入前预留容量，超限拒绝并释放，目标域各计自己的产物",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture("artifact"), dir = await Deno.makeTempDir();
    setStorageProviderForTest(new LocalStorageProvider(dir));
    try {
      await f.db.update(domainLimits).set({ storage_bytes: 10 }).where(
        eq(domainLimits.domain_id, f.a.id),
      );
      await withQueue(async () => {
        await createDomainArtifactSubmission(f.a.slug, f.ref, f.student, {
          file_name: "answer.zip",
          file_stream: zip(),
          version_id: f.v2,
        });
        assertEquals(await getDomainStorageUsage(f.a.id), {
          used: 8,
          reserved: 0,
        });
        const error = await assertRejects(
          () =>
            createDomainArtifactSubmission(f.a.slug, f.ref, f.student, {
              file_name: "answer.zip",
              file_stream: zip(),
              version_id: f.v2,
            }),
          AppError,
        );
        assertEquals(error.code, "DOMAIN_STORAGE_LIMIT");
        assertEquals(await getDomainStorageUsage(f.a.id), {
          used: 8,
          reserved: 0,
        });
        await createDomainArtifactSubmission(f.b.slug, f.ref, f.student, {
          file_name: "answer.zip",
          file_stream: zip(),
          version_id: f.v2,
        });
        assertEquals(await getDomainStorageUsage(f.b.id), {
          used: 8,
          reserved: 0,
        });
        assertEquals((await f.db.select().from(submissions)).length, 2);
      });
    } finally {
      resetStorageProvider();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "域流式产物: 上传后失败删除物理对象并释放预约；有限域频率Redis坏时不创建提交、自测或产物",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const f = await fixture("artifact"), dir = await Deno.makeTempDir();
    setStorageProviderForTest(new DownloadFailure(dir));
    try {
      await withQueue(async () => {
        const failed = await assertRejects(
          () =>
            createDomainArtifactSubmission(f.a.slug, f.ref, f.student, {
              file_name: "answer.zip",
              file_stream: zip(),
              version_id: f.v2,
            }),
          AppError,
        );
        assertEquals(failed.code, "ARTIFACT_DOWNLOAD_ERROR");
        assertEquals(await getDomainStorageUsage(f.a.id), {
          used: 0,
          reserved: 0,
        });
        assertEquals((await f.db.select().from(submissions)).length, 0);
        await f.db.update(domainLimits).set({ submissions_per_minute: 1 })
          .where(eq(domainLimits.domain_id, f.a.id));
        getRedis().disconnect();
        const unavailable = await assertRejects(
          () =>
            createDomainArtifactSubmission(f.a.slug, f.ref, f.student, {
              file_name: "answer.zip",
              file_stream: zip(),
              version_id: f.v2,
            }),
          AppError,
        );
        assertEquals(unavailable.statusCode, 503);
        assertEquals(await getDomainStorageUsage(f.a.id), {
          used: 0,
          reserved: 0,
        });
      });
    } finally {
      resetStorageProvider();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "域提交频率: Redis不可用时正式代码与自测在执行前拒绝",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const code = await fixture();
    await withQueue(async () => {
      await code.db.update(domainLimits).set({ submissions_per_minute: 1 })
        .where(eq(domainLimits.domain_id, code.a.id));
      getRedis().disconnect();
      for (
        const create of [
          () =>
            createDomainSubmission(code.a.slug, code.ref, code.student, {
              language: "python3",
              code: "print(1)",
              version_id: code.v2,
            }),
          () =>
            createDomainSelfTest(code.a.slug, code.ref, code.student, {
              language: "python3",
              code: "print(1)",
              version_id: code.v2,
              cases: [],
            }),
        ]
      ) {
        const rejected = await assertRejects(create, AppError);
        assertEquals(rejected.code, "DOMAIN_SUBMISSION_QUOTA_UNAVAILABLE");
      }
      assertEquals((await code.db.select().from(submissions)).length, 0);
    });
  },
});
