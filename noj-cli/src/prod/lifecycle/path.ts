/**
 * PATH 注册/注销助手（T13 拆分，T15 补反向逻辑）：迁移 `register_command`
 * （production.sh:97-131）与 `unregister_command`（:133-165）。
 *
 * 从 `lifecycle.ts`（T13 时已达 1173 行）抽出的**内聚单元**：注册服务 install 的
 * 第 9 步，注销服务 uninstall 的软链清理；两者与命令入口、结果形状无关，也不参与
 * compose 编排。正反两个方向共享同一套「软链指向何处」判定，故同住一个模块。
 *
 * 本模块不持有任何模块级可变状态（AGENTS.md §8.2 多副本约束）：只有常量与纯函数。
 */

import { dirname, join, resolve } from "@std/path";

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
 * 把运行中的二进制安装到 `<dir>/bin/noj-cli`（迁移 `install.sh:558-565` 的
 * `install_cli()`）。
 *
 * ## 为什么必须有这一步（评审发现的 R4 阻塞）
 *
 * R4 把首次安装改成"用户手动下载二进制，再跑 `install`"。但
 * `install.sh` 随 R4 删除时，它**唯一**负责"把二进制放到安装目录"的那一步
 * （`install_cli()`：`mkdir -p bin` → 暂存 → `chmod 755` → `mv -f`）
 * 没有接上，于是在三处同时出问题：
 *
 * 1. **PATH 注册静默跳过**：`registerCommand` 见目标不存在就按"源码运行模式"
 *    告警跳过（那是为 `deno run src/cli.ts` 设计的路径）——安装版用户拿到的是
 *    一条"未注册 PATH"的告警，却没有任何提示告诉他把二进制放哪里；
 * 2. **`uninstall --all` 永久自锁**：安装完整性判据要求 `bin/noj-cli` 存在，
 *    而它永远不会存在 → 任何真实安装目录都无法被完全卸载
 *    （正是 T15/T24 两次试图消除的同一类自锁，换了个缺失文件再次出现）；
 * 3. **定时备份必然失败**：T24 把 cron 入口重定向到 `<dir>/bin/noj-cli`，
 *    而那个文件不存在 → `backup schedule install` 报"备份脚本不存在或不可执行"。
 *
 * 三份文档都承诺了这个路径（`README.md`、`noj-cli/README.md`、
 * `production-deploy.md` 让用户执行 `/opt/neuro-oj/bin/noj-cli status`），
 * 所以修复方向明确：**把二进制放到文档所说的位置**。
 *
 * ## 实现细节（照 bash）
 *
 * - **暂存 + 原子 rename**：先写 `<dir>/bin/.noj-cli.XXXXXX` 再 `mv -f`，
 *   避免覆盖到一半时用户执行到一个半截二进制；
 * - `chmod 755` 在 rename **之前**，故目标文件一出现就是可执行的；
 * - **源码运行模式跳过**（`Deno.execPath()` 指向 `deno` 而非安装版）：那时
 *   复制 `deno` 自身进安装目录是错的——与 `registerCommand` 的既有判断一致。
 *
 * @returns 写入的绝对路径；源码运行模式下返回 null。
 */
