/**
 * 环境变量启动期快照（issue #99 演进：配置分层语义治理）。
 *
 * 在 main.ts 启动顺序的"DB 迁移之后、MQ 消费者启动之前"调用 snapshotEnv()，
 * 一次性把 bootstrap（env-owned）配置项的 env 键当前值快照到 module-level
 * envSnapshot 对象。
 *
 * 后续所有"环境变量"读取走 snapshot，不直接调 Deno.env.get：
 * - 性能：O(1) 内存读 vs 系统调用
 * - 语义：bootstrap 项与 runtime 项同构（都是 Map 查找）
 * - 测试：通过 _resetEnvSnapshotForTest 重置快照状态
 *
 * 快照键来源为统一注册表（settings-registry.ts）中所有 scope=bootstrap 的
 * envKey（含原 env-only 白名单与划归的 storage/email/audit 启动期项）。
 */

import { CONFIG_DEFINITIONS } from "../../../shared/config/settings-registry.ts";

/** 快照白名单：所有 bootstrap 项的 envKey（原 ENV_ONLY_DEFINITIONS 已被注册表吸收） */
export function getBootstrapEnvKeys(): string[] {
  return CONFIG_DEFINITIONS.filter((d) => d.scope === "bootstrap")
    .map((d) => d.envKey!);
}

/** module-level 快照：env 键 -> 当前值（undefined 表示未设置） */
let envSnapshot: Record<string, string | undefined> = {};

/** 是否已执行 snapshotEnv（用于测试时跳过重复） */
let _snapshotted = false;

/**
 * 执行启动期快照。
 * 遍历 bootstrap 项的 envKey 把 Deno.env.get 结果写入 envSnapshot。
 *
 * 应在 main.ts 启动顺序的"DB 迁移之后"调用一次。
 */
export function snapshotEnv(): Record<string, string | undefined> {
  if (_snapshotted) {
    return envSnapshot;
  }

  const snap: Record<string, string | undefined> = {};
  for (const envKey of getBootstrapEnvKeys()) {
    snap[envKey] = Deno.env.get(envKey);
  }
  envSnapshot = snap;
  _snapshotted = true;
  return envSnapshot;
}

/** 读取快照值（供 service / route 使用） */
export function getEnvSnapshotValue(key: string): string | undefined {
  return envSnapshot[key];
}

/** 重置快照状态（仅供测试用） */
export function _resetEnvSnapshotForTest(): void {
  envSnapshot = {};
  _snapshotted = false;
}
