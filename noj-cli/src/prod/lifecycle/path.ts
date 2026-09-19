/**
 * PATH 注册助手（T13 拆分）：迁移 `register_command`（production.sh:97-131）。
 *
 * 从 `lifecycle.ts`（T13 时已达 1173 行）抽出的**内聚单元**：只服务 install 的
 * 第 9 步「注册 PATH」，与命令入口、结果形状无关，也不参与 compose 编排。
 * T15 uninstall 的软链清理反向逻辑预计复用本模块的判定。
 *
 * 本模块不持有任何模块级可变状态（AGENTS.md §8.2 多副本约束）：只有常量与纯函数。
 */

import { join } from "@std/path";

/** PATH 追加行（逐字对照 production.sh:90）。 */
export const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

/** PATH 注册结果。 */
export interface PathRegistration {
  /** 实际创建（或已存在且正确）的软链接路径；未注册时为 null。 */
  path: string | null;
  /** 用户可见的告警（未覆盖、无法注册、源码运行模式等）。 */
  warnings: string[];
}

/** `link_command` 的三态：ok=已就绪 / refuse=拒绝覆盖 / cannot=无法创建。 */
type LinkStatus = "ok" | "refuse" | "cannot";

/** 该路径是否为可执行普通文件（对应 bash `[[ -x ]]`）。 */
async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile && ((st.mode ?? 0) & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * 在 `binDir` 下建立 `noj-cli` → `target` 软链接（逐字对照 `link_command`）。
 *
 * - 已是软链接且指向同一目标 → `ok`（幂等）；指向他处 → `refuse`；
 * - 存在同名非软链接 → `refuse`（绝不覆盖）；
 * - `mkdir -p` 或 `ln -s` 失败 → `cannot`（调用方据此回落用户目录）。
 */
async function linkCommand(
  binDir: string,
  target: string,
): Promise<LinkStatus> {
  const link = join(binDir, "noj-cli");
  let st: Deno.FileInfo | null = null;
  try {
    st = await Deno.lstat(link);
  } catch {
    st = null;
  }
  if (st !== null && st.isSymlink) {
    const existing = await Deno.readLink(link).catch(() => "");
    return existing === target ? "ok" : "refuse";
  }
  if (st !== null) return "refuse";
  try {
    await Deno.mkdir(binDir, { recursive: true });
  } catch {
    return "cannot";
  }
  try {
    await Deno.symlink(target, link);
  } catch {
    return "cannot";
  }
  return "ok";
}

/**
 * 把 `~/.local/bin` 追加进 `~/.profile`（`add_user_path` :86-95）。
 *
 * `grep -Fqx` 等价：整行比较，已存在则不重复追加。返回是否成功。
 */
async function addUserPath(userHome: string): Promise<boolean> {
  if (userHome === "") return false;
  const profile = join(userHome, ".profile");
  let existing = "";
  try {
    existing = await Deno.readTextFile(profile);
  } catch {
    existing = "";
  }
  if (existing.split("\n").some((line) => line === PATH_LINE)) return true;
  try {
    await Deno.writeTextFile(
      profile,
      `\n# Neuro OJ command\n${PATH_LINE}\n`,
      { append: true, create: true },
    );
  } catch {
    return false;
  }
  return true;
}

/**
 * 迁移 `register_command`（production.sh:97-131）。
 *
 * 目标 `<dir>/bin/noj-cli` 不存在/不可执行时按「源码运行模式」告警并跳过
 * （不把 `deno` 自身误注册成命令）。优先全局目录，权限不足回落 `~/.local/bin`；
 * 两个目录都存在同名且指向他处的命令时**拒绝覆盖**并告警（不静默成功）。
 */
export async function registerCommand(
  opts: {
    cliBinary: string;
    binDir: string;
    userHome: string;
    warn: (message: string) => void;
  },
): Promise<PathRegistration> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    opts.warn(message);
  };

  if (!(await isExecutableFile(opts.cliBinary))) {
    warn("当前为源码运行模式，未注册 PATH；安装版 CLI 位于 " + opts.cliBinary);
    return { path: null, warnings };
  }

  const global = await linkCommand(opts.binDir, opts.cliBinary);
  if (global === "ok") {
    return { path: join(opts.binDir, "noj-cli"), warnings };
  }
  if (global === "refuse") {
    warn(`未覆盖已有命令：${join(opts.binDir, "noj-cli")}`);
    return { path: null, warnings };
  }

  if (opts.userHome !== "") {
    const userBin = join(opts.userHome, ".local/bin");
    const user = await linkCommand(userBin, opts.cliBinary);
    if (user === "ok") {
      const link = join(userBin, "noj-cli");
      if (await addUserPath(opts.userHome)) {
        return { path: link, warnings };
      }
      warn(`已创建用户命令：${link}，但无法自动更新 PATH，请手动将其加入 PATH`);
      return { path: link, warnings };
    }
    if (user === "refuse") {
      warn(`未覆盖已有命令：${join(userBin, "noj-cli")}`);
      return { path: null, warnings };
    }
  }

  warn(`无法注册 noj-cli 到 PATH；部署已完成，可直接运行 ${opts.cliBinary}`);
  return { path: null, warnings };
}
