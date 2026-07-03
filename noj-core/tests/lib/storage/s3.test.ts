/**
 * S3StorageProvider 测试
 *
 * 需要 MinIO 服务运行中（STORAGE_PROVIDER=s3 + S3_ENDPOINT 指向 MinIO）。
 * 缺失时静默跳过。
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { isStorageUrl, parseStorageUrl } from "../../../src/lib/storage/types.ts";

/** 检查 MinIO 是否可用（不抛出 env 权限错误） */
function hasMinioConfig(): boolean {
  try {
    return !!Deno.env.get("S3_ENDPOINT") &&
      Deno.env.get("STORAGE_PROVIDER") === "s3";
  } catch {
    return false;
  }
}

const skip = !hasMinioConfig();

Deno.test({
  name: "S3StorageProvider: put 返回 noj-storage:// URL",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { S3StorageProvider } = await import(
      "../../../src/lib/storage/s3.ts"
    );
    const provider = new S3StorageProvider({
      endpoint: Deno.env.get("S3_ENDPOINT") || "http://localhost:9000",
      region: Deno.env.get("S3_REGION") || "us-east-1",
      accessKeyId: Deno.env.get("S3_ACCESS_KEY") || "minioadmin",
      secretAccessKey: Deno.env.get("S3_SECRET_KEY") || "minioadmin",
      bucket: Deno.env.get("S3_BUCKET") || "noj-support-packages",
      forcePathStyle: true,
    });
    const data = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
    const url = await provider.put("test/put-test.zip", data, "application/zip");

    assertEquals(isStorageUrl(url), true);
    const parsed = parseStorageUrl(url);
    assertEquals(parsed.provider, "s3");
    assertEquals(parsed.key, "test/put-test.zip");
    assertEquals(typeof parsed.checksumSha256, "string");
  },
});

Deno.test({
  name: "S3StorageProvider: get 返回存储的数据",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { S3StorageProvider } = await import(
      "../../../src/lib/storage/s3.ts"
    );
    const provider = new S3StorageProvider({
      endpoint: Deno.env.get("S3_ENDPOINT") || "http://localhost:9000",
      region: Deno.env.get("S3_REGION") || "us-east-1",
      accessKeyId: Deno.env.get("S3_ACCESS_KEY") || "minioadmin",
      secretAccessKey: Deno.env.get("S3_SECRET_KEY") || "minioadmin",
      bucket: Deno.env.get("S3_BUCKET") || "noj-support-packages",
      forcePathStyle: true,
    });
    const data = new Uint8Array([0x50, 0x4b, 0x01, 0x02, 0, 0, 0, 0]);
    const url = await provider.put("test/get-test.zip", data, "application/zip");

    const result = await provider.get(url);
    assertEquals(result.length, data.length);
    assertEquals(result[0], data[0]);
  },
});

Deno.test({
  name: "S3StorageProvider: delete 幂等删除",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { S3StorageProvider } = await import(
      "../../../src/lib/storage/s3.ts"
    );
    const provider = new S3StorageProvider({
      endpoint: Deno.env.get("S3_ENDPOINT") || "http://localhost:9000",
      region: Deno.env.get("S3_REGION") || "us-east-1",
      accessKeyId: Deno.env.get("S3_ACCESS_KEY") || "minioadmin",
      secretAccessKey: Deno.env.get("S3_SECRET_KEY") || "minioadmin",
      bucket: Deno.env.get("S3_BUCKET") || "noj-support-packages",
      forcePathStyle: true,
    });
    const data = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
    const url = await provider.put("test/delete-test.zip", data, "application/zip");

    await provider.delete(url);
    await provider.delete(url);
  },
});

Deno.test({
  name: "S3StorageProvider: downloadUrl 返回 noj-download:// URL",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { S3StorageProvider } = await import(
      "../../../src/lib/storage/s3.ts"
    );
    const provider = new S3StorageProvider({
      endpoint: Deno.env.get("S3_ENDPOINT") || "http://localhost:9000",
      region: Deno.env.get("S3_REGION") || "us-east-1",
      accessKeyId: Deno.env.get("S3_ACCESS_KEY") || "minioadmin",
      secretAccessKey: Deno.env.get("S3_SECRET_KEY") || "minioadmin",
      bucket: Deno.env.get("S3_BUCKET") || "noj-support-packages",
      forcePathStyle: true,
    });
    const data = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
    const storageUrl = await provider.put(
      "test/download-url-test.zip",
      data,
      "application/zip",
    );

    const downloadUrl = await provider.downloadUrl(storageUrl, 3600);
    assertEquals(downloadUrl.startsWith("noj-download://s3?url="), true);
    assertEquals(downloadUrl.includes("checksum_sha256="), true);
  },
});

Deno.test({
  name: "S3StorageProvider: ensureBucket 不抛出错误",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { S3StorageProvider } = await import(
      "../../../src/lib/storage/s3.ts"
    );
    const provider = new S3StorageProvider({
      endpoint: Deno.env.get("S3_ENDPOINT") || "http://localhost:9000",
      region: Deno.env.get("S3_REGION") || "us-east-1",
      accessKeyId: Deno.env.get("S3_ACCESS_KEY") || "minioadmin",
      secretAccessKey: Deno.env.get("S3_SECRET_KEY") || "minioadmin",
      bucket: Deno.env.get("S3_BUCKET") || "noj-support-packages",
      forcePathStyle: true,
    });
    await provider.ensureBucket();
  },
});

Deno.test({
  name: "S3StorageProvider: get 不存在的 key 抛出错误",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { S3StorageProvider } = await import(
      "../../../src/lib/storage/s3.ts"
    );
    const provider = new S3StorageProvider({
      endpoint: Deno.env.get("S3_ENDPOINT") || "http://localhost:9000",
      region: Deno.env.get("S3_REGION") || "us-east-1",
      accessKeyId: Deno.env.get("S3_ACCESS_KEY") || "minioadmin",
      secretAccessKey: Deno.env.get("S3_SECRET_KEY") || "minioadmin",
      bucket: Deno.env.get("S3_BUCKET") || "noj-support-packages",
      forcePathStyle: true,
    });
    await assertRejects(
      () => provider.get("noj-storage://s3/nonexistent-key.zip"),
    );
  },
});
