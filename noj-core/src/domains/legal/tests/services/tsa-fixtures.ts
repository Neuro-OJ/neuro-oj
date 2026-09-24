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
  AttributeTypeAndValue,
  Certificate,
  CryptoEngine,
  EncapsulatedContentInfo,
  IssuerAndSerialNumber,
  MessageImprint,
  PKIStatusInfo,
  RelativeDistinguishedNames,
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
