// 帮助文本渲染：顶层帮助、drill 专项帮助与生产命令帮助。

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
  // T26：把终端宽度传给渲染器，使窄终端下每行不溢出。
  // `COLUMNS` 缺失或非法时不限制宽度（保持既有行为）。
  const raw = Deno.env.get("COLUMNS");
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  const maxWidth = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  return renderCommandList(maxWidth === undefined ? {} : { maxWidth });
}

/**
 * drill 专项帮助（#516 验收：help 必须明确「分钟级、耗 Docker」，
 * 而不是只显示通用的 maintain backup 帮助）。
 *
 * **T23 更新**：快照形态说明随 T19 的裁决反转——现在只接受 `.nojbackup`
 * 单文件（唯一形态），旧的"目录快照"表述已作废。
 */
export function renderDrillHelp(): string {
  return renderCommandHelp(
    "noj-cli backup drill <snapshot> [选项]",
    [
      "在**隔离环境**中真实恢复快照并做业务验收（登录/题目读取/可选评测）。",
      "",
      "注意: 会起独立 Compose 项目（默认每次唯一生成）、占用独立子网与数据卷，",
      "      耗时**分钟级**且**需要 Docker 资源**——不是随手可跑的检查。",
      "      必须连接专用隔离 Docker daemon；默认宿主机 socket 会被拒绝。",
      "      只校验文件完整请用 `backup verify`（结构可解析加 `--deep`）。",
      "",
      "快照形态: `.nojbackup` 单文件（`backup create` 的唯一产物形态）。",
      "演练会校验其 payload_layout == prod-raw 后解包到临时目录，",
      "再交给隔离编排（独立项目/独立子网/**不映射宿主机端口**）。",
      "",
      "选项:",
      "  --skip-judge            跳过 Judge/附件/评测验收（无 Judge 部署时）",
      "  --docker-host SOCKET    专用 daemon socket（或 NOJ_DRILL_DOCKER_HOST）",
      "  --subnet CIDR           演练网络子网（默认每次唯一 172.29.x.0/24）",
      "  --project-name NAME     演练 Compose 项目名（默认每次唯一；禁止含 prod）",
      "  --report FILE           报告路径（默认快照同级 restore-drill-report.txt）",
      "  --rpo-max-hours N       快照年龄上限（默认 24）；超限视为演练失败",
      "  --rto-max-minutes N     恢复耗时上限（默认 60）；超限视为演练失败",
      "  --keep                  保留演练环境以便排查（默认清理）",
      "  --json                  机器可读报告",
      "  --dir <path>            生产安装目录",
      "  --passphrase-file FILE  GPG 口令文件",
      "  --no-encrypt            快照未加密（`backup create --no-encrypt` 的产物）",
      "",
      "退出码: 0 通过 / 1 演练失败（含业务验收失败、超 RPO/RTO）/ 2 参数或资源错误",
    ],
  );
}

/** 生产命令的 CLI 侧帮助（不转发给底层 bash 脚本，#517 E12）。 */
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
  // （评审发现——`judge install --dir X` 只会报"首装必须提供 NOJ_VERSION"，
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
    ]
    : [];
  const backupFlags = command === "backup"
    ? [
      "",
      "backup 常用选项:",
      "  create --retention-days N --min-free-mb N   保留天数 / 可用空间下限",
      "  verify|restore|drill --passphrase-file FILE  GPG 口令（或用",
      "      NOJ_BACKUP_PASSPHRASE_FILE，或 .env.prod 中的同名键）",
      "  restore 省略 --confirm（或显式 --dry-run）为只规划、零副作用",
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
