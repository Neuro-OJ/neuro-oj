/**
 * 公开标识 URL 构造工具。
 *
 * 用户 → username；题目 → display_id（无则回退内部 UUID）；
 * 竞赛/训练/提交/帖子/公告 → public_id。
 */

export function problemUrl(id: string, displayId?: string): string {
  return `/problems/${displayId || id}`;
}

export function userUrl(username: string): string {
  return `/users/${username}`;
}

export function publicUrl(
  kind: 'contest' | 'training' | 'submission' | 'post' | 'announcement',
  publicId: string,
): string {
  const base = {
    contest: 'contests',
    training: 'trainings',
    submission: 'submissions',
    post: 'community/posts',
    announcement: 'announcements',
  }[kind];
  return `/${base}/${publicId}`;
}
