/**
 * 增量 SHA-256 的对照测试（T17）。
 *
 * 验证策略：**与平台实现对照**（`crypto.subtle.digest`），而不是与自写的测试向量
 * 互证——后者只能证明"实现与我的理解一致"，前者才能证明"实现与 SHA-256 一致"。
 *
 * 覆盖的边界：
 * - 空输入；恰好 55 / 56 / 63 / 64 / 65 字节（填充与块边界）；
 * - 跨 `update()` 调用边界的同一份数据（分块喂入必须与一次喂入同摘要）；
 * - 1 MiB 随机数据（覆盖多块与 `subarray` 路径）；
 * - `digestHex()` 可重复调用且可继续 `update`（manifest 二轮打包依赖该语义）；
 * - FIPS 180-4 的公开测试向量（`abc` 等），锁死与规范的偏差。
 */

import { assertEquals } from "@std/assert";
import { makeTempDir } from "../../testing/helpers.ts";
import { fileSha256HexStreaming, Sha256, sha256BytesHex } from "./sha256.ts";

/** 平台的 SHA-256（对照基准）。 */
async function platformHex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  let hex = "";
  for (const b of new Uint8Array(digest)) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}

Deno.test("sha256: FIPS 180-4 公开向量（空串 / abc / 448 位消息）", () => {
  assertEquals(
    sha256BytesHex(new Uint8Array()),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(
    sha256BytesHex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(
    sha256BytesHex(
      new TextEncoder().encode(
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      ),
    ),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

Deno.test("sha256: 与平台实现在填充/块边界长度上逐字节一致", async () => {
  for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) data[i] = (i * 37 + 11) & 0xff;
    assertEquals(
      sha256BytesHex(data),
      await platformHex(data),
      `长度 ${len} 的摘要必须一致`,
    );
  }
});

Deno.test("sha256: 任意分块喂入与一次喂入结果相同（跨块边界）", async () => {
  const total = 4096 + 37;
  const data = new Uint8Array(total);
  for (let i = 0; i < total; i++) data[i] = (i * 131 + 7) & 0xff;
  const expected = await platformHex(data);

  // 多种分块大小：1 / 3 / 63 / 64 / 65 / 1000 都必须得到同一摘要。
  for (const chunk of [1, 3, 63, 64, 65, 1000]) {
    const hasher = new Sha256();
    for (let at = 0; at < total; at += chunk) {
      hasher.update(data.subarray(at, Math.min(at + chunk, total)));
    }
    assertEquals(hasher.digestHex(), expected, `分块 ${chunk} 的摘要必须一致`);
  }
});

Deno.test("sha256: 1 MiB 随机数据与平台一致", async () => {
  const data = new Uint8Array(1024 * 1024);
  crypto.getRandomValues(data.subarray(0, 65536));
  // 其余部分填充确定性字节（getRandomValues 有 65536 上限）
  for (let i = 65536; i < data.length; i++) data[i] = (i * 17) & 0xff;
  assertEquals(sha256BytesHex(data), await platformHex(data));
});

Deno.test("sha256: digestHex 可重复调用且不破坏后续 update", () => {
  const hasher = new Sha256();
  const a = new TextEncoder().encode("hello ");
  const b = new TextEncoder().encode("world");
  hasher.update(a);
  const middle = hasher.digestHex();
  // 重复取摘要必须相同（幂等）
  assertEquals(hasher.digestHex(), middle);
  // 继续喂数据后得到完整摘要
  hasher.update(b);
  const full = hasher.digestHex();
  assertEquals(
    full,
    "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    "hello world 的 SHA-256",
  );
  // 中间的摘要必须**不等于**最终摘要（证明填充没有污染流状态）
  assertEquals(middle === full, false);
  // 而且中间摘要必须等于「只喂 a」的一次性摘要
  assertEquals(middle, sha256BytesHex(a));
});

Deno.test("sha256: 大文件流式摘要与平台一致且不整读（分块生效）", async () => {
  const dir = await makeTempDir();
  try {
    const path = `${dir}/payload.bin`;
    // 3 MiB + 17，跨多个 1 MiB 分块边界
    const size = 3 * 1024 * 1024 + 17;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) data[i] = (i * 251 + 3) & 0xff;
    await Deno.writeFile(path, data);

    assertEquals(await fileSha256HexStreaming(path), await platformHex(data));
    // 自定义更大的分块也必须一致（证明没有依赖固定 1 MiB 的隐式假设）
    assertEquals(
      await fileSha256HexStreaming(path, 4 * 1024 * 1024),
      await platformHex(data),
    );
    // 小分块（7 字节）同样一致——覆盖大量跨块 update
    assertEquals(
      await fileSha256HexStreaming(path, 7),
      await platformHex(data),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sha256: 空文件流式摘要为规范空串摘要", async () => {
  const dir = await makeTempDir();
  try {
    const path = `${dir}/empty.bin`;
    await Deno.writeFile(path, new Uint8Array());
    assertEquals(
      await fileSha256HexStreaming(path),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
