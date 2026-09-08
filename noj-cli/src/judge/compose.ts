import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import type { JudgeOptions } from "./options.ts";

/** 独立 Judge Compose 项目名。 */
const PROJECT_NAME = "noj-judge-standalone";

/**
 * 渲染独立 Judge 的 docker-compose 配置。
 * 模板与 `scripts/deploy/judge-install.sh` 的 `write_compose` 保持一致。
 */
export function renderJudgeCompose(): string {
  return `services:
  judge:
    image: "\${JUDGE_IMAGE_REGISTRY:-ghcr.io/neuro-oj}/noj-judge:\${NOJ_VERSION:?NOJ_VERSION is required}"
    environment:
      REDIS_URL: "\${REDIS_URL:?REDIS_URL is required}"
      JUDGE_QUEUE: "\${JUDGE_QUEUE:-noj:judge:queue}"
      RESULT_QUEUE: "\${RESULT_QUEUE:-noj:judge:results}"
      WORK_DIR: "\${WORK_DIR:-/tmp/noj-judge}"
      JUDGE_MAX_CONCURRENT_JUDGES: "\${JUDGE_MAX_CONCURRENT_JUDGES:-2}"
      JUDGE_CPU_LIMIT_MILLICORES: "\${JUDGE_CPU_LIMIT_MILLICORES:-1000}"
      JUDGE_MAX_EVALUATOR_TIME_MS: "\${JUDGE_MAX_EVALUATOR_TIME_MS:-300000}"
      JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS: "\${JUDGE_MAX_SOLUTION_CALL_TIMEOUT_MS:-60000}"
      JUDGE_IMAGE_PREFIX: "\${JUDGE_IMAGE_PREFIX:-noj-}"
      JUDGE_COMMAND_WHITELIST: "\${JUDGE_COMMAND_WHITELIST:-python3,deno,node,bash,sh}"
      JUDGE_ALLOW_EVALUATOR_NETWORK: "\${JUDGE_ALLOW_EVALUATOR_NETWORK:-false}"
      JUDGE_EVALUATOR_NETWORK: "\${JUDGE_EVALUATOR_NETWORK:-bridge}"
      JUDGE_ALLOW_HTTP_S3: "\${JUDGE_ALLOW_HTTP_S3:-false}"
      JUDGE_DOCKER_HOST: "\${JUDGE_DOCKER_HOST:-unix:///run/noj-judge/docker.sock}"
      JUDGE_REQUIRE_ISOLATED_DOCKER: "true"
      SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT: "\${SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT:-60}"
      SUPPORT_CACHE_DIR: "\${SUPPORT_CACHE_DIR:-/tmp/noj-judge/support-cache}"
      SUPPORT_CACHE_MAX_ITEMS: "\${SUPPORT_CACHE_MAX_ITEMS:-500}"
      SUPPORT_CACHE_MAX_MB: "\${SUPPORT_CACHE_MAX_MB:-2048}"
    volumes:
      - "\${JUDGE_DOCKER_SOCKET:?JUDGE_DOCKER_SOCKET is required}:/run/noj-judge/docker.sock:ro"
      - judge-cache:/tmp/noj-judge
    user: "\${JUDGE_UID:-10001}:\${JUDGE_GID:-10001}"
    group_add:
      - "\${JUDGE_DOCKER_SOCKET_GID:?JUDGE_DOCKER_SOCKET_GID is required}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped

volumes:
  judge-cache:
    name: noj-judge-standalone-cache
`;
}

/**
 * 写入独立 Judge Compose 配置。
 * dryRun 时仅打印将生成的位置，不写文件；否则写入并设置为 600。
 */
export function writeJudgeCompose(file: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(`[dry-run] 将生成 Compose 配置：${file}`);
    return;
  }
  Deno.writeTextFileSync(file, renderJudgeCompose());
  Deno.chmodSync(file, 0o600);
  console.log(`已生成 Compose 配置：${file}`);
}

/** 组装 `docker compose` 的完整参数列表。 */
export function composeArgs(
  opts: JudgeOptions,
  args: string[] = [],
): string[] {
  return [
    "compose",
    "--project-name",
    PROJECT_NAME,
    "--env-file",
    opts.envFile,
    "-f",
    opts.composeFile,
    ...args,
  ];
}

/**
 * 执行独立 Judge 的 docker compose 命令。
 * dryRun 时打印命令并返回 0；否则调用 runner 并返回退出码。
 */
export async function runJudgeCompose(
  opts: JudgeOptions,
  args: string[],
  runner: CommandRunner = realRunner(),
): Promise<number> {
  const allArgs = composeArgs(opts, args);
  if (opts.dryRun) {
    console.log(`[dry-run] docker ${allArgs.join(" ")}`);
    return 0;
  }
  const result = await runner.run("docker", allArgs);
  return result.code;
}
