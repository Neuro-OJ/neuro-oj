import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import {
  logger,
  type LogRecord,
  redactId,
  resetLogSink,
  runWithRequestContext,
  setLogSink,
} from "../../src/lib/logging.ts";

/**
 * 捕获日志记录的辅助：替换 sink，返回收集数组 + 还原函数。
 * 同时快照并可恢复 LOG_LEVEL / NOJ_ENV，避免污染其他测试。
 */
function withCapture(): { records: LogRecord[]; restore: () => void } {
  const records: LogRecord[] = [];
  const prevLevel = Deno.env.get("LOG_LEVEL");
  const prevEnv = Deno.env.get("NOJ_ENV");
  setLogSink((r) => records.push(r));
  return {
    records,
    restore: () => {
      resetLogSink();
      if (prevLevel === undefined) Deno.env.delete("LOG_LEVEL");
      else Deno.env.set("LOG_LEVEL", prevLevel);
      if (prevEnv === undefined) Deno.env.delete("NOJ_ENV");
      else Deno.env.set("NOJ_ENV", prevEnv);
    },
  };
}

Deno.test({
  name: "logging: redactId 截断超长 ID，短 ID 返回 [redacted]",
  fn: () => {
    assertEquals(
      redactId("550e8400-e29b-41d4-a716-446655440000"),
      "550e8400...",
    );
    assertEquals(redactId("short"), "[redacted]");
    assertEquals(redactId(""), "[redacted]");
  },
});

Deno.test({
  name: "logging: logger 输出结构化记录（msg + fields）",
  fn: () => {
    const { records, restore } = withCapture();
    try {
      Deno.env.set("LOG_LEVEL", "debug");
      logger.info("测试消息", { foo: "bar", n: 42 });
      assertEquals(records.length, 1);
      assertEquals(records[0].level, "info");
      assertEquals(records[0].msg, "测试消息");
      assertEquals(records[0].fields.foo, "bar");
      assertEquals(records[0].fields.n, 42);
      assertExists(records[0].ts);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "logging: LOG_LEVEL 过滤低于阈值的日志",
  fn: () => {
    const { records, restore } = withCapture();
    try {
      Deno.env.set("LOG_LEVEL", "warn");
      logger.debug("debug 应被抑制");
      logger.info("info 应被抑制");
      logger.warn("warn 应输出");
      logger.error("error 应输出");
      assertEquals(records.length, 2);
      assertEquals(records[0].level, "warn");
      assertEquals(records[1].level, "error");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "logging: 生产环境脱敏 submission_id / score / code",
  fn: () => {
    const { records, restore } = withCapture();
    try {
      Deno.env.set("NOJ_ENV", "production");
      Deno.env.set("LOG_LEVEL", "debug");
      logger.info("提交", {
        submission_id: "550e8400-e29b-41d4-a716-446655440000",
        score: 9500,
        code: "print(1)",
        status: "Accepted",
      });
      const f = records[0].fields;
      assertEquals(f.submission_id, "550e8400...");
      assertEquals("score" in f, false); // score 生产环境隐藏
      assertEquals(f.code, "[redacted]");
      assertEquals(f.status, "Accepted"); // 非敏感字段保留
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "logging: 开发环境不脱敏（完整字段便于调试）",
  fn: () => {
    const { records, restore } = withCapture();
    try {
      Deno.env.set("NOJ_ENV", "development");
      Deno.env.set("LOG_LEVEL", "debug");
      logger.info("提交", {
        submission_id: "550e8400-e29b-41d4-a716-446655440000",
        score: 9500,
      });
      const f = records[0].fields;
      assertEquals(f.submission_id, "550e8400-e29b-41d4-a716-446655440000");
      assertEquals(f.score, 9500);
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "logging: runWithRequestContext 自动注入 request_id",
  fn: () => {
    const { records, restore } = withCapture();
    try {
      Deno.env.set("LOG_LEVEL", "debug");
      logger.info("请求外");
      runWithRequestContext("req-123", () => {
        logger.info("请求内");
      });
      assertEquals(records[0].request_id, undefined);
      assertEquals(records[1].request_id, "req-123");
    } finally {
      restore();
    }
  },
});

Deno.test({
  name: "logging: Error 字段被序列化为 {name, message}",
  fn: () => {
    const { records, restore } = withCapture();
    try {
      Deno.env.set("NOJ_ENV", "production");
      Deno.env.set("LOG_LEVEL", "debug");
      logger.error("出错了", { err: new Error("boom") });
      const err = records[0].fields.err as { name: string; message: string };
      assertEquals(err.name, "Error");
      assertEquals(err.message, "boom");
    } finally {
      restore();
    }
  },
});
