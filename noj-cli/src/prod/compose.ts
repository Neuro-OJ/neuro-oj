/**
 * prod 侧 compose 服务集与命令封装（T10）。
 *
 * 裁决（spec §3.4 洞 3）：生产编排**只认仓库内受版本管理的
 * `docker-compose.prod.yml`**（由 T9 bootstrap 下载并 SHA-256 校验），
 * **不引入运行时渲染**。理由：固定文件的容器集合 / 健康检查 / profile 已由 CI
 * 与 e2e 覆盖；运行时渲染会引入一份未被测试覆盖的编排面。
 *
 * 与 stack 侧 `deploy/compose.ts` 的 `renderCompose()` 是两个不同模块：
 * 本模块**只**负责服务清单、参数数组构造与调用，不做任何渲染。
 */
import type { CommandRunner } from "../runtime/command.ts";

/** prod compose 支持的可选 profile 名（与 compose 文件中的 `profiles:` 一致）。 */
export type ProdProfile = "judge" | "monitoring";

/** 一个 prod 服务及其所属 profile；无 `profile` 者为默认启动。 */
export interface ProdService {
  /** compose service 名（亦为 noj-net 内的 DNS 名）。 */
  name: string;
  /** 所属 profile；缺省表示无 profile，始终随 `up` 启动。 */
  profile?: ProdProfile;
}

/**
 * 生产 `docker-compose.prod.yml` 的**权威服务集**（顺序即文件中的声明顺序）。
 *
 * 与文件逐服务核对，不得遗漏：`migrate`、`core`、`ui`、`judge`（profile
 * judge）、`llm-gateway`、`nginx`、`prometheus`（profile monitoring）、
 * `alertmanager`（profile monitoring）、`postgres`、`redis`、`minio`、
 * `minio-init`。
 *
 * `compose_test.ts` 会读取真实文件、按缩进层级解析 `services:` 段并与此清单
 * 双向比对，因此此处不是"第二份手抄清单"。
 */
export const PROD_SERVICES: readonly ProdService[] = [
  { name: "migrate" },
  { name: "core" },
  { name: "ui" },
  { name: "judge", profile: "judge" },
  { name: "llm-gateway" },
  { name: "nginx" },
  { name: "prometheus", profile: "monitoring" },
  { name: "alertmanager", profile: "monitoring" },
  { name: "postgres" },
  { name: "redis" },
  { name: "minio" },
  { name: "minio-init" },
];

/** 生产编排文件名（T9 `RELEASE_FILES` 中的固定资产名）。 */
export const PROD_COMPOSE_FILE = "docker-compose.prod.yml";

/** 生产配置文件相对名（安装目录下的 `.env.prod`）。 */
export const PROD_ENV_FILE = ".env.prod";

/** 构造 compose 参数所需的公共选项。 */
export interface ComposeArgsOptions {
  /** `-f` 指向的 compose 文件路径。 */
  composeFile: string;
  /** `--env-file` 指向的环境文件路径。 */
  envFile: string;
  /** 是否启用 `--profile judge`。 */
  judge?: boolean;
  /** 是否启用 `--profile monitoring`。 */
  monitoring?: boolean;
  /** 追加到 profile 之后的 compose 子命令与参数。 */
  command: string[];
}

/**
 * 构造 compose 参数**数组**（绝不拼接 shell 字符串）。
 *
 * 形状：`["compose", "--env-file", <env>, "-f", <compose>, ...profiles, ...cmd]`。
 * `--profile judge` / `--profile monitoring` 仅在对应开关为 `true` 时插入，
 * 且 judge 排在 monitoring 之前（与 `deploy.sh:run_compose` 的插入顺序一致）。
 */
export function composeArgs(options: ComposeArgsOptions): string[] {
  const args = [
    "compose",
    "--env-file",
    options.envFile,
    "-f",
    options.composeFile,
  ];
  if (options.judge === true) args.push("--profile", "judge");
  if (options.monitoring === true) args.push("--profile", "monitoring");
  args.push(...options.command);
  return args;
}

/**
 * 薄封装的公共选项。
 *
 * `dryRun` 为 `true` 时**不执行任何命令**，直接返回将执行的参数数组。
 */
export interface ComposeOptions {
  composeFile: string;
  envFile: string;
  /** 是否启用 `--profile judge`。 */
  judge?: boolean;
  /** 是否启用 `--profile monitoring`。 */
  monitoring?: boolean;
  /** 只对指定服务执行（追加在子命令末尾）。 */
  services?: string[];
  /** 仅返回参数数组，不调用 runner。 */
  dryRun?: boolean;
}

/** compose 调用结果：真实执行返回退出码，`dryRun` 返回参数数组。 */
export type ComposeResult = number | string[];

/** 统一执行路径：`dryRun` 短路，否则执行并透传退出码。 */
function invoke(
  runner: CommandRunner,
  args: string[],
  dryRun: boolean | undefined,
): Promise<ComposeResult> {
  if (dryRun === true) return Promise.resolve(args);
  return runner.run("docker", args).then((result) => result.code);
}

/**
 * `docker compose ... up -d --wait [services...]`。
 *
 * 退出码原样透传；`dryRun` 时返回参数数组。
 */
export function composeUp(
  runner: CommandRunner,
  options: ComposeOptions,
): Promise<ComposeResult> {
  const command = ["up", "-d", "--wait", ...(options.services ?? [])];
  return invoke(
    runner,
    composeArgs({ ...options, command }),
    options.dryRun,
  );
}

/** `docker compose ... down [services...]`（默认不 `-v`，保留数据卷）。 */
export function composeDown(
  runner: CommandRunner,
  options: ComposeOptions,
): Promise<ComposeResult> {
  const command = ["down", ...(options.services ?? [])];
  return invoke(
    runner,
    composeArgs({ ...options, command }),
    options.dryRun,
  );
}

/** `docker compose ... ps`。 */
export function composePs(
  runner: CommandRunner,
  options: ComposeOptions,
): Promise<ComposeResult> {
  return invoke(
    runner,
    composeArgs({ ...options, command: ["ps"] }),
    options.dryRun,
  );
}

/** `composeLogs` 的选项：在公共选项上追加 tail / follow。 */
export interface ComposeLogsOptions extends ComposeOptions {
  /** 仅显示末尾 N 行；缺省 200（与 `deploy.sh:logs` 一致）。 */
  tail?: number;
  /** 是否 `--follow`。 */
  follow?: boolean;
}

/** `docker compose ... logs --tail=<n> [--follow] [services...]`。 */
export function composeLogs(
  runner: CommandRunner,
  options: ComposeLogsOptions,
): Promise<ComposeResult> {
  const command = ["logs", `--tail=${options.tail ?? 200}`];
  if (options.follow === true) command.push("--follow");
  command.push(...(options.services ?? []));
  return invoke(
    runner,
    composeArgs({ ...options, command }),
    options.dryRun,
  );
}

/** `docker compose ... config`：校验编排文件可解析。 */
export function composeConfig(
  runner: CommandRunner,
  options: ComposeOptions,
): Promise<ComposeResult> {
  return invoke(
    runner,
    composeArgs({ ...options, command: ["config"] }),
    options.dryRun,
  );
}
