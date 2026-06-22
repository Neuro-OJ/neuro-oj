## Purpose

定义用户个人资料设置相关 API 规范，允许已登录用户修改自己的个人简介（bio）。API 路径前缀为 `/api/v1/users`，需要认证。

## Requirements

### Requirement: 用户可更新自己的个人简介

系统 SHALL 提供 `PUT /api/v1/users/me` 端点，允许已登录用户更新自己的 `bio` 字段。

此端点 SHALL 需要认证（Bearer Token）。

#### Scenario: 用户成功更新 bio

- **WHEN** 已登录用户发送 `PUT /api/v1/users/me`，JSON body 包含 `{"bio": "## 关于我\n\n算法竞赛爱好者"}`
- **THEN** 系统更新该用户的 bio 字段，返回 200 与更新后的用户信息

#### Scenario: 未登录用户尝试更新

- **WHEN** 未认证用户发送 `PUT /api/v1/users/me`
- **THEN** 系统返回 HTTP 401

#### Scenario: bio 超长

- **WHEN** 用户发送 `PUT /api/v1/users/me`，bio 超过 5000 字
- **THEN** 系统返回 HTTP 400，提示 "bio 长度不能超过 5000 字"

#### Scenario: 清除 bio

- **WHEN** 已登录用户发送 `PUT /api/v1/users/me`，JSON body 包含 `{"bio": ""}`
- **THEN** 系统将 bio 清空为 `""`，返回 200
