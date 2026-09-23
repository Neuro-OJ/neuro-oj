/**
 * gpg / tar 的薄封装（`backup verify/restore` 解包容器时复用）。
 *
 * 从 `prod/cli.ts` 抽出（2026-09-23）：该文件已到单文件规模阈值边缘，而本次复审
 * 修复又在其上增加了几处接线；抽出这两个零业务逻辑的系统调用包装是成本最低的
 * 拆分（它们与 `prod/backup/driver.ts` 的 ops 同名同形，只是接受注入的 runner）。
 *
 * @module
 */

import type { CommandRunner } from "../runtime/command.ts";

/** `gpg --decrypt`（供 verify/restore 解包容器）。 */
export async function gpgDecrypt(
  runner: CommandRunner,
  src: string,
  dest: string,
  passphraseFile: string,
): Promise<void> {
  const res = await runner.run("gpg", [
    "--batch",
    "--yes",
    "--pinentry-mode",
    "loopback",
    "--passphrase-file",
    passphraseFile,
    "--decrypt",
    "--output",
    dest,
    src,
  ]);
  if (res.code !== 0) throw new Error(`gpg 解密失败：${res.stderr.trim()}`);
}

/** `tar -I zstd -xf`（供 verify/restore 解包容器）。 */
export async function untarZst(
  runner: CommandRunner,
  src: string,
  destDir: string,
): Promise<void> {
  await Deno.mkdir(destDir, { recursive: true });
  const res = await runner.run("tar", [
    "-I",
    "zstd",
    "-xf",
    src,
    "-C",
    destDir,
  ]);
  if (res.code !== 0) throw new Error(`tar 解包失败：${res.stderr.trim()}`);
}
