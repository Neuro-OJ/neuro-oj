## Purpose

定义 Neuro OJ 管理员权限系统规范，包括管理中间件、角色提升 API
及种子脚本初始化。API 路径前缀为 `/api/v1/admin`，默认角色为 `user` 和 `admin`
两级。

本文档为基础规范的 delta 补充，反映管理路由组织结构的调整及新增管理端点。

## MODIFIED Requirements

### Requirement: 管理路由统一组织

系统 SHOULD 将所有 admin 端点集中到 `routes/admin.ts` 文件中统一管理，各功能模块在 admin.ts 内按 domain 分组，统一通过路由组级 `authMiddleware` + `adminMiddleware` 保护。

#### Scenario: 管理员访问统一后的管理端点
- **WHEN** 管理员访问所有 `/api/v1/admin/*` 端点
- **THEN** 系统响应与重构前一致，无破坏性变更

### Requirement: 仅管理员可访问管理端点

系统 SHALL 提供 `adminMiddleware`，用于保护非题目类的管理端点。
题目 CRUD 不再依赖 adminMiddleware，改为服务层根据 type+owner 进行权限判断。

所有管理端点（除已使用自有权限模型的题目 CRUD 外）MUST 依次通过 `authMiddleware` 和 `adminMiddleware` 保护。

#### Scenario: 普通用户访问管理端点

- **WHEN** 已登录但角色为 `user` 的用户携带有效 JWT 调用管理员端点
- **THEN** 系统返回 HTTP 403，错误信息为 "需要管理员权限"

#### Scenario: 未登录用户访问管理端点

- **WHEN** 未携带 JWT 的用户调用管理员端点
- **THEN** 系统在 `adminMiddleware` 之前由 `authMiddleware` 返回 HTTP 401

## ADDED Requirements

### Requirement: 管理员可查看仪表盘统计数据

系统 SHALL 提供 `GET /api/v1/admin/dashboard/stats` 端点，返回平台关键统计指标。

详细规范见 `admin-dashboard-api` spec。

#### Scenario: 管理员成功获取统计数据

- **WHEN** 已登录管理员 GET `/api/v1/admin/dashboard/stats`
- **THEN** 系统返回平台统计指标

### Requirement: 管理员可查看任意提交详情

系统 SHALL 提供 `GET /api/v1/admin/submissions/:id` 端点，允许管理员查看任意提交的完整详情。

详细规范见 `admin-submission-detail` spec。

#### Scenario: 管理员成功查看提交详情

- **WHEN** 管理员 GET `/api/v1/admin/submissions/:id`
- **THEN** 系统返回提交完整详情

### Requirement: 管理员可删除提交记录

系统 SHALL 提供 `DELETE /api/v1/admin/submissions/:id` 端点，允许管理员删除提交记录。

详细规范见 `admin-submission-detail` spec。

#### Scenario: 管理员成功删除提交

- **WHEN** 管理员 DELETE `/api/v1/admin/submissions/:id`
- **THEN** 系统返回 HTTP 204
