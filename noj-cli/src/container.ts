/**
 * Tier 3 · 服务端管理命令的**容器包装**（#518 P5）。
 *
 * 运维文档要求用户手写约 150 字符的 compose 调用才能执行一次数据库迁移：
 *
 * ```bash
 * docker compose --env-file /opt/neuro-oj/.env.prod -f /opt/neuro-oj/docker-compose.prod.yml run --rm \\
 *   --entrypoint /app/bin/noj core db migrate
 * ```
 *
 * 这类命令有 5+ 个，而 `noj-cli` 已在宿主机上、已知 `--dir` 与 `.env.prod` 位置，
 * 完全可以提供短命令包装。本模块只负责**构造与渲染**（纯函数，可单测），
 * 实际执行由 `container_run.ts` 负责（继承 stdin 以透传隐藏密码输入）。
 */
import { join } from "@std/path";

/** 容器内 CLI 的路径（`noj-core/Dockerfile`：`--output /app/bin/noj`）。 */
export const CONTAINER_CLI = "/app/bin/noj";

/** Tier 3 命令的 Compose service（`core` 是 service 名，非子命令）。 */
export const CONTAINER_SERVICE = "core";

/**
 * 受支持的 Tier 3 命令（前缀匹配）。
 *
 * 与 `noj-core/scripts/noj.ts` 的子命令定义保持一致；顺序不影响匹配
 * （最长前缀优先，见 {@link parseContainerCommand}）。
 */
export const CONTAINER_COMMANDS: readonly string[][] = [
  ["db", "migrate"],
  ["init", "system"],
  ["bootstrap", "first-admin"],
  ["problems", "build"],
  ["problems", "import"],
  ["search", "reindex"],
];

/** 解析结果。 */
export interface ContainerCommandMatch {
  matched: boolean;
  service: string;
  /** 透传给容器内 CLI 的完整参数（含 Tier 3 前缀）。 */
  args: string[];
}

/**
 * 判断顶层参数是否命中 Tier 3 命令。
 *
 * 采用**最长前缀优先**：例如 `problems import` 与潜在的 `problems` 并存时，
 * 更长的匹配胜出。
 */
export function parseContainerCommand(argv: string[]): ContainerCommandMatch {
  const sorted = [...CONTAINER_COMMANDS].sort((a, b) => b.length - a.length);
  for (const prefix of sorted) {
    if (prefix.length > argv.length) continue;
    if (prefix.every((part, i) => argv[i] === part)) {
      return { matched: true, service: CONTAINER_SERVICE, args: [...argv] };
    }
  }
  return { matched: false, service: CONTAINER_SERVICE, args: [] };
}

/** 构造 compose 参数。 */
export interface ComposeArgsOptions {
  composeFile: string;
  envFile: string;
  service: string;
  /** 容器内 CLI 的子命令与参数。 */
  command: string[];
}

/**
 * 构造 `docker compose … run --rm --entrypoint /app/bin/noj <service> <args>`。
 *
 * 使用参数数组（而非 shell 字符串），从结构上消除注入与转义问题。
 */
export function buildComposeArgs(options: ComposeArgsOptions): string[] {
  return [
    "compose",
    "--env-file",
    options.envFile,
    "-f",
    options.composeFile,
    "run",
    "--rm",
    "--entrypoint",
    CONTAINER_CLI,
    options.service,
    ...options.command,
  ];
}

/** 单个参数是否需要引号（shell 安全渲染用）。 */
function quoteIfNeeded(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)
    ? arg
    : `"${arg.replace(/"/g, '\\"')}"`;
}

/** 渲染为可复制执行的一行命令（`--dry-run` 输出）。 */
export function renderDryRun(args: string[]): string {
  return ["docker", ...args].map(quoteIfNeeded).join(" ");
}

/** 定位生产安装目录下的 compose 与 env 文件路径。 */
export function productionPaths(dir: string): {
  composeFile: string;
  envFile: string;
} {
  return {
    composeFile: join(dir, "docker-compose.prod.yml"),
    envFile: join(dir, ".env.prod"),
  };
}
