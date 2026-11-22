/** `.nojbackup` 容器的解包与 manifest 读取（从 container.ts 拆出）。
 */

import { join } from "@std/path";
import {
  type BackupManifest,
  CONTAINER_FILES,
  ContainerError,
} from "./container.ts";
import type { ContainerPayloadOps } from "./container-create.ts";

// ---------------- 容器解包（verify / restore / drill 共用） ----------------

/** {@link unpackContainer} 的注入点。 */
export interface UnpackContainerOptions {
  /** 容器文件路径。 */
  path: string;
  /** 口令文件路径；容器 `encrypted: false` 时可为空。 */
  passphraseFile?: string;
  /** 解包目标目录（临时目录；**调用方负责清理**）。 */
  destDir: string;
  /** 解包操作集（注入；生产为 `createProdPayloadOps`）。 */
  ops: Pick<ContainerPayloadOps, "gpgDecrypt" | "untarZst">;
  /**
   * 容器是否加密。缺省按"有口令即加密"推断——但更稳妥的是由调用方
   * 先读 manifest 再决定；此处提供显式开关以便测试与 `--no-encrypt` 产物。
   */
  encrypted?: boolean;
}

/** {@link unpackContainer} 的结果。 */
export interface UnpackContainerResult {
  /** 解包出的 staging 目录（= `destDir`）。 */
  staging: string;
  /** 解析后的 manifest；缺失或非法时为 null（由调用方判定是否致命）。 */
  manifest: BackupManifest | null;
}

/**
 * 解包 `.nojbackup` 容器到 `destDir`。
 *
 * 编排：加密时 `gpg --decrypt` → `tar -I zstd -xf` → 读 manifest。
 *
 * **不校验**内容（那是 {@link verifyContainer} 的职责）：本函数只负责把包打开，
 * 让上层按档位自行判定。这样三档 verify 与 restore/drill 共用同一份解包实现。
 *
 * **不清理** `destDir`：调用方在 `finally` 里删（verify 需要在解包后继续读文件）。
 */
export async function unpackContainer(
  opts: UnpackContainerOptions,
): Promise<UnpackContainerResult> {
  const encrypted = opts.encrypted ?? true;
  const tarball = join(opts.destDir, "payload.tar.zst");
  if (encrypted) {
    if (opts.passphraseFile === undefined || opts.passphraseFile === "") {
      throw new ContainerError("encrypt", "容器已加密，需要口令文件才能解包");
    }
    await Deno.mkdir(opts.destDir, { recursive: true });
    await opts.ops.gpgDecrypt(opts.path, tarball, opts.passphraseFile);
  }

  // 解包到一个子目录：容器根的条目直接落在这里，便于与 destDir 自身的
  // `payload.tar.zst` 共存（未加密时它就是容器本身）。
  const staging = join(opts.destDir, "payload");
  if (encrypted) {
    await opts.ops.untarZst(tarball, staging);
  } else {
    await opts.ops.untarZst(opts.path, staging);
  }

  return { staging, manifest: await readManifest(staging) };
}

/** 读并解析 staging 内的 manifest；缺失或非法返回 null（不抛错）。 */
export async function readManifest(
  staging: string,
): Promise<BackupManifest | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(staging, CONTAINER_FILES.manifest));
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as BackupManifest;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
