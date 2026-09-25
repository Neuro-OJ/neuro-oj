/**
 * TSA 测试夹具：用 pkijs 真实构造 RFC 3161 `TimeStampResp`。
 *
 * 目的：让 `tsa.ts` 的解析/验签路径被**真实密码学结构**覆盖，而非伪造字节。
 * 生成一张自签 RSA 证书，用其私钥对 `TSTInfo` 做 CMS SignedData 签名，
 * 可指定 PKIStatus、是否内嵌证书、以及 imprint 用的哈希（用于测不匹配）。
 */

import * as asn1js from "asn1js";
import {
  AlgorithmIdentifier,
  Attribute,
  AttributeTypeAndValue,
  Certificate,
  CryptoEngine,
  EncapsulatedContentInfo,
  IssuerAndSerialNumber,
  MessageImprint,
  PKIStatusInfo,
  RelativeDistinguishedNames,
  SignedAndUnsignedAttributes,
  SignedData,
  SignerInfo,
  Time,
  TSTInfo,
} from "pkijs";

/** 构造选项。 */
export interface FixtureOptions {
  /** PKIStatusInfo.status：0=granted / 1=grantedWithMods / 2=rejection */
  status?: number;
  /** 是否把签名者证书内嵌进 CMS（certReq=true 的响应应内嵌） */
  includeCerts?: boolean;
  /** 签名者证书 notBefore（缺省 now-1h），用于构造过期证书场景 */
  notBefore?: Date;
  /** 签名者证书 notAfter（缺省 now+1h） */
  notAfter?: Date;
  /** messageImprint 的哈希算法 OID（缺省 sha256），用于构造算法不符场景 */
  hashAlgorithmOid?: string;
  /** 回显的 nonce（hex）；缺省不回显，用于构造 nonce 不匹配场景 */
  nonceHex?: string;
  /**
   * 是否携带 signedAttrs（contentType + messageDigest）。
   *
   * 真实 TSA（freetsa/digicert 等）默认携带；缺省 `true` 以贴近真实形态，
   * 并让 `verifyTimestamp` 的 RFC 5652 §5.4 绑定校验被真实覆盖。
   */
  signedAttrs?: boolean;
}

/** 由 hex 构造字节。 */
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

/** 证书 → PEM（供"把签名者证书当根证书"用例使用）。 */
export function certToPem(cert: Certificate): string {
  const der = new Uint8Array(cert.toSchema(true).toBER(false));
  let b64 = "";
  for (const byte of der) b64 += String.fromCharCode(byte);
  const wrapped = btoa(b64).replace(/(.{64})/g, "$1\n").trim();
  return `-----BEGIN CERTIFICATE-----\n${wrapped}\n-----END CERTIFICATE-----\n`;
}

/** 生成自签 RSA 证书（含私钥）。 */
async function makeSelfSignedCert(opts: FixtureOptions = {}): Promise<{
  cert: Certificate;
  privateKey: CryptoKey;
}> {
  const { publicKey, privateKey } = await globalThis.crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const rdn = new RelativeDistinguishedNames({
    typesAndValues: [
      new AttributeTypeAndValue({
        type: "2.5.4.3",
        value: new asn1js.Utf8String({ value: "TSA Test" }),
      }),
    ],
  });

  const cert = new Certificate({
    version: 2,
    serialNumber: new asn1js.Integer({ value: 1 }),
    signature: new AlgorithmIdentifier({
      algorithmId: "1.2.840.113549.1.1.11", // sha256WithRSAEncryption
    }),
    issuer: rdn,
    notBefore: new Time({
      type: 1,
      value: opts.notBefore ?? new Date(Date.now() - 3600_000),
    }),
    notAfter: new Time({
      type: 1,
      value: opts.notAfter ?? new Date(Date.now() + 3600_000),
    }),
    subject: rdn,
    extensions: [],
  });
  await cert.subjectPublicKeyInfo.importKey(publicKey);
  await cert.sign(privateKey, "SHA-256");

  return { cert, privateKey };
}

/**
 * 构造一个 `TimeStampResp`（HTTP 200 + application/timestamp-reply）。
 *
 * @param hashHex 写入 TSTInfo 的 messageImprint 哈希（hex）
 * @param opts 选项
 */
