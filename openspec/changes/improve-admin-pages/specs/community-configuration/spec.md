## MODIFIED Requirements

### Requirement: 社区配置预设

系统 SHALL 在前端提供 `public`、`private`、`knowledge` 三个预设（仅覆盖布尔开关），预设选择 SHALL 存储在前端（localStorage），应用预设 SHALL 将预设值写入页面配置草稿（不直接调用后端 preset API），并进入未保存状态。

#### Scenario: 应用私域预设

- **WHEN** 管理员选择 `private` 并应用
- **THEN** 页面开关草稿更新为私域配置（要求登录阅读、开放三类内容、启用互动、关闭外链图片），页面显示未保存更改标识

#### Scenario: 应用只读知识库预设

- **WHEN** 管理员选择 `knowledge` 并应用
- **THEN** 题解和讨论可读，普通用户写操作、动态、活动、关注和互动关闭，页面显示未保存更改标识

#### Scenario: 预设选择被记忆

- **WHEN** 管理员选择预设后刷新或重新打开页面
- **THEN** 下拉框显示之前选择的预设（来自 localStorage）

#### Scenario: 保存预设更改

- **WHEN** 管理员应用预设后点击"保存更改"
- **THEN** 系统逐个写入对应设置项，成功后清除未保存标识
