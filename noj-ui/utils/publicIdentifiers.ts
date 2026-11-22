/**
 * 公开标识 URL 构造工具。
 *
 * 用户 → username；题目 → display_id（无则回退内部 UUID）；
 * 竞赛/训练/提交/帖子/公告 → public_id。
 */

import { defaultProblemReference } from './default-workspace.ts';
export function problemUrl(id: string, displayId?: string): string {
  const reference = defaultProblemReference(displayId ?? '');
  return reference ? `/d/main/problems/${encodeURIComponent(reference)}` : `/problems/${encodeURIComponent(id)}`;
}

/**
 * 域内题目链接：`display_id` 形如 `{slug}:{number}`（profile 聚合下发）。
 *
 * 0.11 起题目属于域，链接必须带**目标域**，不能假设都在默认域 `main`
 * （审计 F5：个人主页"创建的题目"原先把所有题都指到 `/d/main/...`）。
 * 无法解析的引用退化为旧逻辑（默认域）。
 */
export function workspaceProblemUrl(displayId: string): string {
  const match = /^([a-z][a-z0-9-]{0,47}):([1-9]\d*)$/.exec(displayId);
  if (!match) return problemUrl('', displayId);
  return `/d/${match[1]}/problems/${encodeURIComponent(match[2]!)}`;
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
  return `${['contest', 'submission'].includes(kind) ? '/d/main' : ''}/${base}/${encodeURIComponent(publicId)}`;
}
