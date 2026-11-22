/**
 * 题目包导入 / 建题的纯逻辑（无 Nuxt 依赖，可独立单元测试）。
 *
 * 编辑器与「从题目包导入」页共用：文件校验、可见性规则、导入结果与错误文案。
 */
import type { ApiErrorInfo } from './apiError.ts';

/** 校验所选文件是否为 zip；合法返回 null，否则返回提示文案。 */
export function validateZipFileName(name: string): string | null {
  return name.toLowerCase().endsWith('.zip') ? null : '仅支持 .zip 格式文件';
}

/** 使用域题包导入的响应。 */
export interface BundleImportResult {
  problem_id: string;
  number: number;
  draft_revision: number;
  published?: { version: number; unchanged?: boolean } | null;
}

/** 导入成功提示。 */
export function bundleImportSuccessMessage(result: BundleImportResult): string {
  const label = String(result.number);
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
 * (domain_id, number) 走更新既有题目路径，而该路径必须携带编辑基线（428）。新建入口
 * 没有基线可带，原始文案「保存草稿必须携带 If-Match」会让人摸不着头脑，这里改写成
 * 可操作的提示。
 */
export function bundleImportErrorMessage(err: ApiErrorInfo): string {
  if (err.code === 'DRAFT_REVISION_REQUIRED' || err.status === 428) {
    return '题包 problem.json 中的 number 与已有题目重复：如需更新该题，请到该题编辑页上传支持包；如需新建，请删除 number 字段后重试';
  }
  return err.message;
}
