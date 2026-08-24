## Why

代码编辑器设置中的“清除当前草稿”目前只删除浏览器里的草稿记录，没有重新加载题目启动模板，导致用户清除修改后得到空白编辑器，无法回到可直接作答的初始代码。需要统一清除草稿与模板恢复的行为，修复 issue312。

## What Changes

- 标准题库做题页点击“清除当前草稿”后，清除旧草稿并恢复题目当前的预设代码框架。
- 模板请求失败或题目没有模板时，保留现有编辑器内容和本地草稿，并显示失败提示。
- 为该行为增加回归测试，覆盖成功恢复和失败不覆盖两条路径。

## Capabilities

### New Capabilities

- `code-editor-clear-draft-template`: 定义清除代码草稿后恢复题目预设框架的行为。

### Modified Capabilities

- 无。

## Impact

- `noj-ui/components/editor/EditorWorkspace.vue`：将设置面板的清除草稿事件接入模板恢复流程。
- `noj-ui/tests/`：增加模板恢复行为测试或相应纯函数测试。
- 不修改后端 API；继续复用现有题目模板接口和统一错误提示。
