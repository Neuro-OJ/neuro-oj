/**
 * test-parallel 分片/并行度参数解析。
 *
 * 独立成模块，避免 CLI 脚本顶层副作用影响单元测试导入。语义：
 * - `--shards N`：把**全部**所选测试划分成 N 片（不再按内置分片清单截断，
 *   N=1 时全部测试都在同一片，不允许漏跑业务测试）；
 * - `--jobs M`：同时运行最多 M 片；每片有自己的数据库、Redis 容器与存储目录，
 *   因此并行度受资源上限约束。
 */
import {
  DEFAULT_JOB_COUNT,
  DEFAULT_SHARD_COUNT,
  MAX_JOB_COUNT,
  MAX_SHARD_COUNT,
} from "./test-parallel-shards.ts";

function parsePositiveInteger(raw: string | undefined, option: string): number {
  if (raw === undefined) throw new Error(`${option} 缺少数值`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${option} 必须为 ≥1 的整数，实际 "${raw}"`);
  }
  return value;
}

/**
 * 解析 `--shards`：分片数量上限只受资源约束，不再受"内置分片条数"约束。
 *
 * @param args - 命令行参数
 * @param maxShards - 允许的最大分片数
 * @param defaultShards - 未给出参数时的默认分片数
 */
export function parseShardArgs(
  args: string[],
  maxShards = MAX_SHARD_COUNT,
  defaultShards = DEFAULT_SHARD_COUNT,
): number {
  const idx = args.indexOf("--shards");
  if (idx === -1) return defaultShards;
  const count = parsePositiveInteger(args[idx + 1], "--shards");
  if (count > maxShards) {
    throw new Error(
      `--shards ${count} 超过上限 ${maxShards}；` +
        `继续放大只会增加模板克隆与容器创建成本，请改用 --shards ${maxShards}`,
    );
  }
  return count;
}

/**
 * 解析 `--jobs`：同时运行的分片数。
 *
 * @param args - 命令行参数
 * @param maxJobs - 允许的最大并行度
 * @param defaultJobs - 未给出参数时的默认并行度
 */
export function parseJobArgs(
  args: string[],
  maxJobs = MAX_JOB_COUNT,
  defaultJobs = DEFAULT_JOB_COUNT,
): number {
  const idx = args.indexOf("--jobs");
  if (idx === -1) return defaultJobs;
  const count = parsePositiveInteger(args[idx + 1], "--jobs");
  if (count > maxJobs) {
    throw new Error(
      `--jobs ${count} 超过上限 ${maxJobs}；` +
        "每个 child 都占用独立数据库与 Redis 容器，不能无限放大",
    );
  }
  return count;
}
