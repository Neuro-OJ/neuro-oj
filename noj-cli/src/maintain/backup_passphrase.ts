/**
 * 备份口令策略（#515 P4）。
 *
 * 早先两套备份模式的口令体验断裂：生产模式在 install/upgrade 时
 * **自动生成** `/etc/noj/backup-passphrase`（deploy.sh），而 JSON 模式
 * 只会在缺口令时报错。安全策略不应取决于用哪套模式。
 *
 * 本模块统一为：**首次需要时自动生成，已存在则复用，权限过宽则拒绝**。
 *
 * 权限校验沿用生产脚本 check_secret_file 的既有规则（600 或 400）。
 */

/** 默认口令文件路径（与 scripts/deploy/deploy.sh 的约定一致）。 */
export const DEFAULT_PASSPHRASE_PATH = "/etc/noj/backup-passphrase";

/** 口令文件权限不符合要求。 */
export class PassphraseModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassphraseModeError";
  }
}

/**
 * 校验口令文件权限字符串（八进制）。
 *
 * 只接受 `600` 与 `400`：口令是解密备份的唯一凭据，
 * 组/其他用户可读即等于备份可被任何人解密。
 *
 * @throws {PassphraseModeError} 权限过宽，错误信息含实际值与 chmod 修复建议
 */
export function assertPassphraseFileMode(mode: string): void {
  if (mode === "600" || mode === "400") return;
  throw new PassphraseModeError(
    `口令文件权限必须为 600 或 400，当前为 ${mode}。` +
      `请执行: chmod 600 <口令文件>`,
  );
}

/** 解析/创建选项。 */
export interface ResolvePassphraseOptions {
  /** 口令文件路径（默认 {@link DEFAULT_PASSPHRASE_PATH}）。 */
  path?: string;
  /** 文件不存在时是否自动生成（默认 false，由调用方按场景决定）。 */
  generate?: boolean;
  /** 随机源注入（测试用）；默认 32 字节 hex。 */
  randomHex?: () => string;
}

/** 解析结果。 */
export interface PassphraseResolution {
  path: string;
  /** 本次是否**新建**了文件（false = 复用已有）。 */
  created: boolean;
}

/** 默认随机源：32 字节 → 64 位 hex（与 deploy.sh 的 openssl rand -hex 32 等价）。 */
function defaultRandomHex(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 读取文件权限（八进制字符串，如 "600"）。 */
async function fileMode(path: string): Promise<string> {
  const stat = await Deno.stat(path);
  return ((stat.mode ?? 0) & 0o777).toString(8);
}

/**
 * 解析口令文件：存在则校验权限并复用，不存在则在允许时生成。
 *
 * 语义（与 issue 的验收一致）：
 * - 已存在 → **校验权限**（非 600/400 直接拒绝，不降级）；
 * - 不存在且 `generate: true` → 生成 32 字节随机口令，权限 600；
 * - 不存在且 `generate: false` → 报错（调用方给出如何配置的提示）。
 *
 * @throws {PassphraseModeError} 权限过宽
 * @throws {Error} 文件缺失且未允许生成
 */
export async function resolveOrCreatePassphrase(
  opts: ResolvePassphraseOptions = {},
): Promise<PassphraseResolution> {
  const path = opts.path ?? DEFAULT_PASSPHRASE_PATH;
  const randomHex = opts.randomHex ?? defaultRandomHex;

  let exists = false;
  try {
    await Deno.stat(path);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    // 已存在：权限必须在覆盖/使用前校验，避免"用了一个人人可读的口令"
    assertPassphraseFileMode(await fileMode(path));
    return { path, created: false };
  }

  if (!opts.generate) {
    throw new Error(
      `口令文件不存在：${path}。` +
        "请先用 --passphrase-file 指定已有文件，或允许自动生成。",
    );
  }

  // 首次生成：父目录 700，文件 600（先以 600 创建再写入，避免竞态窗口）
  const parent = path.slice(0, path.lastIndexOf("/")) || ".";
  await Deno.mkdir(parent, { recursive: true, mode: 0o700 });
  const file = await Deno.open(path, {
    createNew: true,
    write: true,
    mode: 0o600,
  });
  try {
    await file.write(new TextEncoder().encode(randomHex() + "\n"));
  } finally {
    file.close();
  }
  await Deno.chmod(path, 0o600);
  return { path, created: true };
}
