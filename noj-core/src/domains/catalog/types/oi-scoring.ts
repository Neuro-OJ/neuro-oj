import type { OiSubtask } from "./runtime-config.ts";

/** Hydro 默认整数等分：余数分给末尾测试点；兼容旧配置的小数分值。 */
export function distributeOiPoints(total: number, count: number): number[] {
  if (count === 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from(
    { length: count },
    (_, index) =>
      base + Math.max(0, Math.min(1, remainder - (count - 1 - index))),
  );
}

/** 展开测试点满分，不改写原始配置；显式零分不作为缺省值。 */
export function oiCaseMaxScores(subtask: OiSubtask): number[] {
  if (subtask.scoring !== "sum") {
    return subtask.cases.map((testCase) => testCase.score ?? subtask.score);
  }
  const explicit = subtask.cases.reduce(
    (sum, testCase) => sum + (testCase.score ?? 0),
    0,
  );
  const missing =
    subtask.cases.filter((testCase) => testCase.score === undefined).length;
  const defaults = distributeOiPoints(
    Math.max(0, subtask.score - explicit),
    missing,
  );
  let next = 0;
  return subtask.cases.map((testCase) => testCase.score ?? defaults[next++]);
}
