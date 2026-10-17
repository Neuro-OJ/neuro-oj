/**
 * AI 题共享草稿内容中编辑器需要原样回写的字段。
 *
 * 草稿 `PUT /api/v1/problems/:id/draft` 是整体替换：编辑器没有编辑入口的字段
 * （题包导入写入的脚本模板）也必须从加载的草稿读出、保存时原样带回。曾经把
 * `template_content` 硬编码为空串，网页上改题后发布，界面题模板被清空，评测时
 * 生成的脚本缺少模板函数（`function 'get_config' not registered`）。
 */
import type { SubmissionMode } from './problemView.ts';

const SUBMISSION_MODES: readonly SubmissionMode[] = [
  'code',
  'artifact',
  'prediction',
  'ui',
];

/** 从草稿内容中读出的透传字段；缺失或类型不对时为 `undefined`（保持表单原值）。 */
export interface AiDraftPassthrough {
  submission_mode?: SubmissionMode;
  template_content?: string;
}

/** 读取草稿内容里的提交模式与脚本模板。 */
export function readAiDraftPassthrough(
  content: Record<string, unknown>,
): AiDraftPassthrough {
  const result: AiDraftPassthrough = {};
  const mode = content.submission_mode;
  if (
    typeof mode === 'string' &&
    (SUBMISSION_MODES as readonly string[]).includes(mode)
  ) {
    result.submission_mode = mode as SubmissionMode;
  }
  if (typeof content.template_content === 'string') {
    result.template_content = content.template_content;
  }
  return result;
}
