import { assertEquals, assertMatch, assertNotEquals } from "jsr:@std/assert@^1";
import { TOTP } from "otpauth";
import {
  decryptTfaSecret,
  encryptTfaSecret,
  generateRecoveryCodes,
  generateTfaSecret,
  hashRecoveryCode,
  verifyTfaCode,
} from "./../../src/domains/identity/services/security/tfa.ts";

const TEST_TFA_KEY = "test-tfa-encryption-key-with-32-chars-min";

Deno.test("tfa: generateTfaSecret 返回 base32 secret 和 otpauth URL", () => {
  const { secret, otpauthUrl } = generateTfaSecret("alice");
  assertEquals(typeof secret, "string");
  assertEquals(secret.length > 0, true);
  assertMatch(otpauthUrl, /^otpauth:\/\/totp\/NeuroOJ:alice\?/);
  assertMatch(otpauthUrl, /secret=/);
  assertMatch(otpauthUrl, /issuer=NeuroOJ/);
});

Deno.test("tfa: encryptTfaSecret/decryptTfaSecret 往返一致", () => {
  Deno.env.set("TFA_ENCRYPTION_KEY", TEST_TFA_KEY);
  const secret = "JBSWY3DPEHPK3PXP";
  const encrypted = encryptTfaSecret(secret);
  assertEquals(encrypted.includes(secret), false);
  assertEquals(decryptTfaSecret(encrypted), secret);
});

Deno.test("tfa: verifyTfaCode 接受当前 TOTP 验证码", () => {
  const { secret } = generateTfaSecret("alice");
  const totp = new TOTP({ secret, issuer: "NeuroOJ", label: "alice" });
  const code = totp.generate();
  assertEquals(verifyTfaCode(secret, code), true);
});

Deno.test("tfa: verifyTfaCode 拒绝错误验证码", () => {
  const { secret } = generateTfaSecret("alice");
  assertEquals(verifyTfaCode(secret, "000000"), false);
});

Deno.test("tfa: generateRecoveryCodes 生成 10 个指定格式恢复码", () => {
  const codes = generateRecoveryCodes();
  assertEquals(codes.length, 10);
  for (const code of codes) {
    assertMatch(
      code,
      /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
    );
  }
});

Deno.test("tfa: hashRecoveryCode 是 SHA-256 hex 且同码同哈希", async () => {
  const code = "ABCD-EFGH-JKLM";
  const hash1 = await hashRecoveryCode(code);
  const hash2 = await hashRecoveryCode(code);
  const hash3 = await hashRecoveryCode("ABCD-EFGH-JKLN");
  assertMatch(hash1, /^[a-f0-9]{64}$/);
  assertEquals(hash1, hash2);
  assertNotEquals(hash1, hash3);
});