export async function buildTestTimeStampResp(
  hashHex: string,
  opts: FixtureOptions = {},
): Promise<Response> {
  const built = await buildTestTimeStampRespWithCert(hashHex, opts);
  return built.response;
}

/**
 * 同 {@link buildTestTimeStampResp}，但一并返回签名者证书的 PEM。
 *
 * 供"信任锚"类用例使用：自签证书场景下，把该 PEM 作为 `tsa_root_cert` 即应
 * 通过链校验；换成另一张无关证书则必须失败（2026-09-25 评审）。
 *
 * @param hashHex 写入 TSTInfo 的 messageImprint 哈希（hex）
 * @param opts 选项
 * @returns 响应与签名者证书 PEM
 */
export async function buildTestTimeStampRespWithCert(
  hashHex: string,
  opts: FixtureOptions = {},
): Promise<{ response: Response; signerCertPem: string }> {
  const status = opts.status ?? 0;
  const includeCerts = opts.includeCerts ?? true;
  const { cert, privateKey } = await makeSelfSignedCert(opts);

  const tstInfo = new TSTInfo({
    version: 1,
    policy: "1.2.3.4.5",
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({
        algorithmId: opts.hashAlgorithmOid ?? "2.16.840.1.101.3.4.2.1", // sha256
      }),
      hashedMessage: new asn1js.OctetString({
        valueHex: hexToBytes(hashHex).buffer as ArrayBuffer,
      }),
    }),
    serialNumber: new asn1js.Integer({ value: 1 }),
    genTime: new Date(),
    // 可选回显 nonce（用于 nonce 不匹配场景；缺省不回显）
    ...(opts.nonceHex
      ? {
        nonce: new asn1js.Integer({
          valueHex: hexToBytes(opts.nonceHex).buffer as ArrayBuffer,
        }),
      }
      : {}),
  });

  const eContent = tstInfo.toSchema().toBER(false);
  const signerInfo = new SignerInfo({
    version: 1,
    sid: new IssuerAndSerialNumber({
      issuer: cert.issuer,
      serialNumber: cert.serialNumber,
    }),
  });
  // 真实 TSA 响应携带 signedAttrs（contentType + messageDigest）。
  // messageDigest 必须是 eContent（TSTInfo DER）的 SHA-256——RFC 5652 §5.4；
  // `verifyCmsSignature` 会核对这一点，缺省构造为真实形态以便回归覆盖。
  if (opts.signedAttrs !== false) {
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest("SHA-256", eContent),
    );
    signerInfo.signedAttrs = new SignedAndUnsignedAttributes({
      type: 0,
      attributes: [
        new Attribute({
          type: "1.2.840.113549.1.9.3", // content-type
          values: [
            new asn1js.ObjectIdentifier({
              value: "1.2.840.113549.1.9.16.1.4",
            }),
          ],
        }),
        new Attribute({
          type: "1.2.840.113549.1.9.4", // message-digest
          values: [new asn1js.OctetString({ valueHex: digest.buffer })],
        }),
      ],
    });
  }
  const signedData = new SignedData({
    version: 3,
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: "1.2.840.113549.1.9.16.1.4", // id-ct-TSTInfo
    }),
    certificates: includeCerts ? [cert] : [],
    crls: [],
    signerInfos: [signerInfo],
  });
  // 显式设置 eContent（构造期传入会被视为 detached）
  signedData.encapContentInfo.eContent = new asn1js.OctetString({
    valueHex: eContent,
  });

  const engine = new CryptoEngine({
    crypto: globalThis.crypto,
    subtle: globalThis.crypto.subtle,
  });
  await signedData.sign(privateKey, 0, "SHA-256", eContent, engine);

  // 组装 SignedData 的 DER：pkijs 的 SignedData.toSchema 在含 SignedAttrs 的
  // signerInfo 场景下会因内部结构缺 lenBlock 而抛错，故逐组件拼接（各组件
  // 的 toSchema/toBER 均已验证可用），再包 ContentInfo [0] EXPLICIT。
  const signedDataDer = assembleSignedDataDer({
    version: 3,
    digestAlgorithms: Array.from(signedData.digestAlgorithms),
    eContentType: "1.2.840.113549.1.9.16.1.4",
    eContent,
    certificates: includeCerts ? [cert] : [],
    signerInfos: Array.from(signedData.signerInfos),
  });

  // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken ContentInfo OPTIONAL }
  const statusDer = new PKIStatusInfo({ status }).toSchema().toBER(false);
  const respValue: asn1js.BaseBlock[] = [
    asn1js.fromBER(statusDer).result as asn1js.Sequence,
  ];
  if (includeCerts) {
    const explicit = new asn1js.Constructed({
      idBlock: { tagClass: 3, tagNumber: 0 }, // [0] EXPLICIT
      value: [asn1js.fromBER(signedDataDer).result as asn1js.Sequence],
    });
    respValue.push(
      new asn1js.Sequence({
        value: [
          new asn1js.ObjectIdentifier({ value: "1.2.840.113549.1.7.2" }),
          explicit,
        ],
      }),
    );
  }
  const respDer = new asn1js.Sequence({ value: respValue }).toBER(false);

  return {
    response: new Response(respDer, {
      status: 200,
      headers: { "Content-Type": "application/timestamp-reply" },
    }),
    signerCertPem: certToPem(cert),
  };
}

