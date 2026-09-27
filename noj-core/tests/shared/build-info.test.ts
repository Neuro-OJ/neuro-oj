/**
 * 构建身份（版本 / commit / 构建时间）解析测试。
 *
 * 两条路径都要覆盖，且不能互相污染：
 * - **ENV 注入**（生产）：镜像构建期给出的三个值原样生效；
 * - **开发回退**：无 ENV 时取 `deno.json` 的 version、本地 git 短 SHA（脏则 `-dirty`）、
 *   进程启动时刻。
 *
 * 模块在加载时求值一次，因此每个用例用**带查询串的动态 import** 拿到独立实例；
 * 回退用例先 `delete` 三个 ENV，避免与注入用例的执行顺序耦合。
 */
import { assertEquals, assertMatch } from "jsr:@std/assert@^1";

/** 读取本模块元数据里的版本号（与实现同源，避免测试自己写死）。 */
function manifestVersion(): string {
  const raw = Deno.readTextFileSync(
    new URL("../../deno.json", import.meta.url),
  );
  return (JSON.parse(raw) as { version: string }).version;
}

const BUILD_ENV_KEYS = [
  "NOJ_BUILD_VERSION",
  "NOJ_BUILD_COMMIT",
  "NOJ_BUILD_TIME",
] as const;

Deno.test("build-info: 无 ENV 时回退 deno.json 版本与本地 git", async () => {
  for (const key of BUILD_ENV_KEYS) Deno.env.delete(key);
  const mod = await import(
    `../../src/shared/base/build-info.ts?fallback=${Date.now()}`
  );
  const info = mod.getBuildInfo();

  assertEquals(info.version, manifestVersion());
  // 本地 git 可用时是短 SHA（可带 -dirty）；无 git/非仓库时为 null
  if (info.commit !== null) {
    assertMatch(info.commit, /^[0-9a-f]{7,40}(-dirty)?$/);
  }
  // builtAt 至少是一个可解析的 ISO 时刻
  assertEquals(Number.isNaN(new Date(info.builtAt).getTime()), false);
});

Deno.test("build-info: ENV 注入时以镜像构建期值为准（生产路径）", async () => {
  Deno.env.set("NOJ_BUILD_VERSION", "9.9.9-test");
  Deno.env.set(
    "NOJ_BUILD_COMMIT",
    "0123456789abcdef0123456789abcdef01234567",
  );
  Deno.env.set("NOJ_BUILD_TIME", "2026-01-02T03:04:05Z");
  try {
    const mod = await import(
      `../../src/shared/base/build-info.ts?injected=${Date.now()}`
    );
    const info = mod.getBuildInfo();

    assertEquals(info.version, "9.9.9-test");
    // 注入值原样使用：不追加 -dirty，也不截断
    assertEquals(info.commit, "0123456789abcdef0123456789abcdef01234567");
    assertEquals(info.builtAt, "2026-01-02T03:04:05Z");
  } finally {
    for (const key of BUILD_ENV_KEYS) Deno.env.delete(key);
  }
});

Deno.test("build-info: 空串 ENV 视为未注入（不会把 version 变成空）", async () => {
  Deno.env.set("NOJ_BUILD_VERSION", "");
  Deno.env.set("NOJ_BUILD_COMMIT", "  ");
  try {
    const mod = await import(
      `../../src/shared/base/build-info.ts?blank=${Date.now()}`
    );
    const info = mod.getBuildInfo();

    assertEquals(info.version, manifestVersion());
    if (info.commit !== null) {
      assertMatch(info.commit, /^[0-9a-f]{7,40}(-dirty)?$/);
    }
  } finally {
    for (const key of BUILD_ENV_KEYS) Deno.env.delete(key);
  }
});

Deno.test("build-info: getBuildInfo 返回模块级常量（同一实例、不可变）", async () => {
  const mod = await import(
    `../../src/shared/base/build-info.ts?stable=${Date.now()}`
  );
  assertEquals(mod.getBuildInfo(), mod.getBuildInfo());
  assertEquals(Object.isFrozen(mod.getBuildInfo()), true);
});
