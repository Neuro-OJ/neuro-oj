/**
 * test-parallel 分片参数解析。
 *
 * 独立成模块，避免 CLI 脚本顶层副作用影响单元测试导入。
 */

/**
 * 解析 --shards 参数，控制实际运行的分片数量。
 *
 * @param args - 命令行参数
 * @param availableShards - 脚本内置的分片数量（默认 2：unit / db）
 * @returns 实际要运行的分片数
 * @throws 参数非法或超过内置分片数时抛错（不再静默截断）
 */
export function parseShardArgs(
  args: string[],
  availableShards = 2,
): number {
  const idx = args.indexOf("--shards");
  if (idx === -1) return availableShards;
  const raw = args[idx + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--shards 必须为 ≥1 的整数，实际 "${raw}"`);
  }
  if (n > availableShards) {
    throw new Error(
      `--shards ${n} 超过内置分片数 ${availableShards}（当前仅 unit/db 两个分片）；` +
        `请改用 --shards ${availableShards}，或先扩展 scripts/test-parallel.ts 的 SHARDS`,
    );
  }
  return n;
}
