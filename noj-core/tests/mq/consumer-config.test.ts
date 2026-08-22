import { assertEquals } from "jsr:@std/assert@^1";
import {
  consumerAlive,
  createResultConsumerPool,
  DEFAULT_RESULT_CONSUMER_CONCURRENCY,
  MAX_RESULT_CONSUMER_CONCURRENCY,
  parseResultConsumerConcurrency,
} from "../../src/mq/consumer.ts";
import type { ConsumerOptions } from "../../src/mq/base-consumer.ts";

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

Deno.test("结果消费者池：启动全部连接并汇总活跃状态", async () => {
  const options: ConsumerOptions[] = [];
  const releases: Array<() => void> = [];
  let allStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    allStarted = resolve;
  });

  const start = createResultConsumerPool(3, (consumerOptions) => {
    options.push(consumerOptions);
    return async () => {
      consumerOptions.aliveRef.value = true;
      if (options.length === 3) allStarted();
      await new Promise<void>((resolve) => releases.push(resolve));
      consumerOptions.aliveRef.value = false;
    };
  });

  const running = start();
  await started;
  assertEquals(options.length, 3);
  assertEquals(options.map((item) => item.queueName), [
    "noj:judge:results",
    "noj:judge:results",
    "noj:judge:results",
  ]);
  assertEquals(consumerAlive.value, true);

  releases.shift()?.();
  await Promise.resolve();
  assertEquals(consumerAlive.value, true);

  for (const release of releases) release();
  await running;
  assertEquals(consumerAlive.value, false);
});