/**
 * 从 TimeStampResp 提取 `{token, chain}`（与 `timestampHash` 落库结构一致），
 * 供测试直接复验伪造/真实响应，无需经过网络路径。
 *
 * @param resp `buildTestTimeStampResp` / `buildForgedTimeStampResp` 的返回值
 */
export async function extractTokenForTest(
  resp: Response,
): Promise<{ token: string; chain: string }> {
  const der = new Uint8Array(await resp.arrayBuffer());
  const parsed = asn1js.fromBER(der.buffer as ArrayBuffer)
    .result as asn1js.Sequence;
  const tokenCi = parsed.valueBlock.value[1] as asn1js.Sequence;
  const explicit = tokenCi.valueBlock.value[1] as asn1js.Constructed;
  const signedDataSeq = explicit.valueBlock.value[0] as asn1js.Sequence;

  const certsImplicit = signedDataSeq.valueBlock.value[3] as asn1js.Constructed;
  const chain = certsImplicit.valueBlock.value
    .map((c) => base64Encode(new Uint8Array(c.toBER(false))))
    .join("\n");

  return {
    token: base64Encode(new Uint8Array(tokenCi.toBER(false))),
    chain,
  };
}

function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * 构造一个**伪造的**时间戳响应：签名与 signedAttrs 来自真实 token（对
 * `signedHashHex` 打戳），但 eContent（TSTInfo）被替换为 `forgedHashHex` 的
 * imprint——即攻击者用任意一条合法 TSA token 冒充「对另一哈希打过戳」。
 *
 * 用于回归 RFC 5652 §5.4 的 `signedAttrs.messageDigest == H(eContent)` 校验：
 * 修复前 `verifyTimestamp(forgedHashHex, …)` 会错误地返回 `ok:true`。
 *
 * @param signedHashHex 真实被打戳的哈希（进入 signedAttrs 的 messageDigest）
 * @param forgedHashHex 伪造进 eContent 的哈希
 */
export async function buildForgedTimeStampResp(
  signedHashHex: string,
  forgedHashHex: string,
): Promise<Response> {
  const built = await buildForgedTimeStampRespWithCert(
    signedHashHex,
    forgedHashHex,
  );
  return built.response;
}

/**
 * 同 {@link buildForgedTimeStampResp}，但一并返回签名者证书 PEM。
 *
 * 供信任锚收紧后的用例使用：伪造 token 的失败必须是"签名绑定不成立"，
 * 因此复验时需要传入真实根证书，否则会因缺少信任锚而先行失败。
 *
 * @param signedHashHex 真实被打戳的哈希
 * @param forgedHashHex 伪造进 eContent 的哈希
 */
