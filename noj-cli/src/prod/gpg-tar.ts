/**
 * gpg / tar 的薄封装（`backup verify/restore` 解包容器时复用）。
 *
 * 与 `prod/backup/driver.ts` 的 ops 同名同形，只是接受注入的 runner。
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
