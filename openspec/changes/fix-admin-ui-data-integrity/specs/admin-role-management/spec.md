## ADDED Requirements

### Requirement: 用户角色编辑器预选当前角色
用户角色编辑器 SHALL 显示目标用户当前拥有的全部角色，并在打开时预选对应复选框。保存 SHALL 仅在管理员明确修改选择后替换角色集合。

#### Scenario: 打开拥有多个角色的用户编辑器
- **WHEN** 管理员打开一个拥有 user 和 moderator 角色的用户的角色编辑器
- **THEN** user 和 moderator 复选框均处于选中状态
