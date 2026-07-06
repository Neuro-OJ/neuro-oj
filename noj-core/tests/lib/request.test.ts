import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { parseJsonBody } from "../../src/lib/request.ts";
import { ValidationError } from "../../src/lib/errors.ts";

function mockCtx(body: unknown) {
  return {
    req: {
      json: <T>() => body as T,
    },
  };
}

Deno.test({
  name: "parseJsonBody: 有效 JSON 返回正确类型",
  fn: async () => {
    const ctx = mockCtx({ name: "test", value: 42 });
    const result = await parseJsonBody<{ name: string; value: number }>(ctx);
    assertEquals(result.name, "test");
    assertEquals(result.value, 42);
  },
});

Deno.test({
  name: "parseJsonBody: JSON 解析失败抛出 ValidationError",
  fn: async () => {
    const badCtx = {
      req: {
        json: <T>() => {
          throw new SyntaxError("Unexpected token");
        },
      },
    };
    await assertRejects(
      () => parseJsonBody(badCtx),
      ValidationError,
      "请求体格式错误",
    );
  },
});
