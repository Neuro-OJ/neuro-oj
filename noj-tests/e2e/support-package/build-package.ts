#!/usr/bin/env deno
/**
 * 构建 E2E 测试用支持包（zip）。
 *
 * 将 support-package/ 目录下的文件打包为 zip，
 * 供 docker-compose.e2e.yml 中的 noj-core 服务挂载使用。
 *
 * 用法：
 *   cd noj-tests
 *   deno run --allow-read --allow-write e2e/support-package/build-package.ts
 *
 * 输出：
 *   e2e/support-package/dist/e2e-test-package.zip
 */

const SUPPORT_DIR = new URL(".", import.meta.url).pathname;
const DIST_DIR = `${SUPPORT_DIR}dist`;
const OUTPUT_ZIP = `${DIST_DIR}/e2e-test-package.zip`;

async function buildPackage() {
  // 确保 dist 目录存在
  await Deno.mkdir(DIST_DIR, { recursive: true });

  // 收集需要打包的文件
  const files: string[] = [];
  for await (const entry of Deno.readDir(SUPPORT_DIR)) {
    if (entry.isFile && entry.name.endsWith(".py")) {
      files.push(entry.name);
    }
  }

  if (files.length === 0) {
    console.warn("  ⚠ support-package 中没有找到 .py 文件");
    return;
  }

  // 用 zip 命令打包（需要系统安装 zip）
  const cmd = new Deno.Command("zip", {
    args: ["-j", OUTPUT_ZIP, ...files.map((f) => `${SUPPORT_DIR}${f}`)],
    cwd: SUPPORT_DIR,
  });

  const { success, stderr } = await cmd.output();
  if (success) {
    console.log(`  ✓ 支持包已创建: ${OUTPUT_ZIP}`);
  } else {
    const err = new TextDecoder().decode(stderr);
    throw new Error(`打包失败: ${err}`);
  }
}

if (import.meta.main) {
  await buildPackage();
}
