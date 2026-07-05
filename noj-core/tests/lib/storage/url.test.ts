/**
 * URL 工具测试 — `noj-storage://` 和 `noj-download://` 两种 URL 空间
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  buildBase64DownloadUrl,
  buildS3DownloadUrl,
  buildStorageUrl,
  isDownloadUrl,
  isStorageUrl,
  parseDownloadUrl,
  parseStorageUrl,
} from "../../../src/lib/storage/types.ts";

// ── `noj-storage://` 解析 ────────────────────────────────────

Deno.test("parseStorageUrl: local 模式完整 URL", () => {
  const result = parseStorageUrl(
    "noj-storage://local/aGVsbG8=?checksum_sha256=abc123",
  );
  assertEquals(result.provider, "local");
  assertEquals(result.key, "aGVsbG8=");
  assertEquals(result.checksumSha256, "abc123");
});

Deno.test("parseStorageUrl: S3 模式完整 URL", () => {
  const result = parseStorageUrl(
    "noj-storage://s3/packages/1001.zip?checksum_sha256=def456",
  );
  assertEquals(result.provider, "s3");
  assertEquals(result.key, "packages/1001.zip");
  assertEquals(result.checksumSha256, "def456");
});

Deno.test("parseStorageUrl: 无 checksum", () => {
  const result = parseStorageUrl("noj-storage://local/aGVsbG8=");
  assertEquals(result.provider, "local");
  assertEquals(result.key, "aGVsbG8=");
  assertEquals(result.checksumSha256, undefined);
});

Deno.test("parseStorageUrl: 非 noj-storage:// URL 拒绝", () => {
  assertThrows(
    () => parseStorageUrl("data/packages/1001.zip"),
    Error,
    "不是合法的 noj-storage:// URL",
  );
});

Deno.test("parseStorageUrl: 空 key", () => {
  const result = parseStorageUrl("noj-storage://local");
  assertEquals(result.provider, "local");
  assertEquals(result.key, "");
});

// ── `noj-storage://` 构建 ────────────────────────────────────

Deno.test("buildStorageUrl: local 模式", () => {
  const url = buildStorageUrl("local", "aGVsbG8=", "abc123");
  assertEquals(
    url,
    "noj-storage://local/aGVsbG8=?checksum_sha256=abc123",
  );
});

Deno.test("buildStorageUrl: S3 模式", () => {
  const url = buildStorageUrl("s3", "packages/1001.zip", "def456");
  assertEquals(
    url,
    "noj-storage://s3/packages/1001.zip?checksum_sha256=def456",
  );
});

Deno.test("buildStorageUrl: 无 checksum", () => {
  const url = buildStorageUrl("local", "aGVsbG8=");
  assertEquals(url, "noj-storage://local/aGVsbG8=");
});

// ── isStorageUrl ─────────────────────────────────────────────

Deno.test("isStorageUrl: 识别 noj-storage:// 前缀", () => {
  assert(isStorageUrl("noj-storage://local/key"));
  assert(isStorageUrl("noj-storage://s3/key"));
  assert(!isStorageUrl("data/packages/1001.zip"));
  assert(!isStorageUrl(""));
  assert(!isStorageUrl("noj-download://base64/"));
});

// ── `noj-download://` 解析 ───────────────────────────────────

Deno.test("parseDownloadUrl: base64 模式", () => {
  const result = parseDownloadUrl(
    "noj-download://base64/?content=UEsDBBQAAAAI&checksum_sha256=abc123",
  );
  assertEquals(result.mode, "base64");
  assertEquals(result.content, "UEsDBBQAAAAI");
  assertEquals(result.checksumSha256, "abc123");
});

Deno.test("parseDownloadUrl: S3 模式", () => {
  const result = parseDownloadUrl(
    "noj-download://s3?url=http%3A%2F%2Fminio%3A9000%2Fbucket%2Fkey&checksum_sha256=def456",
  );
  assertEquals(result.mode, "s3");
  assertEquals(result.url, "http://minio:9000/bucket/key");
  assertEquals(result.checksumSha256, "def456");
});

Deno.test("parseDownloadUrl: 无 checksum", () => {
  const result = parseDownloadUrl(
    "noj-download://base64/?content=UEsDBBQAAAAI",
  );
  assertEquals(result.mode, "base64");
  assertEquals(result.content, "UEsDBBQAAAAI");
  assertEquals(result.checksumSha256, undefined);
});

Deno.test("parseDownloadUrl: S3 模式无 url 参数", () => {
  const result = parseDownloadUrl("noj-download://s3");
  assertEquals(result.mode, "s3");
  assertEquals(result.url, undefined);
});

Deno.test("parseDownloadUrl: 未知 host 抛出错误", () => {
  assertThrows(() => parseDownloadUrl("noj-download://unknown/"));
});

// ── `noj-download://` 构建 ───────────────────────────────────

Deno.test("buildBase64DownloadUrl", () => {
  const url = buildBase64DownloadUrl("UEsDBBQAAAAI", "abc123");
  assertEquals(
    url,
    "noj-download://base64/?content=UEsDBBQAAAAI&checksum_sha256=abc123",
  );
});

Deno.test("buildBase64DownloadUrl: 无 checksum", () => {
  const url = buildBase64DownloadUrl("UEsDBBQAAAAI");
  assertEquals(url, "noj-download://base64/?content=UEsDBBQAAAAI");
});

Deno.test("buildS3DownloadUrl", () => {
  const url = buildS3DownloadUrl(
    "http://minio:9000/bucket/key?X-Amz-Signature=abc",
    "def456",
  );
  assert(url.startsWith("noj-download://s3?url="));
  assert(url.includes("http%3A%2F%2Fminio%3A9000"));
  assert(url.includes("checksum_sha256=def456"));
});

Deno.test("buildS3DownloadUrl: 无 checksum", () => {
  const url = buildS3DownloadUrl("http://minio:9000/bucket/key");
  assert(url.startsWith("noj-download://s3?url="));
  assert(!url.includes("checksum_sha256"));
});

// ── isDownloadUrl ────────────────────────────────────────────

Deno.test("isDownloadUrl: 识别 noj-download:// 前缀", () => {
  assert(isDownloadUrl("noj-download://base64/?content=abc"));
  assert(isDownloadUrl("noj-download://s3?url=abc"));
  assert(!isDownloadUrl("noj-storage://local/key"));
  assert(!isDownloadUrl(""));
});

// ── 往返测试 ─────────────────────────────────────────────────

Deno.test("noj-storage:// 往返: build → parse", () => {
  const original = buildStorageUrl("s3", "packages/1001.zip", "abc123");
  const parsed = parseStorageUrl(original);
  assertEquals(parsed.provider, "s3");
  assertEquals(parsed.key, "packages/1001.zip");
  assertEquals(parsed.checksumSha256, "abc123");
});

Deno.test("noj-download:// 往返: build → parse (base64)", () => {
  const original = buildBase64DownloadUrl("UEsDBBQAAAAI", "abc123");
  const parsed = parseDownloadUrl(original);
  assertEquals(parsed.mode, "base64");
  assertEquals(parsed.content, "UEsDBBQAAAAI");
  assertEquals(parsed.checksumSha256, "abc123");
});

Deno.test("noj-download:// 往返: build → parse (S3)", () => {
  const presignedUrl =
    "http://minio:9000/noj-support-packages/packages/1001.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123";
  const original = buildS3DownloadUrl(presignedUrl, "def456");
  const parsed = parseDownloadUrl(original);
  assertEquals(parsed.mode, "s3");
  assertEquals(parsed.url, presignedUrl);
  assertEquals(parsed.checksumSha256, "def456");
});
