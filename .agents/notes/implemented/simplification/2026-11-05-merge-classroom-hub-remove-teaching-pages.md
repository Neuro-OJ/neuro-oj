# Agent Note: 合并班级研练中心并删除废弃教学工作台

Status: implemented

## Problem

0.11 的班级能力分散在三个入口：`/d/:slug/teaching`（教师工作台）、
`/d/:slug/my-learning`（学生学习页）与 `/d/:slug/classrooms`（班级研练中心）。
前两者与研练中心的「带班教学 / 我的学习」视角重复实现同一批
dashboard 接口与卡片，路由、面包屑、空态与分页各自维护；`TeachingDashboard`
组件也因此成为第二套布局。

## Decision

- 删除 `pages/d/:slug/teaching.vue`、`pages/d/:slug/my-learning.vue`、
  `components/education/TeachingDashboard.vue` 及其单测。
- 班级研练中心成为唯一入口：首页教学/学习卡片跳转到
  `/d/:slug/classrooms?view=teaching|learning`（路径用 `workspacePath` 生成，
  query 走对象形式，避免 section 正则拒绝查询串）。
- 同步删除面包屑与 i18n 中 `teaching`、`myLearning` 条目，更新
  `docs/workspace.md` 与导航测试。
- 研练中心内「我的作业任务」「班级教学任务列表」统一改为与
  `ClassroomContests` 一致的卡片区块：`border` 容器 + 带底边框的标题栏
  （图标、标题、共 N 项）+ `p-5` 内容区 + `border-t` 分页页脚；空态改为
  单行紧凑提示，不再使用整块虚线占位。
- `AsyncContent` 新增 `padding: "normal" | "compact" | "none"`，卡片内使用
  `none` 由调用方控制留白。

## Alternatives considered

- 保留旧页面并加 301 跳转：三个入口的 dashboard 请求与分页状态仍会分叉，
  等于继续维护重复实现。
- 只在旧页面套用新卡片样式：入口重复的问题没有解决。

## Consequences

- 旧书签访问 `/teaching`、`/my-learning` 将落到 404；这两个页面在
  0.11 导航中已无入口，未做兼容跳转。
- 班级研练中心的两个视角共享同一套分页状态，切换视角时回到第一页。
- 组件测试新增 `ClassroomsHub.spec.ts` 覆盖视角切换、事件刷新与分页读取。
