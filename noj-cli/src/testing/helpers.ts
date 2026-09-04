/** noj-cli 测试共享工具：减少各测试文件重复的 fixture / runner 构造。 */

import type { DeployConfig, SecretsConfig } from "../config/types.ts";
import type {
  CmdResult,
  CommandRunner,
  SpawnHandle,
  SpawnOpts,
} from "../runtime/command.ts";

/** 测试用固定时间戳。 */
export const NOW = "2026-08-31T00:00:00Z";

/** 创建临时目录（统一封装，便于后续统一清理策略）。 */
export function makeTempDir(): Promise<string> {
  return Deno.makeTempDir();
}

/** 构造一份最小可用的 DeployConfig，支持按测试覆盖字段。 */
export function baseConfig(
  overrides: Partial<DeployConfig> = {},
): DeployConfig {
  return {
    schema_version: 1,
    type: "prod",
    state: "running",
    created_at: NOW,
    updated_at: NOW,
    install_dir: "/opt/neuro-oj",
    version: { noj_cli: "0.1.0", noj_server: "0.1.0" },
    env: {},
    components: {},
    reverse_proxy: {
      type: "nginx",
      config_dir: "/etc/nginx/conf.d",
      domain: "oj.example.com",
      upstream_port: 8080,
    },
    ...overrides,
  };
}

/** 构造一份最小可用的 SecretsConfig，支持按测试覆盖字段。 */
export function secrets(
  overrides: Partial<SecretsConfig> = {},
): SecretsConfig {
  return {
    schema_version: 1,
    created_at: NOW,
    updated_at: NOW,
    secrets: {},
    ...overrides,
  };
}

/** 把配置写入临时部署目录（noj-deploy.json + noj-secrets.json）。 */
export async function writeFixture(
  dir: string,
  cfg: DeployConfig,
  sec: SecretsConfig,
): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/noj-deploy.json`, JSON.stringify(cfg));
  await Deno.writeTextFile(`${dir}/noj-secrets.json`, JSON.stringify(sec));
}

/** 基础 fake runner：所有命令成功，spawn 抛错。 */
export function fakeRunner(): CommandRunner {
  return {
    run() {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(_opts: SpawnOpts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
  };
}

/** 记录 run 调用的 fake runner；stdout 可配置（默认空串）。 */
export function recordingRunner(
  records: string[][],
  stdout = "",
): CommandRunner {
  return {
    run(cmd, args) {
      records.push([cmd, ...args]);
      const r: CmdResult = { code: 0, stdout, stderr: "" };
      return Promise.resolve(r);
    },
    spawn(_opts: SpawnOpts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
  };
}

/** up 失败但记录 down 调用的 runner，用于验证失败后仍清理。 */
export function failingUpRunner(downCalls: number[]): CommandRunner {
  return {
    run(cmd, args) {
      if (cmd === "docker" && args.includes("up")) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "up failed" });
      }
      if (cmd === "docker" && args.includes("down")) {
        downCalls.push(1);
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    spawn(_opts: SpawnOpts): SpawnHandle {
      throw new Error("fake runner 不 spawn");
    },
  };
}
