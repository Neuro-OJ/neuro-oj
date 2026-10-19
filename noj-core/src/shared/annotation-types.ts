/** 使用域由路由决定；原文身份始终显式携带，不读取导航偏好。 */
export type AnnotationTarget =
  | {
    kind: "problem";
    reference: string;
    version_id?: string;
    field: string;
    contest_id?: string;
  }
  | { kind: "submission"; submission_id: string; file_name: string }
  | { kind: "solution"; post_id: string };

/** 样例输入输出保留空白与 Markdown 符号，与源码一样按纯文本定位。 */
export function annotationIsPlainText(target: AnnotationTarget): boolean {
  return target.kind === "submission" ||
    target.kind === "problem" &&
      /^samples\.\d+\.(input|output)$/.test(target.field);
}

/** 文本块内的 UTF-16 范围与不可变原文哈希共同定位引用。 */
export interface AnnotationAnchor {
  block_id: string;
  start: number;
  end: number;
  quote: string;
  before: string;
  after: string;
  start_line: number;
  end_line: number;
}

/** 原文分块由服务端生成，页面选择只提交块身份和范围。 */
export interface AnnotationBlock {
  id: string;
  text: string;
  start_line: number;
}
