/** 使用已解析的题目内部 ID 构造做题历史；竞赛仍走自己的提交权限边界。 */
export function getEditorHistoryUrl(problem: { id: string } | null, contestId = ''): string {
  if (contestId) {
    return `/api/v1/contests/${encodeURIComponent(contestId)}/my-submissions?per_page=100`;
  }
  if (!problem) return '';
  return `/api/v1/submissions?problem_id=${encodeURIComponent(problem.id)}&per_page=30`;
}
