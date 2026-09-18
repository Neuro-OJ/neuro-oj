import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@^1";
import { SignJWT } from "jose";
import { signToken, verifyToken } from "../../services/security/jwt.ts";

// 本文件只测试 JWT 签发/校验的纯逻辑，不依赖真实数据库。
//
// 此前每个用例都带基于 hasJwtSecret 的 ignore 守卫：CI 由工作流注入 JWT_SECRET 时
// 用例会真正执行，但一旦密钥缺失整个文件就"静默跳过"——既产生假绿，也让静默跳过
// 基线因上游新增用例而失败（该文件 ignore 数 6 → 7）。
//
// 改为无条件兜底注入仅测试用的固定密钥（长度 ≥32，满足 main.ts 的强度校验），
// 用例始终真正执行；CI 已注入的值优先，不受影响。与 noj-core/scripts/test-domain.sh
// 中 JWT_SECRET 的兜底语义一致。
const TEST_JWT_SECRET = "jwt-lib-test-secret-at-least-32-characters";
Deno.env.set(
  "JWT_SECRET",
  Deno.env.get("JWT_SECRET") || TEST_JWT_SECRET,
);

Deno.test({
  name: "jwt: 会话版本往返且拒绝畸形版本",
  fn: async () => {
    const token = await signToken({
      sub: "version-user",
      role: "user",
      session_version: 7,
    });
    assertEquals((await verifyToken(token)).session_version, 7);
    for (const session_version of [-1, 1.5, "1", null]) {
      const invalid = await new SignJWT({ role: "user", session_version })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("noj-core").setAudience("noj-ui")
        .setSubject("version-user").setIssuedAt().setExpirationTime("1h")
        .sign(new TextEncoder().encode(Deno.env.get("JWT_SECRET")));
      await assertRejects(() => verifyToken(invalid), Error, "会话版本无效");
    }
  },
});

Deno.test({
  name: "jwt: signToken 返回有效的 JWT 字符串",
  fn: async () => {
    const token = await signToken({ sub: "user-1", role: "user" });
    // JWT 由三个点分隔的 base64 段组成
    assertEquals(token.split(".").length, 3);
  },
});

Deno.test({
  name: "jwt: verifyToken 成功验证签发的令牌",
  fn: async () => {
    const token = await signToken({ sub: "user-abc", role: "admin" });
    const payload = await verifyToken(token);
    assertEquals(payload.sub, "user-abc");
    assertEquals(payload.role, "admin");
  },
});

Deno.test({
  name: "jwt: verifyToken 对无效签名抛出错误",
  fn: async () => {
    const token = await signToken({ sub: "u1", role: "user" });
    // 篡改 payload 部分使其无效
    const parts = token.split(".");
    const tampered = parts[0] + "." + parts[1] + ".invalidsig";
    await assertRejects(
      () => verifyToken(tampered),
      Error,
    );
  },
});

Deno.test({
  name: "jwt: verifyToken 对格式错误的令牌抛出错误",
  fn: async () => {
    await assertRejects(
      () => verifyToken("not-a-jwt"),
      Error,
    );
  },
});

Deno.test({
  name: "jwt: verifyToken 拒绝非 HS256 算法（NOJ-000）",
  fn: async () => {
    const secret = new TextEncoder().encode(Deno.env.get("JWT_SECRET"));
    const token = await new SignJWT({ role: "user" })
      .setProtectedHeader({ alg: "HS384" })
      .setIssuer("noj-core")
      .setAudience("noj-ui")
      .setSubject("alg-user")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);
    await assertRejects(() => verifyToken(token), Error);
  },
});

Deno.test({
  name: "jwt: 不同 sub 生成不同令牌",
  fn: async () => {
    const [t1, t2] = await Promise.all([
      signToken({ sub: "u1", role: "user" }),
      signToken({ sub: "u2", role: "user" }),
    ]);
    assertNotEquals(t1, t2);
  },
});
