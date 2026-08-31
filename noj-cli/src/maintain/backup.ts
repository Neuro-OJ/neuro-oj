import type { DeployConfig } from "../config/types.ts";
import { loadDeployment } from "../config/load.ts";
import { DEPLOY_FILE, SECRETS_FILE } from "../config/io.ts";
import {
  type BackupDriver,
  fileSha256Hex,
  sha256Hex,
} from "./backup_driver.ts";

/** 快照归档清单（写入归档内部 manifest.json）。 */
export interface Manifest {
  schema_version: number;
  created_at: string;
  type: string;
  version: { noj_cli: string; noj_server: string };
  encrypted: boolean;
  zstd_level: number;
  sha256: string;
  files: string[];
}

/** backup create 选项。 */
export interface BackupCreateOptions {
  dir: string;
  backupDir?: string;
  passphraseFile?: string;
  zstdLevel?: number;
  noEncrypt?: boolean;
  driver?: BackupDriver;
}

/** 生成本次快照文件名：snapshot-<timestamp>.nojbackup。 */
export function snapshotFileName(ts: Date): string {
  const stamp = ts.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  return `snapshot-${stamp}.nojbackup`;
}

/** 默认备份目录：${install_dir}/backups。 */
export function defaultBackupDir(config: DeployConfig): string {
  return `${config.install_dir}/backups`;
}

/** 解析口令文件：旗标优先，回退 NOJ_BACKUP_PASSPHRASE_FILE；都没有返回 null。 */
export function resolvePassphraseFile(passphraseFlag?: string): string | null {
  if (passphraseFlag) return passphraseFlag;
  const env = Deno.env.get("NOJ_BACKUP_PASSPHRASE_FILE");
  return env || null;
}

/** 写 sha256sums.txt（每行 `<sha256>  <relPath>`，两空格分隔）。 */
export async function writeSha256Sums(
  dir: string,
  entries: { relPath: string; sha256: string }[],
): Promise<void> {
  let text = "";
  for (const e of entries) {
    text += `${e.sha256}  ${e.relPath}\n`;
  }
  await Deno.writeTextFile(`${dir}/sha256sums.txt`, text);
}

/** 收集 staging 内相对文件路径列表（递归）。 */
async function listFilesRecursive(
  dir: string,
  base: string,
): Promise<string[]> {
  const out: string[] = [];
  const entries = await Array.fromAsync(Deno.readDir(dir));
  for (const e of entries) {
    const full = `${dir}/${e.name}`;
    const rel = `${base}${e.name}`;
    if (e.isDirectory) {
      out.push(...(await listFilesRecursive(full, `${rel}/`)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/** backup create：仅 prod；收集 staging → tar+zstd 打包 → 可选 gpg。 */
export async function backupCreate(
  opts: BackupCreateOptions,
): Promise<{ path: string; sha256: string }> {
  const { config, secrets } = await loadDeployment(opts.dir);
  if (config.type !== "prod") {
    throw new Error("backup create 仅面向 prod 部署");
  }
  const driver = opts.driver!;
  const zstdLevel = opts.zstdLevel ?? 15;
  const noEncrypt = opts.noEncrypt ?? false;
  const passphraseFile = resolvePassphraseFile(opts.passphraseFile);
  if (!noEncrypt && passphraseFile === null) {
    throw new Error(
      "加密备份需要口令：--passphrase-file 或 NOJ_BACKUP_PASSPHRASE_FILE",
    );
  }
  const backupDir = opts.backupDir ?? defaultBackupDir(config);
  const now = new Date();
  const destName = snapshotFileName(now);
  const destPath = `${backupDir}/${destName}`;
  await Deno.mkdir(backupDir, { recursive: true });

  // 1) staging 目录收集文件
  const staging = await Deno.makeTempDir({ prefix: "noj-backup-staging-" });
  try {
    // 数据转储
    const dumps = await driver.produceDataDumps(config, secrets, staging);
    // 把 dump 条目写入 staging
    for (const d of dumps) {
      const full = `${staging}/${d.relPath}`;
      const idx = full.lastIndexOf("/");
      if (idx > 0) {
        await Deno.mkdir(full.slice(0, idx), { recursive: true });
      }
      await Deno.writeTextFile(full, d.content);
    }
    // 配置文件
    await Deno.copyFile(
      `${opts.dir}/${DEPLOY_FILE}`,
      `${staging}/${DEPLOY_FILE}`,
    );
    await Deno.copyFile(
      `${opts.dir}/${SECRETS_FILE}`,
      `${staging}/${SECRETS_FILE}`,
    );
    // SUCCESS 哨兵
    await Deno.writeTextFile(`${staging}/SUCCESS`, "ok\n");
    // sha256sums.txt（不含 manifest/sha256sums 自身）
    const payload = [
      ...dumps.map((d) => d.relPath),
      DEPLOY_FILE,
      SECRETS_FILE,
      "SUCCESS",
    ];
    const sums: { relPath: string; sha256: string }[] = [];
    for (const rel of payload) {
      sums.push({
        relPath: rel,
        sha256: await fileSha256Hex(`${staging}/${rel}`),
      });
    }
    await writeSha256Sums(staging, sums);
    // manifest（先占位 sha256，打包后回填）
    const tarZst = `${staging}.tar.zst`;
    await driver.archive(staging, tarZst, zstdLevel);
    const tarSha = await fileSha256Hex(tarZst);
    const files = await listFilesRecursive(staging, "");
    const manifest: Manifest = {
      schema_version: 1,
      created_at: now.toISOString(),
      type: config.type,
      version: config.version,
      encrypted: !noEncrypt,
      zstd_level: zstdLevel,
      sha256: tarSha,
      files,
    };
    await Deno.writeTextFile(
      `${staging}/manifest.json`,
      JSON.stringify(manifest, null, 2),
    );
    // manifest 写入后需重新打包（含 manifest）
    await driver.archive(staging, tarZst, zstdLevel);

    // 2) 加密或直落
    if (noEncrypt) {
      await Deno.copyFile(tarZst, destPath);
    } else {
      await driver.gpgEncrypt(tarZst, destPath, passphraseFile!);
    }
    // 3) 整体产物 SHA-256
    const finalSha = await fileSha256Hex(destPath);
    void sha256Hex; // 保留纯函数引用（供后续 verify 复用以避免未使用告警）
    return { path: destPath, sha256: finalSha };
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    await Deno.remove(`${staging}.tar.zst`, { recursive: true }).catch(
      () => {},
    );
  }
}
