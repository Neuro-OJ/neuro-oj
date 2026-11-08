/** `.nojbackup` 容器的三档校验（从 container.ts 拆出）。
 */

import { join } from "@std/path";
import { fileSha256HexStreaming } from "./sha256.ts";
import {
  type BackupManifest,
  CHECKSUM_SUFFIX,
  CONTAINER_FILES,
  PAYLOAD_LAYOUT,
  SUCCESS_MARKER,
} from "./container.ts";
import { parseChecksums } from "./container-checksums.ts";
import {
  unpackContainer,
  type UnpackContainerOptions,
} from "./container-unpack.ts";

// ---------------- 容器校验（verify 的三档共用底座） ----------------

/** 单条校验失败。 */
export interface VerifyIssue {
  /** 失败所属档位。 */
  level: "files" | "deep" | "payload";
  /** 面向用户的说明。 */
  message: string;
}

/** {@link verifyContainer} 的结果。 */
export interface VerifyContainerResult {
  /** 解包出的 staging（调用方负责清理）。 */
  staging: string;
  manifest: BackupManifest | null;
  /** 逐档结论。 */
  checks: {
    /** 默认档：manifest + SUCCESS + sha256sums 逐文件。 */
    files: boolean;
    /** `--deep`：结构可解析 + env 可解密。 */
    deep: boolean;
    /** `--payload-sha`：容器文件摘要与同级 sidecar `.sha256` 一致。 */
    payload: boolean;
  };
  issues: VerifyIssue[];
  /** 是否已询问的档位全部通过。 */
  pass: boolean;
  /** `--deep` 是否因缺口令而跳过了需要口令的检查（如实报告，不静默通过）。 */
  skippedDecrypt: boolean;
}

/** {@link verifyContainer} 的注入点。 */
export interface VerifyContainerOptions extends UnpackContainerOptions {
  /** 是否跑 `--deep` 档。 */
  deep?: boolean;
  /** 是否跑 `--payload-sha` 档。 */
  payloadSha?: boolean;
}

/**
 * 校验 `.nojbackup` 容器（`backup.sh verify_snapshot` :302-334 的等价 + 两档增强）。
 *
 * 三档**累加**（高档包含低档的全部检查）：
 *
 * | 档位 | 内容 | 成本 |
 * | --- | --- | --- |
 * | 默认 | `payload_layout == "prod-raw"`、`SUCCESS` 哨兵、`sha256sums.txt` 逐文件 | 秒级 |
 * | `--deep` | 上一档 + `postgres.restore-list` 非空 + `redis.rdb` 首字节 `REDIS` + `minio/` 存在 + `env.prod.gpg` 可解密且非空 | 十秒级 |
 * | `--payload-sha` | 上一档 + 复算**容器文件**摘要并与同级 sidecar `.sha256` 比对 | 十秒级 |
 *
 * 设计要点：
 * - **不清理** staging（调用方 `finally` 删）——verify 之后 restore/drill 可能还要读；
 * - `sha256sums` 的路径做**穿越防护**（`../`、绝对路径一律拒绝），与 bash
 *   `verify_snapshot` 的 `[[ "$file" != /* && "$file" != *".."* ]]` 同义；
 * - `--deep` 在缺口令时**跳过**解密并置 {@link VerifyContainerResult.skippedDecrypt}，
 *   由调用方如实报告——静默通过会让"加密档"名不副实。
 */
