import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { sendPasswordResetEmail as mockSend } from "../../src/lib/email-providers/mock.ts";
import type { SendPasswordResetEmail } from "../../src/lib/email-providers/types.ts";

// ── Mock Provider 测试 ──

Deno.test({
  name: "email-providers: mock 返回 Promise<void> 不抛出",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // 不输出到 stdout 避免干扰测试输出
    const logs: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };

    try {
      // mock 是同步实现但接口返回 Promise<void>
      const result = mockSend("test@example.com", "http://localhost/token");
      assertEquals(result instanceof Promise, true);
      await result;

      // 验证日志输出
      assertEquals(logs.length, 1);
      const entry = JSON.parse(logs[0] as string);
      assertEquals(entry.module, "email-mock");
      assertEquals(entry.to, "test@example.com");
      assertEquals(entry.link, "http://localhost/token");
    } finally {
      console.log = originalLog;
    }
  },
});

Deno.test({
  name: "email-providers: mock 接收 expiresInMinutes 参数",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const logs: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };

    try {
      await mockSend("test@example.com", "http://localhost/token", 30);
      const entry = JSON.parse(logs[0] as string);
      assertEquals(entry.expiresIn, "30 minutes");
    } finally {
      console.log = originalLog;
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
        "ALIBABA_ACCESS_KEY_ID",
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

      const { sendPasswordResetEmail: tencentSend } = await import(
        "../../src/lib/email-providers/tencent.ts"
      );

      await assertRejects(
        () => tencentSend("test@example.com", "http://localhost/token"),
        Error,
        "TENCENT_SECRET_ID",
      );
    } finally {
      if (originalId) Deno.env.set("TENCENT_SECRET_ID", originalId);
      if (originalKey) Deno.env.set("TENCENT_SECRET_KEY", originalKey);
      if (originalFrom) Deno.env.set("TENCENT_FROM_EMAIL", originalFrom);
    }
  },
});
