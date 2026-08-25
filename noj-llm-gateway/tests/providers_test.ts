import { assertEquals } from "jsr:@std/assert@^1";
import { maskApiKey } from "../src/providers.ts";

Deno.test("providers: maskApiKey masks plaintext key suffix", () => {
  assertEquals(maskApiKey("sk-1234567890abcdef"), "sk-****cdef");
  assertEquals(maskApiKey("short"), "****");
});
