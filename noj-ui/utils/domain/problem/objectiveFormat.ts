/**
 * 客观题提交记录展示用的纯函数工具。
 */

export interface ObjectiveQuestionLike {
  type: 'single' | 'multiple' | 'judge';
  options: { key: string; text: string }[];
}

/** 将作答值转换为可读文本。判断题显示“正确/错误”，选择题显示选项内容。 */
export function formatObjectiveAnswer(
  q: ObjectiveQuestionLike | undefined,
  values: (string | boolean)[],
): string {
  if (!q) return values.join(', ');
  if (q.type === 'judge') {
    return values.map((v) => (v === true ? '正确' : '错误')).join(', ');
  }
  const optMap = new Map(q.options.map((o) => [o.key, o.text]));
  return values.map((v) => `${v}. ${optMap.get(String(v)) ?? ''}`.trim()).join('；') ||
    '未作答';
}
