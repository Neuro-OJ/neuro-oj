/** 旧生产命令别名到统一 production 模块的分发。 */

import { resolveContext } from "../context/context.ts";
import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import {
  prodLogs,
  prodRestart,
  prodStart,
  prodStatus,
  prodStop,
} from "./lifecycle.ts";
import {
  prodInstall,
  prodInstallEnv,
  prodUninstall,
  prodUpdate,
} from "./install.ts";
import {
  prodBackupCreate,
  prodBackupDrill,
  prodBackupRestore,
  prodBackupVerify,
} from "./backup.ts";
import { prodConfigCheck, prodConfigSet, prodConfigShow } from "./config.ts";

export interface ProdDispatchContext {
  cwd: string;
  runner?: CommandRunner;
}

function optionValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** 提取并移除全局 `--dir <path>`，避免其被当作子命令参数透传。 */
function extractDirArg(args: string[]): { dir?: string; rest: string[] } {
  const idx = args.indexOf("--dir");
  if (idx === -1) return { rest: args };
  const value = args[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--dir 缺少目录参数");
  }
  return { dir: value, rest: [...args.slice(0, idx), ...args.slice(idx + 2)] };
}

export async function dispatchProdAlias(
  command: string,
  args: string[],
  ctx: ProdDispatchContext,
): Promise<number> {
  const runner = ctx.runner ?? realRunner();
  const { dir: explicitDir, rest: restArgs } = extractDirArg(args);
  const context = resolveContext({ cwd: ctx.cwd, dir: explicitDir });
  const dir = context.kind === "production" && context.dir !== null
    ? context.dir
    : undefined;
  if (!dir) {
    console.error(`noj-cli ${command}: 未找到生产安装目录`);
    return 1;
  }
  const envFile = optionValue(restArgs, "--env-file") ?? `${dir}/.env.prod`;
  const composeFile = optionValue(restArgs, "--compose-file") ??
    `${dir}/docker-compose.prod.yml`;
  const dryRun = hasFlag(restArgs, "--dry-run");
  const base = { envFile, composeFile, dryRun };
  const backupDir = optionValue(restArgs, "--backup-dir") ?? `${dir}/backups`;
  const passphraseFile = optionValue(restArgs, "--passphrase-file") ??
    Deno.env.get("NOJ_BACKUP_PASSPHRASE_FILE") ?? "";

  switch (command) {
    case "start":
      return await prodStart(base, runner);
    case "stop":
      return await prodStop(base, runner);
    case "restart":
      return await prodRestart(base, runner);
    case "status":
      return await prodStatus(base, runner);
    case "logs":
      return await prodLogs(
        { ...base, follow: hasFlag(restArgs, "--follow") },
        runner,
      );
    case "install-env":
      return await prodInstallEnv({ ...base, dir }, runner);
    case "install":
      return await prodInstall(
        {
          ...base,
          dir,
          nonInteractive: hasFlag(restArgs, "--non-interactive"),
          downloadOnly: hasFlag(restArgs, "--download-only"),
        },
        runner,
      );
    case "update":
    case "upgrade":
      return await prodUpdate(
        {
          ...base,
          dir,
          version: optionValue(restArgs, "--version"),
          latest: hasFlag(restArgs, "--latest"),
        },
        runner,
      );
    case "uninstall":
      return await prodUninstall(
        {
          ...base,
          dir,
          yes: hasFlag(restArgs, "--yes") || hasFlag(restArgs, "-y"),
          uninstallAll: hasFlag(restArgs, "--all"),
        },
        runner,
      );
    case "verify":
      return await prodConfigCheck({ envFile, composeFile, dryRun }, runner);
    case "config": {
      const sub = restArgs[0] ?? "";
      if (sub === "check") {
        return await prodConfigCheck({ envFile, composeFile, dryRun }, runner);
      }
      if (sub === "show") {
        console.log(prodConfigShow({ envFile, composeFile, dryRun }));
        return 0;
      }
      if (sub === "set") {
        const key = restArgs[1];
        const value = restArgs[2];
        if (!key || !value) {
          console.error("config set: 需要 <key> <value>");
          return 1;
        }
        return await prodConfigSet(
          { envFile, composeFile, dryRun },
          key,
          value,
          runner,
        );
      }
      console.error("config: 需要子命令 check/show/set");
      return 1;
    }
    case "backup": {
      const sub = restArgs[0] ?? "";
      const opts = {
        envFile,
        composeFile,
        backupDir,
        passphraseFile,
        snapshot: restArgs[1],
        confirm: hasFlag(restArgs, "--confirm"),
        report: optionValue(restArgs, "--report"),
      };
      if (sub === "create" || sub === "") {
        const snapshot = await prodBackupCreate(opts, runner);
        console.log(`备份完成: ${snapshot}`);
        return 0;
      }
      if (sub === "verify") {
        if (!opts.snapshot) {
          console.error("backup verify: 需要 <snapshot>");
          return 1;
        }
        return await prodBackupVerify(opts, runner);
      }
      if (sub === "restore") {
        if (!opts.snapshot) {
          console.error("backup restore: 需要 <snapshot>");
          return 1;
        }
        return await prodBackupRestore(opts, runner);
      }
      if (sub === "drill") {
        if (!opts.snapshot) {
          console.error("backup drill: 需要 <snapshot>");
          return 1;
        }
        return await prodBackupDrill(opts, runner);
      }
      console.error("backup: 需要子命令 create/verify/restore/drill");
      return 1;
    }
    default:
      console.error(`未知生产命令: ${command}`);
      return 1;
  }
}
