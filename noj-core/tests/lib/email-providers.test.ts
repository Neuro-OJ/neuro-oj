import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { sendPasswordResetEmail as mockSend } from "../../src/lib/email-providers/mock.ts";
import type { SendPasswordResetEmail } from "../../src/lib/email-providers/types.ts";
import {
  type LogRecord,
  resetLogSink,
  setLogSink,
} from "../../src/lib/logging.ts";

// ── Mock Provider 测试 ──

Deno.test({
  name: "email-providers: mock 返回 Promise<void> 不抛出",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 通过 setLogSink 捕获 logger 记录，避免污染测试输出
    const records: LogRecord[] = [];
    setLogSink((r) => records.push(r));

    try {
      // mock 是同步实现但接口返回 Promise<void>
      const result = mockSend("test@example.com", "http://localhost/token");
      assertEquals(result instanceof Promise, true);
      await result;

      // 验证日志输出
      assertEquals(records.length, 1);
      assertEquals(records[0].fields.module, "email-mock");
      assertEquals(records[0].fields.to, "test@example.com");
      assertEquals(records[0].fields.link, "http://localhost/token");
    } finally {
      resetLogSink();
    }
  },
});

Deno.test({
  name: "email-providers: mock 接收 expiresInMinutes 参数",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const records: LogRecord[] = [];
    setLogSink((r) => records.push(r));

    try {
      await mockSend("test@example.com", "http://localhost/token", 30);
      assertEquals(records[0].fields.expiresIn, "30 minutes");
    } finally {
      resetLogSink();
    }
  },
});

// ── Provider 接口类型校验（编译期检查，确保各 provider 签名一致） ──

Deno.test({
  name: "email-providers: mock 符合 SendPasswordResetEmail 类型签名",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    // 类型检查（编译期）：赋值必须兼容
    const fn: SendPasswordResetEmail = mockSend;
    assertEquals(typeof fn, "function");
  },
});

// ── 阿里云 Provider 测试 ──
// 不测试真实 SDK 调用，仅验证环境变量校验逻辑

Deno.test({
  name: "email-providers: aliyun 缺失环境变量时抛出配置错误",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 确保环境变量为空
    const originalAkId = Deno.env.get("ALIBABA_ACCESS_KEY_ID");
    const originalAkSecret = Deno.env.get("ALIBABA_ACCESS_KEY_SECRET");
    const originalFrom = Deno.env.get("ALIBABA_FROM_EMAIL");

    try {
      Deno.env.delete("ALIBABA_ACCESS_KEY_ID");
      Deno.env.delete("ALIBABA_ACCESS_KEY_SECRET");
      Deno.env.delete("ALIBABA_FROM_EMAIL");

      const { sendPasswordResetEmail: aliyunSend } = await import(
        "../../src/lib/email-providers/aliyun.ts"
      );

      await assertRejects(
        () => aliyunSend("test@example.com", "http://localhost/token"),
        Error,
        "阿里云 AccessKey ID",
      );
    } finally {
      // 恢复环境变量
      if (originalAkId) Deno.env.set("ALIBABA_ACCESS_KEY_ID", originalAkId);
      if (originalAkSecret) {
        Deno.env.set("ALIBABA_ACCESS_KEY_SECRET", originalAkSecret);
      }
      if (originalFrom) Deno.env.set("ALIBABA_FROM_EMAIL", originalFrom);
    }
  },
});

// ── 腾讯云 Provider 测试 ──
// 不测试真实 SDK 调用，仅验证环境变量校验逻辑

Deno.test({
  name: "email-providers: tencent 缺失环境变量时抛出配置错误",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const originalId = Deno.env.get("TENCENT_SECRET_ID");
    const originalKey = Deno.env.get("TENCENT_SECRET_KEY");
    const originalFrom = Deno.env.get("TENCENT_FROM_EMAIL");

    try {
      Deno.env.delete("TENCENT_SECRET_ID");
      Deno.env.delete("TENCENT_SECRET_KEY");
      Deno.env.delete("TENCENT_FROM_EMAIL");
      Deno.env.delete("TENCENT_REGION");

      const { sendPasswordResetEmail: tencentSend } = await import(
        "../../src/lib/email-providers/tencent.ts"
      );

      await assertRejects(
        () => tencentSend("test@example.com", "http://localhost/token"),
        Error,
        "腾讯云 SecretId",
      );
    } finally {
      if (originalId) Deno.env.set("TENCENT_SECRET_ID", originalId);
      if (originalKey) Deno.env.set("TENCENT_SECRET_KEY", originalKey);
      if (originalFrom) Deno.env.set("TENCENT_FROM_EMAIL", originalFrom);
    }
  },
});
