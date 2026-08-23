## MODIFIED Requirements

### Requirement: manifest 模板索引（template 字段）

系统 SHALL 支持 `problem.json` 顶层可选字段 `template`，用于索引与数据库题目
`number` 和 `title`
一致的题目源码目录中的模板文件（前端编辑器初始代码）。`template` MUST
为纯文件名（不含 `/`、`\`、`..`），缺省默认
`"template.py"`（保证未声明该字段的既有题目兼容）。

模板读取接口 `GET /api/v1/problems/:id/template` SHALL 按 manifest `template`
字段（缺省
`"template.py"`）定位已验证归属的源码目录中的对应文件并返回内容；文件不存在、目录无唯一归属或
manifest 不匹配 MUST 返回 HTTP 404。模板候选集 MUST 不再包含
`submission_sample.py` /
`submission.py`（参考实现从模板回退链中移除，**BREAKING**：仅提供参考实现而未提供
`template.py` 的题目模板接口返回 404）。

#### Scenario: 声明 template 字段

- **WHEN** 与数据库题目一致的 `problem.json` 含 `"template": "template.py"`
- **THEN** 模板接口返回该源码目录中的 `template.py`

#### Scenario: 缺省 template 字段（兼容旧题目）

- **WHEN** 与数据库题目一致的 `problem.json` 不含 `template` 字段
- **THEN** 系统按默认值 `"template.py"` 索引模板，行为与显式声明一致

#### Scenario: 模板文件缺失返回 404

- **WHEN** 已验证归属的题目源码目录中 `template.py` 不存在且 manifest
  未声明其他模板文件
- **THEN** `GET /api/v1/problems/:id/template` 返回 HTTP 404
- **THEN** 系统不再回退读取 `submission_sample.py` / `submission.py`

#### Scenario: 非法 template 值被拒

- **WHEN** `template` 字段含 `/`、`\` 或 `..`
- **THEN** 题目包导入返回 HTTP 400，错误信息指明 `manifest.template` 非法
