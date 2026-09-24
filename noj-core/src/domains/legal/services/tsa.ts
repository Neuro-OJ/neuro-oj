/**
 * 时间戳（RFC 3161）可选 Provider（PIPL 合规增强）。
 *
 * 设计取舍（见设计文档 §4.8）：
 * - **只对"政策版本哈希"打戳**，不对每次用户同意打戳（低频、成本可控、法律价值更高）。
 * - **默认关闭**（`tsa_provider=disabled`）；失败的打戳不阻塞发布。
 * - 收到 TimeStampResp 后**必须校验**：PKIStatus 授权、messageImprint 与
 *   我们的 `content_hash` 一致、CMS 签名有效、证书链存在；任一不满足视为失败。
 *   （此前实现"收到即存"，会把拒答响应或错 token 当真——是实际正确性缺陷。）
 * - 保存**真实证书链**（从 CMS 提取，非 token 副本）与**原始 TSQ（含 nonce）**，
 *   供 TSA 证书轮换后长期验证。
 *
 * Provider 说明（部署指导中详述）：
 * - `freetsa` / `digicert`：免费、RFC 3161，**仅技术验证**，不构成中国法律证据。
 * - `custom`：自填地址与根证书；中国法律场景建议接联合信任等国内 TSA。
 */

import * as asn1js from "asn1js";
import {
  Certificate,
  ContentInfo,
  CryptoEngine,
  PKIStatusInfo,
  SignedData,
  TimeStampResp,
  TSTInfo,
} from "pkijs";
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

/** 可接受的 PKIStatus：0=granted，1=grantedWithMods。 */
const PKI_STATUS_GRANTED = new Set([0, 1]);

/** SHA-256 的 OID。 */
const SHA256_OID = "2.16.840.1.101.3.4.2.1";
/** id-ct-TSTInfo（CMS eContentType）。 */
const TSTINFO_OID = "1.2.840.113549.1.9.16.1.4";
/** id-signedData（ContentInfo contentType）。 */
const SIGNED_DATA_OID = "1.2.840.113549.1.7.2";

/** 打戳结果；失败时为 null（调用方不阻塞）。 */
export interface TsaResult {
  provider: string;
  /** RFC 3161 TimeStampToken（base64，即 CMS SignedData） */
  token: string;
  /** 签名者证书链（base64，多证书以 `\n` 分隔；长期验证必需） */
  chain: string;
  /** 原始 RFC 3161 请求 TSQ（base64，含 nonce），供事后重放/复核 */
  query: string;
  /** TSTInfo.genTime（ISO 8601；由 TSA 签名保护） */
  timestamp: string;
}

/**
 * 离线验证结果。
 *
 * 信任模型（2026-09-25 评审）：`ok=true` 仅在**完整验证**通过时给出——
 * imprint 匹配 + CMS 签名有效 + 证书在有效期内 + 签名者证书由**配置的**
 * `tsa_root_cert` 签发。未配置根证书时不得凭 token 内嵌链自证，
 * 此时 `signature_valid=true` 而 `trusted=false`、`ok=false`。
 */
