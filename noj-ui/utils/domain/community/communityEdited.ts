/**
 * 社区内容"是否已编辑"判断工具。
 *
 * Post 与 Comment 编辑时都会更新 updated_at（见 community-post-crud / community-comments），
 * 因此用 updated_at !== created_at 判定是否被编辑过。
 * 返回 true 时前端展示「已编辑」标签。
 */
export function isCommunityEdited(createdAt: string, updatedAt: string): boolean {
  if (!createdAt || !updatedAt) return false;
  return updatedAt !== createdAt;
}
