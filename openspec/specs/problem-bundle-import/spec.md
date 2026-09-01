## Purpose

定义统一题目包（Problem Bundle）导入规范。统一题目包是题目导入的唯一载体格式：单个 zip 文件（根级 `problem.json` manifest + 编程题 `evaluate.py` 评测脚本 / 客观题 `questions.json` 小题数组 + 可选 `statement.md` 题面），经 `POST /api/v1/problems/import-bundle` 端点完成解析 → 校验 → 剥离 → 存储 → 元数据 upsert 全流程，替代旧式松散 zip 上传路径。评测内容统一走 CLI（`scripts/noj.ts`）构建与导入。
## Requirements
### Requirement: 统一题目包格式（导入载体）

系统 SHALL 定义统一题目包（Problem Bundle）作为题目导入的唯一载体格式：单个 zip 文件，根级 MUST 包含 `problem.json`（manifest）。编程题包（`is_objective` 缺省或 false）根级 MUST 包含 `evaluate.py`（评测脚本入口）；客观题套卷包（`is_objective=true`）根级 MUST 包含 `questions.json`（小题数组），SHOULD 包含 `statement.md`（题面 Markdown），可包含任意其他内容文件。

`evaluate.py` MUST 位于 zip 根级——judge 将包解压到容器 `/workspace` 后路径固定为 `/workspace/evaluate.py`。

#### Scenario: 合法导入包结构

- **WHEN** 用户提供 zip，根级含 `problem.json`、`statement.md`、`evaluate.py`、`visible.jsonl`/`hidden.jsonl` 及任意子目录资源
- **THEN** 系统接受该包为合法导入载体

#### Scenario: evaluate.py 强制根级

- **WHEN** zip 内 `evaluate.py` 位于子目录（如 `evaluator/evaluate.py`）而非根级
- **THEN** 系统返回 HTTP 400，提示评测脚本必须位于包根级

#### Scenario: 客观题套卷包导入

- **WHEN** `problem.json` 含 `"is_objective": true`，zip 根级含 `questions.json` 且不含 `evaluate.py`
- **THEN** 系统校验通过，创建/更新客观题套卷并全量替换小题
- **THEN** 系统不存储评测包，`support_package_storage_url` 为 NULL

#### Scenario: 客观题包携带编程题专属字段

- **WHEN** `is_objective=true` 的 manifest 携带 `runtime_config` / `llm` / `template` / `submission_mode` / `artifact_max_size_mb`
- **THEN** 系统返回 HTTP 400

#### Scenario: 客观题包缺 questions.json

- **WHEN** `is_objective=true` 的 zip 根级缺少 `questions.json`
- **THEN** 系统返回 HTTP 400

### Requirement: manifest 结构

系统 SHALL 要求 `problem.json` 为合法 JSON 对象，字段定义如下：

