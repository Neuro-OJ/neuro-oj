import { assertEquals } from "jsr:@std/assert@^1";
import { parseQueryLimit } from "../../services/community/query-limit.ts";

// 纯函数单测：覆盖 NaN 穿透这一真实缺陷的各类输入。
// 这些用例不依赖 DB，任意测试路径（test / test:domain / test:parallel）都会跑。

Deno.test("parseQueryLimit: 合法值原样返回", () => {
  assertEquals(parseQueryLimit("5", { default: 20 }), 5);
  assertEquals(parseQueryLimit("100", { default: 20 }), 100);
});

Deno.test("parseQueryLimit: 非法字符串回退默认值（NaN 不穿透）", () => {
  // 修复前路由直接 Number("abc") → NaN → clamp 失效 → 静默空列表
  assertEquals(parseQueryLimit("abc", { default: 20 }), 20);
  assertEquals(parseQueryLimit("", { default: 20 }), 20);
  assertEquals(parseQueryLimit(undefined, { default: 20 }), 20);
  assertEquals(parseQueryLimit("  ", { default: 20 }), 20);
});

Deno.test("parseQueryLimit: Infinity / -Infinity 回退默认值", () => {
  assertEquals(parseQueryLimit("Infinity", { default: 20 }), 20);
  assertEquals(parseQueryLimit("-Infinity", { default: 20 }), 20);
  assertEquals(parseQueryLimit("NaN", { default: 20 }), 20);
});

Deno.test("parseQueryLimit: 小数与越界值被夹取", () => {
  assertEquals(parseQueryLimit("2.5", { default: 20 }), 20);
  assertEquals(parseQueryLimit("0", { default: 20 }), 1);
  assertEquals(parseQueryLimit("-7", { default: 20 }), 1);
  assertEquals(parseQueryLimit("100000", { default: 20 }), 100);
});

Deno.test("parseQueryLimit: 自定义 min/max/default 生效", () => {
  const opts = { default: 30, max: 50 };
  assertEquals(parseQueryLimit("abc", opts), 30);
  assertEquals(parseQueryLimit("999", opts), 50);
  assertEquals(parseQueryLimit("0", opts), 1);
});

Deno.test("parseQueryLimit: 默认值本身越界时也被夹取", () => {
  assertEquals(parseQueryLimit(undefined, { default: 9999 }), 100);
  assertEquals(parseQueryLimit(undefined, { default: -3 }), 1);
});
