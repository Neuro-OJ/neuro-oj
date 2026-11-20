# Agent Note: 域社区发帖校验复用当前事务

Status: implemented

## Problem

Public/Mixed 浏览器旅程中，普通成员发布讨论挂起。真实数据库停在板块查询后的
idle-in-transaction：域写入事务内的板块角色校验却重新使用全局连接，单连接池
无法继续。新用户审核期的作者读取也存在同样的执行器遗漏。

## Decision

板块发帖权限、角色授权和发布状态计算均接受现有 CommunityScope，并使用
`communityDb(scope)`。帖子与评论调用继续传递同一 scope，保持默认域平台角色
政策与其他域成员权限不变，不复制另一份授权规则。

## Alternatives considered

- 调高连接池后忽略：小连接池仍会挂起，没有修复遗漏的事务归属。
- 取消板块权限或新用户审核：会改变已确认的社区治理规则。

## Consequences

community 85 项测试、core 类型和 lint 通过。相同独立运行套件重新执行真实
Public/Mixed 旅程，普通成员发帖、另一成员评论和点赞步骤已通过，约 1 秒完成。
完整浏览器结果和最终 CI 仍单独记录，不把本次定向恢复写成全套通过。
