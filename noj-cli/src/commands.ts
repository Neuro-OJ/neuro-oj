/**
 * noj-cli 命令树的**单一事实源**（Task 7）。
 *
 * 背景：命令清单此前同时维护在 `help.ts` 的分区常量与 `cli.ts` 的多处手写
 * 文案里，已实测漂移——`noj-cli backup --help` 漏列 `list`/`prune`（真实能力），
 * 根因正是同一份清单有 4 个副本。本模块把**顶层命令及其子命令**收敛为唯一
 * 声明（以 `cli.ts` 的分发代码为准，而非以旧 help 文案为准），
 * `cli.ts` 的 `printHelp()` 改为渲染本模块。
 *
 * 防漂移门禁见 `commands_test.ts`：它把本模块声明的顶层命令与
 * `cli.ts:dispatchableTopLevelNames()`（从 dispatcher 自身逻辑提取）比对，
 * 而非与第二份手写清单比对。
 */

/** 命令所属分区；决定顶层 help 的展示分组。 */
export type Tier = "prod" | "problem" | "tier3" | "global";

/** 单条命令声明（可递归嵌套子命令）。 */
export interface CommandSpec {
  /** 命令名（顶层为裸名；子命令为相对父级的名，如 `list`）。 */
  name: string;
  /** 一句话说明。 */
  summary: string;
  /** 别名（可接受的等价名，用于 help 标注）。 */
  aliases?: string[];
  /**
   * 所属分区。
   *
   * 子命令沿用父级分区：分区只用于顶层 help 的分组渲染，
   * 子命令随父级出现在同一分区。
   */
  tier: Tier;
  /** 子命令（可多级）。 */
  subcommands?: CommandSpec[];
}

/** 命令表每行的缩进宽度（缩进计入 `maxWidth` 预算）。 */
const TABLE_INDENT = 2;

/**
 * 按显示宽度折行（CJK 全角按 2 列计）。
 *
 * 与 {@link renderTable} 分开是因为职责不同：表格管**列对齐**，本函数管
 * **散文换行**（抬头、用法、分区标题/说明、退出码）。两者共用
 * {@link displayWidth} 这一个宽度口径，故窄终端下不会出现"表格收窄了、
 * 抬头却仍然溢出"的半吊子状态。
 *
 * `maxWidth` 未给定时原样返回（保持既有输出契约）。
 */
