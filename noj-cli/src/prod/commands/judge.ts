/** `judge` 子命令（install-env / install / check / start / stop / status / logs / upgrade）的分发与输出。 */

import { realRunner } from "../../runtime/command.ts";
import { UsageError } from "../../util/args.ts";
import { EXIT_USAGE } from "../../cli-commands/exit-codes.ts";
import {
  judgeCheck,
  judgeInstall,
  judgeInstallEnv,
  judgeLogs,
  judgeStart,
  judgeStatus,
  judgeStop,
  judgeUpgrade,
} from "../judge/actions.ts";
import { createLocalRedis } from "../judge/config.ts";
import { humanOutput } from "./args.ts";
import { flagValue, hasFlag } from "../../util/args.ts";

/**
 * `judge` 的子命令分发（`install-env` / `install` / `upgrade` 等）。
 */
export async function runProdJudge(
  dir: string,
  args: string[],
  json: boolean,
): Promise<number> {
  const sub = args[0] ?? "";
  const rest = args.slice(1);
  const say = humanOutput(json);
  const base = {
    dir,
    runner: realRunner(),
    envFile: flagValue(rest, "--env-file"),
    composeFile: flagValue(rest, "--compose-file"),
    dockerBin: Deno.env.get("NOJ_DEPLOY_DOCKER_BIN") ?? undefined,
    // **必须转发 `--dry-run`**：`judgeInstall` 里有完整的 dry-run
    // 分支（校验后直接返回、不写任何文件），但 CLI 层从未传这个字段，于是
    // `--dry-run` 被静默吞掉 → **真的写了 `.env.judge`** 才因后续检查失败退出。
    // 即"预演"产生了副作用，违反"dry-run 零副作用"。
    dryRun: hasFlag(rest, "--dry-run"),
    log: say,
  };

  switch (sub) {
    case "install-env": {
      const r = await judgeInstallEnv(base);
      say(r.message);
      return r.exitCode;
    }
    case "install": {
      // `--redis-mode local`：先为本机 Judge 创建**仅绑定回环**的 Redis，
      // 再把它的连接串喂给 install。缺省（不传）为"连接已有 Redis"。
      let redisUrl = flagValue(rest, "--redis-url");
      let localRedis: Awaited<ReturnType<typeof createLocalRedis>> | null =
        null;
      const redisMode = flagValue(rest, "--redis-mode");
      // **`--dry-run` 下绝不创建 Redis**：否则预演会真的建容器并写 `redis.conf`。
      const dryRunForRedis = hasFlag(rest, "--dry-run");
      if (redisMode === "local" && dryRunForRedis) {
        say("[dry-run] 将创建本机 Redis（仅绑定 127.0.0.1，不执行）");
      } else if (redisMode === "local") {
        const portRaw = flagValue(rest, "--redis-port");
        localRedis = await createLocalRedis({
          dir,
          runner: base.runner,
          containerName: flagValue(rest, "--redis-container"),
          port: portRaw === undefined
            ? undefined
            : Number.parseInt(portRaw, 10),
          dockerBin: base.dockerBin,
        });
        redisUrl = localRedis.checkUrl;
        say(
          `✓ 本机 Redis 已就绪：${localRedis.containerName}（仅绑定 127.0.0.1:${localRedis.port}）`,
        );
      } else if (redisMode !== undefined && redisMode !== "existing") {
        throw new UsageError(
          `--redis-mode 只能是 local 或 existing，收到 "${redisMode}"`,
        );
      }
      const r = await judgeInstall({
        ...base,
        version: flagValue(rest, "--version"),
        redisUrl,
        // 容器内的 Judge 必须走 `host.docker.internal`（Redis 在宿主机上）
        redisCheckUrl: localRedis === null
          ? flagValue(rest, "--redis-url")
          : localRedis.runtimeUrl,
        socketPath: flagValue(rest, "--socket-path"),
        socketGid: flagValue(rest, "--socket-gid"),
        values: {},
      });
      say(r.message);
      return r.exitCode;
    }
    case "check": {
      const r = await judgeCheck(base);
      say(r.message);
      return r.exitCode;
    }
    case "start": {
      const r = await judgeStart(base);
      say(r.message);
      return r.exitCode;
    }
    case "stop": {
      const r = await judgeStop(base);
      say(r.message);
      return r.exitCode;
    }
    case "status": {
      const r = await judgeStatus(base);
      if (json) {
        console.log(JSON.stringify(
          {
            exitCode: r.exitCode,
            message: r.message,
            summary: r.summary,
            ps: r.psOutput,
          },
          null,
          2,
        ));
      } else {
        // **人类模式不得重复打印**：`judgeStatus` 已经通过
        // `base.log`（= say）逐行输出了 summary 与 compose ps，这里再打印
        // 一遍会让每行出现两次（实测 15 行重复）。
        // 因此人类模式只补 `message`；`summary`/`psOutput` 仅在 `--json`
        // 分支作为结构化字段输出（那时 log 走 stderr，不污染 stdout）。
        say(r.message);
      }
      return r.exitCode;
    }
    case "logs": {
      const r = await judgeLogs({
        ...base,
        follow: hasFlag(rest, "--follow", "-f"),
      });
      say(r.message);
      return r.exitCode;
    }
    case "upgrade": {
      // 版本来自配置文件（`prepareExisting` 会读取并校验），不接受 `--version`：
      // 升级的目标版本是"配置里写的那个"，显式传值会让配置与实际运行不一致。
      const r = await judgeUpgrade(base);
      say(r.message);
      return r.exitCode;
    }
    default:
      console.error(
        `judge 需要子命令 install-env/install/check/start/stop/status/logs/` +
          `upgrade，收到 "${sub}"`,
      );
      return EXIT_USAGE;
  }
}
