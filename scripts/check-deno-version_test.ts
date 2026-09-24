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

// ── 2026-09-21 修复：Dockerfile 扫描只覆盖 noj-core ──
// 触发条件：noj-ui / noj-llm-gateway 的 Dockerfile deno 镜像版本漂移。
Deno.test("checkDenoVersion: 非 noj-core 模块的 Dockerfile 版本漂移必须报错", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/.dvmrc`, "v2.9.5\n");
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.github/workflows/ci.yml`,
      "        deno-version-file: .dvmrc\n",
    );
    // core 与 .dvmrc 一致
    await Deno.mkdir(`${dir}/noj-core`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/noj-core/Dockerfile`,
      "FROM denoland/deno:debian-2.9.5\n",
    );
    // 非 core 模块漂移到 2.8.1
    await Deno.mkdir(`${dir}/noj-ui`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/noj-ui/Dockerfile`,
      "FROM denoland/deno:debian-2.8.1 AS builder\n",
    );
    const errors = await checkDenoVersion(dir);
    const hit = errors.find((e) => e.includes("noj-ui/Dockerfile"));
    assertEquals(
      typeof hit === "string",
      true,
      `noj-ui/Dockerfile 的版本漂移应被检出，实际 errors=${
        JSON.stringify(errors)
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkDenoVersion: 新模块任意深度的 Dockerfile 也在扫描范围内", async () => {
  // 防回归：不得再硬编码 Dockerfile 清单。用一个"未来可能出现"的嵌套路径
  // 证明扫描是递归的，而不是只认 noj-core 或固定前缀。
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/.dvmrc`, "v2.9.5\n");
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.github/workflows/ci.yml`,
      "        deno-version-file: .dvmrc\n",
    );
    await Deno.mkdir(`${dir}/noj-future/deploy`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/noj-future/deploy/Dockerfile.worker`,
      "FROM denoland/deno:alpine-2.8.0\n",
    );
    const errors = await checkDenoVersion(dir);
    const hit = errors.find((e) =>
      e.includes("noj-future/deploy/Dockerfile.worker")
    );
    assertEquals(
      typeof hit === "string",
      true,
      `嵌套新模块的 Dockerfile 漂移应被检出，实际 errors=${
        JSON.stringify(errors)
      }`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
