/**
 * TFA TOTP 工具库（issue #228）。
 *
 * 职责：
 * - 生成 TOTP secret 与 otpauth URI
 * - 使用 `TFA_ENCRYPTION_KEY` 对 secret 做 AES-256-GCM 加密/解密
 * - 校验 TOTP 验证码（允许 ±1 个时间步长）
 * - 生成/哈希一次性恢复码
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { Secret, TOTP } from "otpauth";

/** TFA 加密密钥最小长度。 */
const MIN_TFA_ENCRYPTION_KEY_LENGTH = 32;

/** 恢复码字符集：去除 0/O/1/I，避免手输混淆。 */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 恢复码分组数。 */
const RECOVERY_GROUP_COUNT = 3;

/** 每组字符数。 */
const RECOVERY_GROUP_LENGTH = 4;

/** 默认恢复码数量。 */
export const RECOVERY_CODE_COUNT = 10;

export interface TfaSecretResult {
  /** TOTP base32 secret */
  secret: string;
  /** otpauth:// 二维码 URI */
  otpauthUrl: string;
}

function getEncryptionKey(): Uint8Array {
  const key = Deno.env.get("TFA_ENCRYPTION_KEY");
  if (!key || key.length < MIN_TFA_ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `TFA_ENCRYPTION_KEY 未配置或长度不足 ${MIN_TFA_ENCRYPTION_KEY_LENGTH} 字符`,
    );
  }
  return new Uint8Array(createHash("sha256").update(key).digest());
}

/**
 * 生成新的 TOTP secret 与 otpauth URI。
 *
 * @param username - 用于 otpauth label 的用户名
 */
export function generateTfaSecret(username: string): TfaSecretResult {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    secret: secret.base32,
    issuer: "NeuroOJ",
    label: username,
  });
  return {
    secret: secret.base32,
    otpauthUrl: totp.toString(),
  };
}

/**
 * 加密 TOTP secret（AES-256-GCM）。
 * 返回格式：`base64(iv).base64(ciphertext + authTag)`
 */
export function encryptTfaSecret(secret: string): string {
  const key = getEncryptionKey();
  const iv = new Uint8Array(randomBytes(12));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = new Uint8Array(
    Buffer.concat([
      new Uint8Array(cipher.update(secret, "utf8")),
      new Uint8Array(cipher.final()),
    ]),
  );
  const authTag = new Uint8Array(cipher.getAuthTag());
  const payload = new Uint8Array(encrypted.length + authTag.length);
  payload.set(encrypted);
  payload.set(authTag, encrypted.length);
  return `${Buffer.from(iv).toString("base64")}.${
    Buffer.from(payload).toString("base64")
  }`;
}

/**
 * 解密 TOTP secret。
 * 输入格式须与 `encryptTfaSecret` 一致。
 */
export function decryptTfaSecret(payload: string): string {
  const key = getEncryptionKey();
  const [ivB64, dataB64] = payload.split(".");
  if (!ivB64 || !dataB64) {
    throw new Error("TFA secret 密文格式无效");
  }
  const iv = new Uint8Array(Buffer.from(ivB64, "base64"));
  const data = new Uint8Array(Buffer.from(dataB64, "base64"));
  const authTag = data.subarray(data.length - 16);
  const encrypted = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    new Uint8Array(decipher.update(encrypted)),
    new Uint8Array(decipher.final()),
  ]).toString("utf8");
}

/**
 * 校验 TOTP 验证码。
 * 允许 ±1 个时间步长（30 秒）的时钟偏移。
 */
export function verifyTfaCode(secret: string, code: string): boolean {
  try {
    const totp = new TOTP({ secret, issuer: "NeuroOJ" });
    return totp.validate({ token: code, window: 1 }) !== null;
  } catch {
    return false;
  }
}

function generateRecoveryGroup(): string {
  let group = "";
  for (let i = 0; i < RECOVERY_GROUP_LENGTH; i++) {
    group += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }
  return group;
}

/**
 * 生成一次性恢复码。
 * 格式：`XXXX-XXXX-XXXX`，字符集去除 0/O/1/I。
 */
export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
): string[] {
  return Array.from(
    { length: count },
    () =>
      Array.from(
        { length: RECOVERY_GROUP_COUNT },
        () => generateRecoveryGroup(),
      )
        .join("-"),
  );
}

/**
 * 计算恢复码 SHA-256 哈希（hex）。
 */
export async function hashRecoveryCode(code: string): Promise<string> {
  const data = new TextEncoder().encode(code);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
