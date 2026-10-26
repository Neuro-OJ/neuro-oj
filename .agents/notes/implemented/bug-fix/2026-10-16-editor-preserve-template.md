# Agent Note: 题目编辑器保存草稿时保留题包模板

Status: implemented

## Problem

网页题目编辑器 `CodingProblemEditor.vue` 的 `buildContent()` 把
`template_content` 硬编码为空串，而共享草稿 `PUT /api/v1/problems/:id/draft`
是整体替换。题包导入写入的脚本模板在编辑器中没有编辑入口，只要在网页上保存或发布
一次 AI 题草稿，模板就被清空：

- 界面题（`submission_mode=ui`）评测时生成的脚本缺少模板函数，报
  `function 'get_config' not registered`（线上 P23）；
- 代码题丢失初始代码（线上 P25）。

线上已用基于 v0.10.6 的热修复镜像（同名标签覆盖
`ghcr.io/neuro-oj/noj-ui:v0.10.6`，内部标记
`v0.10.6+hotfix.template`）临时修复；重新拉取官方镜像会覆盖热修复，因此
下一个正式版本必须包含本修复。

## Decision

- 新增纯函数 `noj-ui/utils/aiDraftContent.ts` 的 `readAiDraftPassthrough()`，
  从草稿内容读出编辑器需要原样回写的字段（`submission_mode`、`template_content`），
  缺失或类型不对时返回 `undefined`，表单保持原值；空串模板按空串保留。
- 编辑器新增 `templateContent` ref：`applyDraftContent()` 读入，`buildContent()`
  原样回写，不再硬编码空串。原组件内的 `isSubmissionMode` 校验并入该纯函数。
- `noj-ui/tests/aiDraftContent_test.ts` 覆盖界面题模板读回、全部提交模式、空串与
  非法字段。

## Alternatives considered

- **后端在草稿 PUT 时合并缺失字段**：改变整体替换语义，影响 CLI/IDE
  等其他写入方，且无法区分“有意清空”和“未提供”，放弃。
- **在编辑器中提供模板编辑入口**：工作量大且不是本次缺陷的根因，留待后续需求。
- **只在 Vue 组件内加三行读写**：线上热修复采用此方式；合入 main
  时把读取逻辑抽成纯函数以便 deno 单测覆盖。

## Consequences

- 网页上保存/发布 AI 题草稿不再丢失题包模板；已被清空的题目需要重新导入题包或
  恢复模板后再发布。
- 编辑器回写模板为只读透传：今后若新增编辑器不编辑但草稿携带的字段，应同样加入
  `readAiDraftPassthrough()` 并回写。
