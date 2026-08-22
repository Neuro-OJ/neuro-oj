## Why

做题时修改过代码或保存了草稿后，用户只能手动删除内容，无法快速回到题目提供的启动模板。

## What Changes

- 在非竞赛做题工作区提供“重置”按钮。
- 重置前确认覆盖当前代码；确认后重新获取题目模板并替换代码与本地草稿。
- 模板不可用时保留当前代码并提示失败原因。

## Capabilities

### New Capabilities

- `code-editor-template-reset`: 让做题用户安全地将代码恢复为题目启动模板。

### Modified Capabilities

- 无。

## Impact

- `noj-ui/components/editor/EditorWorkspace.vue`
- `noj-ui/components/editor/EditorToolbar.vue`
