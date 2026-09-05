import { assertEquals } from "jsr:@std/assert@^1";
import { calcBilledUsage } from "../src/billing.ts";

Deno.test("billing: 无 usage 时回退估算值，不产生缓存扣除", () => {
  const r = calcBilledUsage(undefined, 100, 50);
  assertEquals(r.promptTokens, 100);
  assertEquals(r.completionTokens, 50);
  assertEquals(r.cachedPromptTokens, 0);
  assertEquals(r.billedPromptTokens, 100);
  assertEquals(r.billedTotalTokens, 150);
});

Deno.test("billing: 有 cached_tokens 时 billedPrompt = prompt - cached", () => {
  const r = calcBilledUsage(
    {
      prompt_tokens: 200,
      completion_tokens: 30,
      total_tokens: 230,
      prompt_tokens_details: { cached_tokens: 180 },
    },
    300,
    100,
  );
  assertEquals(r.promptTokens, 200);
  assertEquals(r.completionTokens, 30);
  assertEquals(r.cachedPromptTokens, 180);
  assertEquals(r.billedPromptTokens, 20);
  assertEquals(r.billedTotalTokens, 50);
});

Deno.test("billing: cached 超过 prompt 时按 0 处理", () => {
  const r = calcBilledUsage(
    {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 99 },
    },
    10,
    5,
  );
  assertEquals(r.billedPromptTokens, 0);
  assertEquals(r.billedTotalTokens, 5);
});
