/** 返回题目默认答题模板接口地址。 */
export function getProblemTemplateUrl(problemId: string): string {
  return `/api/v1/problems/${problemId}/template`;
}
