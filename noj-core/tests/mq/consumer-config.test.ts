import { assertEquals } from "jsr:@std/assert@^1";
import {
  DEFAULT_RESULT_CONSUMER_CONCURRENCY,
  MAX_RESULT_CONSUMER_CONCURRENCY,
  parseResultConsumerConcurrency,
} from "../../src/mq/consumer.ts";

Deno.test("结果消费者并发配置：缺省使用安全默认值", () => {
  assertEquals(
    parseResultConsumerConcurrency(undefined),
    DEFAULT_RESULT_CONSUMER_CONCURRENCY,
  );
});

Deno.test("结果消费者并发配置：接受范围内的整数", () => {
  assertEquals(parseResultConsumerConcurrency("1"), 1);
  assertEquals(
    parseResultConsumerConcurrency(String(MAX_RESULT_CONSUMER_CONCURRENCY)),
    MAX_RESULT_CONSUMER_CONCURRENCY,
  );
});

Deno.test("结果消费者并发配置：非法值回退默认值", () => {
  for (const value of ["0", "17", "2.5", "not-a-number", ""]) {
    assertEquals(
      parseResultConsumerConcurrency(value),
      DEFAULT_RESULT_CONSUMER_CONCURRENCY,
      `非法值 ${value} 应回退默认值`,
    );
  }
});
