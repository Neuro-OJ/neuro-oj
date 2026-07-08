/**
 * 题目样例解析器（issue #28）。
 *
 * 题目 description 是 Markdown 文本，约定使用 `## 样例输入` / `## 样例输出`
 * 段标记可见样例。导入导出场景需要单独抽取出这些段。
 *
 * 支持的 heading 形式（# 表示 1-3 个 `#`）：
 * - `## 样例输入` / `## 样例输入 #1`
 * - `### Sample Input` 同样识别（英文混排场景）
 *
 * 配对规则：按出现顺序，遇到 `样例输入` 后必须紧跟 `样例输出` 才能配对。
 * 连续两个输入时第一个被丢弃；末尾孤立输入/输出被忽略。
 */

export interface SamplePair {
  input: string;
  output: string;
}

interface Hit {
  /** "输入" 或 "输出" */
  type: "输入" | "输出";
  /** heading 在原文的起始位置（用于切片） */
  start: number;
  /** heading 行结束位置（用于取正文起点） */
  headingEnd: number;
}

/**
 * 匹配样例相关 heading（大小写不敏感）：
 *   ## 样例输入 / ## 样例输出 / ## Sample Input / ## Sample Output 等。
 * 捕获组为 input/output/输入/输出 之一。 可选尾随 " #N" 编号。
 */
const HEADING_RE =
  /^#{1,3}\s*样例\s*(input|output|输入|输出)(?:\s*#\s*\d+)?\s*$/gim;

const KEY_MAP: Record<string, "输入" | "输出"> = {
  "输入": "输入",
  "输出": "输出",
  "input": "输入",
  "output": "输出",
};

function collectHits(description: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of description.matchAll(HEADING_RE)) {
    const start = m.index ?? 0;
    const key = (m[1] ?? "").toLowerCase();
    const type = KEY_MAP[key];
    if (!type) continue;
    hits.push({
      type,
      start,
      headingEnd: start + m[0].length,
    });
  }
  return hits;
}

/**
 * 从 description 抽取所有可见样例对。
 * 不解析 Markdown 代码块——样例本身就是预格式化文本。
 */
export function extractSamples(description: string): SamplePair[] {
  const hits = collectHits(description);
  if (hits.length === 0) return [];

  // 取第 i 个 heading 段的正文：从 headingEnd 到下一个 heading start
  const sectionContent = (i: number): string => {
    const hit = hits[i];
    const nextStart = i + 1 < hits.length
      ? hits[i + 1].start
      : description.length;
    return description.slice(hit.headingEnd, nextStart).trim();
  };

  // 按出现顺序配对：每个 "输入" 段配对其后第一个 "输出" 段
  const pairs: SamplePair[] = [];
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].type !== "输入") continue;
    if (i + 1 >= hits.length) break;
    if (hits[i + 1].type !== "输出") {
      // 输入后紧跟另一个输入 → 跳过当前输入
      continue;
    }
    pairs.push({
      input: sectionContent(i),
      output: sectionContent(i + 1),
    });
    i++; // 消耗已配对的输出
  }
  return pairs;
}
