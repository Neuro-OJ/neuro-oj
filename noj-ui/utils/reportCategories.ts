/** 举报分类（与后端 types/community.ts REPORT_CATEGORIES 保持一致） */
export const REPORT_CATEGORIES = [
  '违法违规',
  '人身侵权',
  '涉嫌欺诈',
  '侵权抄袭',
  '垃圾信息',
  '站外风险引流',
  'AI生成内容问题',
  '其他',
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
