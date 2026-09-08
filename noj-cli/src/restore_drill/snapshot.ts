/** restore-drill 快照校验与元数据工具。 */

import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";

export interface VerifySnapshotOptions {
  snapshot: string;
  envFile: string;
  composeFile: string;
  passphraseFile: string;
  runner?: CommandRunner;
}

function isFile(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return Deno.statSync(p).isDirectory;
  } catch {
    return false;
  }
}

/** 规范化并校验快照目录路径；返回绝对路径。 */
export function validateSnapshotPath(snapshot: string): string {
  if (!isDir(snapshot)) throw new Error(`快照目录不存在：${snapshot}`);
  const base = snapshot.split("/").filter(Boolean).pop() ?? "";
  if (!base.startsWith("snapshot-")) {
    throw new Error(`只允许演练 snapshot-* 快照目录：${snapshot}`);
  }
  if (snapshot.includes("/..") || snapshot.includes("/.snapshot-")) {
    throw new Error(`非法快照路径：${snapshot}`);
  }
  return Deno.realPathSync(snapshot);
}

/** 检查快照必备文件；返回问题列表。 */
export function checkSnapshotFiles(snapshot: string): string[] {
  const problems: string[] = [];
  if (!isFile(`${snapshot}/SUCCESS`)) problems.push("快照缺少 SUCCESS");
  if (!isFile(`${snapshot}/manifest.json`)) {
    problems.push("快照缺少 manifest.json");
  }
  if (!isFile(`${snapshot}/env.prod.gpg`)) {
    problems.push("快照缺少 env.prod.gpg");
  }
  if (!isFile(`${snapshot}/postgres.dump`)) {
    problems.push("快照缺少 postgres.dump");
  }
  if (!isFile(`${snapshot}/postgres-globals.sql`)) {
    problems.push("快照缺少 postgres-globals.sql");
  }
  if (!isFile(`${snapshot}/redis.rdb`)) problems.push("快照缺少 redis.rdb");
  if (!isDir(`${snapshot}/minio`)) problems.push("快照缺少 minio 目录");
  if (!isFile(`${snapshot}/sha256sums.txt`)) {
    problems.push("快照缺少 sha256sums.txt");
  }
  return problems;
}

/** 检查 GPG 口令文件权限；返回问题列表。 */
export function checkSecretFile(file: string): string[] {
  if (!isFile(file)) return [`GPG 口令文件不存在：${file}`];
  const mode = Deno.statSync(file).mode! & 0o777;
  if (mode !== 0o600 && mode !== 0o400) {
    return [`GPG 口令文件权限必须为 600 或 400：${file}`];
  }
  return [];
}

/** 从 manifest.json 读取 created_at。 */
export function snapshotCreatedAt(snapshot: string): string {
  const raw = Deno.readTextFileSync(`${snapshot}/manifest.json`);
  const manifest = JSON.parse(raw) as { created_at?: string };
  const value = manifest.created_at;
  if (!value) throw new Error("manifest.json 缺少 created_at");
  return value;
}

/** 计算当前时间与快照创建时间的小时差。 */
export function hoursSinceSnapshot(createdAt: string): number {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return 0;
  return (Date.now() - created) / 3600_000;
}

/** SHA-256 十六进制。 */
export async function sha256File(file: string): Promise<string> {
  const data = await Deno.readFile(file);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 文件级快照校验（对应 backup.sh verify_snapshot 的 Deno 移植）。 */
export async function verifySnapshot(
  opts: VerifySnapshotOptions,
): Promise<string[]> {
  const runner = opts.runner ?? realRunner();
  const snapshot = validateSnapshotPath(opts.snapshot);
  const problems = checkSnapshotFiles(snapshot);
  if (problems.length > 0) return problems;
  if (opts.passphraseFile === "") {
    return ["必须提供 --passphrase-file 或 NOJ_BACKUP_PASSPHRASE_FILE"];
  }
  problems.push(...checkSecretFile(opts.passphraseFile));

  // 校验 sha256sums.txt
  const lines = Deno.readTextFileSync(`${snapshot}/sha256sums.txt`)
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  for (const line of lines) {
    const idx = line.indexOf("  ");
    if (idx === -1) continue;
    const expected = line.slice(0, idx);
    const rel = line.slice(idx + 2);
    if (rel.includes("..") || rel.startsWith("/")) {
      return [`校验清单包含非法路径：${rel}`];
    }
    const file = `${snapshot}/${rel}`;
    if (!isFile(file)) return [`校验清单文件缺失：${rel}`];
    const actual = await sha256File(file);
    if (actual !== expected) return [`SHA-256 校验失败：${rel}`];
  }

  // GPG 解密环境文件
  const decrypted = `${snapshot}/.env.prod.drill-decrypted`;
  try {
    const r = await runner.run("gpg", [
      "--batch",
      "--yes",
      "--pinentry-mode",
      "loopback",
      "--passphrase-file",
      opts.passphraseFile,
      "--decrypt",
      "--output",
      decrypted,
      `${snapshot}/env.prod.gpg`,
    ]);
    if (r.code !== 0) return ["GPG 解密失败"];
  } finally {
    try {
      await Deno.remove(decrypted);
    } catch {
      // 忽略清理失败
    }
  }
  return [];
}
