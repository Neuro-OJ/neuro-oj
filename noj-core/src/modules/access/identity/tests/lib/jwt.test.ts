import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@^1";
import { decodeJwt, SignJWT } from "jose";
import { signToken, verifyToken } from "../../services/security/jwt.ts";

// 本文件只测试 JWT 签发/校验的纯逻辑，但仍要求测试启动器显式提供必需密钥。
const jwtSecret = Deno.env.get("JWT_SECRET");
if (!jwtSecret) {
  throw new Error(
    "JWT_SECRET 未设置：即使是纯 JWT 测试也不得用固定密钥掩盖缺失配置",
  );
}

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
        .sign(new TextEncoder().encode(jwtSecret));
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
    const secret = new TextEncoder().encode(jwtSecret);
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

Deno.test({
  name:
    "jwt: remember 使用长有效期，expiresAt 沿用指定过期时间，verifyToken 返回 exp",
  fn: async () => {
    const plain = decodeJwt(await signToken({ sub: "u", role: "user" }));
    assertEquals(plain.exp! - plain.iat!, 24 * 3600);

    const remembered = decodeJwt(
      await signToken({ sub: "u", role: "user" }, { remember: true }),
    );
    assertEquals(remembered.exp! - remembered.iat!, 30 * 24 * 3600);

    const expiresAt = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
    const pinned = await signToken({ sub: "u", role: "user" }, {
      remember: true,
      expiresAt,
    });
    assertEquals(decodeJwt(pinned).exp, expiresAt);
    assertEquals((await verifyToken(pinned)).exp, expiresAt);
  },
});
