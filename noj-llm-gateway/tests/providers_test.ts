import { assertEquals } from "jsr:@std/assert@^1";
import { maskApiKey, validateByokBaseUrl } from "../src/providers.ts";

Deno.test("providers: maskApiKey masks plaintext key suffix", () => {
  assertEquals(maskApiKey("sk-1234567890abcdef"), "sk-****cdef");
  assertEquals(maskApiKey("short"), "****");
});

Deno.test("providers: BYOK base URL rejects unsafe targets", () => {
  assertEquals(
    validateByokBaseUrl("https://api.openai.com/v1"),
    "https://api.openai.com/v1",
  );
  for (
    const value of [
      "http://api.openai.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://api.openai.com:8443",
      "https://evil.example",
    ]
  ) {
    try {
      validateByokBaseUrl(value);
      throw new Error(`expected target to be rejected: ${value}`);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "provider_target_rejected"
      ) {
        throw error;
      }
    }
  }
});
