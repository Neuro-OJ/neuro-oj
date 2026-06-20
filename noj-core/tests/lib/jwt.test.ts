import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@^1";
import { signToken, verifyToken } from "../../src/lib/jwt.ts";

const hasJwtSecret = !!Deno.env.get("JWT_SECRET");

Deno.test({
  name: "jwt: signToken 返回有效的 JWT 字符串",
  ignore: !hasJwtSecret,
  fn: async () => {
    const token = await signToken({ sub: "user-1", role: "user" });
    // JWT 由三个点分隔的 base64 段组成
    assertEquals(token.split(".").length, 3);
  },
});

Deno.test({
  name: "jwt: verifyToken 成功验证签发的令牌",
  ignore: !hasJwtSecret,
  fn: async () => {
    const token = await signToken({ sub: "user-abc", role: "admin" });
    const payload = await verifyToken(token);
    assertEquals(payload.sub, "user-abc");
    assertEquals(payload.role, "admin");
  },
});

Deno.test({
  name: "jwt: verifyToken 对无效签名抛出错误",
  ignore: !hasJwtSecret,
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
  ignore: !hasJwtSecret,
  fn: async () => {
    await assertRejects(
      () => verifyToken("not-a-jwt"),
      Error,
    );
  },
});

Deno.test({
  name: "jwt: 不同 sub 生成不同令牌",
  ignore: !hasJwtSecret,
  fn: async () => {
    const [t1, t2] = await Promise.all([
      signToken({ sub: "u1", role: "user" }),
      signToken({ sub: "u2", role: "user" }),
    ]);
    assertNotEquals(t1, t2);
  },
});
