## Purpose

定义 Neuro OJ 公开标识（public identifier）的生成规则、API 双解析语义与前端 URL 规则。UUID 仅作为内部主键，用户可见实体对外使用可读公开标识。

## Requirements

### Requirement: 公开标识生成规则

系统 SHALL 在创建以下实体时生成不可变公开标识：竞赛 `ct-`、训练 `tr-`、提交 `sub-`、社区帖子 `post-`、公告 `ann-`，后接 8 位字符，字符集为 `123456789abcdefghjkmnpqrstuvwxyz`。

#### Scenario: 生成短码格式

- **WHEN** 创建竞赛
- **THEN** 返回的 `public_id` 匹配 `^ct-[123456789abcdefghjkmnpqrstuvwxyz]{8}$`

#### Scenario: 公开标识不可变

- **WHEN** 更新实体标题/内容
- **THEN** `public_id` 不发生变化

### Requirement: API 双解析

系统 SHALL 在目标实体的详情/更新/删除路由中同时接受内部 UUID 与公开标识作为路径参数。

#### Scenario: 使用 public_id 访问

- **WHEN** 请求 `/api/v1/contests/ct-8f3k2xq`
- **THEN** 系统解析到对应竞赛并返回正常响应

#### Scenario: 使用 UUID 访问

- **WHEN** 请求 `/api/v1/contests/<uuid>`
- **THEN** 系统仍按内部主键解析并返回正常响应

### Requirement: 用户与题目标识

用户公开标识 SHALL 使用 `username`，题目公开标识 SHALL 使用 `display_id`（`type + number`）。

#### Scenario: 用户路由支持 username

- **WHEN** 请求 `/api/v1/users/zhangsan`
- **THEN** 系统解析到对应用户并返回正常响应

#### Scenario: 题目路由支持 display_id

- **WHEN** 请求 `/api/v1/problems/P100`
- **THEN** 系统解析到对应题目并返回正常响应

### Requirement: 前端 URL 使用公开标识

前端（含 admin）生成用户可见 URL 时 SHALL 使用 `username` / `display_id` / `public_id`，不得使用 UUID。

#### Scenario: 用户链接

- **WHEN** 前端渲染用户主页链接
- **THEN** 链接格式为 `/users/<username>`

#### Scenario: 题目链接

- **WHEN** 前端渲染题目链接
- **THEN** 链接格式为 `/problems/<display_id>`，无 `display_id` 时才回退 UUID

#### Scenario: 竞赛/训练/提交/帖子/公告链接

- **WHEN** 前端渲染这些实体链接
- **THEN** 链接格式为 `/contests/<public_id>`、`/trainings/<public_id>`、`/submissions/<public_id>`、`/community/posts/<public_id>`、`/announcements/<public_id>`

### Requirement: 内部实体保持 UUID

私信会话/消息、自测、评论、澄清、题目小题等非公开 URL 实体 SHALL 继续使用内部 UUID，不引入 `public_id`。

#### Scenario: 私信 API

- **WHEN** 前端调用私信会话 API
- **THEN** 继续使用会话 UUID，不生成公开标识