export interface TsaVerifyResult {
  ok: boolean;
  /** 失败原因（ok=false 时有值） */
  reason?: string;
  /** 时间戳签发时间（ISO 8601） */
  timestamp?: string;
  /** imprint 与 CMS 签名是否有效（不含信任链判定） */
  signature_valid?: boolean;
  /** 签名者证书是否由配置的根证书签发（未配置根证书时为 false） */
  trusted?: boolean;
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

/** 统一的 CryptoEngine（Deno 内建 WebCrypto）。 */
function cryptoEngine(): CryptoEngine {
  return new CryptoEngine({
    crypto: globalThis.crypto,
    subtle: globalThis.crypto.subtle,
  });
}

/**
 * 对给定哈希打 RFC 3161 时间戳。
 *
 * @param hashHex SHA-256 十六进制（政策 `content_hash`）
 * @returns 成功返回已验证的 token/chain/query/timestamp；未配置或失败返回 null
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
    // nonce 同时用于：写入请求、随 query 一并留档、校验响应回显。
    const { der: query, nonce } = buildTimeStampQuery(hashHex);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query" },
      // 超时按失败处理（不阻塞政策发布）。
      signal: AbortSignal.timeout(TSA_TIMEOUT_MS),
      body: query.buffer.slice(
        query.byteOffset,
        query.byteOffset + query.byteLength,
      ) as ArrayBuffer,
    });
    if (!res.ok) {
      logger.warn("TSA 响应非 2xx，跳过打戳", { provider, status: res.status });
      return null;
    }

    const respBytes = new Uint8Array(await res.arrayBuffer());
    const parsed = await parseAndValidate(
      respBytes,
      hashHex,
      bytesToHex(nonce),
    );
    if (!parsed) {
      logger.warn("TSA 响应校验失败（状态/imprint/签名/证书链），跳过打戳", {
        provider,
      });
      return null;
    }

    return {
      provider,
      token: base64Encode(parsed.tokenDer),
      chain: parsed.chainBase64.join("\n"),
      query: base64Encode(query),
      timestamp: parsed.genTime,
    };
  } catch (err) {
    logger.warn("TSA 打戳失败（不阻塞发布）", { provider, err: String(err) });
    return null;
  }
}

/**
 * 解析并**校验** TimeStampResp（异步：含 CMS 验签）。
 *
 * 校验链（任一失败返回 null）：
 * 1. `PKIStatus ∈ {0,1}`（拒答 `2` 不得被当成功）
 * 2. `messageImprint` 等于我们的 `hashHex`
 * 3. CMS `eContentType == id-ct-TSTInfo`
 * 4. 从 CMS 提取到非空证书链（`certReq=true` 的响应必须内嵌）
 * 5. CMS 签名有效（用内嵌签名者证书验签）
 * 6. 响应回显的 nonce 与请求一致（缺失仅告警，不一致判失败）
 *
 * @param respBytes 原始 TimeStampResp DER
 * @param hashHex 期望的 SHA-256（hex）
 * @param expectedNonceHex 请求中发送的 nonce（hex）；缺省则跳过回显校验
 */
async function parseAndValidate(
  respBytes: Uint8Array,
  hashHex: string,
  expectedNonceHex?: string,
): Promise<
  { tokenDer: Uint8Array; chainBase64: string[]; genTime: string } | null
> {
  const resp = TimeStampResp.fromBER(toBufferSource(respBytes));
  const status = (resp.status as PKIStatusInfo).status;
  if (!PKI_STATUS_GRANTED.has(status)) {
    logger.warn("TSA PKIStatus 非授权", { status });
    return null;
  }
  const tokenCi = resp.timeStampToken as ContentInfo | undefined;
  if (!tokenCi || tokenCi.contentType !== SIGNED_DATA_OID) {
    logger.warn("TSA 响应缺少 TimeStampToken");
    return null;
  }

  const signedData = new SignedData({ schema: tokenCi.content });
  if (
    signedData.encapContentInfo.eContentType !== TSTINFO_OID ||
    !signedData.encapContentInfo.eContent
  ) {
    logger.warn("TSA eContentType 非 TSTInfo");
    return null;
  }

  // messageImprint == content_hash（防止 TSA 返回错 token）
  const tstBytes = signedData.encapContentInfo.eContent.getValue();
  const tst = TSTInfo.fromBER(tstBytes);
  const imprint = bytesToHex(
    new Uint8Array(tst.messageImprint.hashedMessage.valueBlock.valueHexView),
  );
  if (imprint !== hashHex.toLowerCase()) {
    logger.warn("TSA messageImprint 与政策哈希不匹配");
    return null;
  }
  const genTime = tst.genTime.toISOString();

  // nonce 回显校验（2026-09-25 评审）：RFC 3161 要求授权响应回显请求 nonce，
  // 用于防重放/掉包。缺失时仅告警（兼容不实现回显的 TSA），不匹配则判失败。
  // 比较前去掉前导 0（DER INTEGER 可能补 0x00 以避免被当作负数）。
  const respNonce = tst.nonce?.valueBlock?.valueHexView;
  const stripLeadingZeros = (hex: string) =>
    hex.replace(/^0+/, "").toLowerCase();
  if (respNonce && expectedNonceHex) {
    const echoed = stripLeadingZeros(bytesToHex(new Uint8Array(respNonce)));
    if (echoed !== stripLeadingZeros(expectedNonceHex)) {
      logger.warn("TSA nonce 回显与请求不一致（疑似重放/掉包）");
      return null;
    }
  } else if (expectedNonceHex) {
    logger.warn("TSA 响应未回显 nonce，无法据此防重放");
  }

  // 证书链（certReq=true 的响应必须内嵌，长期验证必需）
  const certs = (signedData.certificates ?? []) as Certificate[];
  if (certs.length === 0) {
    logger.warn("TSA 响应未内嵌证书链（certReq 未满足）");
    return null;
  }
  const chainBase64 = certs.map((c) =>
    base64Encode(new Uint8Array(c.toSchema().toBER(false)))
  );

  // CMS 签名有效（用内嵌签名者证书离线验签）。
  // 注意：pkijs 的 SignedData.verify 对 `eContentType=id-ct-TSTInfo` 走特殊分支，
  // 要求传入"原始被戳数据"以重算 imprint，而非校验 CMS 签名本身。此处需要的
  // 是"签名确实由该证书对这段 TSTInfo 签发"，故自行对 eContent 验签。
  const signerCert = findSignerCert(certs, signedData.signerInfos[0]);
  if (!signerCert) {
    logger.warn("TSA 找不到签名者证书");
    return null;
  }
  const sigOk = await verifyCmsSignature(signedData, signerCert);
  if (!sigOk) {
    logger.warn("TSA CMS 签名验证失败");
    return null;
  }

  return {
    tokenDer: new Uint8Array(tokenCi.toSchema().toBER(false)),
    chainBase64,
    genTime,
  };
}

/** 在指定证书集中寻找与 SignerInfo.sid 匹配的证书。 */
function findSignerCert(
  certs: Certificate[],
  // deno-lint-ignore no-explicit-any
  signerInfo: any,
): Certificate | null {
  const serial = signerInfo?.sid?.serialNumber?.valueBlock?.valueDec;
  if (serial === undefined) return certs[0] ?? null;
  return certs.find((c) => c.serialNumber.valueBlock.valueDec === serial) ??
    certs[0] ?? null;
}

/** CMS signedAttrs 的必选属性 OID（RFC 5652 §11.1/§11.2）。 */
const ATTR_CONTENT_TYPE_OID = "1.2.840.113549.1.9.3";
const ATTR_MESSAGE_DIGEST_OID = "1.2.840.113549.1.9.4";

/** 摘要算法 OID → WebCrypto 名称（signedAttrs.messageDigest 校验用）。 */
const DIGEST_ALGORITHMS: Record<string, string> = {
  "2.16.840.1.101.3.4.2.1": "SHA-256",
  "2.16.840.1.101.3.4.2.2": "SHA-384",
  "2.16.840.1.101.3.4.2.3": "SHA-512",
  "1.3.14.3.2.26": "SHA-1",
};

/**
 * 校验 CMS 签名：用签名者证书公钥验证 signerInfo.signature，并在有
 * `signedAttrs` 时核对其与 eContent 的绑定关系（RFC 5652 §5.4）。
 *
 * 覆盖无 `signedAttrs`（签名直接 over eContent=TSTInfo DER）与有 `signedAttrs`
 * （签名 over signedAttrs SET）两种形态。不走 pkijs 的 `SignedData.verify`，
 * 因其对 TSTInfo 会改用"重算 imprint"语义，不是我们要的签名校验。
 *
 * **为什么必须核对 signedAttrs（2026-09-24 评审发现）**：有 signedAttrs 时，
 * 签名只覆盖 signedAttrs，不再覆盖 eContent。若不核对
 * `messageDigest == H(eContent)`，任何持有**任意一条合法 TSA token** 的人
 * 都可以替换 eContent（伪造 messageImprint/时间）而签名仍然验签通过，
 * 从而让复核端点对从未打戳过的哈希错误地返回 `ok:true`。
 *
 * @param signedData 已解析的 CMS
 * @param signerCert 签名者证书
 */
async function verifyCmsSignature(
  signedData: SignedData,
  signerCert: Certificate,
): Promise<boolean> {
  const signerInfo = signedData.signerInfos[0];
  if (!signerInfo) return false;

  // 待验数据
  let signedBytes: Uint8Array;
  if (signerInfo.signedAttrs) {
    // 有 signedAttrs：签名 over DER 的 SET OF（tag 0x31）
    const ber = new Uint8Array(signerInfo.signedAttrs.toSchema().toBER(false));
    ber[0] = 0x31; // 由 SEQUENCE 改为 SET
    signedBytes = ber;

    // RFC 5652 §5.4：signedAttrs 必须包含 content-type 与 message-digest，
    // 且 messageDigest 必须等于 eContent 的摘要，否则签名与内容解绑（伪造面）。
    const eContent = signedData.encapContentInfo.eContent;
    if (!eContent) return false;
    // deno-lint-ignore no-explicit-any
    const attributes = (signerInfo.signedAttrs as any).attributes ?? [];
    let contentTypeOk = false;
    let messageDigest: Uint8Array | null = null;
    // deno-lint-ignore no-explicit-any
    for (const attr of attributes as any[]) {
      const values = attr.values ?? [];
      if (attr.type === ATTR_CONTENT_TYPE_OID && values.length === 1) {
        contentTypeOk = values[0].valueBlock?.toString?.() ===
          signedData.encapContentInfo.eContentType;
      } else if (attr.type === ATTR_MESSAGE_DIGEST_OID && values.length === 1) {
        messageDigest = new Uint8Array(values[0].valueBlock.valueHexView ?? []);
      }
    }
    if (!contentTypeOk || !messageDigest) return false;

    const digestName = DIGEST_ALGORITHMS[
      signerInfo.digestAlgorithm.algorithmId
    ];
    if (!digestName) return false;
    const actual = new Uint8Array(
      await globalThis.crypto.subtle.digest(
        digestName,
        toBufferSource(new Uint8Array(eContent.getValue())),
      ),
    );
    if (actual.length !== messageDigest.length) return false;
    // 常量时间比对（属性长度可控，且避免时序侧信道）
    let diff = 0;
    for (let i = 0; i < actual.length; i++) {
      diff |= actual[i] ^ messageDigest[i];
    }
    if (diff !== 0) return false;
  } else {
    if (!signedData.encapContentInfo.eContent) return false;
    signedBytes = new Uint8Array(
      signedData.encapContentInfo.eContent.getValue(),
    );
  }

  try {
    return await cryptoEngine().verifyWithPublicKey(
      toBufferSource(signedBytes),
      signerInfo.signature,
      signerCert.subjectPublicKeyInfo,
      signerInfo.signatureAlgorithm,
    );
  } catch {
    return false;
  }
}

/** Uint8Array → 独立 ArrayBuffer（满足 BufferSource 类型且共享底层字节）。 */
function toBufferSource(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
}

/**
 * 离线验证已保存的时间戳（供审计/长期验证）。
 *
 * 复核链（2026-09-25 评审收紧）：
 * 1. imprint 哈希算法必须是 SHA-256，且 `messageImprint == hashHex`；
 * 2. CMS 签名有效；
 * 3. 签名者证书在 `genTime` 时刻处于有效期内（notBefore ≤ genTime ≤ notAfter）；
 * 4. **必须**配置 `rootCertPem`，且签名者证书由该根签发——否则 token 内嵌的
 *    自签证书可以自我证明，`ok:true` 将毫无信任锚意义。
 *
 * @param hashHex 政策 `content_hash`
 * @param saved `token`（base64）与 `chain`（base64，`\n` 分隔）
 * @param rootCertPem 根证书（PEM）；未提供时结果 `trusted=false`、`ok=false`
 */
export async function verifyTimestamp(
  hashHex: string,
  saved: { token: string; chain: string },
  rootCertPem?: string,
): Promise<TsaVerifyResult> {
  try {
    const tokenDer = base64Decode(saved.token);
    const ci = ContentInfo.fromBER(toBufferSource(tokenDer));
    if (ci.contentType !== SIGNED_DATA_OID) {
      return { ok: false, trusted: false, reason: "token 不是 CMS SignedData" };
    }
    const signedData = new SignedData({ schema: ci.content });
    if (!signedData.encapContentInfo.eContent) {
      return { ok: false, trusted: false, reason: "Token 缺少 TSTInfo" };
    }
    const tst = TSTInfo.fromBER(
      signedData.encapContentInfo.eContent.getValue(),
    );
    const imprintOid = tst.messageImprint.hashAlgorithm.algorithmId;
    if (imprintOid !== SHA256_OID) {
      return {
        ok: false,
        trusted: false,
        reason: `messageImprint 哈希算法必须为 SHA-256，实际为 ${imprintOid}`,
      };
    }
    const imprint = bytesToHex(
      new Uint8Array(tst.messageImprint.hashedMessage.valueBlock.valueHexView),
    );
    if (imprint !== hashHex.toLowerCase()) {
      return {
        ok: false,
        trusted: false,
        reason: "messageImprint 与哈希不匹配",
      };
    }

    // 证书链存在性
    const chainDer = saved.chain.split("\n").filter((s) => s.trim());
    if (chainDer.length === 0) {
      return { ok: false, trusted: false, reason: "缺少证书链" };
    }
    const certs = chainDer.map((b64) =>
      Certificate.fromBER(toBufferSource(base64Decode(b64)))
    );

    // CMS 签名验证（用签名者证书）
    const signerCert = findSignerCert(certs, signedData.signerInfos[0]);
    if (!signerCert) {
      return { ok: false, trusted: false, reason: "找不到签名者证书" };
    }
    const sigOk = await verifyCmsSignature(signedData, signerCert);
    if (!sigOk) {
      return { ok: false, trusted: false, reason: "CMS 签名验证失败" };
    }

    // 签名者证书在签发时刻必须处于有效期内
    const genTime = tst.genTime;
    const notBefore = signerCert.notBefore.value;
    const notAfter = signerCert.notAfter.value;
    if (genTime < notBefore || genTime > notAfter) {
      return {
        ok: false,
        signature_valid: true,
        trusted: false,
        reason:
          `签名者证书在签发时刻不在有效期内（${notBefore.toISOString()} ~ ${notAfter.toISOString()}）`,
      };
    }

    // 信任锚：必须配置根证书，且签名者证书由该根签发
    if (!rootCertPem || !rootCertPem.trim()) {
      return {
        ok: false,
        signature_valid: true,
        trusted: false,
        reason:
          "未配置 tsa_root_cert：仅能确认 CMS 签名与哈希一致，无法确认签发者身份（不得作为可信时间戳证据）",
        timestamp: genTime.toISOString(),
      };
    }
    const root = certFromPem(rootCertPem);
    const chained = await signerCert.verify(root, cryptoEngine());
    if (!chained) {
      return {
        ok: false,
        signature_valid: true,
        trusted: false,
        reason: "签名者证书未由给定根证书签发",
        timestamp: genTime.toISOString(),
      };
    }

    return {
      ok: true,
      signature_valid: true,
      trusted: true,
      timestamp: genTime.toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      trusted: false,
      reason: `解析失败：${err instanceof Error ? err.message : err}`,
    };
  }
}

/** 由 PEM 解析证书（供根证书校验）。 */
function certFromPem(pem: string): Certificate {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/, "")
    .replace(/-----END CERTIFICATE-----/, "")
    .replace(/\s+/g, "");
  return Certificate.fromBER(toBufferSource(base64Decode(b64)));
}

