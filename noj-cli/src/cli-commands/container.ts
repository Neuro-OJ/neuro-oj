// Tier 3 容器命令：按命令表路由、容器侧帮助与执行（含 noj-cli 自有旗标的剥离）。

import { CONTAINER_ROUTES } from "../commands.ts";
import { findProductionDir } from "../prod/install-dir.ts";
import { dispatchMaintain } from "../prod/maintain.ts";
import { CONTAINER_SERVICE, runInContainer } from "../prod/tier3.ts";
import { parseInstallDirArg, stripCliOwnedFlags } from "./args.ts";
import { renderCommandHelp } from "./help.ts";
import { EXIT_OK, wantsHelp } from "./guards.ts";

/** 解析结果。 */
export interface ContainerCommandMatch {
    matched: boolean;
    service: string;
    /** 透传给容器内 CLI 的完整参数（含 Tier 3 前缀）。 */
    args: string[];
    /** 是否以 `--no-deps` 执行（不创建/启动依赖服务）。 */
    noDeps: boolean;
}

/** 判断参数是否命中 Tier 3 命令（{@link CONTAINER_ROUTES} 已按最长前缀优先排序）。 */
export function parseContainerCommand(argv: string[]): ContainerCommandMatch {
    for (const { prefix, noDeps } of CONTAINER_ROUTES) {
        if (prefix.every((part, i) => argv[i] === part)) {
            return {
                matched: true,
                service: CONTAINER_SERVICE,
                args: [...argv],
                noDeps,
            };
        }
    }
    return {
        matched: false,
        service: CONTAINER_SERVICE,
        args: [],
        noDeps: false,
    };
}

/**
 * 执行 Tier 3 容器命令。
 *
 * 需要生产安装目录（含 `docker-compose.prod.yml` 与 `.env.prod`）。
 * `--dry-run` 只打印将执行的命令。退出码原样透传。
 */
export async function dispatchContainer(
    match: { service: string; args: string[]; noDeps?: boolean },
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
            `noj-cli ${
                match.args.filter((a) => a !== "--help" && a !== "-h").join(" ")
            } [选项]`,
            [
                "在 noj-server 容器内执行服务端管理命令（Tier 3）。",
                "",
                "说明:",
                `  等价于 docker compose … run --rm --entrypoint /app/bin/noj ${match.service} ${
                    match.args.filter((a) => a !== "--help" && a !== "-h").join(
                        " ",
                    )
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
    // 安装目录用 --install-dir，避免与容器命令自身的 --dir 冲突
    const dirOverride = parseInstallDirArg(tail);
    const dir = await findProductionDir(dirOverride, Deno.cwd());
    // CLI 自身的选项（--dir/--dry-run）不得进入容器命令，否则会被
    // 容器内的 noj 当作未知参数而报错。
    const cleaned = stripCliOwnedFlags(match.args);
    return await runInContainer({
        dir,
        service: match.service,
        command: cleaned,
        noDeps: match.noDeps,
        dryRun,
    });
}
