/**
 * LocalStorageProvider 存储根目录测试（problem-bundle-import 目录分层）。
 *
 * 验证：
 * - 默认存储目录为 data/storage/（与构建产物 data/packages/ 分离）
 * - SUPPORT_PACKAGE_DIR 可覆盖存储根目录
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { dirname, join } from "jsr:@std/path@^1";
import { LocalStorageProvider } from "../../../src/modules/assets/storage/local.ts";

Deno.test("LocalStorageProvider: 原产物流式读取及取消释放文件句柄", async () => {
  const directory = await Deno.makeTempDir();
  const provider = new LocalStorageProvider(directory);
  const bytes = new Uint8Array(1024 * 1024).fill(42);
  try {
    const url = await provider.put("stream-download", bytes);
    const response = new Response(await provider.getStream(url));
    assertEquals(new Uint8Array(await response.arrayBuffer()), bytes);
    const reader = (await provider.getStream(url)).getReader();
    assertEquals((await reader.read()).done, false);
    await reader.cancel();
    reader.releaseLock();
    await provider.delete(url);
    assertEquals((await provider.stat(url)).exists, false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("LocalStorageProvider: 默认落盘到 data/storage 而非 data/packages", async () => {
  // 默认路径也在临时 cwd 中验收，避免接触开发者真实 data/storage。
  const directory = await Deno.makeTempDir();
  const originalCwd = Deno.cwd();
  const originalDirectory = Deno.env.get("SUPPORT_PACKAGE_DIR");
  try {
    Deno.chdir(directory);
    Deno.env.delete("SUPPORT_PACKAGE_DIR");
    const provider = new LocalStorageProvider();
    const url = await provider.put(
      "test-key",
      new TextEncoder().encode("hello"),
      "application/zip",
    );
    assertEquals(url.startsWith("noj-storage://local/"), true);
    const key = url.split("?")[0].replace("noj-storage://local/", "");
    assertEquals(
      (await Deno.stat(join(directory, "data", "storage", `${key}.zip`)))
        .isFile,
      true,
      "默认文件应写入 data/storage/",
    );
    await assertRejects(
      () => Deno.stat(join(directory, "data", "packages", `${key}.zip`)),
      Deno.errors.NotFound,
    );
  } finally {
    Deno.chdir(originalCwd);
    if (originalDirectory === undefined) Deno.env.delete("SUPPORT_PACKAGE_DIR");
    else Deno.env.set("SUPPORT_PACKAGE_DIR", originalDirectory);
    await Deno.remove(directory, { recursive: true });
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

Deno.test("LocalStorageProvider: downloadUrl 返回 noj-download://local 路径", async () => {
  const provider = new LocalStorageProvider();
  const url = await provider.put(
    "download-key",
    new TextEncoder().encode("data"),
    "application/zip",
  );
  const downloadUrl = await provider.downloadUrl(url);
  assertEquals(downloadUrl.startsWith("noj-download://local?path="), true);
  assertEquals(downloadUrl.includes("checksum_sha256="), true);
  await provider.delete(url);
});

Deno.test("LocalStorageProvider: putStream 流式写入并读回", async () => {
  const provider = new LocalStorageProvider();
  const chunks = [
    new TextEncoder().encode("hello "),
    new TextEncoder().encode("world"),
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  const url = await provider.putStream("stream-key", stream, "application/zip");
  const readBack = await provider.get(url);
  assertEquals(new TextDecoder().decode(readBack), "hello world");
  await provider.delete(url);
});

Deno.test("LocalStorageProvider: putStream 超过大小限制时中止", async () => {
  const provider = new LocalStorageProvider();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("12345"));
      controller.close();
    },
  });
  await assertRejects(
    () => provider.putStream("stream-key-limit", stream, "application/zip", 4),
    Error,
    "超过大小限制",
  );
});

Deno.test("LocalStorageProvider: 图片 key 的 get/delete 使用正确路径", async () => {
  const directory = await Deno.makeTempDir();
  const provider = new LocalStorageProvider(directory);
  try {
    const url = await provider.put(
      "k",
      new TextEncoder().encode("img"),
      "image/webp",
    );
    const key = url.split("?")[0].replace("noj-storage://local/", "");
    const file = join(directory, key);
    assertEquals((await Deno.stat(file)).isFile, true, "图片文件应按 key 落盘");
    await provider.delete(url);
    await assertRejects(() => Deno.stat(file), Deno.errors.NotFound);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