export async function buildForgedTimeStampRespWithCert(
  signedHashHex: string,
  forgedHashHex: string,
): Promise<{ response: Response; signerCertPem: string }> {
  const real = await buildTestTimeStampRespWithCert(signedHashHex);
  const realDer = new Uint8Array(await real.response.arrayBuffer());

  // 解析真实响应，取 token 的签名字节与证书，替换 eContent 为伪造 TSTInfo。
  const resp = asn1js.fromBER(realDer.buffer as ArrayBuffer)
    .result as asn1js.Sequence;
  const tokenCi = resp.valueBlock.value[1] as asn1js.Sequence;
  const explicit = tokenCi.valueBlock.value[1] as asn1js.Constructed;
  const signedDataSeq = explicit.valueBlock.value[0] as asn1js.Sequence;

  const forgedTst = new TSTInfo({
    version: 1,
    policy: "1.2.3.4.5",
    messageImprint: new MessageImprint({
      hashAlgorithm: new AlgorithmIdentifier({
        algorithmId: "2.16.840.1.101.3.4.2.1",
      }),
      hashedMessage: new asn1js.OctetString({
        valueHex: hexToBytes(forgedHashHex).buffer as ArrayBuffer,
      }),
    }),
    serialNumber: new asn1js.Integer({ value: 1 }),
    genTime: new Date(),
  });
  const forgedEContent = forgedTst.toSchema().toBER(false);

  // signedDataSeq.valueBlock.value[2] = encapContentInfo（保留其 eContentType，
  // 仅替换 [0] EXPLICIT 内的 OCTET STRING 内容）。
  const eci = signedDataSeq.valueBlock.value[2] as asn1js.Sequence;
  const eciExplicit = eci.valueBlock.value[1] as asn1js.Constructed;
  eciExplicit.valueBlock.value = [
    new asn1js.OctetString({ valueHex: forgedEContent }),
  ];

  const forgedSignedData = new asn1js.Sequence({
    value: signedDataSeq.valueBlock.value,
  }).toBER(false);

  const statusDer = new PKIStatusInfo({ status: 0 }).toSchema().toBER(false);
  const respDer = new asn1js.Sequence({
    value: [
      asn1js.fromBER(statusDer).result as asn1js.Sequence,
      new asn1js.Sequence({
        value: [
          new asn1js.ObjectIdentifier({ value: "1.2.840.113549.1.7.2" }),
          new asn1js.Constructed({
            idBlock: { tagClass: 3, tagNumber: 0 },
            value: [
              asn1js.fromBER(forgedSignedData).result as asn1js.Sequence,
            ],
          }),
        ],
      }),
    ],
  }).toBER(false);

  return {
    response: new Response(respDer, {
      status: 200,
      headers: { "Content-Type": "application/timestamp-reply" },
    }),
    signerCertPem: real.signerCertPem,
  };
}

/**
 * 手工组装 SignedData 的 DER。
 *
 * SignedData ::= SEQUENCE {
 *   version INTEGER,
 *   digestAlgorithms SET OF AlgorithmIdentifier,
 *   encapContentInfo EncapsulatedContentInfo,
 *   certificates [0] IMPLICIT SET OF Certificate OPTIONAL,
 *   signerInfos SET OF SignerInfo }
 */
function assembleSignedDataDer(parts: {
  version: number;
  // deno-lint-ignore no-explicit-any
  digestAlgorithms: any[];
  eContentType: string;
  eContent: ArrayBuffer;
  // deno-lint-ignore no-explicit-any
  certificates: any[];
  // deno-lint-ignore no-explicit-any
  signerInfos: any[];
}): Uint8Array {
  const seq = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: parts.version }),
      new asn1js.Set({
        value: parts.digestAlgorithms.map((a) => a.toSchema()),
      }),
      new asn1js.Sequence({
        value: [
          new asn1js.ObjectIdentifier({ value: parts.eContentType }),
          new asn1js.Constructed({
            idBlock: { tagClass: 3, tagNumber: 0 }, // [0] EXPLICIT
            value: [new asn1js.OctetString({ valueHex: parts.eContent })],
          }),
        ],
      }),
      new asn1js.Constructed({
        idBlock: { tagClass: 3, tagNumber: 0 }, // [0] IMPLICIT certificates
        value: parts.certificates.map((c) => c.toSchema()),
      }),
      new asn1js.Set({
        value: parts.signerInfos.map((s) => s.toSchema()),
      }),
    ],
  });
  return new Uint8Array(seq.toBER(false));
}
