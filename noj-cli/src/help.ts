/**
 * noj-cli 帮助文本的**唯一事实源**（#517 E5/E11）。
 *
 * 早先 help 是 `cli.ts` 里手写的一个字符串数组，与实现分离：
 * - 声称 `backup` 支持 `schedule`，但 `maintain backup` 并未实现（E5）；
 * - 顶层把生产命令与 JSON 命令混排，只用一句「以下命令支持 --dir」分隔（E11）。
 *
 * 现在按 **模式（profile）分区**声明，命令清单与用法同处一处，
 * 便于测试逐项断言（`help_test.ts`）。
 */

/** 单个命令的用法条目。 */
export interface HelpEntry {
  /** 命令名（含子命令，如 `deploy init`）。 */
  name: string;
  /** 一句话说明。 */
  summary: string;
  /** 别名（用于 help 标注与解析提示）。 */
  aliases?: string[];
}

/** 一个模式分区。 */
export interface HelpSection {
  title: string;
  /** 该分区的适用场景说明。 */
  note?: string;
  entries: HelpEntry[];
}

/** 生产模式（.env.prod + docker-compose.prod.yml，宿主机运维，无需 Deno）。 */
export const PRODUCTION_SECTION: HelpSection = {
  title:
    "生产模式（.env.prod + docker-compose.prod.yml；宿主机运维，无需 Deno）",
  note: "以下命令支持 --dir <安装目录>；在安装目录内可省略。",
  entries: [
    { name: "install", summary: "生产安装" },
    {
      name: "check",
      summary: "生产环境检测（Linux/Docker/Compose/磁盘/端口）",
    },
    { name: "start | stop | restart", summary: "生产服务生命周期" },
    { name: "status", summary: "生产服务状态" },
    { name: "logs", summary: "生产服务日志（支持 --follow）" },
    {
      name: "update",
      summary: "同步部署文件、备份并升级生产服务",
      aliases: ["upgrade"],
    },
    { name: "backup", summary: "生产备份；子命令 create/verify/restore/drill" },
    { name: "verify", summary: "生产配置与镜像签名校验（比 config 多验签名）" },
    {
      name: "config",
      summary: "生产配置校验（原 config check；不验镜像签名）",
    },
    { name: "uninstall", summary: "卸载生产服务；--all 删除全部数据，需确认" },
  ],
};

/** JSON 编排模式（noj-deploy.json + noj-secrets.json；源码开发，需 Deno）。 */
export const STACK_SECTION: HelpSection = {
  title:
    "JSON 编排模式（noj-deploy.json + noj-secrets.json；源码开发，需 Deno）",
  note: "以下命令支持 --dir <部署目录>；可用 --profile stack 显式指定模式。",
  entries: [
    { name: "doctor", summary: "环境检测" },
    // #518：deploy + maintain 合并为 stack；旧名保留为别名
    {
      name: "stack",
      summary:
        "部署与运维：init/up/down/restart/status/logs/config/verify/reset/backup",
    },
    { name: "deploy", summary: "部署生命周期 init/up/down/restart/status" },
    {
      name: "maintain",
      summary:
        "运维 logs/config/verify/reset/backup(create/verify/restore/drill)",
    },
    { name: "run-server", summary: "前台运行 noj-server 二进制" },
  ],
};

/**
 * Tier 3 服务端管理分区（#518 P5）。
 *
 * 这些命令把约 150 字符的 compose 调用收敛为短命令。
 */
export const TIER3_SECTION: HelpSection = {
  title: "服务端管理（Tier 3；在 noj-server 容器内执行生产安装的 CLI）",
  note: "以下命令支持 --install-dir <安装目录> 与 --dry-run。",
  entries: [
    { name: "db migrate", summary: "执行数据库迁移" },
    { name: "init system", summary: "初始化系统基础数据" },
    { name: "bootstrap first-admin", summary: "创建首个管理员" },
    { name: "problems build | import", summary: "构建 / 导入题目包" },
    { name: "search reindex", summary: "全量重建搜索索引" },
  ],
};

/** 全局选项分区。 */
export const GLOBAL_SECTION: HelpSection = {
  title: "全局选项",
  entries: [
    { name: "--help, -h", summary: "显示帮助（只读，不产生任何副作用）" },
    { name: "--version, -v", summary: "显示版本" },
    {
      name: "--debug",
      summary: "错误时打印完整栈帧（排查用；亦可设 NOJ_CLI_DEBUG=1）",
    },
    {
      name: "--profile <prod|stack>",
      summary: "显式指定部署模式；缺省按目录特征自动探测（探测失败会报错）",
    },
  ],
};

/** 退出码语义（#517 E9）。 */
export const EXIT_CODES: Array<{ code: number; meaning: string }> = [
  { code: 0, meaning: "成功" },
  { code: 1, meaning: "运行失败（命令已执行但未成功）" },
  { code: 2, meaning: "用法错误（参数非法、缺少必需参数、未知命令）" },
];

/** 全部模式分区（顺序即 help 展示顺序）。 */
export const HELP_SECTIONS: HelpSection[] = [
  PRODUCTION_SECTION,
  STACK_SECTION,
  TIER3_SECTION,
  GLOBAL_SECTION,
];

/** 渲染完整顶层帮助文本。 */
export function renderHelp(): string {
  const lines: string[] = [
    "noj-cli - Neuro OJ 统一部署与运维 CLI",
    "",
    "用法: noj-cli <命令> [子命令] [选项]",
  ];

  for (const section of HELP_SECTIONS) {
    lines.push("", `${section.title}`);
    if (section.note) lines.push(`  ${section.note}`);
    const width = Math.max(...section.entries.map((e) => e.name.length));
    for (const entry of section.entries) {
      const alias = entry.aliases?.length
        ? `（别名 ${entry.aliases.join("/")}）`
        : "";
      lines.push(
        `  ${entry.name.padEnd(width)}  ${entry.summary}${alias}`,
      );
    }
  }

  lines.push("", "退出码");
  for (const { code, meaning } of EXIT_CODES) {
    lines.push(`  ${code}  ${meaning}`);
  }

  lines.push(
    "",
    "提示: \`noj-cli --help\` 只读，不会创建目录、读取配置或启动容器。",
    "",
  );
  return lines.join("\n");
}

/** 生成某个子命令的用法文本（供 `<cmd> --help` 使用）。 */
export function renderCommandHelp(
  usage: string,
  body: string[],
): string {
  return [`用法: ${usage}`, "", ...body, ""].join("\n");
}