function wrap(text: string, indent = "", maxWidth?: number): string[] {
  if (maxWidth === undefined) return [indent + text];
  const budget = Math.max(8, maxWidth - displayWidth(indent));
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (displayWidth(cur + ch) > budget && cur !== "") {
      out.push(indent + cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  out.push(indent + cur);
  return out;
}

/** 分区展示顺序即顶层 help 的顺序。 */
const TIER_ORDER: readonly Tier[] = [
  "prod",
  "problem",
  "tier3",
  "global",
];

/** 各分区的标题与适用说明。 */
const SECTIONS: Record<Tier, { title: string; note?: string }> = {
  prod: {
    title:
      "生产模式（.env.prod + docker-compose.prod.yml；宿主机运维，无需 Deno）",
    note: "以下命令支持 --dir <安装目录>；在安装目录内可省略。",
  },
  problem: {
    title: "题目包管理（离线；无需部署环境）",
  },
  tier3: {
    title: "服务端管理（Tier 3；在 noj-server 容器内执行生产安装的 CLI）",
    note: "以下命令支持 --install-dir <安装目录> 与 --dry-run。",
  },
  global: {
    title: "全局命令与选项（所有模式可用）",
  },
};

/** 退出码语义（#517 E9）。 */
export const EXIT_CODES: ReadonlyArray<{ code: number; meaning: string }> = [
  { code: 0, meaning: "成功" },
  { code: 1, meaning: "运行失败（命令已执行但未成功）" },
  { code: 2, meaning: "用法错误（参数非法、缺少必需参数、未知命令）" },
];

/**
 * 顶层命令与子命令声明。
 *
 * 逐条核对自 `cli.ts` 的实际分发：`PRODUCTION_COMMANDS`、
 * `dispatchCommand` 的 `switch (command)` 分支、`problem`/`problems`/
 * `stack` 特判，以及 `container.ts` 的 Tier 3 前缀路由。
 */
import { displayWidth, renderTable } from "./output/render.ts";

export const COMMANDS: readonly CommandSpec[] = [
  // ── 生产模式（PRODUCTION_COMMANDS）──
  {
    name: "install",
    tier: "prod",
    summary: "生产安装（写入 .env.prod 并启动 Docker Compose 栈）",
  },
  {
    name: "check",
    tier: "prod",
    summary: "生产环境检测（Linux/Docker/Compose/磁盘/端口）",
  },
  { name: "start", tier: "prod", summary: "启动生产服务" },
  { name: "stop", tier: "prod", summary: "停止生产服务" },
  { name: "restart", tier: "prod", summary: "重启生产服务" },
  { name: "status", tier: "prod", summary: "查看生产服务状态" },
  {
    name: "logs",
    tier: "prod",
    summary: "查看生产服务日志（支持 --follow）",
  },
  {
    name: "update",
    tier: "prod",
    aliases: ["upgrade"],
    summary: "同步部署文件、备份并升级生产服务",
  },
  {
    name: "backup",
    tier: "prod",
    summary: "生产备份；子命令如下（list/prune 支持 --json）",
    subcommands: [
      { name: "create", tier: "prod", summary: "创建完整生产备份快照" },
      { name: "verify", tier: "prod", summary: "校验快照完整性（<snapshot>）" },
      {
        name: "restore",
        tier: "prod",
        summary: "恢复到已停止的 Compose 环境（需 --confirm）",
      },
      {
        name: "drill",
        tier: "prod",
        summary: "隔离环境真实恢复演练（分钟级、需 Docker）",
      },
      { name: "list", tier: "prod", summary: "列出备份（支持 --json）" },
      {
        name: "prune",
        tier: "prod",
        summary: "清理过期备份（默认 dry-run，--confirm 才真正删除）",
      },
      {
        name: "schedule",
        tier: "prod",
        summary: "安装/查看/删除定期备份 cron 任务",
      },
    ],
  },
  {
    // T26：独立 Judge Worker 部署入口（对应已删除的 judge-install.sh）。
    // 子命令与 bash `judge-install.sh usage()` 逐项对应。
    name: "judge",
    tier: "prod",
    summary: "独立 Judge Worker 部署（需专用 rootless Docker socket）",
    subcommands: [
      {
        name: "install-env",
        tier: "prod",
        summary: "检查依赖并输出 rootless 准备指引",
      },
      { name: "install", tier: "prod", summary: "首次配置并启动独立 Judge" },
      {
        name: "check",
        tier: "prod",
        summary: "检查配置 / Redis / 专用 socket / 镜像架构",
      },
      { name: "start", tier: "prod", summary: "启动 Judge（保留现有容器）" },
      {
        name: "stop",
        tier: "prod",
        summary: "停止 Judge（保留配置与 Redis 任务）",
      },
      { name: "status", tier: "prod", summary: "查看状态与脱敏配置摘要" },
      { name: "logs", tier: "prod", summary: "查看日志（--follow 实时跟随）" },
      { name: "upgrade", tier: "prod", summary: "升级 Judge 镜像" },
    ],
  },
  {
    name: "verify",
    tier: "prod",
    summary: "生产配置与镜像签名校验（比 config 多验签名）",
  },
  {
    name: "config",
    tier: "prod",
    summary: "生产配置校验（原 config check；不验镜像签名）",
  },
  {
    name: "uninstall",
    tier: "prod",
    summary: "卸载生产服务；--all 删除全部数据，需确认",
  },

  // ── 题目包管理（离线）──
  {
    name: "problem",
    tier: "problem",
    aliases: ["problems"],
    summary: "题目包管理（离线 init/lint/pack；build/import 经 Tier 3 容器）",
    subcommands: [
      {
        name: "init",
        tier: "problem",
        summary: "生成题目骨架（TTY 下为交互式引导）",
      },
      {
        name: "lint",
        tier: "problem",
        summary: "校验题目包（MUST/SHOULD 两级）",
      },
      { name: "pack", tier: "problem", summary: "打包为可导入的题目包 ZIP" },
      {
        name: "build",
        tier: "problem",
        summary: "构建题目包（Tier 3，需生产安装目录）",
      },
      {
        name: "import",
        tier: "problem",
        summary: "导入题目包（Tier 3，需生产安装目录）",
      },
    ],
  },

  // ── Tier 3 服务端管理（container.ts 前缀路由）──
  {
    name: "db",
    tier: "tier3",
    summary: "数据库维护",
    subcommands: [
      { name: "migrate", tier: "tier3", summary: "执行数据库迁移" },
    ],
  },
  {
    name: "init",
    tier: "tier3",
    summary: "初始化系统",
    subcommands: [
      { name: "system", tier: "tier3", summary: "初始化系统基础数据" },
    ],
  },
  {
    name: "bootstrap",
    tier: "tier3",
    summary: "引导初始化",
    subcommands: [
      { name: "first-admin", tier: "tier3", summary: "创建首个管理员" },
    ],
  },
  {
    name: "search",
    tier: "tier3",
    summary: "搜索索引维护",
    subcommands: [
      { name: "reindex", tier: "tier3", summary: "全量重建搜索索引" },
    ],
  },

  // ── 全局命令与选项 ──
  // `version` 是可分发命令（`dispatchCommand` 的 `case "version"`），且与部署
  // 模式无关；它与 `--version`/`-v` 等价，故与全局选项同区展示。
  {
    name: "version",
    tier: "global",
    aliases: ["--version", "-v"],
    summary: "显示版本",
  },
  // 以下三项由 run() 前置处理，不是可分发命令（declaredTopLevelNames 已排除）
  {
    name: "--help",
    tier: "global",
    aliases: ["-h"],
    summary: "显示帮助（只读，不产生任何副作用）",
  },
  {
    name: "--version",
    tier: "global",
    aliases: ["-v"],
    summary: "显示版本（等价于 version 命令）",
  },
  {
    name: "--debug",
    tier: "global",
    summary: "错误时打印完整栈帧（排查用；亦可设 NOJ_CLI_DEBUG=1）",
  },
  {
    // T23 收敛为单模态后只剩 `prod`。**这里必须与实现同步**：旧的
    // `<prod|stack>` 会让用户照 help 传 `--profile stack`，然后被拒绝——
    // help 承诺一个实现不接受的取值，是最容易误导人的一类漂移。
    name: "--profile <prod>",
    tier: "global",
    summary: "显式确认部署模式（仅 prod）；缺省按目录特征自动探测",
  },
];

/**
 * 顶层命令名集合（不含别名，也不含 `-` 开头的全局选项）。
 *
 * 这是防漂移门禁的左侧：`commands_test.ts` 断言它 ⊆
 * `cli.ts:dispatchableTopLevelNames()`（从 dispatcher 自身逻辑提取），
 * 因此新增 help 命令却未实现、或删除实现却未清理 help，都会立刻变红。
 */
export function declaredTopLevelNames(): Set<string> {
  const names = new Set<string>();
  for (const cmd of COMMANDS) {
    if (cmd.name.startsWith("-")) continue;
    names.add(cmd.name);
  }
  return names;
}

/**
 * 按名查找命令：先匹配顶层，再递归匹配任意层级的子命令；均支持别名。
 *
 * 找不到返回 `undefined`（调用方负责报错），不抛异常。
 */
export function findCommand(name: string): CommandSpec | undefined {
  const matches = (cmd: CommandSpec) =>
    cmd.name === name || (cmd.aliases?.includes(name) ?? false);
  for (const cmd of COMMANDS) {
    if (matches(cmd)) return cmd;
  }
  const walk = (cmd: CommandSpec): CommandSpec | undefined => {
    for (const sub of cmd.subcommands ?? []) {
      if (matches(sub)) return sub;
      const deeper = walk(sub);
      if (deeper !== undefined) return deeper;
    }
    return undefined;
  };
  for (const cmd of COMMANDS) {
    const found = walk(cmd);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** 渲染一行所需的扁平条目。 */
interface RenderRow {
  label: string;
  summary: string;
  aliasSuffix: string;
}

/** 把一条命令（含其后代）摊平为若干渲染行，子命令标签带父级前缀。 */
function flatten(cmd: CommandSpec, prefix = ""): RenderRow[] {
  const label = prefix === "" ? cmd.name : `${prefix} ${cmd.name}`;
  const aliasSuffix = cmd.aliases?.length
    ? `（别名 ${cmd.aliases.join("/")}）`
    : "";
  const rows: RenderRow[] = [{ label, summary: cmd.summary, aliasSuffix }];
  for (const sub of cmd.subcommands ?? []) {
    rows.push(...flatten(sub, label));
  }
  return rows;
}

/**
 * 渲染完整的顶层帮助文本。
 *
 * 输出按 {@link Tier} 分区；每个分区内，顶层命令与其子命令逐行展开，
 * 使 `backup list` 这类真实能力可直接从顶层 help 发现（本任务修复的漂移）。
 *
 * ## 窄终端（T26）
 *
 * 传入 `maxWidth`（通常为 `COLUMNS`）时，每个分区的命令表经
 * {@link renderTable} 的宽度约束渲染：先均摊收缩最宽列、超宽以 `…` 截断、
 * 极窄时整行兜底截断。
 *
 * **此前这里手写 `padEnd` 对齐**，导致 `renderTable` 已有的宽度感知能力
 * （及其测试）在 help 这条唯一的表格路径上被绕过——`COLUMNS=40` 下实测有 26 行
 * 溢出。改为复用同一渲染器后，help 与表格走同一条代码路径，
 * 宽度行为也就只有一处需要正确。
 *
 * `maxWidth` 缺省时不限制（保持既有行为，便于调用方与测试不加参数直接比较全文）。
 */
export function renderCommandList(opts: { maxWidth?: number } = {}): string {
  const lines: string[] = [];
  // 抬头与用法行同样受宽度约束（此处**是** `renderCommandList` 的正文，
  // 不是外部传入的标题；`maxWidth=30` 时这两行实测 37/36 列）。
  const pushProse = (text: string, indent = ""): void => {
    lines.push(...wrap(text, indent, opts.maxWidth));
  };
  pushProse("noj-cli - Neuro OJ 统一部署与运维 CLI");
  lines.push("");
  pushProse("用法: noj-cli <命令> [子命令] [选项]");

  for (const tier of TIER_ORDER) {
    const section = SECTIONS[tier];
    lines.push("", ...wrap(section.title, "", opts.maxWidth));
    if (section.note) lines.push(...wrap(section.note, "  ", opts.maxWidth));

    const rows: RenderRow[] = [];
    for (const cmd of COMMANDS) {
      if (cmd.tier !== tier) continue;
      rows.push(...flatten(cmd));
    }
    if (rows.length === 0) continue;
    // 复用 renderTable：CJK 按 2 列计宽，且在 maxWidth 下收缩/截断。
    // 末行以恰好一个换行结尾，故裁掉后按行推入。
    // **缩进要在预算里扣掉**：本行随后会加 2 空格缩进，
    // 若把整个 maxWidth 交给 renderTable，加缩进后每行都会超宽 2 列
    // （实测：`maxWidth=30` 时全部命令行都溢出）。
    // **必须捕获 `renderTable` 的写出**：它除返回文本外还会经 `emitHuman`
    // 直接写 stdout（设计如此，供表格类命令使用）。在 help 里那会导致
    // **双份输出**——一份是它自己写的（未去尾空格），一份是下面拼进
    // `lines` 再由调用方打印的。传入一个捕获 sink 即可让它只返回不写出。
    const captured: string[] = [];
    const table = renderTable(
      rows.map((r) => [r.label, r.summary + r.aliasSuffix]),
      {
        ...(opts.maxWidth === undefined
          ? {}
          : { maxWidth: Math.max(1, opts.maxWidth - TABLE_INDENT) }),
        io: { stdout: (text: string) => captured.push(text) },
      },
    ).replace(/\n$/, "");
    // 去掉行尾填充空格：`renderTable` 会补齐到列宽（便于逐行比较总宽），
    // 但 help 是给人读的，行尾空白只会让复制粘贴带上尾随空格。
    for (const line of table.split("\n")) {
      lines.push(`  ${line.replace(/ +$/, "")}`);
    }
    void tier;
  }

  lines.push("", ...wrap("退出码", "", opts.maxWidth));
  for (const { code, meaning } of EXIT_CODES) {
    lines.push(...wrap(`${code}  ${meaning}`, "  ", opts.maxWidth));
  }

  lines.push(
    "",
    ...wrap(
      "提示: `noj-cli --help` 只读，不会创建目录、读取配置或启动容器。",
      "",
      opts.maxWidth,
    ),
    "",
  );
  return lines.join("\n");
}
