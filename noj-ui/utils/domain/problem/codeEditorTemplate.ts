/**
 * 用题目模板替换当前代码草稿。
 *
 * 只有拿到非空模板后才清除旧草稿和更新编辑器，避免模板请求失败导致代码丢失。
 */
export async function restoreCodeTemplate(options: {
  fetchTemplate: () => Promise<string | null>;
  clearDraft: () => void;
  setCode: (template: string) => void;
}): Promise<boolean> {
  const template = await options.fetchTemplate();
  if (!template) return false;

  options.clearDraft();
  options.setCode(template);
  return true;
}
