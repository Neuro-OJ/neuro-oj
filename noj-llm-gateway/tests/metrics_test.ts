import { assert, assertStringIncludes } from "jsr:@std/assert@^1";
import { inc, observe, renderMetrics } from "../src/metrics.ts";

Deno.test("metrics: counter/histogram 渲染且无重复 HELP", () => {
  inc("noj_llm_requests_total");
  inc("noj_llm_tokens_total", {}, 42);
  observe("noj_llm_request_duration_seconds", 0.5);

  const out = renderMetrics();
  assertStringIncludes(out, "# HELP noj_llm_requests_total");
  assertStringIncludes(out, "noj_llm_requests_total 1");
  assertStringIncludes(out, "noj_llm_tokens_total 42");
  assertStringIncludes(out, "noj_llm_request_duration_seconds_count 1");

  const helps = out.split("\n")
    .filter((line) => line.startsWith("# HELP "))
    .map((line) => line.split(" ")[2]);
  assert(
    new Set(helps).size === helps.length,
    "同一 metric family 不应重复 HELP",
  );
});

Deno.test("metrics: 未知指标写入是 no-op", () => {
  inc("noj_llm_unknown_total");
  observe("noj_llm_unknown_seconds", 1);
  const out = renderMetrics();
  assert(!out.includes("noj_llm_unknown_total"));
});
