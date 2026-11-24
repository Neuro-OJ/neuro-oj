// 帮助文本渲染：顶层帮助与生产命令帮助。

import { COMMANDS, renderCommandList } from "../commands.ts";

/** 生成某个子命令的用法文本（供 `<cmd> --help` 使用）。 */
export function renderCommandHelp(usage: string, body: string[]): string {
  return [`用法: ${usage}`, "", ...body, ""].join("\n");
}

/**
 * 生成顶层帮助文本（唯一事实源见 {@link renderCommandList}）。
 *
 * 命令清单已收敛到 `commands.ts`；此处只做委托，不再手写命令列表。
 */
export function printHelp(): string {
  // 把终端宽度传给渲染器，使窄终端下每行不溢出。
  // `COLUMNS` 缺失或非法时不限制宽度（保持既有行为）。
  const raw = Deno.env.get("COLUMNS");
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  const maxWidth = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  return renderCommandList(maxWidth === undefined ? {} : { maxWidth });
}

/** 生产命令的 CLI 侧帮助（#517 E12）。 */
export function renderProductionCommandHelp(command: string): string {
  // 摘要与子命令取自命令表（唯一事实源），不再另维护一份。
  const spec = COMMANDS.find((c) =>
    c.name === command || (c.aliases?.includes(command) ?? false)
  );
  const head = [spec?.summary ?? "生产命令"];
  if (spec !== undefined && spec.name !== command) {
    head.push(`（${command} 是 ${spec.name} 的别名）`);
  }
  const subs = spec?.subcommands ?? [];
  const width = Math.max(0, ...subs.map((sub) => sub.name.length));
  const subLines = subs.length === 0 ? [] : [
    "",
    "子命令:",
    ...subs.map((sub) => `  ${sub.name.padEnd(width)}  ${sub.summary}`),
  ];
  // `judge` 的必需旗标必须出现在 help 里：文档给的一行命令此前不可执行
  // （`judge install --dir X` 只会报"首装必须提供 NOJ_VERSION"，
  // 而 `--version`/`--redis-url`/`--socket-path` 在任何 help 中都不出现）。
  const judgeFlags = command === "judge"
    ? [
      "",
      "judge install 必需旗标（首装）:",
      "  --version <tag>        不可变 Release 版本（如 v0.9.5；禁用 main/latest）",
      "  --redis-url <url>      与 noj-core 相同的 Redis 地址",
      "  --socket-path <path>   专用 rootless Docker socket（禁用宿主共享 socket）",
      "  --socket-gid <gid>     socket 实际组 ID（stat -c '%g' <socket>）",
      "",
      "可选: --redis-mode local|existing、--redis-port、--redis-container、",
      "      --dry-run（零副作用预演）、--env-file、--compose-file",
      "",
      "judge reset-config 常用选项（排空后解除资源组容量锁）:",
      "  --group <name>         资源组名（缺省读 JUDGE_RESOURCE_GROUP）",
      "  --claim-prefix <pfx>   Redis 键前缀（缺省从 JUDGE_QUEUE 派生）",
      "  --stop                 重置前先停止本机 Judge 容器（compose stop -t <sec>）",
      "  --restart              先停止、重置并更新后以 --force-recreate 重建启动",
      "  --wait-timeout <sec>   等待同组心跳/租约过期超时（0..3600，默认 90）",
      "  --ai-tasks <n>         同步更新 JUDGE_AI_TASK_CONCURRENCY（1..1024）",
      "  --wasm-tasks <n>       同步更新 JUDGE_WASM_TASK_CONCURRENCY（1..1024）",
      "  --native-tasks <n>     同步更新 JUDGE_NATIVE_TASK_CONCURRENCY（1..1024）",
      "  --wasm-compile <n>     同步更新 JUDGE_WASM_COMPILE_CONCURRENCY（1..1024）",
      "  --wasm-run <n>         同步更新 JUDGE_WASM_CASE_CONCURRENCY（1..1024）",
      "  --memory-mb <n|auto>   同步更新 JUDGE_RESOURCE_MEMORY_MB",
      "  --pools <list>         同步更新 JUDGE_RESOURCE_POOLS",
      "  --dry-run / --json     零副作用预演 / 机器可读 JSON 输出",
      "",
    ]
    : [];
  const backupFlags = command === "backup"
    ? [
      "",
      "backup 常用选项:",
      "  create --retention-days N --min-free-mb N   保留天数 / 备份目录可用空间下限（默认 1024）",
      "  verify|restore --passphrase-file FILE  GPG 口令（或用",
      "      NOJ_BACKUP_PASSPHRASE_FILE，或 .env.prod 中的同名键）",
      "  restore 省略 --confirm（或显式 --dry-run）为只规划、零副作用",
    ]
    : command === "update" || command === "upgrade"
    ? [
      "",
      "update 常用选项:",
      "  --latest                 升级到最新稳定正式 Release",
      "  --min-free-mb N          升级前备份的可用空间下限（默认 1024 MiB）",
      "  --skip-drain             跳过维护模式自动排空",
      "  --drain-timeout N        等待排空超时秒数",
      "  --recover                从上次未完成 checkpoint 恢复升级",
    ]
    : [];
  return renderCommandHelp(`noj-cli ${command} [选项]`, [
    ...head,
    ...subLines,
    "",
    "说明:",
    "  该命令需要完整的生产安装目录（含 docker-compose.prod.yml 与",
    "  .env.prod）。使用 --dir <path> 指定，或在安装目录内执行。",
    "  `judge` 允许空/新建目录（独立节点不运行 noj-core/noj-ui）。",
    ...judgeFlags,
    ...backupFlags,
  ]);
}
