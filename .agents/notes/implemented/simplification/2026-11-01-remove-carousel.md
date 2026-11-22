# Agent Note: 下线首页轮播

Status: implemented

## Problem

首页轮播（实例级 + 域级，`carousel_slides`
表、管理页、图片上传与授权读取）与公告 功能重叠。#698
审查时只读查询生产库：实例运行约两个月，`carousel_slides` 为 0 行，
首页一直显示无幻灯片时的默认占位。整套功能约 1.5k 行代码与测试持续消耗维护成本。

## Decision

- 删除 core 的轮播服务、实例/域公开与管理路由、schema，迁移 `0129` 删除
  `carousel_slides` 表；存储引用核对与域配额统计不再查询该表。
- 删除 UI 的轮播组件、管理页、域设置入口、BFF `carousel`
  分区；域首页头部改为静态 `WorkspaceHero`，展示域名称与简介（与原空态一致）。
- 审计动作 `carousel.*` 保留在类型、CHECK
  约束与管理端筛选中，以便查看历史审计记录。

## Alternatives considered

- 默认关闭、保留代码：仍要维护路由、测试和存储授权逻辑，与「零使用」不相称。
- 把轮播并入公告（公告加图片字段）：没有需求来源，属于新增功能。

## Consequences

- 被删除接口直接返回 404，不登记到已下线接口表。
- 已上传的轮播图片在对象存储中失去引用，可用 `deno task storage:audit`
  盘点后清理； 生产实例无此类数据。
- 浏览器 E2E 与 BFF SSR 验证改用公告接口验证局部降级。
