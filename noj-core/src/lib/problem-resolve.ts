/**
 * 题目双索引解析工具。
 *
 * 支持 UUID、display_id（如 P1001 / U42）、纯数字 ID（兼容旧 seed 数据）以及
 * 任意非标准 ID 格式。供 problems 路由与自测路由共用。
 */

import {
  getProblem,
  getProblemByTypeAndNumber,
} from "../domains/catalog/index.ts";
import { NotFoundError } from "./errors.ts";
import { isUuid } from "./public-id.ts";

/**
 * 双索引查找题目。
 * 先通过正则判断 id 格式，避免每次 display_id 请求都先多一次 UUID 查询。
 * 对于不匹配任何已知格式的 ID，fallback 到 `getProblem(id)` 直接查找。
 */
export function resolveProblem(id: string) {
  // UUID / 纯数字（兼容旧 seed 数据 1001/1002/1003 等）：直接按 id 精确查找
  if (isUuid(id) || /^\d+$/.test(id)) {
    return getProblem(id);
  }

  // display_id 格式：解析 "P1001" / "U42" → (type, number)
  const match = id.match(/^([UuPp])(\d+)$/);
  if (match) {
    const type = match[1].toUpperCase();
    const number = parseInt(match[2], 10);
    return getProblemByTypeAndNumber(type, number);
  }

  // fallback：尝试直接按 id 查找（兼容非标准 ID 格式）
  return getProblem(id);
}

/**
 * 将题目标识解析为内部题目 UUID；题目不存在时返回 null。
 */
export async function resolveProblemIdOrNull(
  reference: string,
): Promise<string | null> {
  try {
    const problem = await resolveProblem(reference);
    return problem.id;
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/**
 * 将题目标识解析为内部题目 UUID；题目不存在时抛 NotFoundError。
 */
export async function resolveProblemIdOrThrow(
  reference: string,
): Promise<string> {
  const problem = await resolveProblem(reference);
  return problem.id;
}
