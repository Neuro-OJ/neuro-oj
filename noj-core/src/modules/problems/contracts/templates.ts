/**
 * 题目版本模板/界面只读合同。
 *
 * contests 只读取此合同返回的版本绑定内容；支持包存储实现留在 problems 内部，
 * 不进入 contests 公共门面，也不承载任何写入能力。
 */
export {
  resolveProblemTemplate,
  resolveProblemUiHtml,
} from "../services/support-package.ts";
