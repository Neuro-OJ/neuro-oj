import { dirname, join, resolve } from "@std/path";

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

async function isInstallDir(dir: string): Promise<boolean> {
  try {
    return (await Deno.stat(join(dir, "scripts/deploy/production.sh")))
      .isFile &&
      (await Deno.stat(join(dir, "docker-compose.prod.yml"))).isFile;
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
  throw new Error("未找到生产安装目录，请使用 --dir 指定 setup.sh 安装的目录");
}

/** 仅消费 CLI 自身的 --dir，其他参数原样交给生产驱动，禁止 shell 字符串拼接。 */
export function parseProductionArgs(args: string[]): {
  dir?: string;
  forwarded: string[];
} {
  let dir: string | undefined;
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dir" || arg.startsWith("--dir=")) {
      const value = arg === "--dir" ? args[++i] : arg.slice(6);
      if (!value || value.startsWith("--")) {
        throw new Error("--dir 需要一个安装目录");
      }
      dir = value;
    } else {
      forwarded.push(arg);
    }
  }
  return { dir, forwarded };
}

/** 继承终端以保留敏感输入、确认提示和连续日志，原样返回底层退出码。 */
export async function runProduction(
  command: string,
  args: string[],
): Promise<number> {
  try {
    const parsed = parseProductionArgs(args);
    const dir = await findProductionDir(parsed.dir);
    const child = new Deno.Command("bash", {
      args: [
        join(dir, "scripts/deploy/production.sh"),
        command,
        ...parsed.forwarded,
      ],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    return (await child.status).code;
  } catch (error) {
    console.error(`noj-cli ${command}: ${(error as Error).message}`);
    return 1;
  }
}
