## Why

题目详情页的“加入题单”面板在未点击入口时仍渲染内容并占据页面布局，导致题目信息区出现与操作无关的文字和按钮。应仅在用户主动打开面板后展示题单选择与创建操作。

## What Changes

- 将“加入题单”面板的内容延迟到用户点击入口后再挂载和展示。
- 关闭面板时清理临时选择与新建题单表单状态，避免下次打开时保留过期界面。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `training-plans`: 题目详情页的“加入题单”入口仅在用户打开面板后展示题单操作内容。

## Impact

- 影响 `noj-ui/components/feature/training/AddToTrainingMenu.vue` 的前端渲染与交互状态。
- 不改变题单 API、数据模型或权限行为。
