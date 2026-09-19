import { dirname, join, resolve } from "@std/path";
import { PRODUCTION_MARKERS } from "./profile.ts";

/** 兼容现有 .env.prod 生产部署；JSON 部署继续使用 deploy/maintain 子命令。 */
export const PRODUCTION_COMMANDS = new Set([
  "install",
  "check",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "update",
  "upgrade",
  "backup",
  "verify",
  "config",
  "uninstall",
]);

/**
 * 某目录是否为完整生产安装目录。
 *
 * T12 carry-forward（T5）：**消费** `profile.ts` 导出的 {@link PRODUCTION_MARKERS}
 * 作为唯一事实源（此前是手抄的第二份清单）。只认安装目录必备、且不随 bash 删除
 * 而消失的文件（spec §3.3 洞 1）。
 */
async function isInstallDir(dir: string): Promise<boolean> {
  try {
    for (const marker of PRODUCTION_MARKERS) {
      if (!(await Deno.stat(join(dir, marker))).isFile) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 优先显式目录，然后当前目录及祖先，最后已安装二进制的位置。 */
export async function findProductionDir(
  explicit?: string,
  cwd = Deno.cwd(),
  executable = Deno.execPath(),
): Promise<string> {
  if (explicit !== undefined) {
    const dir = resolve(cwd, explicit);
    if (await isInstallDir(dir)) return dir;
    throw new Error(`不是完整的 NOJ 生产安装目录：${dir}`);
  }
  let dir = cwd;
  while (true) {
    if (await isInstallDir(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const installed = dirname(dirname(await Deno.realPath(executable)));
  if (await isInstallDir(installed)) return installed;
  throw new Error(
    "未找到生产安装目录，请用 --install-dir 指定 setup.sh 安装的目录" +
      "（Tier 3 命令）或 --dir（生产/编排命令）",
  );
}

/**
 * 仅消费 CLI 自身的 --dir，其他参数原样交给生产驱动，禁止 shell 字符串拼接。
 *
 * 复用 {@link parseDirArg} 以保证 4 处调用点的 `--dir`/`--dir=` 语义与
 * 缺值报错完全一致（#517 E6）。
 */
export class ProductionDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionDirError";
  }
}
