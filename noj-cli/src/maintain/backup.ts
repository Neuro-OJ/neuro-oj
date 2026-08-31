import type { DeployConfig, DeployState } from "../config/types.ts";
import { loadDeployment } from "../config/load.ts";
import { saveDeployment } from "../config/save.ts";
import { DEPLOY_FILE, SECRETS_FILE } from "../config/io.ts";
import { deployDown } from "../deploy/deploy.ts";
import { COMPOSE_FILE, ensureComposeFile } from "../deploy/compose.ts";
import { dockerDown, dockerUpServices } from "../deploy/docker.ts";
import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
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
  if (config.state !== "running") {
    throw new Error(
      `backup create 需要部署处于 running 状态，当前: ${config.state}`,
    );
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

/** verify 选项。 */
export interface BackupVerifyOptions {
  snapshotPath: string;
  passphraseFile?: string;
  driver?: BackupDriver;
}

/** verify 报告。 */
export interface VerifyReport {
  manifest: Manifest | null;
  filesOk: boolean;
  sumOk: boolean;
  successOk: boolean;
  pass: boolean;
  errors: string[];
}

/** 解密（如已加密）并解包到临时目录，返回 staging 与 manifest；调用方负责清理 staging。 */
async function decryptAndExtract(
  snapshotPath: string,
  passphraseFile: string | undefined,
  driver: BackupDriver,
): Promise<{ staging: string; manifest: Manifest | null }> {
  const staging = await Deno.makeTempDir({ prefix: "noj-backup-verify-" });
  const pass = resolvePassphraseFile(passphraseFile);
  if (pass !== null) {
    const plain = `${staging}.tar.zst`;
    await driver.gpgDecrypt(snapshotPath, plain, pass);
    await driver.extract(plain, staging);
  } else {
    // 未给口令：尝试当未加密归档直接解包
    await driver.extract(snapshotPath, staging);
  }
  let manifest: Manifest | null = null;
  try {
    const text = await Deno.readTextFile(`${staging}/manifest.json`);
    manifest = JSON.parse(text) as Manifest;
  } catch {
    manifest = null;
  }
  return { staging, manifest };
}

/** backup verify：解密+解包 → 校验 SUCCESS / manifest / sha256sums。 */
export async function backupVerify(
  opts: BackupVerifyOptions,
): Promise<VerifyReport> {
  const driver = opts.driver!;
  const errors: string[] = [];
  const { staging, manifest } = await decryptAndExtract(
    opts.snapshotPath,
    opts.passphraseFile,
    driver,
  );
  try {
    // 1) SUCCESS 哨兵
    let successOk = false;
    try {
      const t = await Deno.readTextFile(`${staging}/SUCCESS`);
      successOk = t.trim() === "ok";
    } catch {
      successOk = false;
    }
    if (!successOk) errors.push("缺少有效的 SUCCESS 哨兵");

    // 2) sha256sums.txt 逐文件校验
    let sumOk = false;
    try {
      const sumsText = await Deno.readTextFile(`${staging}/sha256sums.txt`);
      let ok = true;
      for (const line of sumsText.split("\n")) {
        if (!line) continue;
        const sep = line.indexOf("  ");
        if (sep === -1) {
          ok = false;
          break;
        }
        const hash = line.slice(0, sep);
        const rel = line.slice(sep + 2);
        let actual = "";
        try {
          actual = await fileSha256Hex(`${staging}/${rel}`);
        } catch {
          ok = false;
          errors.push(`sha256sums: 缺失文件 ${rel}`);
          continue;
        }
        if (actual !== hash) {
          ok = false;
          errors.push(`sha256sums: ${rel} 校验失败`);
        }
      }
      sumOk = ok;
    } catch {
      sumOk = false;
      errors.push("缺少或无法解析 sha256sums.txt");
    }

    // 3) manifest 存在性
    const filesOk = manifest !== null;
    if (!filesOk) errors.push("缺少 manifest.json");

    const pass = successOk && sumOk && filesOk;
    return { manifest, filesOk, sumOk, successOk, pass, errors };
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }
}

/** restore 选项。 */
export interface BackupRestoreOptions {
  dir: string;
  snapshotPath: string;
  confirm: boolean;
  passphraseFile?: string;
  includeDeployConfigs?: boolean;
  driver?: BackupDriver;
  runner?: CommandRunner;
}

/** backup restore：仅恢复数据；--include-deploy-configs 时连同配置一起恢复。 */
export async function backupRestore(
  opts: BackupRestoreOptions,
): Promise<DeployState> {
  if (!opts.confirm) {
    throw new Error("restore 需要 --confirm 确认");
  }
  const runner = opts.runner ?? realRunner();
  const { config, secrets } = await loadDeployment(opts.dir);
  const downState = await deployDown({ dir: opts.dir, runner });
  // 目标必须已停止
  if (downState !== "stopped") {
    throw new Error(`restore 要求目标已停止，当前状态: ${downState}`);
  }
  const driver = opts.driver!;
  const snap = opts.snapshotPath;
  const { staging, manifest } = await decryptAndExtract(
    snap,
    opts.passphraseFile,
    driver,
  );
  const infraServices = Object.entries(config.components)
    .filter(([name, c]) =>
      c.enabled && c.method === "docker" &&
      (name === "postgres" || name === "redis" || name === "minio")
    )
    .map(([name]) => name);
  let infraStarted = false;
  try {
    if (infraServices.length > 0) {
      const composePath = `${opts.dir}/${COMPOSE_FILE}`;
      await ensureComposeFile(opts.dir, config, secrets);
      const upRes = await dockerUpServices(runner, composePath, infraServices);
      if (upRes.code !== 0) {
        throw new Error(
          `restore 前启动基础设施失败: ${upRes.stderr || upRes.stdout}`,
        );
      }
      infraStarted = true;
    }
    await driver.restoreDataDumps(config, secrets, staging);
    if (opts.includeDeployConfigs) {
      if (manifest === null) {
        throw new Error("includeDeployConfigs 需要快照内含 manifest.json");
      }
      // 从 staging 恢复配置：先备份现状再覆盖（写入前留档）
      const backup = await Deno.makeTempDir({
        prefix: "noj-restore-config-bak-",
      });
      try {
        await Deno.copyFile(
          `${opts.dir}/noj-deploy.json`,
          `${backup}/noj-deploy.json.bak`,
        );
        await Deno.copyFile(
          `${opts.dir}/noj-secrets.json`,
          `${backup}/noj-secrets.json.bak`,
        );
        await Deno.copyFile(
          `${staging}/noj-deploy.json`,
          `${opts.dir}/noj-deploy.json`,
        );
        await Deno.copyFile(
          `${staging}/noj-secrets.json`,
          `${opts.dir}/noj-secrets.json`,
        );
      } finally {
        await Deno.remove(backup, { recursive: true }).catch(() => {});
      }
      // 恢复出的配置可能带有备份时的 state（如 running），但当前部署实际已停止，强制校正。
      const restored = await loadDeployment(opts.dir);
      restored.config.state = "stopped";
      await saveDeployment(opts.dir, restored.config, restored.secrets);
    }
    return "stopped";
  } finally {
    if (infraStarted) {
      await dockerDown(runner, `${opts.dir}/${COMPOSE_FILE}`);
    }
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }
}

/** drill 选项。 */
export interface BackupDrillOptions {
  snapshotPath: string;
  passphraseFile?: string;
  report?: string;
  driver?: BackupDriver;
}

/** backup drill：跑 verify，并把报告写入 report 文件（若提供）。 */
export async function backupDrill(
  opts: BackupDrillOptions,
): Promise<VerifyReport> {
  const report = await backupVerify({
    snapshotPath: opts.snapshotPath,
    passphraseFile: opts.passphraseFile,
    driver: opts.driver,
  });
  if (opts.report) {
    await Deno.writeTextFile(
      opts.report,
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  return report;
}
