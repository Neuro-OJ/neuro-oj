/**
 * LocalStorageProvider 存储根目录测试（problem-bundle-import 目录分层）。
 *
 * 验证：
 * - 默认存储目录为 data/storage/（与构建产物 data/packages/ 分离）
 * - SUPPORT_PACKAGE_DIR 可覆盖存储根目录
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { dirname, join } from "jsr:@std/path@^1";
import { LocalStorageProvider } from "../../../src/lib/storage/local.ts";

// 项目根目录 = noj-core（本文件位于 tests/lib/storage/，向上 3 层：
// storage → lib → tests → noj-core）。
// 注意：LocalStorageProvider 默认目录 data/storage 是相对进程 cwd 解析的，
// 测试须从 noj-core 目录运行（CI 与 deno task 均如此）。
const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");

Deno.test("LocalStorageProvider: 默认落盘到 data/storage 而非 data/packages", async () => {
  const provider = new LocalStorageProvider();
  const url = await provider.put(
    "test-key",
    new TextEncoder().encode("hello"),
    "application/zip",
  );

  // URL 格式：noj-storage://local/<base64>?checksum_sha256=<hex>
  assertEquals(url.startsWith("noj-storage://local/"), true);

  // 文件应在 data/storage/ 下
  const parsed = url.split("?")[0].replace("noj-storage://local/", "");
  const storageFile = join(PROJECT_ROOT, "data", "storage", `${parsed}.zip`);
  const packagesFile = join(PROJECT_ROOT, "data", "packages", `${parsed}.zip`);

  let storageExists = false;
  let packagesExists = false;
  try {
    await Deno.stat(storageFile);
    storageExists = true;
  } catch {
    // not found
  }
  try {
    await Deno.stat(packagesFile);
    packagesExists = true;
  } catch {
    // not found
  }

  assertEquals(storageExists, true, "文件应写入 data/storage/");
  assertEquals(packagesExists, false, "文件不应写入 data/packages/");

  // 清理
  try {
    await Deno.remove(storageFile);
  } catch {
    // ignore
  }
});

Deno.test("LocalStorageProvider: SUPPORT_PACKAGE_DIR 覆盖存储根目录", async () => {
  const tmpDir = await Deno.makeTempDir();
  const old = Deno.env.get("SUPPORT_PACKAGE_DIR");
  Deno.env.set("SUPPORT_PACKAGE_DIR", tmpDir);

  try {
    // 重新实例化以读取新 env（模块常量在 import 时解析，这里直接验证文件路径约定）
    const provider = new LocalStorageProvider();
    const url = await provider.put(
      "test-key-2",
      new TextEncoder().encode("world"),
      "application/zip",
    );
    const parsed = url.split("?")[0].replace("noj-storage://local/", "");
    const file = join(tmpDir, `${parsed}.zip`);
    let exists = false;
    try {
      await Deno.stat(file);
      exists = true;
    } catch {
      // not found
    }
    assertEquals(exists, true, "文件应写入 SUPPORT_PACKAGE_DIR 指定目录");
  } finally {
    if (old === undefined) Deno.env.delete("SUPPORT_PACKAGE_DIR");
    else Deno.env.set("SUPPORT_PACKAGE_DIR", old);
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// 保留 dirname import 避免未使用警告（实际路径基于 import.meta.dirname）
void dirname;

// ── 头像图片扩展名支持（issue #229）───────────────────────────

Deno.test("LocalStorageProvider: image/png 存为 .png key 并读回", async () => {
  const provider = new LocalStorageProvider();
  const data = new TextEncoder().encode("fake-png-bytes");
  const url = await provider.put("avatar-key", data, "image/png");

  const key = url.split("?")[0].replace("noj-storage://local/", "");
  assertEquals(key.endsWith(".png"), true, "key 应带 .png 扩展名");

  const readBack = await provider.get(url);
  assertEquals(new TextDecoder().decode(readBack), "fake-png-bytes");
});

Deno.test("LocalStorageProvider: image/jpeg 存为 .jpg key（规范化）", async () => {
  const provider = new LocalStorageProvider();
  const url = await provider.put(
    "k",
    new TextEncoder().encode("jpeg"),
    "image/jpeg",
  );
  const key = url.split("?")[0].replace("noj-storage://local/", "");
  assertEquals(key.endsWith(".jpg"), true);
});

Deno.test("LocalStorageProvider: zip/未知 contentType 保持无扩展名 key", async () => {
  const provider = new LocalStorageProvider();
  const url = await provider.put(
    "k",
    new TextEncoder().encode("x"),
    "application/zip",
  );
  const key = url.split("?")[0].replace("noj-storage://local/", "");
  // 兼容既有支持包：key 无扩展名，文件落盘为 <key>.zip
  assertEquals(/\.(png|jpg|webp)$/.test(key), false);
  const readBack = await provider.get(url);
  assertEquals(new TextDecoder().decode(readBack), "x");
});

Deno.test("LocalStorageProvider: 图片 key 的 get/delete 使用正确路径", async () => {
  const provider = new LocalStorageProvider();
  const url = await provider.put(
    "k",
    new TextEncoder().encode("img"),
    "image/webp",
  );
  const key = url.split("?")[0].replace("noj-storage://local/", "");
  const file = join(PROJECT_ROOT, "data", "storage", key);
  let exists = true;
  try {
    await Deno.stat(file);
  } catch {
    exists = false;
  }
  assertEquals(exists, true, "图片文件应落盘为 <key>（含扩展名）");
  // 删除后文件消失
  await provider.delete(url);
  let gone = false;
  try {
    await Deno.stat(file);
  } catch {
    gone = true;
  }
  assertEquals(gone, true, "delete 应删除带扩展名文件");
});
