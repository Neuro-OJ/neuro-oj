// Tier 3 容器命令的执行与容器侧帮助（含 noj-cli 自有旗标的剥离）。

import { findProductionDir } from "../production.ts";
import { parseInstallDirArg, stripCliOwnedFlags } from "./args.ts";
import { renderCommandHelp } from "../help.ts";
import { dispatchMaintain } from "../prod/maintain.ts";
import { runInContainer } from "../container_run.ts";
import { EXIT_OK, wantsHelp } from "./guards.ts";

/**
 * 执行 Tier 3 容器命令。
 *
 * 需要生产安装目录（含 `docker-compose.prod.yml` 与 `.env.prod`）。
 * `--dry-run` 只打印将执行的命令。退出码原样透传。
 */
export async function dispatchContainer(
  match: { service: string; args: string[] },
  tail: string[],
): Promise<number> {
  // maintain 有独立参数契约与帮助（prod/maintain.ts），固定 --no-deps 执行。
  if (match.args[0] === "maintain") {
    return await dispatchMaintain(match, {
      findProductionDir: (dir) => findProductionDir(dir, Deno.cwd()),
      parseInstallDir: parseInstallDirArg,
      stripCliFlags: stripCliOwnedFlags,
    });
  }
  if (wantsHelp(tail)) {
    console.log(renderCommandHelp(
      `noj-cli ${match.args.join(" ")} [选项]`,
      [
        "在 noj-server 容器内执行服务端管理命令（Tier 3）。",
        "",
        "说明:",
        `  等价于 docker compose … run --rm --entrypoint /app/bin/noj ${match.service} ${
          match.args.join(" ")
        }`,
        "  交互式输入（如隐藏密码）会透传到容器。",
        "",
        "选项:",
        "  --install-dir <path>   生产安装目录（CLI 自身选项）",
        "  --dry-run              仅打印将执行的 compose 命令",
        "",
        "注：--dir 属于容器内命令自身的选项（如 problems import --dir），",
        "    会原样透传；指定生产安装目录请用 --install-dir。",
      ],
    ));
    return EXIT_OK;
  }

  const dryRun = tail.includes("--dry-run");
  // 评审 M1：安装目录用 --install-dir，避免与容器命令自身的 --dir 冲突
  const dirOverride = parseInstallDirArg(tail);
  const dir = await findProductionDir(dirOverride, Deno.cwd());
  // CLI 自身的选项（--dir/--dry-run）不得进入容器命令，否则会被
  // 容器内的 noj 当作未知参数而报错。
  const cleaned = stripCliOwnedFlags(match.args);
  return await runInContainer({
    dir,
    service: match.service,
    command: cleaned,
    dryRun,
  });
}
