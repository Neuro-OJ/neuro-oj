import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { convertDenoLock, parseNpmKey } from "./deno-lock-to-package-lock.ts";

Deno.test("parseNpmKey: 普通包与 scoped 包", () => {
  assertEquals(parseNpmKey("lodash@4.17.20"), {
    name: "lodash",
    version: "4.17.20",
  });
  assertEquals(parseNpmKey("@scope/pkg@1.2.3"), {
    name: "@scope/pkg",
    version: "1.2.3",
  });
});

Deno.test("parseNpmKey: 剥离 Deno 记录的 peer 依赖后缀", () => {
  assertEquals(parseNpmKey("vue@3.5.43_typescript@5.9.3"), {
    name: "vue",
    version: "3.5.43",
  });
});

Deno.test("parseNpmKey: 无版本或非包键返回 null", () => {
  assertEquals(parseNpmKey("broken"), null);
  assertEquals(parseNpmKey("@scope/only"), null);
});

Deno.test("convertDenoLock: 生成 package-lock v3 并去重", () => {
  const { lockfile, stats } = convertDenoLock({
    version: "5",
    jsr: { "@std/path@1.0.0": {} },
    npm: {
      "lodash@4.17.20": { integrity: "sha512-a" },
      // 同一 name@version 的另一个 peer 变体，只应保留一条
      "lodash@4.17.20_foo@1.0.0": { integrity: "sha512-b" },
      "@scope/pkg@2.0.0": {
        tarball: "https://registry.npmmirror.com/@scope/pkg/-/pkg-2.0.0.tgz",
        integrity: "sha512-c",
      },
    },
  }, "test-lock");

  assertEquals(stats.npm, 2);
  assertEquals(stats.jsr, 1);
  assertEquals(stats.skipped, []);

  const packages = lockfile.packages as Record<
    string,
    Record<string, unknown>
  >;
  assertEquals(packages[""].name, "test-lock");
  assertEquals(
    packages["node_modules/.deno/lodash@4.17.20/node_modules/lodash"],
    {
      name: "lodash",
      version: "4.17.20",
      // 缺 tarball 时按 npm 官方 registry 布局补全，否则 osv-scanner 会静默跳过
      resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
      integrity: "sha512-a",
    },
  );
  assertEquals(
    packages["node_modules/.deno/@scope/pkg@2.0.0/node_modules/@scope/pkg"]
      .resolved,
    "https://registry.npmmirror.com/@scope/pkg/-/pkg-2.0.0.tgz",
  );
});

Deno.test("convertDenoLock: npm 段格式异常时抛错", () => {
  assertThrows(() => convertDenoLock({ npm: "not-an-object" }));
  assertThrows(() => convertDenoLock(null));
});
