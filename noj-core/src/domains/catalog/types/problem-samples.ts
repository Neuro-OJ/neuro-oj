import { BadRequestError } from "../../../shared/base/errors.ts";

/** 独立的公开题目样例；与隐藏测试数据分开保存。 */
export interface ProblemSample {
  id: string;
  input: string;
  output: string;
  explanation?: string;
}

/** 样例大小按 UTF-8 字节计，拒绝重复标识及超大公开响应。 */
export function validateProblemSamples(
  value: unknown,
): asserts value is ProblemSample[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new BadRequestError("样例必须是最多 100 项的数组");
  }
  const ids = new Set<string>();
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const sample of value) {
    if (
      !sample || typeof sample !== "object" ||
      typeof sample.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(sample.id) || ids.has(sample.id) ||
      typeof sample.input !== "string" || typeof sample.output !== "string" ||
      (sample.explanation !== undefined &&
        typeof sample.explanation !== "string")
    ) {
      throw new BadRequestError(
        "样例必须包含不重复的 id、input、output 及可选说明",
      );
    }
    ids.add(sample.id);
    const size = encoder.encode(sample.input).length +
      encoder.encode(sample.output).length +
      encoder.encode(sample.explanation ?? "").length;
    if (size > 256 * 1024) throw new BadRequestError("单个样例超过 256 KiB");
    bytes += size;
  }
  if (bytes > 1024 * 1024) throw new BadRequestError("样例总大小超过 1 MiB");
}
