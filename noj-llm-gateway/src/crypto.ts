/**
 * 加密工具：AES-256-GCM 信封加密 + AEAD eval_token。
 *
 * - NOJ_LLM_STORE_KEY：加密/解密上游 Provider API Key
 * - NOJ_LLM_SERVICE_TOKEN：签发/校验 eval_token
 */
import { encodeBase64, decodeBase64 } from "@std/encoding/base64";

const IV_LENGTH = 12;

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 使用 AES-256-GCM 加密字符串，返回 base64(iv || ciphertext || tag) */
export async function encryptSecret(
  plaintext: string,
  storeKey: string,
): Promise<string> {
  const key = await deriveKey(storeKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const data = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  data.set(iv);
  data.set(new Uint8Array(ciphertext), IV_LENGTH);
  return encodeBase64(data);
}

/** 解密 encryptSecret 产生的密文 */
export async function decryptSecret(
  payload: string,
  storeKey: string,
): Promise<string> {
  const key = await deriveKey(storeKey);
  const data = decodeBase64(payload);
  if (data.length < IV_LENGTH) {
    throw new Error("密文格式错误：长度不足");
  }
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

export interface EvalTokenPayload {
  jti: string;
  submission_id: string;
  problem_id: string;
  user_id: string;
  provider_id: string;
  allowed_models: string[];
  iat: number;
  exp: number;
  max_calls: number;
  max_tokens: number;
}

/** 签发 AEAD eval_token，返回 base64url(iv || ciphertext || tag) */
export async function mintEvalToken(
  payload: EvalTokenPayload,
  serviceToken: string,
): Promise<string> {
  const key = await deriveKey(serviceToken);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  const data = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  data.set(iv);
  data.set(new Uint8Array(ciphertext), IV_LENGTH);
  return encodeBase64(data);
}

/** 校验并解密 eval_token；过期或非法时抛出错误 */
export async function verifyEvalToken(
  token: string,
  serviceToken: string,
): Promise<EvalTokenPayload> {
  const key = await deriveKey(serviceToken);
  const data = decodeBase64(token);
  if (data.length < IV_LENGTH) {
    throw new Error("eval_token 格式错误");
  }
  const iv = data.slice(0, IV_LENGTH);
  const ciphertext = data.slice(IV_LENGTH);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
  } catch {
    throw new Error("eval_token 校验失败");
  }
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as EvalTokenPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("eval_token 已过期");
  }
  return payload;
}
