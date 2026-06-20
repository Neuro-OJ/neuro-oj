/**
 * 构建 Support Package 脚本。
 *
 * 将 data/problems-src/<id>/ 目录下的题目文件打包为
 * data/packages/<id>.zip，供评测时使用。
 *
 * 用法: deno task build-packages
 *
 * 目录结构:
 *   data/problems-src/<id>/
 *     ├── evaluate.py       (评测脚本，入口)
 *     ├── hidden.jsonl      (隐藏测试用例，不公开)
 *     ├── visible.jsonl     (可见测试用例)
 *     └── README.md         (题目描述)
 *
 *   data/packages/
 *     └── <id>.zip          (构建产物，gitignored)
 */

import { dirname, join, resolve } from "jsr:@std/path@^1";

const __dirname = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(__dirname, "..");
const SRC_DIR = join(PROJECT_ROOT, "data", "problems-src");
const OUT_DIR = join(PROJECT_ROOT, "data", "packages");

async function buildProblemPackage(id: string): Promise<void> {
  const srcDir = join(SRC_DIR, id);
  const outFile = join(OUT_DIR, `${id}.zip`);

  // 使用 Deno 的 zip 命令
  const cmd = new Deno.Command("zip", {
    args: ["-r", outFile, "."],
    cwd: srcDir,
  });

  const { code, stdout: _stdout, stderr } = await cmd.output();

  if (code !== 0) {
    throw new Error(
      `打包失败 (${id}): ${new TextDecoder().decode(stderr)}`,
    );
  }

  console.log(`已构建: ${outFile}`);
}

async function main() {
  console.log("=".repeat(48));
  console.log("Support Package 构建脚本");
  console.log("=".repeat(48));

  // 确认输出目录存在
  try {
    await Deno.mkdir(OUT_DIR, { recursive: true });
  } catch {
    // 目录已存在
  }

  // 扫描源码目录
  let problemDirs: string[] = [];
  try {
    for await (const entry of Deno.readDir(SRC_DIR)) {
      if (entry.isDirectory) {
        problemDirs.push(entry.name);
      }
    }
  } catch {
    console.warn(`源码目录不存在: ${SRC_DIR}，创建空目录...`);
    await Deno.mkdir(SRC_DIR, { recursive: true });
    problemDirs = [];
  }

  if (problemDirs.length === 0) {
    console.log("没有找到题目源码（空目录），跳过打包");
    console.log(`  请将题目文件放入 ${SRC_DIR}/<id>/ 后重新运行`);
    return;
  }

  for (const id of problemDirs) {
    try {
      await buildProblemPackage(id);
    } catch (err) {
      console.error(`打包失败 (${id}):`, err);
    }
  }

  console.log("构建完成");
}

await main();
