import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { decodeBase64 } from "@std/encoding/base64";
import { sendPasswordResetEmail as mockSend } from "./../../src/domains/system/services/email-providers/mock.ts";
import { sendPasswordResetEmail as disabledSend } from "./../../src/domains/system/services/email-providers/disabled.ts";
import type { SendPasswordResetEmail } from "./../../src/domains/system/services/email-providers/types.ts";
import {
  type LogRecord,
  resetLogSink,
  setLogSink,
} from "./../../src/shared/base/logging.ts";

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

Deno.test({
  name: "email-providers: disabled 不发送也不记录重置链接",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const records: LogRecord[] = [];
    setLogSink((r) => records.push(r));

    try {
      await disabledSend(
        "test@example.com",
        "https://noj.test/reset?token=secret",
      );
      assertEquals(records.length, 1);
      assertEquals(records[0].fields.module, "email-disabled");
      assertEquals(records[0].fields.link, undefined);
      assertEquals(records[0].fields.token, undefined);
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

Deno.test({
  name: "email-providers: disabled 符合 SendPasswordResetEmail 类型签名",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const fn: SendPasswordResetEmail = disabledSend;
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
        "./../../src/domains/system/services/email-providers/aliyun.ts"
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

// ── 阿里云 Provider 请求契约 ──
//
// 2026-09-26 生产实测缺陷：请求字段写成 PascalCase（`AccountName`），而
// `@alicloud/dm20151123` 的请求模型只识别 camelCase 属性，构造器静默丢弃全部字段，
// 服务端报 `MissingAccountName`。这里直接拿 SDK 模型做契约校验（离线、无网络）。
Deno.test({
  name: "email-providers: aliyun 请求字段必须能被 SDK 模型映射为 wire 参数",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { buildSendMailParams } = await import(
      "./../../src/domains/system/services/email-providers/aliyun.ts"
    );
    // deno-lint-ignore no-explicit-any
    const dm: any = await import("npm:@alicloud/dm20151123@^1.10.2");
    const names: Record<string, string> = dm.SingleSendMailRequest.names();

    const params = buildSendMailParams(
      "service@neuro-oj.icu",
      "user@example.com",
      "主题",
      "<p>正文</p>",
    );

    // ① 传入的每个字段都必须被模型识别（PascalCase 会在此失败）
    for (const key of Object.keys(params)) {
      assertEquals(
        typeof names[key],
        "string",
        `SDK 模型不识别请求字段 ${key}（字段名大小写不符合模型定义）`,
      );
    }

    // ② 按模型 names() 映射后，wire 参数必须齐备且值正确
    const req = new dm.SingleSendMailRequest(params);
    const wire: Record<string, unknown> = {};
    for (const [camel, wireName] of Object.entries(names)) {
      const value = req[camel];
      if (value !== undefined) wire[wireName] = value;
    }
    assertEquals(wire.AccountName, "service@neuro-oj.icu");
    assertEquals(wire.ToAddress, "user@example.com");
    assertEquals(wire.Subject, "主题");
    assertEquals(wire.HtmlBody, "<p>正文</p>");
    assertEquals(wire.AddressType, 1);
    assertEquals(wire.ReplyToAddress, false);
  },
});

// ── 腾讯云 Provider 正文编码 ──
//
// 邮件模板正文含中文，而 `btoa` 只接受 Latin-1 字符，直接用它会在本地抛
// InvalidCharacterError（邮件永远发不出去）。此处锁定 base64 必须按 UTF-8 编码。
Deno.test({
  name: "email-providers: tencent 中文 HTML 的 base64 编码按 UTF-8 字节",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { encodeHtmlBase64 } = await import(
      "./../../src/domains/system/services/email-providers/tencent.ts"
    );
    const html = "<p>欢迎注册 Neuro OJ。</p>";
    const encoded = encodeHtmlBase64(html);
    assertEquals(
      decodeBase64(encoded),
      new TextEncoder().encode(html),
      "base64 必须可还原为原始 UTF-8 字节",
    );
    assert(!encoded.includes("<"), "编码结果不应包含原始 HTML");
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
        "./../../src/domains/system/services/email-providers/tencent.ts"
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
