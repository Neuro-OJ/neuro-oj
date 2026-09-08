/**
 * test-parallel 分片参数解析。
 *
 * 独立成模块，避免 CLI 脚本顶层副作用影响单元测试导入。
 */

/**
 * 解析 --shards 参数，控制实际运行的分片数量。
 *
 * 默认 2（当前脚本内置 unit/db 两个分片）；非法值回退默认。
 * 超过内置分片数时按内置分片数截断。
 */
export function parseShardArgs(args: string[]): number {
  const idx = args.indexOf("--shards");
  if (idx === -1) return 2;
  const raw = args[idx + 1];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 2;
}
