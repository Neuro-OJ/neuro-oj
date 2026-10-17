/**
 * 题目包导入 / 建题的纯逻辑（无 Nuxt 依赖，可独立单元测试）。
 *
 * 编辑器与「从题目包导入」页共用：文件校验、可见性规则、导入结果与错误文案。
 */
import type { ApiErrorInfo } from './apiError.ts';

export type ProblemType = 'U' | 'P';
export type ProblemVisibility = 'public' | 'private';

/** 校验所选文件是否为 zip；合法返回 null，否则返回提示文案。 */
export function validateZipFileName(name: string): string | null {
  return name.toLowerCase().endsWith('.zip') ? null : '仅支持 .zip 格式文件';
}

/**
 * 题目实际提交的可见性。
 *
 * 主题库（P）题目必须公开（服务端校验「P 型题目必须公开」）；编辑器只在用户题库（U）
 * 下展示可见性选择，因此 P 型一律按公开提交，避免隐藏字段残留「私有」导致建题失败。
 */
export function effectiveVisibility(
  type: ProblemType,
  visibility: ProblemVisibility,
): ProblemVisibility {
  return type === 'P' ? 'public' : visibility;
}

/** `POST /api/v1/problems/import-bundle` 的响应数据（仅前端用到的字段）。 */
export interface BundleImportResult {
  id: string;
  display_id?: string;
  title?: string;
  published?: { version: number; unchanged?: boolean } | null;
}

/** 导入成功提示。 */
export function bundleImportSuccessMessage(result: BundleImportResult): string {
  const label = result.display_id ?? result.title ?? '题目';
  if (result.published) {
    return result.published.unchanged
      ? `已导入 ${label}，内容未变化，继续使用 V${result.published.version}`
      : `已导入 ${label} 并发布 V${result.published.version}`;
  }
  return `已导入 ${label}（草稿：核对后发布即可作答）`;
}

/**
 * 「从题目包导入」的错误文案。
 *
 * 管理员导入的包若在 problem.json 写了 `number` 且与已有题目重复，服务端会按
 * (type, number) 走**更新既有题目**路径，而该路径必须携带编辑基线（428）。新建入口
 * 没有基线可带，原始文案「保存草稿必须携带 If-Match」会让人摸不着头脑，这里改写成
 * 可操作的提示。
 */
export function bundleImportErrorMessage(err: ApiErrorInfo): string {
  if (err.code === 'DRAFT_REVISION_REQUIRED' || err.status === 428) {
    return '题包 problem.json 中的 number 与已有题目重复：如需更新该题，请到该题编辑页上传支持包；如需新建，请删除 number 字段后重试';
  }
  return err.message;
}
