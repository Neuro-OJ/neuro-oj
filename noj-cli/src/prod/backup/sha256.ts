/**
 * 增量 SHA-256（纯 TS，无外部命令、无整读内存）。
 *
 * ## 为什么需要它
 *
 * `crypto.subtle.digest` 是**一次性** API（没有 `update`），`util/hash.ts` 的
 * `fileSha256Hex` 因此用 `Deno.readFile` 整读文件。备份容器要处理任意大的
 * payload（`postgres.dump`、`minio/` 对象镜像可达数百 MB），整读会直接吃满内存。
 *
 * 三个可选方案与取舍：
 * 1. **spawn `sha256sum`**：coreutils 通常存在，但把"算摘要"这一纯计算绑到外部
 *    二进制上；R1 要求 CLI 在仅有 docker/curl/openssl 的环境可用，且
 *    `openssl dgst` 的输出格式还需再解析——不必要的外部面。
 * 2. **`FFI` 调 OpenSSL**：Deno 的 FFI 需要 `--allow-ffi` 且跨平台差异大。
 * 3. **纯 TS 增量实现**（本模块）：约 100 行、无依赖、内存有界，代价是吞吐低于
 *    原生实现（备份场景是 IO 密集而非 CPU 密集，可接受）。
 *
 * 选择 3。正确性由 `sha256_test.ts` 对 `crypto.subtle.digest` 做**逐字节比对**
 * （含跨块边界、非对齐长度、空输入与大幅随机输入）来保证——不与"自己写的
 * 测试向量"互证，而是与平台实现对照。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §8.2 多副本约束）：状态全在实例内。
 */

/** SHA-256 的轮常量（FIPS 180-4 §4.2.2）。 */
const K = new Uint32Array([
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
]);

/** SHA-256 的初始哈希值（FIPS 180-4 §5.3.3）。 */
const H0 = new Uint32Array([
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
]);

/** 循环右移（32 位）。 */
function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * 增量 SHA-256 计算器。
 *
 * 用法：反复 `update(chunk)`，最后 `digestHex()`。`digestHex()` 可调用多次
 * （内部按已处理的字节数固化，不破坏后续 `update`）——备份场景下需要"取当前
 * 摘要"后再继续喂数据（例如 manifest 的二轮打包）。
 */
export class Sha256 {
  /** 中间哈希状态。 */
  private h = new Uint32Array(H0);
  /** 未满一个 64 字节块的残留数据。 */
  private buffer = new Uint8Array(64);
  /** `buffer` 中已填充的字节数。 */
  private buffered = 0;
  /** 已喂入的总字节数（用于填充长度字段）。 */
  private totalBytes = 0;
  /** 消息块复用缓冲（避免每块分配）。 */
  private w = new Uint32Array(64);

  /** 喂入一段数据。 */
  update(data: Uint8Array): this {
    this.totalBytes += data.length;
    let offset = 0;

    // 先填满上次的残留块。
    if (this.buffered > 0) {
      const need = 64 - this.buffered;
      const take = Math.min(need, data.length);
      this.buffer.set(data.subarray(0, take), this.buffered);
      this.buffered += take;
      offset = take;
      if (this.buffered === 64) {
        this.compress(this.buffer, 0);
        this.buffered = 0;
      }
    }

    // 整块直接压缩，不经过 buffer。
    while (offset + 64 <= data.length) {
      this.compress(data, offset);
      offset += 64;
    }

    // 余数留在 buffer 里等下次。
    if (offset < data.length) {
      this.buffer.set(data.subarray(offset), 0);
      this.buffered = data.length - offset;
    }
    return this;
  }

  /** 压缩一个 64 字节块。 */
  private compress(block: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((block[j]! << 24) | (block[j + 1]! << 16) |
        (block[j + 2]! << 8) | block[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) >>> 0;
      const ch = ((e! & f!) ^ (~e! & g!)) >>> 0;
      const t1 = (h! + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = (rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) >>> 0;
      const maj = ((a! & b!) ^ (a! & c!) ^ (b! & c!)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    const hh = this.h;
    hh[0] = (hh[0]! + a!) >>> 0;
    hh[1] = (hh[1]! + b!) >>> 0;
    hh[2] = (hh[2]! + c!) >>> 0;
    hh[3] = (hh[3]! + d!) >>> 0;
    hh[4] = (hh[4]! + e!) >>> 0;
    hh[5] = (hh[5]! + f!) >>> 0;
    hh[6] = (hh[6]! + g!) >>> 0;
    hh[7] = (hh[7]! + h!) >>> 0;
  }

  /** 取当前摘要的十六进制串（不破坏内部状态，可继续 update）。 */
  digestHex(): string {
    // 在副本上做填充，避免污染正在进行的流。
    const clone = new Sha256();
    clone.h = new Uint32Array(this.h);
    clone.buffered = this.buffered;
    clone.buffer.set(this.buffer.subarray(0, this.buffered));
    clone.totalBytes = this.totalBytes;

    // FIPS 180-4 §5.1.1 填充：0x80 + 若干 0x00 + 64 位大端长度（比特）。
    const bitLen = clone.totalBytes * 8;
    const pad = new Uint8Array(
      clone.buffered < 56 ? 64 - clone.buffered : 128 - clone.buffered,
    );
    pad[0] = 0x80;
    // 长度字段高 32 位（本场景下文件不会超过 2^32 比特 = 512 MiB 的 8 倍，
    // 但仍完整写入 64 位以满足规范）。
    const high = Math.floor(bitLen / 0x100000000);
    const low = bitLen >>> 0;
    const at = pad.length - 8;
    pad[at] = (high >>> 24) & 0xff;
    pad[at + 1] = (high >>> 16) & 0xff;
    pad[at + 2] = (high >>> 8) & 0xff;
    pad[at + 3] = high & 0xff;
    pad[at + 4] = (low >>> 24) & 0xff;
    pad[at + 5] = (low >>> 16) & 0xff;
    pad[at + 6] = (low >>> 8) & 0xff;
    pad[at + 7] = low & 0xff;
    clone.update(pad);

    let hex = "";
    for (const word of clone.h) hex += word.toString(16).padStart(8, "0");
    return hex;
  }
}

/** 一次性计算字节的 SHA-256（便捷入口，小数据用）。 */
export function sha256BytesHex(data: Uint8Array): string {
  return new Sha256().update(data).digestHex();
}

/**
 * 流式计算文件 SHA-256（**有界内存**：1 MiB 分块）。
 *
 * 这是备份容器计算大文件摘要的唯一入口。与 `util/hash.ts:fileSha256Hex`
 * （整读）刻意分开：那个用于小配置文件的便捷场景，本函数用于任意大的 payload。
 */
export async function fileSha256HexStreaming(
  path: string,
  chunkSize = 1024 * 1024,
): Promise<string> {
  const hasher = new Sha256();
  const file = await Deno.open(path, { read: true });
  try {
    const buf = new Uint8Array(chunkSize);
    for (;;) {
      const n = await file.read(buf);
      if (n === null) break;
      hasher.update(buf.subarray(0, n));
    }
  } finally {
    file.close();
  }
  return hasher.digestHex();
}
