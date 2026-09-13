/**
 * 密钥占位值检测测试（2026-09-12 架构评审 §2.4）。
 *
 * 核心回归点：`.env.prod.example` 曾用
 * `change-me-to-a-random-string-at-least-32-chars`（46 字符）——它**长度合格**，
 * 仅靠 main.ts 的 ≥32 长度校验会被放行，部署者会以公开已知密钥上线。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  describePlaceholderSecret,
  isPlaceholderSecret,
} from "../../../src/shared/security/secret-placeholders.ts";

Deno.test("secret-placeholders: 空值视为未配置", () => {
  assertEquals(isPlaceholderSecret(""), true);
  assertEquals(isPlaceholderSecret(null), true);
  assertEquals(isPlaceholderSecret(undefined), true);
});

Deno.test("secret-placeholders: 历史模板中的占位密钥被拦截", () => {
  // 这是本次评审发现的真实缺陷值（长度 46 ≥ 32，能通过长度校验）
  assertEquals(
    isPlaceholderSecret("change-me-to-a-random-string-at-least-32-chars"),
    true,
  );
  assertEquals(
    isPlaceholderSecret("change-this-to-a-strong-random-secret"),
    true,
  );
  assertEquals(isPlaceholderSecret("your-secret-here"), true);
  assertEquals(isPlaceholderSecret("placeholder-key-0123456789abcdef"), true);
  assertEquals(isPlaceholderSecret("example"), true);
  assertEquals(isPlaceholderSecret("test"), true);
  assertEquals(isPlaceholderSecret("xxx"), true);
  assertEquals(isPlaceholderSecret("replace-me-with-real-key"), true);
});

Deno.test("secret-placeholders: 真实随机密钥不误杀", () => {
  // openssl rand -base64 48 的典型输出
  assertEquals(
    isPlaceholderSecret("kR7vQ2mX9pLzT4sB1nYcW8dF6hJ3gA0eU5iO7qZ2xV4bN9mC1tR="),
    false,
  );
  // 仓库 E2E / CI 使用的固定测试密钥：含 "test" 但不等于 "test"
  assertEquals(
    isPlaceholderSecret("e2e-ci-secret-fixed-value-with-32-chars-min-abc"),
    false,
  );
  assertEquals(
    isPlaceholderSecret("noj-test-jwt-secret-fixed-value-with-32-chars-min"),
    false,
  );
});

Deno.test("secret-placeholders: describePlaceholderSecret 给出可读原因", () => {
  assertEquals(
    describePlaceholderSecret(
      "JWT_SECRET",
      "kR7vQ2mX9pLzT4sB1nYcW8dF6hJ3gA0eU5iO7qZ2xV4bN9mC1tR=",
    ),
    null,
  );
  const reason = describePlaceholderSecret("JWT_SECRET", "change-me-please");
  assertEquals(typeof reason, "string");
  assertEquals(reason?.includes("JWT_SECRET"), true);
  assertEquals(reason?.includes("占位值"), true);
});
