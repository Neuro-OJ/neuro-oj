## ADDED Requirements

### Requirement: 管理员管理镜像白名单

系统 SHALL 提供管理员 API 管理评测镜像白名单（`judge_images` 表），支持增删改查操作。

每条白名单记录包含 `image`（镜像名）、`mode`（`exact` 或 `all_versions`）、`description`（介绍文案）。

#### Scenario: 管理员添加精确版本镜像

- **WHEN** 管理员发送 `POST /api/v1/admin/judge-images`，携带 `{ "image": "noj-judge-cpp:gcc13", "mode": "exact", "description": "C++ GCC 13 评测环境" }`
- **THEN** 系统创建白名单记录，仅 `noj-judge-cpp:gcc13` 精确匹配该条目，返回 HTTP 201 及记录详情

#### Scenario: 管理员添加全版本镜像

- **WHEN** 管理员发送 `POST /api/v1/admin/judge-images`，携带 `{ "image": "noj-judge-python", "mode": "all_versions", "description": "Python 3.12 评测环境" }`
- **THEN** 系统创建白名单记录，`noj-judge-python`、`noj-judge-python:latest`、`noj-judge-python:v1.0` 等均匹配该条目，返回 HTTP 201

#### Scenario: 管理员查看白名单列表

- **WHEN** 管理员发送 `GET /api/v1/admin/judge-images`
- **THEN** 系统返回所有白名单记录列表，每条含 `id`、`image`、`mode`、`description`、`created_at`、`updated_at`

#### Scenario: 管理员更新白名单条目

- **WHEN** 管理员发送 `PUT /api/v1/admin/judge-images/:id`，携带 `{ "description": "更新后的介绍" }`
- **THEN** 系统更新该条记录的指定字段，返回 HTTP 200 及更新后详情

#### Scenario: 管理员删除白名单条目

- **WHEN** 管理员发送 `DELETE /api/v1/admin/judge-images/:id`
- **THEN** 系统删除该白名单记录，返回 HTTP 204

#### Scenario: 非管理员访问白名单 API 被拒

- **WHEN** 非管理员用户发送任意 `/api/v1/admin/judge-images` 请求
- **THEN** 系统返回 HTTP 403

#### Scenario: mode 字段非法值被拒

- **WHEN** 管理员创建白名单条目时传入 `mode: "regex"`
- **THEN** 系统返回 HTTP 400，提示 mode 仅允许 `exact` 或 `all_versions`

### Requirement: 题目创建/更新时校验镜像白名单

系统 SHALL 对题目创建和更新请求中的 `judge_image` 字段执行白名单校验。

白名单为空时 SHALL 拒绝所有镜像名，返回明确错误提示。

#### Scenario: 白名单非空时允许白名单中的镜像

- **WHEN** 白名单中存在 `all_versions: "noj-judge-python"` 条目，用户创建题目时传入 `judge_image: "noj-judge-python:latest"`
- **THEN** 系统通过白名单校验（镜像名去掉标签后匹配），正常创建题目

#### Scenario: 白名单非空时精确匹配

- **WHEN** 白名单中存在 `exact: "noj-judge-cpp:gcc13"` 条目，用户创建题目时传入 `judge_image: "noj-judge-cpp:gcc13"`
- **THEN** 系统通过白名单校验（完全相等），正常创建题目
- **WHEN** 同一白名单下用户传入 `judge_image: "noj-judge-cpp:gcc14"`
- **THEN** 系统返回 HTTP 400，提示该镜像不在允许列表中

#### Scenario: 白名单为空时拒绝所有镜像

- **WHEN** `judge_images` 表为空，用户创建题目时传入任意 `judge_image` 字符串
- **THEN** 系统返回 HTTP 400，提示"系统尚未配置允许的评测镜像，请联系管理员"

#### Scenario: 更新题目时校验镜像

- **WHEN** 白名单非空，用户编辑题目时修改 `judge_image` 为不在白名单中的值
- **THEN** 系统返回 HTTP 400，拒绝更新

### Requirement: 公开镜像列表 API

系统 SHALL 提供 `GET /api/v1/judge-images` 端点（无需认证），返回所有白名单镜像记录供题目编辑器使用。

#### Scenario: 获取可用镜像列表

- **WHEN** 任意用户（含未登录）发送 `GET /api/v1/judge-images`
- **THEN** 系统返回所有白名单记录的数组，每条含 `id`、`image`、`mode`、`description`

#### Scenario: 白名单为空时返回空列表

- **WHEN** 尚无任何白名单记录，用户请求 `GET /api/v1/judge-images`
- **THEN** 系统返回 HTTP 200 及空数组 `{ "data": [] }`

### Requirement: 全版本模式安全警告

系统 SHALL 在管理后台 UI 中，当管理员选择 `all_versions` 模式时展示安全风险警告。警告 SHALL 说明该模式允许该镜像的所有版本标签，存在攻击者利用未授权版本的风险。警告 SHALL NOT 阻止管理员继续操作。

#### Scenario: 管理员选择全版本模式时看到警告

- **WHEN** 管理员在新增/编辑镜像弹窗中选择模式为"所有版本"
- **THEN** UI 显示醒目警告文案（黄色/橙色提示），说明安全风险，但"确认"按钮仍可点击