| 字段 | 必填 | 规则 |
|------|:---:|------|
| `format_version` | ✅ | 当前为 `1` |
| `title` | ✅ | 非空字符串 |
| `runtime_config` | ✅* | 遵循 `problem-runtime-config` 规范，`evaluator.command` 可缺省（缺省注入 `python3 /workspace/evaluate.py`）；`is_objective=true` 时禁止提供 |
| `is_objective` | ❌ | 布尔值，缺省 `false`；`true` 表示客观题套卷包，不要求 `runtime_config`/`evaluate.py`，必须含 `questions.json` |
| `number` | ❌ | 仅 admin 生效：幂等键——按 (type, number) 匹配既有题目则更新；缺省 type 内 MAX+1。非 admin 提供 number MUST 返回 HTTP 400 |
| `difficulty` | ❌ | `easy`/`medium`/`hard`，缺省 `medium` |
| `type` | ❌ | `U`/`P`，缺省 `U`（P 型仅 admin） |
| `description` | ❌ | 与 `statement.md` 二选一；两者均存在时以文件为准 |
| `tags` | ❌ | 字符串数组，按 name 匹配已有标签，缺省忽略 + warning |
| `samples` | ❌ | 预留字段（仅校验格式，不落库）：题目样例由展示层从题面（description）提取 |
| `template` | ❌ | 模板文件索引（纯文件名，禁止 `/`、`\`、`..`），缺省 `"template.py"`；非法值（含 `/`、`\`、`..`）MUST 返回 HTTP 400 |

#### Scenario: 题面缺失被拒

- **WHEN** zip 内无 `statement.md` 且 manifest 无 `description`
- **THEN** 系统返回 HTTP 400，提示缺少题面（`statement.md` 与 `manifest.description` 至少提供其一）

#### Scenario: 完整 manifest 导入

- **WHEN** `problem.json` 含全部必填字段与部分可选字段（`number`/`difficulty`/`type`/`tags`/`samples`/`template`）
- **THEN** 系统校验通过并按其声明创建/更新题目

#### Scenario: 必填字段缺失

- **WHEN** `problem.json` 缺失 `title` 或 `runtime_config` 或 `format_version`
- **THEN** 系统返回 HTTP 400，错误信息指明缺失字段

#### Scenario: 非法字段值

- **WHEN** `difficulty` 非法、`type` 非法或 `runtime_config` 未通过结构/白名单校验
- **THEN** 系统返回 HTTP 400，错误信息指明非法字段

#### Scenario: 题面以 statement.md 为准

- **WHEN** zip 内 `statement.md` 存在且 manifest 同时含 `description`
- **THEN** 系统以 `statement.md` 内容作为题目 description 落库

#### Scenario: 样例由展示层提取

- **WHEN** manifest 提供 `samples`（或未提供）
- **THEN** 系统仅校验其格式（`{input, output}` 字符串对），不落库
- **THEN** 题目样例由展示层从落库后的题面（description）提取，不依赖 manifest.samples

#### Scenario: manifest.template 索引模板

- **WHEN** `problem.json` 含 `"template": "template.py"`（或缺省）
- **THEN** 系统校验通过（缺省默认 `"template.py"`），模板接口按该文件名读取源码目录内容
- **WHEN** `template` 含 `/`、`\` 或 `..`
- **THEN** 系统返回 HTTP 400，错误信息指明 `manifest.template` 非法

### Requirement: manifest 模板索引（template 字段）

系统 SHALL 支持 `problem.json` 顶层可选字段 `template`，用于索引题目源码目录中的模板文件（前端编辑器初始代码）。`template` MUST 为纯文件名（不含 `/`、`\`、`..`），缺省默认 `"template.py"`（保证未声明该字段的既有题目兼容）。

模板读取接口 `GET /api/v1/problems/:id/template` SHALL 按 manifest `template` 字段（缺省 `"template.py"`）定位已验证归属的源码目录中的对应文件并返回内容；文件不存在、目录无唯一归属或 manifest 不匹配 MUST 返回 HTTP 404。模板候选集 MUST 不再包含 `submission_sample.py` / `submission.py`（参考实现从模板回退链中移除，**BREAKING**：仅提供参考实现而未提供 `template.py` 的题目模板接口返回 404）。

#### Scenario: 声明 template 字段

- **WHEN** 与数据库题目一致的 `problem.json` 含 `"template": "template.py"`
- **THEN** 模板接口返回该源码目录中的 `template.py`

#### Scenario: 缺省 template 字段（兼容旧题目）

- **WHEN** `problem.json` 不含 `template` 字段
- **THEN** 系统按默认值 `"template.py"` 索引模板，行为与显式声明一致

#### Scenario: 模板文件缺失返回 404

- **WHEN** 题目源码目录中 `template.py` 不存在且 manifest 未声明其他模板文件
- **THEN** `GET /api/v1/problems/:id/template` 返回 HTTP 404
- **THEN** 系统不再回退读取 `submission_sample.py` / `submission.py`

#### Scenario: 非法 template 值被拒

- **WHEN** `template` 字段含 `/`、`\` 或 `..`
- **THEN** 题目包导入返回 HTTP 400，错误信息指明 `manifest.template` 非法

### Requirement: manifest.llm 字段

系统 SHALL 支持 `problem.json` 顶层可选字段 `llm`，用于声明题目可用的 LLM Provider 与模型。`llm` MUST 为对象，包含 `provider_id`（非空字符串）与 `model`（非空字符串）；该字段仅对受信题目（管理员 P 型/官方题或审核通过题目）合法，且必须与 `runtime_config.evaluator.network.enabled = true` 同时出现。

#### Scenario: 合法 llm 字段

- **WHEN** 导入包中的 `problem.json` 包含 `llm: {"provider_id": "uuid", "model": "qwen-plus"}`，且 `runtime_config.evaluator.network.enabled = true`
- **THEN** 导入校验通过，`llm` 配置写入题目 `llm_config`

#### Scenario: llm 字段缺少 model

- **WHEN** `problem.json` 的 `llm` 缺少 `model` 或 `model` 为空
- **THEN** 系统返回 HTTP 400，提示 `llm.model` 必填

#### Scenario: llm 字段未开启网络

- **WHEN** `problem.json` 包含 `llm` 但 `runtime_config.evaluator.network.enabled` 不是 true
- **THEN** 系统返回 HTTP 400，提示必须启用 evaluator 网络

#### Scenario: 非受信题目携带 llm

- **WHEN** 导入 U 型题目或未审核题目且 `problem.json` 包含 `llm`
- **THEN** 系统返回 HTTP 403，提示仅受信题目可启用 LLM

### Requirement: 客观题套卷包（questions.json）

系统 SHALL 支持 `is_objective=true` 的题目包通过根级 `questions.json` 导入客观题小题。`questions.json` MUST 为非空数组，每项包含 `type`（`single`/`multiple`/`judge`）、`prompt`、`options`（judge 可省略）、`answer`、可选 `explanation` 与 `sort_order`。导入更新 SHALL 全量替换既有小题，且 SHALL NOT 自动重测历史提交。

#### Scenario: 客观题小题导入

- **WHEN** `questions.json` 为合法小题数组
- **THEN** 系统创建/更新套卷并写入全部小题

#### Scenario: 客观题小题非法

- **WHEN** `questions.json` 为空数组、字段非法或 `sort_order` 重复
- **THEN** 系统返回 HTTP 400

### Requirement: 严格校验与 ZIP 安全

系统 SHALL 对导入包执行严格校验，根级缺失 `problem.json` 的 zip MUST 被拒绝（HTTP 400）；编程题包根级缺失 `evaluate.py`、客观题包根级缺失 `questions.json` 也 MUST 被拒绝。ZIP 解析 MUST 复用既有安全约束：拒绝路径穿越条目（`..` 或 `/` 开头）、条目数 ≤ 1000、单文件 ≤ 64 MiB、总解压 ≤ 512 MiB。

#### Scenario: 无 manifest 的旧式 zip 被拒

- **WHEN** 用户上传根级无 `problem.json` 的松散 zip（旧格式）
- **THEN** 系统返回 HTTP 400，提示必须使用统一题目包格式

#### Scenario: 路径穿越条目被拒

- **WHEN** zip 内含 `../escape` 或绝对路径条目
- **THEN** 系统返回 HTTP 400，拒绝解析该包

#### Scenario: 炸弹防护

- **WHEN** zip 条目数超过 1000、单文件超过 64 MiB 或总解压超过 512 MiB
- **THEN** 系统返回 HTTP 400，拒绝解析该包

### Requirement: 剥离后存储

系统 SHALL 在导入时将 `problem.json` 与 `statement.md` 两个元数据文件从编程题 zip 中剥离，重建"纯净评测包"（仅含评测内容，`evaluate.py` 仍在根级）后通过 StorageProvider 存储，`support_package_storage_url` 指向剥离后的评测包。客观题套卷包 SHALL NOT 存储评测包，`support_package_storage_url` 保持 NULL。题面/元数据唯一事实来源为数据库。

#### Scenario: 剥离元数据后存储

- **WHEN** 导入包含 `problem.json`/`statement.md`/`evaluate.py`/`visible.jsonl`/`hidden.jsonl`/`assets/`
- **THEN** 存储的评测包仅含 `evaluate.py`/`visible.jsonl`/`hidden.jsonl`/`assets/`
- **THEN** `support_package_storage_url` 的 SHA-256 为剥离后评测包的校验值

#### Scenario: 剥离后评测包可用

- **WHEN** 剥离后的评测包被 judge 下载解压
- **THEN** 解压到 `/workspace` 后 `evaluate.py` 位于根级，评测命令可正常执行

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

#### Scenario: 审计日志

- **WHEN** admin 或所有者成功导入/更新题目
- **THEN** 系统记录审计日志（action 含导入来源标识与题目 id）

### Requirement: CLI 管理工具集

系统 SHALL 提供基于 Cliffy 的单入口 CLI（`scripts/noj.ts`，task 前缀 `noj`），以子命令形式承载全部管理操作：`db migrate`（迁移）、`init system`（系统基础数据：root 用户 + RBAC 预置 + 镜像白名单 + 标签）、`bootstrap admin`（管理员引导，支持 `--email`/`--password` 传参）、`problems build`（源目录 → 统一题目包构建，`--id` 可选）、`problems import`（扫描目录导入统一题目包，`--dir` 可选）、`dev-setup`（开发环境聚合命令）。

`dev-setup` MUST 聚合 `db migrate` + `init system` + `bootstrap admin` + `problems build` + `problems import`，并额外填充仅适用于开发/测试环境的数据（示例题、E2E 守卫用户）；生产环境初始化 MUST 不执行 `dev-setup` 的 dev 数据部分。

CLI MUST 提供自动生成的 help（`-h/--help`）与错误退出码约定。`seed`/`build-packages`/`setup` 等旧 task 名称 MUST 不再出现。

#### Scenario: CLI help 输出

- **WHEN** 用户执行 `deno task noj --help` 或任一子命令 `--help`
- **THEN** CLI 输出命令用法、子命令列表、选项与示例说明

#### Scenario: 生产初始化流程

- **WHEN** 生产环境执行 `deno task db:migrate`、`deno task init:system`、`deno task bootstrap:admin -- --email admin@x.com`、`deno task problems:build`、`deno task problems:import`
- **THEN** 数据库完成迁移、基础数据就绪、管理员创建、题目包构建并导入
- **THEN** 生产环境不包含示例题与 E2E 守卫用户

#### Scenario: dev-setup 一键开发环境

- **WHEN** 开发环境执行 `deno task dev-setup`
- **THEN** 依次完成迁移、系统基础数据、管理员引导、题目包构建与导入
- **THEN** 额外填充示例题（1001-1003）与 E2E 守卫用户
- **THEN** 重复执行幂等，不产生重复题目或重复用户

#### Scenario: 管理员引导传参

- **WHEN** 执行 `deno task bootstrap:admin -- --email admin@example.com --password 'xxx'`
- **THEN** 指定邮箱的用户被创建（不存在时）并提升为 admin，或已存在时仅提升角色

### Requirement: 数据目录分层

系统 SHALL 将题目数据按生命周期分层存储：`data/problems-src/<id>/`（源目录，版本控制）→ `build-packages` 构建产物 `data/packages/<id>.zip`（导入载体，gitignored）→ StorageProvider 存储后端目录（gitignored，默认 `data/storage/`，`SUPPORT_PACKAGE_DIR` 可覆盖）。存储后端目录 MUST 与构建产物目录分离，`seed` 导入扫描 MUST 仅扫描构建产物目录。

构建排除规则：`build-packages` 打包时 MUST 排除 `template.py`（模板仅供前端编辑器使用）、`submission*`、`__pycache__`、`.git` 等非评测内容。题目源码目录 MUST 不再维护参考实现文件（`submission_sample.py` / `submission.py`），`template.py`（或 manifest `template` 字段索引的文件）为模板唯一来源。

#### Scenario: 存储与构建产物分离

- **WHEN** `STORAGE_PROVIDER=local`
- **THEN** `storage.put()` 落盘到独立存储目录（默认 `data/storage/`），不写入 `data/packages/`
- **THEN** `data/packages/` 仅含构建产物 zip

#### Scenario: 非评测内容不进入评测包

- **WHEN** `build-packages` 打包 `problems-src/<id>/`（含 `template.py` 与 `__pycache__/`）
- **THEN** 构建产物与剥离后评测包均不含 `template.py`、`submission*` 与 `__pycache__` 条目

### Requirement: 题目导入速率限制

`POST /api/v1/problems/import-bundle` SHALL 受速率限制保护，防止大包上传造成资源消耗。

#### Scenario: 导入超限返回 429

- **WHEN** 用户短时间内调用 import-bundle 次数超过阈值
- **THEN** 系统返回 HTTP 429，且不解析上传包


### Requirement: manifest 字段对齐

系统 SHALL 在 `problem.json` 中使用 `tags`（字符串数组）作为标签字段，不再接受 `categories`。`tags` 按 name 匹配已有标签，缺省忽略 + warning。

#### Scenario: manifest 使用 tags

- **WHEN** `problem.json` 含 `"tags": ["入门", "LMCC 样例题"]`
- **THEN** 系统按标签名解析并关联已有标签；不存在的标签名被忽略并记录 warning

#### Scenario: manifest 使用已退役 categories

- **WHEN** `problem.json` 含 `"categories": [...]`
- **THEN** 系统返回 HTTP 400，提示使用 `tags` 字段

### Requirement: 包结构与版本

系统 SHALL 定义统一题目包结构：根级 MUST 包含 `problem.json` 与 `evaluate.py`，SHOULD 包含 `statement.md`，可包含 `visible.jsonl`/`hidden.jsonl`/`assets/` 等评测内容。`format_version` 当前 MUST 为 `1`，未知版本 MUST 返回 HTTP 400。

#### Scenario: 合法包结构

- **WHEN** zip 根级含 `problem.json`、`evaluate.py`、`statement.md`、`visible.jsonl`、`hidden.jsonl`、`assets/`
- **THEN** 系统接受该包为合法导入载体

#### Scenario: 未知 format_version

- **WHEN** `problem.json` 的 `format_version` 不是 `1`
- **THEN** 系统返回 HTTP 400，提示不支持的 manifest 格式版本

### Requirement: 测试数据推荐约定

系统 SHALL 在文档中推荐 JSONL 测试数据格式（`id`/`input`/`expected`/`score`/`tags`/`message`），并推荐目录约定 `visible.jsonl`/`hidden.jsonl` 或 `cases/visible/*.json`/`cases/hidden/*.json`。测试数据格式本身不强制，evaluator 自行读取。

#### Scenario: 文档提供推荐约定

- **WHEN** 出题人阅读统一题目包文档
- **THEN** 文档给出 JSONL 字段说明与目录约定，并说明格式不强制

### Requirement: 特殊题型边界

系统 SHALL 在规范中明确：LLM 调用题通过 manifest `llm` 字段配置（`provider_id`/`model`），必须 P 型 + evaluator 联网；客观题套卷通过 `is_objective=true` + `questions.json` 导入，不要求 `evaluate.py`/`runtime_config`。

#### Scenario: LLM 字段校验

- **WHEN** `problem.json` 含 `llm` 且 type 非 P 或未开启 evaluator 网络
- **THEN** 系统返回 HTTP 400

#### Scenario: 客观题通过包导入

- **WHEN** 用户用统一题目包导入客观题套卷（`is_objective=true` + `questions.json`）
- **THEN** 系统创建/更新套卷并全量替换小题
