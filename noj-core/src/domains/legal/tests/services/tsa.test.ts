/**
 * TSA（RFC 3161 时间戳）Provider 测试。
 *
 * 覆盖：
 * - disabled / 未配置端点 → null
 * - **拒答响应**（PKIStatus=2）不得当成功
 * - **messageImprint 不匹配** 不得当成功
 * - **无证书链**（certReq=true 但 TSA 未回证书）不得当成功
 * - 成功时解析出 token（TST）、证书链、genTime、原始 TSQ
 * - 网络错误 / 非 2xx → null 且不抛
 * - `verifyTimestamp`：篡改哈希必失败；离线复验成功案例
 *
 * 测试夹具用 pkijs **真实构造** TimeStampResp（自签证书 + CMS 签名），
 * 而非伪造字节，以真正覆盖解析与验签路径。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import { resetDbForTest } from "../../../../shared/db/connection.ts";
import { updateSetting } from "./../../../system/services/system-settings.ts";
import { timestampHash, tsaEnabled, verifyTimestamp } from "../../index.ts";
import {
  buildForgedTimeStampRespWithCert,
  buildTestTimeStampResp,
  buildTestTimeStampRespWithCert,
} from "./tsa-fixtures.ts";

/** 临时替换全局 fetch。 */
function withFetch(
  impl: typeof fetch,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

Deno.test({
  name: "tsa: disabled 时 tsaEnabled=false 且不打戳",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "disabled", "0");
    assertEquals(tsaEnabled(), false);
    assertEquals(await timestampHash("ab".repeat(32)), null);
  },
});

Deno.test({
  name: "tsa: 未配置自定义端点时返回 null",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "", "0");
    assertEquals(tsaEnabled(), true);
    assertEquals(await timestampHash("ab".repeat(32)), null);
  },
});

Deno.test({
  name: "tsa: 成功时解析 token、证书链、genTime 与原始 TSQ",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    const hash = "ab".repeat(32);
    const resp = await buildTestTimeStampResp(hash);

    await withFetch(
      (() => Promise.resolve(resp)) as typeof fetch,
      async () => {
        const result = await timestampHash(hash);
        assertEquals(result?.provider, "custom");
        assertEquals(typeof result?.token, "string");
        assertEquals(result!.token.length > 0, true);
        // chain 是真证书链（非 token 副本）
        assertEquals(result!.chain.length > 0, true);
        assertEquals(result!.chain === result!.token, false);
        // genTime 存在且可解析
        assertEquals(typeof result?.timestamp, "string");
        assertEquals(Number.isNaN(Date.parse(result!.timestamp)), false);
        // 原始 TSQ 保存
        assertEquals(typeof result?.query, "string");
        assertEquals(result!.query.length > 0, true);
      },
    );
  },
});

Deno.test({
  name: "tsa: PKIStatus 拒答（2）不得被当成功",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    const hash = "ab".repeat(32);
    const resp = await buildTestTimeStampResp(hash, { status: 2 });

    await withFetch(
      (() => Promise.resolve(resp)) as typeof fetch,
      async () => {
        assertEquals(await timestampHash(hash), null);
      },
    );
  },
});

Deno.test({
  name: "tsa: messageImprint 不匹配不得被当成功",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    // TSA 返回的是别的哈希的 token
    const resp = await buildTestTimeStampResp("cd".repeat(32));

    await withFetch(
      (() => Promise.resolve(resp)) as typeof fetch,
      async () => {
        assertEquals(await timestampHash("ab".repeat(32)), null);
      },
    );
  },
});

Deno.test({
  name: "tsa: 响应无证书链（certReq 未满足）不得被当成功",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    const hash = "ab".repeat(32);
    const resp = await buildTestTimeStampResp(hash, { includeCerts: false });

    await withFetch(
      (() => Promise.resolve(resp)) as typeof fetch,
      async () => {
        assertEquals(await timestampHash(hash), null);
      },
    );
  },
});

Deno.test({
  name: "tsa: 网络错误返回 null 且不抛",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    await withFetch(
      (() => Promise.reject(new Error("network down"))) as typeof fetch,
      async () => {
        assertEquals(await timestampHash("ab".repeat(32)), null);
      },
    );
  },
});

