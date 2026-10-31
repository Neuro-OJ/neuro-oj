import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  compareReleaseVersion,
  normalizeVersion,
  readManifestVersion,
} from "./check-release-version.ts";

/**
 * 仓库根目录。
 *
 * 基于本文件位置解析而非 `Deno.cwd()`：CI 从仓库根执行，本地可能从 `scripts/`
 * 执行，写死相对路径会在其中一种环境下失败。
 */
const REPO_ROOT = new URL("..", import.meta.url).pathname;

Deno.test("normalizeVersion: 拆分基础版本与预发布后缀", () => {
  assertEquals(normalizeVersion("v0.11.0-rc.1"), {
    base: "0.11.0",
    suffix: "-rc.1",
  });
  assertEquals(normalizeVersion("0.11.0"), { base: "0.11.0", suffix: "" });
  assertEquals(normalizeVersion("v0.11.0+build.5"), {
    base: "0.11.0",
    suffix: "+build.5",
  });
});

Deno.test("normalizeVersion: 非法标签返回 null", () => {
  assertEquals(normalizeVersion("0.11"), null);
  assertEquals(normalizeVersion("release-0.11.0"), null);
  assertEquals(normalizeVersion(""), null);
});

Deno.test("compareReleaseVersion: 同基础版本（含 RC 标签）通过", () => {
  assertEquals(compareReleaseVersion("v0.11.0-rc.1", "0.11.0"), []);
  assertEquals(compareReleaseVersion("v0.11.0", "0.11.0"), []);
  assertEquals(compareReleaseVersion("0.11.0", "0.11.0-rc.1"), []);
});

Deno.test("compareReleaseVersion: 基础版本不一致时报错并给出目标版本", () => {
  const errors = compareReleaseVersion("v0.11.0-rc.1", "0.10.5");
  assertEquals(errors.length, 1);
  assert(errors[0]!.includes("0.11.0"), errors[0]);
  assert(errors[0]!.includes("0.10.5"), errors[0]);
});

Deno.test("compareReleaseVersion: 非法标签直接失败（不能作为发布证据）", () => {
  const errors = compareReleaseVersion("0.11", "0.11.0");
  assertEquals(errors.length, 1);
  assert(errors[0]!.includes("不是合法形态"), errors[0]);
});

Deno.test("compareReleaseVersion: 清单版本非法时失败", () => {
  const errors = compareReleaseVersion("v0.11.0", "latest");
  assertEquals(errors.length, 1);
  assert(errors[0]!.includes("清单版本"), errors[0]);
});

Deno.test("readManifestVersion: 真实仓库能读到一个合法版本", async () => {
  const manifest = await readManifestVersion(REPO_ROOT);
  assert(manifest !== null, "应能从仓库清单读出模块版本");
  assert(normalizeVersion(manifest!.version) !== null, manifest!.version);
});
