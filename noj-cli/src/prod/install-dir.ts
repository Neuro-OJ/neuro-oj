/**
 * 生产安装目录的识别与定位。
 *
 * 特征文件 {@link PRODUCTION_MARKERS} 是唯一事实源：命令分发、Tier 3 容器命令与
 * `prod/lifecycle/steps.ts` 的安装完整性判定都消费它，不得另抄清单。
 */
import { dirname, join, resolve } from "@std/path";

/** 生产安装目录必备的特征文件（两者都在才算安装目录）。 */
export const PRODUCTION_MARKERS: readonly string[] = [
    "docker-compose.prod.yml",
    ".env.prod",
];

/** 安装目录定位失败：属于运行失败（退出码 1），且无需提示 `--debug` 查看栈。 */
export class ProductionDirError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProductionDirError";
    }
}

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
        throw new ProductionDirError(`不是完整的 NOJ 生产安装目录：${dir}`);
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
    throw new ProductionDirError(
        "未找到生产安装目录（需要同时含 " + PRODUCTION_MARKERS.join(" 与 ") +
            "），请用 --dir 指定；Tier 3 命令用 --install-dir",
    );
}
