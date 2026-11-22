/**
 * 备份口令文件管理：权限校验、路径选择、生成与 .env.prod 回填。
 */

import { dirname } from "@std/path";
import { type EnvValues, generateSecret } from "./checks.ts";

/** 缺省备份口令文件路径。 */
export const DEFAULT_BACKUP_PASSPHRASE_FILE = "/etc/noj/backup-passphrase";

/** 口令文件允许的权限。 */
export const PASSPHRASE_ALLOWED_MODES: readonly string[] = ["600", "400"];

/**
 * 返回八进制权限串（如 "600"/"640"）。
 *
 * 文件缺失时抛 `Deno.errors.NotFound`
 * （调用方先做存在性判定，见 {@link ensureBackupPassphrase}）。
 */
export async function passphraseFileMode(path: string): Promise<string> {
  const st = await Deno.stat(path);
  return ((st.mode ?? 0) & 0o777).toString(8).padStart(3, "0");
}

/** {@link backupPassphrasePath} 的候选来源（优先级从高到低）。 */
export interface PassphrasePathOptions {
  /** `--passphrase-file`。 */
  flag?: string;
  /** 环境变量 `NOJ_BACKUP_PASSPHRASE_FILE`（进程环境）。 */
  explicit?: string;
  /** .env.prod 中的 `NOJ_BACKUP_PASSPHRASE_FILE`。 */
  configured?: string;
}

/**
 * 备份口令文件的目标选择：
 * `flag` > `explicit` > `configured` > {@link DEFAULT_BACKUP_PASSPHRASE_FILE}。
 */
export function backupPassphrasePath(opts: PassphrasePathOptions): string {
  return opts.flag || opts.explicit || opts.configured ||
    DEFAULT_BACKUP_PASSPHRASE_FILE;
}

/** {@link ensureBackupPassphrase} 的注入点。 */
export interface EnsurePassphraseOptions {
  /** 覆盖目标路径（测试用；生产由 {@link backupPassphrasePath} 决定）。 */
  targetFile?: string;
  /**
   * 口令来源是否来自**进程环境** `NOJ_BACKUP_PASSPHRASE_FILE`。
   *
   * 回填门只看两处：.env.prod 里有没有该键、进程环境有没有该变量。
   * **`--passphrase-file` 旗标不参与该门**：它只用于选目标路径，
   * 故旗标给出的路径仍会被回填进 .env.prod。
   *
   * 缺省 false = 进程环境未给出该变量 → 允许回填。
   */
  configuredFromEnv?: boolean;
}

/** {@link ensureBackupPassphrase} 结果。 */
export interface EnsurePassphraseResult {
  path: string;
  created: boolean;
  /** 本次新生成的口令明文；复用已有文件时为 null。 */
  passphrase: string | null;
  /** 需要回填到 .env.prod 的键；无需回填时为 null。 */
  envUpdate: Record<string, string> | null;
  error: string | null;
}

/**
 * 确保备份口令文件存在且权限正确。
 *
 * - 目标存在：必须是普通文件且权限为 600/400，否则拒绝并给可操作提示；
 * - 目标缺失：`mkdir -p -m 700` 父目录 → 生成 32 字节 hex → 临时文件 600 →
 *   原子 rename → 最终 600；仅当"配置里没有该键 **且** 进程环境未给出
 *   `NOJ_BACKUP_PASSPHRASE_FILE`"时才回填。**`--passphrase-file` 旗标不抑制
 *   回填**：它只参与选目标路径。
 *
 * 口令生成不依赖 openssl（复用 init/secrets.ts 的 `randomKey`），因此不会因缺
 * openssl 失败。
 */
export async function ensureBackupPassphrase(
  env: EnvValues,
  opts: EnsurePassphraseOptions = {},
): Promise<EnsurePassphraseResult> {
  const configured = env["NOJ_BACKUP_PASSPHRASE_FILE"] ?? "";
  const target = opts.targetFile ?? backupPassphrasePath({ configured });

  let stat: Deno.FileInfo | null = null;
  try {
    stat = await Deno.stat(target);
  } catch {
    stat = null;
  }

  if (stat !== null) {
    if (!stat.isFile) {
      return {
        path: target,
        created: false,
        passphrase: null,
        envUpdate: null,
        error: `GPG 备份口令路径不是普通文件：${target}`,
      };
    }
    const mode = await passphraseFileMode(target);
    if (!PASSPHRASE_ALLOWED_MODES.includes(mode)) {
      return {
        path: target,
        created: false,
        passphrase: null,
        envUpdate: null,
        error: `GPG 备份口令文件权限必须为 600 或 400：${target}`,
      };
    }
    return {
      path: target,
      created: false,
      passphrase: null,
      envUpdate: null,
      error: null,
    };
  }

  const passphrase = generateSecret();
  const parent = dirname(target);
  const tmp = `${target}.tmp.${Deno.pid}.${crypto.randomUUID()}`;
  try {
    if (parent !== "" && parent !== ".") {
      await Deno.mkdir(parent, { recursive: true, mode: 0o700 });
    }
    const file = await Deno.open(tmp, {
      create: true,
      write: true,
      truncate: true,
      mode: 0o600,
    });
    try {
      await file.write(new TextEncoder().encode(passphrase));
    } finally {
      file.close();
    }
    await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, target);
    await Deno.chmod(target, 0o600);
  } catch {
    try {
      await Deno.remove(tmp);
    } catch {
      // 清理失败不覆盖原始错误
    }
    return {
      path: target,
      created: false,
      passphrase: null,
      envUpdate: null,
      error:
        `无法创建 GPG 备份口令文件：${target}；请使用 --passphrase-file 指定可写路径`,
    };
  }

  return {
    path: target,
    created: true,
    passphrase,
    // 回填条件：.env.prod 里没有该键，且进程环境未给出该变量。
    // `--passphrase-file` 旗标不抑制回填。
    envUpdate: configured === "" && !opts.configuredFromEnv
      ? { NOJ_BACKUP_PASSPHRASE_FILE: target }
      : null,
    error: null,
  };
}
