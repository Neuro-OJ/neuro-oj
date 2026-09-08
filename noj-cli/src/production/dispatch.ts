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

export async function dispatchProdAlias(
  command: string,
  args: string[],
  ctx: ProdDispatchContext,
): Promise<number> {
  const runner = ctx.runner ?? realRunner();
  const context = resolveContext({ cwd: ctx.cwd });
  const dir = context.kind === "production" && context.dir !== null
    ? context.dir
    : undefined;
  if (!dir) {
    console.error(`noj-cli ${command}: 未找到生产安装目录`);
    return 1;
  }
  const envFile = optionValue(args, "--env-file") ?? `${dir}/.env.prod`;
  const composeFile = optionValue(args, "--compose-file") ??
    `${dir}/docker-compose.prod.yml`;
  const dryRun = hasFlag(args, "--dry-run");
  const base = { envFile, composeFile, dryRun };
  const backupDir = optionValue(args, "--backup-dir") ?? `${dir}/backups`;
  const passphraseFile = optionValue(args, "--passphrase-file") ??
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
        { ...base, follow: hasFlag(args, "--follow") },
        runner,
      );
    case "install-env":
      return await prodInstallEnv({ ...base, dir }, runner);
    case "install":
      return await prodInstall(
        {
          ...base,
          dir,
          nonInteractive: hasFlag(args, "--non-interactive"),
          downloadOnly: hasFlag(args, "--download-only"),
        },
        runner,
      );
    case "update":
    case "upgrade":
      return await prodUpdate(
        {
          ...base,
          dir,
          version: optionValue(args, "--version"),
          latest: hasFlag(args, "--latest"),
        },
        runner,
      );
    case "uninstall":
      return await prodUninstall(
        {
          ...base,
          dir,
          yes: hasFlag(args, "--yes") || hasFlag(args, "-y"),
          uninstallAll: hasFlag(args, "--all"),
        },
        runner,
      );
    case "verify":
      return await prodConfigCheck({ envFile, composeFile, dryRun }, runner);
    case "config": {
      const sub = args[0] ?? "";
      if (sub === "check") {
        return await prodConfigCheck({ envFile, composeFile, dryRun }, runner);
      }
      if (sub === "show") {
        console.log(prodConfigShow({ envFile, composeFile, dryRun }));
        return 0;
      }
      if (sub === "set") {
        const key = args[1];
        const value = args[2];
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
      const sub = args[0] ?? "";
      const opts = {
        envFile,
        composeFile,
        backupDir,
        passphraseFile,
        snapshot: args[1],
        confirm: hasFlag(args, "--confirm"),
        report: optionValue(args, "--report"),
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
