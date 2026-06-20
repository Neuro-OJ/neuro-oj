import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { comparePassword, hashPassword } from "../../src/lib/password.ts";

Deno.test("password: hashPassword 返回 bcrypt 哈希字符串", async () => {
  const hash = await hashPassword("test1234");
  // bcrypt 哈希以 $2a$ 或 $2b$ 开头，长度 60
  assertEquals(hash.startsWith("$2"), true);
  assertEquals(hash.length, 60);
});

Deno.test("password: 相同密码的两次哈希结果不同（随机 salt）", async () => {
  const [hash1, hash2] = await Promise.all([
    hashPassword("same-password"),
    hashPassword("same-password"),
  ]);
  assertNotEquals(hash1, hash2);
});

Deno.test("password: comparePassword 验证正确密码返回 true", async () => {
  const hash = await hashPassword("my-password");
  const match = await comparePassword("my-password", hash);
  assertEquals(match, true);
});

Deno.test("password: comparePassword 验证错误密码返回 false", async () => {
  const hash = await hashPassword("correct-pass");
  const match = await comparePassword("wrong-pass", hash);
  assertEquals(match, false);
});

Deno.test("password: 空密码也能正常哈希和比较", async () => {
  const hash = await hashPassword("");
  const match = await comparePassword("", hash);
  assertEquals(match, true);
  const wrong = await comparePassword("x", hash);
  assertEquals(wrong, false);
});