Deno.test({
  name: "tsa: 非 2xx 返回 null",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    await withFetch(
      (() =>
        Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch,
      async () => {
        assertEquals(await timestampHash("ab".repeat(32)), null);
      },
    );
  },
});

Deno.test({
  name: "tsa: verifyTimestamp 成功复验；篡改哈希必失败",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    const hash = "ab".repeat(32);
    const built = await buildTestTimeStampRespWithCert(hash);
    let captured: { token: string; chain: string } | null = null;

    await withFetch(
      (() => Promise.resolve(built.response)) as typeof fetch,
      async () => {
        const r = await timestampHash(hash);
        captured = { token: r!.token, chain: r!.chain };
      },
    );

    // 正确哈希 + 提供签名者证书作为根 → 完整验证通过
    const ok = await verifyTimestamp(hash, captured!, built.signerCertPem);
    assertEquals(ok.ok, true);
    assertEquals(ok.trusted, true);
    assertEquals(ok.signature_valid, true);

    // 篡改哈希 → 失败（imprint 不匹配）
    const bad = await verifyTimestamp(
      "cd".repeat(32),
      captured!,
      built.signerCertPem,
    );
    assertEquals(bad.ok, false);
  },
});

Deno.test({
  // 2026-09-25 评审：未配置根证书时不得用 token 内嵌的自签链自证
  name: "tsa: verifyTimestamp 未配置根证书时 refused（trusted=false）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    const hash = "ef".repeat(32);
    const built = await buildTestTimeStampRespWithCert(hash);
    let captured: { token: string; chain: string } | null = null;
    await withFetch(
      (() => Promise.resolve(built.response)) as typeof fetch,
      async () => {
        const r = await timestampHash(hash);
        captured = { token: r!.token, chain: r!.chain };
      },
    );

    const result = await verifyTimestamp(hash, captured!);
    assertEquals(result.ok, false);
    assertEquals(result.trusted, false);
    // 签名本身有效，但无信任锚——这正是"不得作为可信证据"的语义
    assertEquals(result.signature_valid, true);
    assertEquals(result.reason?.includes("tsa_root_cert"), true);
  },
});

Deno.test({
  name: "tsa: verifyTimestamp 无关根证书 → 拒绝；过期证书 → 拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    const hash = "12".repeat(32);
    const built = await buildTestTimeStampRespWithCert(hash);
    let captured: { token: string; chain: string } | null = null;
    await withFetch(
      (() => Promise.resolve(built.response)) as typeof fetch,
      async () => {
        const r = await timestampHash(hash);
        captured = { token: r!.token, chain: r!.chain };
      },
    );

    // 另一张无关的自签证书作为根 → 链校验必失败
    const unrelated = await buildTestTimeStampRespWithCert("34".repeat(32));
    const chained = await verifyTimestamp(
      hash,
      captured!,
      unrelated.signerCertPem,
    );
    assertEquals(chained.ok, false);
    assertEquals(chained.trusted, false);
    assertEquals(chained.reason?.includes("未由给定根证书签发"), true);

    // 签名者证书已过期（notAfter 在过去）→ 拒绝
    const expired = await buildTestTimeStampRespWithCert(hash, {
      notBefore: new Date(Date.now() - 7200_000),
      notAfter: new Date(Date.now() - 3600_000),
    });
    let expiredCaptured: { token: string; chain: string } | null = null;
    await withFetch(
      (() => Promise.resolve(expired.response)) as typeof fetch,
      async () => {
        const r = await timestampHash(hash);
        expiredCaptured = { token: r!.token, chain: r!.chain };
      },
    );
    const expiredResult = await verifyTimestamp(
      hash,
      expiredCaptured!,
      expired.signerCertPem,
    );
    assertEquals(expiredResult.ok, false);
    assertEquals(expiredResult.reason?.includes("有效期内"), true);
  },
});

Deno.test({
  name: "tsa: 响应 nonce 与请求不一致 → 打戳失败（防重放）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    const hash = "78".repeat(32);
    // 回显一个固定但错误的 nonce：与请求中随机 nonce 必然不一致
    const resp = await buildTestTimeStampResp(hash, {
      nonceHex: "0011223344556677",
    });
    await withFetch(
      (() => Promise.resolve(resp)) as typeof fetch,
      async () => {
        assertEquals(await timestampHash(hash), null);
      },
    );
  },
});

