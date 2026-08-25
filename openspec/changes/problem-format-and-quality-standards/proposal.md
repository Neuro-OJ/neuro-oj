## Why

Neuro OJ 已有统一题目包导入规范，但文档与实现存在不一致（如 `categories` 已退役为 `tags`），且缺少题目质量建议规范。出题人缺少命名、tag、测试数据可见性、评测脚本质量等方面的成文指导。

## What Changes

- 修订 `problem-bundle-import` 规范：对齐 `tags`、补全包结构/版本/校验、标准化测试数据推荐约定、覆盖 LLM 调用题与客观题边界。
- 新增 `problem-quality-guidelines` 规范：题目命名（含来源署名）、tag 适用（含 LMCC 标签体系）、题面与数据质量、评测脚本质量、难度与发布流程、测试数据可见性策略。
- noj-docs 在 problemsetters 下新增“Neuro OJ 题目规范及质量要求”子章节，旧页面改为重定向。

## Capabilities

### Modified Capabilities
- `problem-bundle-import`: manifest 字段对齐、包结构/版本/校验补全、测试数据推荐约定、特殊题型说明。

### New Capabilities
- `problem-quality-guidelines`: 题目质量建议规范（SHOULD/建议，不强制）。

## Impact

- 仅文档与 OpenSpec 规范变更，无代码/数据库/测试变更。
- noj-docs 在 `/problemsetters/standards/` 新增子章节，更新导航与旧页面重定向。
