import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  decryptSecret,
  encryptSecret,
  mintEvalToken,
  verifyEvalToken,
} from "../src/crypto.ts";

Deno.test("crypto: encrypt/decrypt roundtrip", async () => {
  const key = "test-store-key-0123456789abcdef";
  const secret = "sk-test-secret";
  const encrypted = await encryptSecret(secret, key);
  const decrypted = await decryptSecret(encrypted, key);
  assertEquals(decrypted, secret);
});

Deno.test("crypto: eval_token mint/verify", async () => {
  const serviceToken = "test-service-token-0123456789abcdef";
  const payload = {
    jti: crypto.randomUUID(),
    submission_id: "sub-1",
    problem_id: "prob-1",
    user_id: "user-1",
    provider_id: "prov-1",
    allowed_models: ["qwen-plus"],
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 3600,
    max_calls: 100,
    max_tokens: 50000,
  };
  const token = await mintEvalToken(payload, serviceToken);
  const verified = await verifyEvalToken(token, serviceToken);
  assertEquals(verified.submission_id, payload.submission_id);
  assertEquals(verified.allowed_models, ["qwen-plus"]);
});

Deno.test("crypto: expired token rejected", async () => {
  const serviceToken = "test-service-token-0123456789abcdef";
  const payload = {
    jti: crypto.randomUUID(),
    submission_id: "sub-1",
    problem_id: "prob-1",
    user_id: "user-1",
    provider_id: "prov-1",
    allowed_models: ["qwen-plus"],
    iat: Math.floor(Date.now() / 1000) - 7200,
    exp: Math.floor(Date.now() / 1000) - 3600,
    max_calls: 100,
    max_tokens: 50000,
  };
  const token = await mintEvalToken(payload, serviceToken);
  await assertRejects(() => verifyEvalToken(token, serviceToken));
});
