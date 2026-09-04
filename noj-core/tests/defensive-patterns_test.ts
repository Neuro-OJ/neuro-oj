// 防御模式回归测试（noj-core）。
import { validateStorageKey } from "./../src/domains/system/services/storage/types.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertThrows(fn: () => void, msg: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`应抛出异常: ${msg}`);
}

Deno.test("defensive: storage key 拒绝路径穿越", () => {
  const badKeys = [
    "../secret",
    "a/../../b",
    "/etc/passwd",
    "a\\b",
    "a\0b",
    "a/./b",
    "a//b",
    "",
  ];
  for (const key of badKeys) {
    assertThrows(() => validateStorageKey(key), `key=${key}`);
  }
});

Deno.test("defensive: 合法 storage key 通过", () => {
  const goodKeys = ["abc", "a/b", "a-b_c.d", "x".repeat(1024)];
  for (const key of goodKeys) {
    validateStorageKey(key);
  }
  assert(true, "合法 key 不应抛出");
});