Deno.test({
  name: "tsa: verifyTimestamp 非 SHA-256 imprint 算法 → 拒绝",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    const hash = "56".repeat(32);
    // SHA-1 OID：算法不符必须拒绝（此前只比对字节、不看算法标识）
    const built = await buildTestTimeStampRespWithCert(hash, {
      hashAlgorithmOid: "1.3.14.3.2.26",
    });
    let captured: { token: string; chain: string } | null = null;
    await withFetch(
      (() => Promise.resolve(built.response)) as typeof fetch,
      async () => {
        const r = await timestampHash(hash);
        captured = { token: r!.token, chain: r!.chain };
      },
    );

    const result = await verifyTimestamp(hash, captured!, built.signerCertPem);
    assertEquals(result.ok, false);
    assertEquals(result.reason?.includes("SHA-256"), true);
  },
});

Deno.test({
  name:
    "tsa: verifyTimestamp 拒绝 eContent 被替换的伪造 token（signedAttrs 绑定）",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    // 攻击场景：持有对 `signedHash` 的合法 token，把 eContent 换成
    // `forgedHash` 的 imprint，冒充「该哈希被打过戳」。
    const signedHash = "ab".repeat(32);
    const forgedHash = "cd".repeat(32);
    const forged = await buildForgedTimeStampRespWithCert(
      signedHash,
      forgedHash,
    );

    // 通过 timestampHash 落库路径构造伪造记录不可行（它只接受真实响应），
    // 因此直接解析伪造响应，组装 saved 结构后复验。
    // 修复前这里会返回 ok:true（缺少 signedAttrs.messageDigest 校验），
    // 修复后必须 ok:false——且必须传入真实根证书，使失败归因于签名绑定
    // 而非"缺少信任锚"（2026-09-25 评审收紧信任模型）。
    const { extractTokenForTest } = await import("./tsa-fixtures.ts");
    const saved = await extractTokenForTest(forged.response);

    const result = await verifyTimestamp(
      forgedHash,
      saved,
      forged.signerCertPem,
    );
    assertEquals(result.ok, false);

    // 对照：真实 token 对真实哈希仍然通过
    const real = await buildTestTimeStampRespWithCert(signedHash);
    const realSaved = await extractTokenForTest(real.response);
    const realOk = await verifyTimestamp(
      signedHash,
      realSaved,
      real.signerCertPem,
    );
    assertEquals(realOk.ok, true);
  },
});

Deno.test({
  name: "tsa: publishVersion 落库 tsa_query / tsa_timestamp / 真证书链",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetDbForTest();
    await updateSetting("tsa_provider", "custom", "0");
    await updateSetting("tsa_url", "https://tsa.example.test/tsr", "0");

    // 需要发布者用户（created_by FK）
    const { getDb } = await import("../../../../shared/db/connection.ts");
    const { users } = await import("../../../../shared/db/schema.ts");
    const db = getDb();
    const now = new Date().toISOString();
    const publisher = "tsa-publish-publisher";
    await db.insert(users).values({
      id: publisher,
      username: "tsa_publisher",
      email: "tsa_publisher@example.test",
      password_hash: "",
      created_at: now,
      updated_at: now,
    }).onConflictDoNothing();

    // 先算出内容哈希以构造匹配的 TSA 响应
    const { hashContent, publishVersion, getVersionTsa } = await import(
      "../../index.ts"
    );
    const content = "# 政策正文（TSA 落库）";
    const hash = await hashContent(content);
    const resp = await buildTestTimeStampResp(hash);

    const fetchImpl = (() => Promise.resolve(resp)) as typeof fetch;
    // publishVersion 内部 fetch；需要在此期间替换
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await publishVersion("privacy", content, "重大", true, publisher);
    } finally {
      globalThis.fetch = original;
    }

    const rec = await getVersionTsa("privacy", 1);
    assertEquals(rec?.provider, "custom");
    assertEquals(typeof rec?.query, "string");
    assertEquals((rec!.query ?? "").length > 0, true);
    assertEquals(typeof rec?.timestamp, "string");
    // 证书链是真链（多行 base64），不是 token 副本
    assertEquals(typeof rec?.chain, "string");
    assertEquals(rec!.chain !== rec!.token, true);
  },
});
