/**
 * 时间戳（RFC 3161）可选 Provider（PIPL 合规增强）。
 *
 * 设计取舍（见设计文档 §4.8）：
 * - **只对"政策版本哈希"打戳**，不对每次用户同意打戳（低频、成本可控、法律价值更高）。
 * - **默认关闭**（`tsa_provider=disabled`）；失败的打戳不阻塞发布。
 * - 必须保存**证书链**（`certReq=true`），否则 TSA 证书轮换后无法长期验证。
 *
 * Provider 说明（部署指导中详述）：
 * - `freetsa` / `digicert`：免费、RFC 3161，**仅技术验证**，不构成中国法律证据。
 * - `custom`：自填地址与根证书；中国法律场景建议接联合信任等国内 TSA。
 */

import { getSetting } from "../../system/index.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "legal", "tsa"]);

/** 免费 Provider 的内置端点。 */
const PROVIDER_URLS: Record<string, string> = {
  freetsa: "https://freetsa.org/tsr",
  digicert: "https://timestamp.digicert.com",
};

/** TSA 请求超时（毫秒）；超时按打戳失败处理，不阻塞发布。 */
const TSA_TIMEOUT_MS = 10_000;

/** 打戳结果；失败时为 null（调用方不阻塞）。 */
export interface TsaResult {
  provider: string;
  /** RFC 3161 TimeStampToken（base64） */
  token: string;
  /** 证书链（base64；长期验证必需） */
  chain: string;
}

/** 当前是否启用 TSA（provider 非 disabled）。 */
export function tsaEnabled(): boolean {
  const provider = String(getSetting("tsa_provider")?.value ?? "disabled");
  return provider !== "disabled" && provider.trim().length > 0;
}

/** 解析 provider 对应的端点；`custom` 时取 `tsa_url`。 */
function resolveUrl(provider: string): string | null {
  if (provider === "custom") {
    const url = String(getSetting("tsa_url")?.value ?? "").trim();
    return url || null;
  }
  return PROVIDER_URLS[provider] ?? null;
}

/**
 * 对给定哈希打 RFC 3161 时间戳。
 *
 * @param hashHex SHA-256 十六进制
 * @returns 成功返回 token+chain；未配置或失败返回 null（并记录 warn）
 */
export async function timestampHash(
  hashHex: string,
): Promise<TsaResult | null> {
  const provider = String(getSetting("tsa_provider")?.value ?? "disabled");
  const url = resolveUrl(provider);
  if (!url) {
    logger.warn("TSA 已启用但端点未配置，跳过打戳", { provider });
    return null;
  }

  try {
    const query = buildTimeStampQuery(hashHex);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query" },
      // 超时按失败处理（不阻塞政策发布）。
      signal: AbortSignal.timeout(TSA_TIMEOUT_MS),
      // Uint8Array 需转为 ArrayBuffer 才符合 BodyInit 类型。
      body: query.buffer.slice(
        query.byteOffset,
        query.byteOffset + query.byteLength,
      ) as ArrayBuffer,
    });
    if (!res.ok) {
      logger.warn("TSA 响应非 2xx，跳过打戳", { provider, status: res.status });
      return null;
    }
    const tokenBytes = new Uint8Array(await res.arrayBuffer());
    return {
      provider,
      token: base64Encode(tokenBytes),
      // certReq=true 时响应（TimeStampResp）内嵌证书链，整包保存。
      // 字段名为 `chain` 但语义是「含证书的完整响应」——离线验证时从中解析
      // 出证书集；当前仅签发不验证，故不在此处拆分 DER。
      chain: base64Encode(tokenBytes),
    };
  } catch (err) {
    logger.warn("TSA 打戳失败（不阻塞发布）", { provider, err: String(err) });
    return null;
  }
}

/**
 * 构造 RFC 3161 TimeStampReq（DER 编码，SHA-256，`certReq=true`）。
 *
 * 结构：SEQUENCE { version=1, messageImprint, certReq=TRUE }
 */
function buildTimeStampQuery(hashHex: string): Uint8Array {
  const hash = hexToBytes(hashHex);
  // MessageImprint ::= SEQUENCE { hashAlgorithm AlgorithmIdentifier, hashedMessage OCTET STRING }
  // AlgorithmIdentifier: SEQUENCE { OID 2.16.840.1.101.3.4.2.1 (sha256), NULL }
  const sha256Oid = new Uint8Array([
    0x06,
    0x09,
    0x60,
    0x86,
    0x48,
    0x01,
    0x65,
    0x03,
    0x04,
    0x02,
    0x01,
  ]);
  const algId = derSequence(concat(sha256Oid, new Uint8Array([0x05, 0x00])));
  const hashedMessage = derOctetString(hash);
  const messageImprint = derSequence(concat(algId, hashedMessage));
  const version = new Uint8Array([0x02, 0x01, 0x01]); // INTEGER 1
  const certReq = new Uint8Array([0x01, 0x01, 0xff]); // BOOLEAN TRUE
  return derSequence(concat(version, messageImprint, certReq));
}

/** DER SEQUENCE（0x30）。 */
function derSequence(content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x30]), derLength(content.length), content);
}

/** DER OCTET STRING（0x04）。 */
function derOctetString(content: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0x04]), derLength(content.length), content);
}

/** DER 长度编码（短/长形式）。 */
function derLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
