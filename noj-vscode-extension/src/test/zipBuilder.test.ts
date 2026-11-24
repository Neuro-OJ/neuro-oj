import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import {
  buildZipBuffer,
  crc32,
  isIgnoredPath,
  normalizeArchivePath,
  packWorkspaceZip,
} from "../zipBuilder";

test("crc32 与标准 IEEE 802.3 校验值一致", () => {
  assert.equal(crc32(Buffer.from("123456789", "utf8")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0x00000000);
});

test("normalizeArchivePath 规范化分隔符并拒绝路径穿越", () => {
  assert.equal(normalizeArchivePath("./src\\main.py"), "src/main.py");
  assert.throws(() => normalizeArchivePath("../secret.txt"), /非法路径段/);
  assert.throws(() => normalizeArchivePath("a/../b.py"), /非法路径段/);
  assert.throws(() => normalizeArchivePath(""), /不能为空/);
});

test("buildZipBuffer 产出的 ZIP 可被标准 unzip 与 zlib 正确解压", async () => {
  const repeated = "print('neuro-oj-zip-test')\n".repeat(40);
  const zip = buildZipBuffer([
    { name: "submission.py", data: Buffer.from(repeated, "utf8") },
    { name: "中文目录/empty.txt", data: Buffer.alloc(0) },
    { name: "meta.json", data: Buffer.from('{"ok":true}', "utf8") },
  ]);

  assert.equal(zip.readUInt32LE(0), 0x04034b50);

  // 验证第一个条目使用 DEFLATE 压缩并可通过 raw inflate 还原
  const method = zip.readUInt16LE(8);
  const compSize = zip.readUInt32LE(18);
  const nameLen = zip.readUInt16LE(26);
  const extraLen = zip.readUInt16LE(28);
  assert.equal(method, 8);
  const payloadStart = 30 + nameLen + extraLen;
  const inflated = zlib.inflateRawSync(
    zip.subarray(payloadStart, payloadStart + compSize),
  );
  assert.equal(inflated.toString("utf8"), repeated);

  // 使用系统 unzip 命令验证完整归档结构与校验和
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noj-zip-test-"));
  try {
    const zipPath = path.join(dir, "bundle.zip");
    await fs.writeFile(zipPath, zip);
    try {
      execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
      const extracted = execFileSync("unzip", ["-p", zipPath, "submission.py"]);
      assert.equal(extracted.toString("utf8"), repeated);
    } catch (error) {
      // 若环境未安装 unzip 则跳过外部命令断言
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("packWorkspaceZip 按 .nojignore 过滤目录与文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "noj-ws-zip-"));
  try {
    await fs.mkdir(path.join(root, ".noj"), { recursive: true });
    await fs.mkdir(path.join(root, ".venv", "lib"), { recursive: true });
    await fs.mkdir(path.join(root, "__pycache__"), { recursive: true });
    await fs.mkdir(path.join(root, "src"), { recursive: true });

    await fs.writeFile(
      path.join(root, ".nojignore"),
      ".venv/\n__pycache__/\n*.log\n",
    );
    await fs.writeFile(path.join(root, ".noj", "problem.json"), "{}");
    await fs.writeFile(path.join(root, ".venv", "lib", "pkg.py"), "x=1");
    await fs.writeFile(path.join(root, "__pycache__", "a.pyc"), "bin");
    await fs.writeFile(path.join(root, "debug.log"), "noise");
    await fs.writeFile(path.join(root, "src", "agent.py"), "print(1)\n");
    await fs.writeFile(path.join(root, "submission.py"), "import src.agent\n");

    const packed = await packWorkspaceZip(root);
    assert.deepEqual(packed.files, [
      ".nojignore",
      "src/agent.py",
      "submission.py",
    ]);
    assert.equal(isIgnoredPath(".git/config", []), true);
    assert.equal(isIgnoredPath("src/agent.py", [".venv"]), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