export async function installCliBinary(opts: {
  /** 安装目录。 */
  dir: string;
  /** 运行中的可执行文件路径；缺省 `Deno.execPath()`。 */
  executable?: string;
}): Promise<string | null> {
  const executable = opts.executable ?? Deno.execPath();
  // 源码运行模式：`deno run src/cli.ts` 的 execPath 是 deno 本身。
  // 复制它进安装目录会得到一个"能跑 deno 但跑不了本 CLI"的文件。
  const base = executable.split(/[\\/]/).pop() ?? "";
  if (base === "deno" || base.startsWith("deno.")) return null;

  const binDir = join(opts.dir, "bin");
  await Deno.mkdir(binDir, { recursive: true });
  const target = join(binDir, "noj-cli");
  const staged = await Deno.makeTempFile({
    dir: binDir,
    prefix: ".noj-cli.",
  });
  try {
    await Deno.copyFile(executable, staged);
    await Deno.chmod(staged, 0o755);
    // 原子替换：同目录 rename，目标要么是旧的完整文件、要么是新的完整文件。
    await Deno.rename(staged, target);
  } catch (err) {
    await Deno.remove(staged).catch(() => {});
    throw err;
  }
  return target;
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

// ---------------- unregister_command（T15） ----------------
//
// production.sh:133-165 的反向逻辑：**只**移除解析后指向本安装目录
// `<dir>/bin/noj-cli` 或 `<dir>/noj` 的软链。三条语义逐条对照：
// 1. `[[ -L "$command_path" ]] || continue`：普通文件（或不存在）一律跳过，
//    绝不 `rm` 掉别的安装留下的真实命令；
// 2. `symlink_points_to_current_install`（:133-146）：绝对目标直接比较；相对目标
//    以软链所在目录为基准解析（bash 用 `cd -P "$(dirname ...)"`，本实现用
//    `resolve(dirname(link), target)`），因此同一目标写成相对路径也能命中；
// 3. 一个都没删时 `warn`（不是失败）——"没有可清理的软链"是正常终态。

/**
 * 该软链是否指向**本安装目录**（production.sh:133-146 的等价判定）。
 *
 * 目标为绝对路径时直接比较；为相对路径时以软链所在目录为基准解析——与 bash
 * `cd -P "$(dirname "$command_path")" && cd -P "$(dirname "$target")" && pwd`
 * 后再拼 `basename` 的结果一致（`resolve` 已规范化 `.` 与 `..`）。
 * 不是软链、目标是空串、或解析结果不属于本安装目录 → false。
 */
export async function symlinkPointsToInstall(
  commandPath: string,
  dir: string,
): Promise<boolean> {
  let st: Deno.FileInfo | null = null;
  try {
    st = await Deno.lstat(commandPath);
  } catch {
    st = null;
  }
  if (st === null || !st.isSymlink) return false;
  const target = await Deno.readLink(commandPath).catch(() => "");
  if (target === "") return false;
  const resolved = target.startsWith("/")
    ? target
    : resolve(dirname(commandPath), target);
  const expected = [join(dir, "bin/noj-cli"), join(dir, "noj")];
  return expected.includes(resolved);
}

/**
 * 迁移 `unregister_command`（production.sh:148-165）：移除指向本安装目录的 PATH 软链。
 *
 * 候选路径的**顺序与重复**都照抄 bash：`NOJ_BIN_DIR`（若设置）下的 `noj-cli`/`noj`、
 * 再 `/usr/local/bin` 的两个、最后 `$HOME/.local/bin` 的两个。`NOJ_BIN_DIR` 等于
 * `/usr/local/bin` 时同一路径出现两次属 bash 既有行为——第二次已不是软链，自然跳过。
 *
 * **失败即抛错**（bash `rm -f ... || fail`）：不做"尽力而为"，删除失败必须让调用方
 * 转成退出码 1；返回的是**确实已移除**的路径列表。一个都没移除时调用方按 bash 的
 * `warn` 处理（本函数返回空数组，不写输出）。
 */
export async function unregisterCommand(opts: {
  dir: string;
  binDir?: string;
  userHome?: string;
  remove?: (path: string) => Promise<void>;
}): Promise<string[]> {
  const candidates: string[] = [];
  if (opts.binDir !== undefined && opts.binDir !== "") {
    candidates.push(join(opts.binDir, "noj-cli"), join(opts.binDir, "noj"));
  }
  candidates.push("/usr/local/bin/noj-cli", "/usr/local/bin/noj");
  if (opts.userHome !== undefined && opts.userHome !== "") {
    candidates.push(
      join(opts.userHome, ".local/bin/noj-cli"),
      join(opts.userHome, ".local/bin/noj"),
    );
  }

  const remove = opts.remove ?? ((path: string) => Deno.remove(path));
  const removed: string[] = [];
  for (const commandPath of candidates) {
    if (!(await symlinkPointsToInstall(commandPath, opts.dir))) continue;
    try {
      await remove(commandPath);
    } catch {
      throw new Error("无法移除 PATH 命令软链接：" + commandPath);
    }
    removed.push(commandPath);
  }
  return removed;
}