/**
 * 构造 RFC 3161 TimeStampReq（DER 编码，SHA-256，`certReq=true`，含 nonce）。
 *
 * 结构：SEQUENCE { version=1, messageImprint, nonce INTEGER, certReq=TRUE }
 *
 * @param hashHex SHA-256 十六进制
 * @returns DER 字节与生成的 nonce
 */
export function buildTimeStampQuery(
  hashHex: string,
): { der: Uint8Array; nonce: Uint8Array } {
  const hash = hexToBytes(hashHex);
  const sha256Oid = new asn1js.ObjectIdentifier({ value: SHA256_OID });
  const algId = new asn1js.Sequence({
    value: [sha256Oid, new asn1js.Null()],
  });
  const messageImprint = new asn1js.Sequence({
    value: [
      algId,
      new asn1js.OctetString({ valueHex: hash.buffer as ArrayBuffer }),
    ],
  });
  // 64-bit nonce
  const nonceBytes = new Uint8Array(8);
  crypto.getRandomValues(nonceBytes);
  const nonceInt = new asn1js.Integer({ valueHex: nonceBytes.buffer });
  const der = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 1 }),
      messageImprint,
      nonceInt,
      new asn1js.Boolean({ value: true }),
    ],
  }).toBER(false);
  return { der: new Uint8Array(der), nonce: nonceBytes };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
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

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
