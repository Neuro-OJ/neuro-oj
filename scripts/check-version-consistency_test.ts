import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  checkVersionConsistency,
  compareVersions,
  isVersionLike,
  parseJsonManifestVersion,
  parseManifestVersion,
  parseTomlManifestVersion,
  VERSION_MANIFESTS,
} from "./check-version-consistency.ts";

/**
 * 仓库根目录。
 *
 * 基于本文件位置解析而非 `Deno.cwd()`：CI 从仓库根执行
 * `deno test -A scripts/check-version-consistency_test.ts`，本地可能从
 * `scripts/` 执行，写死相对路径会在其中一种环境下失败。
 */
const REPO_ROOT = new URL("..", import.meta.url).pathname;

Deno.test("parseJsonManifestVersion: 提取顶层 version", () => {
  assertEquals(
    parseJsonManifestVersion(
      '{\n  "name": "@noj/core",\n  "version": "0.10.5"\n}',
    ),
    "0.10.5",
  );
});

Deno.test("parseJsonManifestVersion: 非法 JSON / 缺少字段返回 null", () => {
  assertEquals(parseJsonManifestVersion("{not json"), null);
  assertEquals(parseJsonManifestVersion('{"name":"x"}'), null);
  assertEquals(parseJsonManifestVersion('{"version":1}'), null);
  assertEquals(parseJsonManifestVersion("null"), null);
});

Deno.test("parseTomlManifestVersion: 只取行首 version，不误抓依赖内联版本", () => {
  const content = [
    "[package]",
    'name = "noj-judge"',
    'version = "0.10.5"',
    "",
    "[dependencies]",
    'redis = { version = "0.27", features = ["tokio-comp"] }',
    'tokio = "1"',
  ].join("\n");
  assertEquals(parseTomlManifestVersion(content), "0.10.5");
});

Deno.test("parseTomlManifestVersion: 缺少 version 返回 null", () => {
  assertEquals(parseTomlManifestVersion('[package]\nname = "x"\n'), null);
});

Deno.test("parseManifestVersion: 按格式分派", () => {
  assertEquals(parseManifestVersion("json", '{"version":"1.2.3"}'), "1.2.3");
  assertEquals(parseManifestVersion("toml", 'version = "1.2.3"\n'), "1.2.3");
});

Deno.test("isVersionLike: 接受 X.Y.Z 与预发布后缀", () => {
  assertEquals(isVersionLike("0.10.5"), true);
  assertEquals(isVersionLike("0.10.4-rc.1"), true);
  assertEquals(isVersionLike("v0.10.5"), false);
  assertEquals(isVersionLike("0.10"), false);
  assertEquals(isVersionLike("latest"), false);
});

Deno.test("compareVersions: 全部一致时无错误", () => {
  const errors = compareVersions([
    { path: "a/deno.json", version: "0.10.5" },
    { path: "b/Cargo.toml", version: "0.10.5" },
  ]);
  assertEquals(errors, []);
});

Deno.test("compareVersions: 版本漂移必须报错并列出全部清单", () => {
  const errors = compareVersions([
    { path: "a/deno.json", version: "0.10.5" },
    { path: "b/deno.json", version: "0.10.5" },
    { path: "c/deno.json", version: "0.9.5" },
  ]);
  assertEquals(errors.length, 1);
  assert(errors[0].includes("0.9.5"), errors[0]);
  assert(errors[0].includes("c/deno.json"), errors[0]);
  assert(errors[0].includes("基准 0.10.5"), errors[0]);
});

Deno.test("compareVersions: 无法解析的清单单独报错", () => {
  const errors = compareVersions([
    { path: "a/deno.json", version: "0.10.5" },
    { path: "b/deno.json", version: null },
  ]);
  assertEquals(errors.length, 1);
  assert(errors[0].includes("b/deno.json"), errors[0]);
});

Deno.test("compareVersions: 非法版本号不被当成一致", () => {
  const errors = compareVersions([
    { path: "a/deno.json", version: "0.10.5" },
    { path: "b/deno.json", version: "latest" },
  ]);
  assertEquals(errors.length, 1);
  assert(errors[0].includes("不是合法的 X.Y.Z"), errors[0]);
});

Deno.test("compareVersions: 零输入守卫", () => {
  const errors = compareVersions([]);
  assertEquals(errors.length, 1);
  assert(errors[0].includes("未扫描到任何模块清单"), errors[0]);
});

Deno.test("VERSION_MANIFESTS: 覆盖 7 个模块且路径唯一", () => {
  assertEquals(VERSION_MANIFESTS.length, 7);
  const paths = new Set(VERSION_MANIFESTS.map((m) => m.path));
  assertEquals(paths.size, VERSION_MANIFESTS.length);
});

Deno.test("真实仓库当前通过（版本号一致）", async () => {
  // 门禁生效的自检：任何模块清单版本漂移，本测试立即失败。
  const errors = await checkVersionConsistency(REPO_ROOT);
  assertEquals(errors, [], errors.join("; "));
});

Deno.test("checkVersionConsistency: 清单缺失时报错而不是静默通过", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const errors = await checkVersionConsistency(dir);
    assertEquals(errors.length, VERSION_MANIFESTS.length);
    assert(errors[0].includes("无法解析出 version"), errors[0]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
