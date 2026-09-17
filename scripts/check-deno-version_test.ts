import { assertEquals } from "jsr:@std/assert@^1";
import {
  checkDenoVersion,
  findDockerDenoTags,
  findPinnedDenoVersions,
  majorMinor,
  parseDvmrc,
} from "./check-deno-version.ts";

/**
 * 仓库根目录。
 *
 * 必须基于本文件位置解析，而非 Deno.cwd()：CI 从仓库根执行
 * `deno test -A scripts/check-deno-version_test.ts`，而本地可能从 scripts/ 执行，
 * 写死相对路径会在其中一种环境下失败（本测试初版即因此红灯）。
 */
const REPO_ROOT = new URL("..", import.meta.url).pathname;

Deno.test("parseDvmrc: 去掉前导 v 与空白", () => {
  assertEquals(parseDvmrc("v2.9.5\n"), "2.9.5");
  assertEquals(parseDvmrc("  2.9.5  "), "2.9.5");
});

Deno.test("findPinnedDenoVersions: 只抓写死的 deno-version，不误抓 file 形式", () => {
  const content = [
    "      - uses: denoland/setup-deno@v2",
    "        with:",
    "          deno-version: v2.x",
    "      - uses: denoland/setup-deno@v2",
    "        with:",
    "          deno-version-file: .dvmrc",
  ].join("\n");
  assertEquals(findPinnedDenoVersions(content), ["v2.x"]);
});

Deno.test("findPinnedDenoVersions: 全为 file 形式时返回空", () => {
  assertEquals(findPinnedDenoVersions("        deno-version-file: .dvmrc"), []);
});

Deno.test("findDockerDenoTags: 提取镜像标签", () => {
  assertEquals(
    findDockerDenoTags("FROM denoland/deno:alpine-2.9.5\nRUN echo hi"),
    ["alpine-2.9.5"],
  );
  assertEquals(findDockerDenoTags("FROM node:20"), []);
});

Deno.test("majorMinor: 提取主次版本", () => {
  assertEquals(majorMinor("alpine-2.9.5"), "2.9");
  assertEquals(majorMinor("2.8.0"), "2.8");
  assertEquals(majorMinor("latest"), null);
});

Deno.test("真实仓库当前通过（.dvmrc 为唯一事实源）", async () => {
  // 门禁生效的自检：若有人新增写死的 deno-version 或 Docker 版本漂移，
  // 本测试立即失败。
  const errors = await checkDenoVersion(REPO_ROOT);
  assertEquals(errors, [], errors.join("; "));
});

Deno.test("checkDenoVersion: 缺少 .dvmrc 时报错", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const errors = await checkDenoVersion(dir);
    assertEquals(errors.some((e) => e.includes(".dvmrc")), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
