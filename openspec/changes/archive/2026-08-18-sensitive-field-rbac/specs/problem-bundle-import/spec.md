## MODIFIED Requirements

### Requirement: import-bundle 导入端点

系统 SHALL 提供 `POST /api/v1/problems/import-bundle` 端点，接受 multipart/form-data 格式（文件字段名 `file`）的统一题目包 zip 上传，执行解析 → 校验 → 剥离 → 存储 → 元数据 upsert 全流程。

权限：admin MUST 可导入任意 type 且可指定 `number`（幂等键）；题目所有者（U 型）MUST 可导入，其 manifest 提供 `number` 时 MUST 返回 HTTP 400（题号由系统自动分配）；其他用户 MUST 返回 HTTP 403。

upsert 语义：admin 提供 `number` 且 (type, number) 匹配既有题目 → 更新元数据并替换评测包；未命中 → 创建新题目（id 一律由服务端生成 UUID，(type, number) 由 DB 联合唯一约束保证唯一）。非 admin 的导入仅走创建路径。

导入路径 SHALL 对 manifest 的 `runtime_config` 执行与 CRUD 相同的敏感字段权限检查与资源上限校验（见 `sensitive-field-permissions` 与 `problem-resource-limits` spec）：manifest 中显式包含的敏感字段/资源字段按同一守卫校验，无权限返回 HTTP 403、超限返回 HTTP 400。CLI `problems import`（root 用户，`admin:full_access`）SHALL 天然放行。

#### Scenario: admin 导入新题（P 型）

- **WHEN** admin 上传含 `type: "P"` 的合法统一包（无 `number`）
- **THEN** 系统创建 P 型题目（服务端生成 UUID，number 自动分配），注册剥离后评测包，返回创建结果

#### Scenario: admin 导入带 number 的包（幂等更新）

- **WHEN** admin 上传含 `number: 1001`、`type: "P"` 的统一包，P 题库中题号 1001 已存在
- **THEN** 系统更新该题元数据并替换评测包，返回 HTTP 200
- **THEN** 重复导入不产生新题目行（(type, number) 唯一）

#### Scenario: 所有者导入 U 型题目（number 自动分配）

- **WHEN** 题目所有者上传合法统一包（manifest 无 `number`）
- **THEN** 系统创建新 U 型题目（服务端生成 id），`number` 自动分配（type 内 MAX+1），所有者设为该用户

#### Scenario: 所有者导入含 number 的包被拒

- **WHEN** 题目所有者上传合法统一包（manifest 含 `number`）
- **THEN** 系统返回 HTTP 400，提示仅管理员可指定 number
- **THEN** 不创建、不更新任何题目

#### Scenario: 非所有者/非 admin 导入被拒

- **WHEN** 普通用户对 P 型 manifest 或他人题目上传统一包
- **THEN** 系统返回 HTTP 403

#### Scenario: 上传非 zip 被拒

- **WHEN** 上传文件扩展名非 `.zip` 或 Content-Type 非 zip
- **THEN** 系统返回 HTTP 400，提示"仅支持 .zip 格式文件"

#### Scenario: 导入含敏感字段的包受权限约束

- **WHEN** 无 `problem:field_evaluator_command` 权限的用户导入 manifest 显式含 `evaluator.command` 的题目包
- **THEN** 系统返回 HTTP 403，不创建、不更新题目
- **WHEN** admin 或 CLI root 用户导入相同包
- **THEN** 导入成功（`admin:full_access` 放行）

#### Scenario: 导入超限包被拒

- **WHEN** 对应 `judge_max_*` 上限已配置且 manifest 中资源字段值超限
- **THEN** 系统返回 HTTP 400（`RESOURCE_LIMIT_EXCEEDED`），不创建、不更新题目