export async function verifyContainer(
  opts: VerifyContainerOptions,
): Promise<VerifyContainerResult> {
  const issues: VerifyIssue[] = [];
  const unpacked = await unpackContainer(opts);
  const { staging } = unpacked;
  const manifest = unpacked.manifest;

  // ---- 默认档：manifest / payload_layout ----
  let filesOk = true;
  if (manifest === null) {
    filesOk = false;
    issues.push({ level: "files", message: "缺少或无法解析 manifest.json" });
  } else if (manifest.payload_layout !== PAYLOAD_LAYOUT) {
    // 唯一形态：不做分派，直接拒绝（历史/未知布局不在支持范围）
    filesOk = false;
    issues.push({
      level: "files",
      message:
        `payload_layout 不受支持：${manifest.payload_layout}（只支持 ${PAYLOAD_LAYOUT}）`,
    });
  }

  // ---- 默认档：SUCCESS 哨兵 ----
  let successOk = false;
  try {
    successOk =
      (await Deno.readTextFile(join(staging, CONTAINER_FILES.success)))
        .trim() ===
        SUCCESS_MARKER;
  } catch {
    successOk = false;
  }
  if (!successOk) {
    filesOk = false;
    issues.push({
      level: "files",
      message: `缺少有效的 ${CONTAINER_FILES.success} 哨兵`,
    });
  }

  // ---- 默认档：sha256sums 逐文件 ----
  let sumsOk = false;
  try {
    const text = await Deno.readTextFile(
      join(staging, CONTAINER_FILES.checksums),
    );
    const entries = parseChecksums(text);
    let ok = true;
    for (const entry of entries) {
      // 穿越防护：绝对路径或含 .. 的清单项一律拒绝。
      if (entry.relPath.startsWith("/") || entry.relPath.includes("..")) {
        ok = false;
        issues.push({
          level: "files",
          message: `校验清单包含非法路径：${entry.relPath}`,
        });
        continue;
      }
      let actual = "";
      try {
        actual = await fileSha256HexStreaming(join(staging, entry.relPath));
      } catch {
        ok = false;
        issues.push({
          level: "files",
          message: `校验清单引用了缺失文件：${entry.relPath}`,
        });
        continue;
      }
      if (actual !== entry.sha256) {
        ok = false;
        issues.push({
          level: "files",
          message: `SHA-256 校验失败：${entry.relPath}`,
        });
      }
    }
    sumsOk = ok && entries.length > 0;
    if (entries.length === 0) {
      issues.push({ level: "files", message: "校验清单为空" });
    }
  } catch (err) {
    issues.push({
      level: "files",
      message: `无法解析 ${CONTAINER_FILES.checksums}：${
        (err as Error).message
      }`,
    });
  }
  filesOk = filesOk && successOk && sumsOk;

  // ---- --deep 档：结构可解析 ----
  let deepOk = filesOk;
  let skippedDecrypt = false;
  if (opts.deep === true) {
    if (filesOk) {
      // restore-list 非空（create 时 pg_restore --list 的产物）
      let listOk = false;
      try {
        listOk = (await Deno.stat(
          join(staging, CONTAINER_FILES.postgresRestoreList),
        )).size > 0;
      } catch {
        listOk = false;
      }
      if (!listOk) {
        deepOk = false;
        issues.push({
          level: "deep",
          message:
            `${CONTAINER_FILES.postgresRestoreList} 为空或缺失（PostgreSQL 结构未验证）`,
        });
      }

      // redis.rdb 非空且首字节是 "REDIS"（RDB 魔术串）
      let rdbOk = false;
      let rdbDetail = "缺失或为空";
      try {
        const rdbPath = join(staging, CONTAINER_FILES.redisRdb);
        const size = (await Deno.stat(rdbPath)).size;
        if (size >= 5) {
          const file = await Deno.open(rdbPath, { read: true });
          try {
            const head = new Uint8Array(5);
            await file.read(head);
            rdbOk = new TextDecoder().decode(head) === "REDIS";
            if (!rdbOk) {
              rdbDetail = `首字节不是 REDIS 魔术串：${
                JSON.stringify(new TextDecoder().decode(head))
              }`;
            }
          } finally {
            file.close();
          }
        }
      } catch {
        rdbOk = false;
      }
      if (!rdbOk) {
        deepOk = false;
        issues.push({
          level: "deep",
          message: `redis.rdb 不可解析：${rdbDetail}`,
        });
      }

      // minio/ 目录存在
      let minioOk = false;
      try {
        minioOk = (await Deno.stat(join(staging, CONTAINER_FILES.minioDir)))
          .isDirectory;
      } catch {
        minioOk = false;
      }
      if (!minioOk) {
        deepOk = false;
        issues.push({
          level: "deep",
          message: `${CONTAINER_FILES.minioDir}/ 目录缺失`,
        });
      }
    } else {
      deepOk = false;
    }

    // env.prod.gpg 可解密（需要口令；缺口令则如实跳过）
    const hasPassphrase = (opts.passphraseFile ?? "") !== "";
    if (deepOk && hasPassphrase) {
      const out = join(opts.destDir, "env.prod.verify");
      try {
        await opts.ops.gpgDecrypt(
          join(staging, CONTAINER_FILES.envProdGpg),
          out,
          opts.passphraseFile!,
        );
        const size = (await Deno.stat(out)).size;
        if (size === 0) {
          deepOk = false;
          issues.push({
            level: "deep",
            message: "环境文件解密结果为空",
          });
        }
      } catch (err) {
        deepOk = false;
        issues.push({
          level: "deep",
          message: `环境文件解密失败：${(err as Error).message}`,
        });
      } finally {
        await Deno.remove(out).catch(() => {});
      }
    } else if (deepOk && !hasPassphrase) {
      skippedDecrypt = true;
    }
  }

  // ---- --payload-sha 档：容器整体摘要 vs 同级 sidecar ----
  //
  // 语义与**安全边界**（必须诚实）：sidecar 检测的是**意外损坏**——介质位翻转、
  // 拷贝被截断、下载不完整、误改。它**不**防蓄意篡改：能改 `.nojbackup` 的人
  // 同样能改同级 `.sha256`。要防蓄意篡改需要非对称签名（cosign 一类），
  // 而对称口令体系下"持有口令者可重写一切"，签名不在本任务的范围内。
  let payloadOk = deepOk;
  if (opts.payloadSha === true) {
    if (!filesOk) {
      payloadOk = false;
    } else {
      const sidecar = opts.path + CHECKSUM_SUFFIX;
      try {
        const text = await Deno.readTextFile(sidecar);
        const expected = text.trim().split(/\s+/)[0] ?? "";
        if (!/^[0-9a-f]{64}$/.test(expected)) {
          payloadOk = false;
          issues.push({
            level: "payload",
            message: `sidecar 校验文件格式非法：${sidecar}`,
          });
        } else {
          const actual = await fileSha256HexStreaming(opts.path);
          payloadOk = actual === expected;
          if (!payloadOk) {
            issues.push({
              level: "payload",
              message:
                `容器摘要与 sidecar 不一致（期望 ${expected}，实际 ${actual}）——文件可能已损坏`,
            });
          }
        }
      } catch {
        payloadOk = false;
        issues.push({
          level: "payload",
          message: `缺少 sidecar 校验文件：${sidecar}`,
        });
      }
    }
  }

  const pass = filesOk &&
    (opts.deep !== true || deepOk) &&
    (opts.payloadSha !== true || payloadOk);

  return {
    staging,
    manifest,
    checks: {
      files: filesOk,
      deep: opts.deep === true ? deepOk : filesOk,
      payload: opts.payloadSha === true ? payloadOk : deepOk,
    },
    issues,
    pass,
    skippedDecrypt,
  };
}
