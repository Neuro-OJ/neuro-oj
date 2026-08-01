## Purpose

定义统一题目包（Problem Bundle）导入规范。统一题目包是题目导入的唯一载体格式：单个 zip 文件（根级 `problem.json` manifest + `evaluate.py` 评测脚本 + 可选 `statement.md` 题面），经 `POST /api/v1/problems/import-bundle` 端点完成解析 → 校验 → 剥离 → 存储 → 元数据 upsert 全流程，替代旧式松散 zip 上传路径。评测内容统一走 CLI（`scripts/noj.ts`）构建与导入。

## Requirements

### Requirement: 统一题目包格式（导入载体）

系统 SHALL 定义统一题目包（Problem Bundle）作为题目导入的唯一载体格式：单个 zip 文件，根级 MUST 包含 `problem.json`（manifest）与 `evaluate.py`（评测脚本入口），SHOULD 包含 `statement.md`（题面 Markdown），可包含任意其他评测内容文件（testcase 不标准化，格式由题目自定，`evaluate.py` 自行读取）。

`evaluate.py` MUST 位于 zip 根级——judge 将包解压到容器 `/workspace` 后路径固定为 `/workspace/evaluate.py`。

#### Scenario: 合法导入包结构

- **WHEN** 用户提供 zip，根级含 `problem.json`、`statement.md`、`evaluate.py`、`visible.jsonl`/`hidden.jsonl` 及任意子目录资源
- **THEN** 系统接受该包为合法导入载体

#### Scenario: evaluate.py 强制根级

- **WHEN** zip 内 `evaluate.py` 位于子目录（如 `evaluator/evaluate.py`）而非根级
- **THEN** 系统返回 HTTP 400，提示评测脚本必须位于包根级

### Requirement: manifest 结构

系统 SHALL 要求 `problem.json` 为合法 JSON 对象，字段定义如下：

| 字段 | 必填 | 规则 |
|------|:---:|------|
| `format_version` | ✅ | 当前为 `1` |
| `title` | ✅ | 非空字符串 |
| `runtime_config` | ✅ | 遵循 `problem-runtime-config` 规范，`evaluator.command` 可缺省（缺省注入 `python3 /workspace/evaluate.py`） |
| `number` | ❌ | 仅 admin 生效：幂等键——按 (type, number) 匹配既有题目则更新；缺省 type 内 MAX+1 |
| `difficulty` | ❌ | `easy`/`medium`/`hard`，缺省 `medium` |
| `type` | ❌ | `U`/`P`，缺省 `U`（P 型仅 admin） |
| `description` | ❌ | 与 `statement.md` 二选一；两者均存在时以文件为准 |
| `categories` | ❌ | 字符串数组，按 name 匹配已有分类，缺省忽略 + warning |
| `samples` | ❌ | 预留字段（仅校验格式，不落库）：题目样例由展示层从题面（description）提取 |

#### Scenario: 题面缺失被拒

- **WHEN** zip 内无 `statement.md` 且 manifest 无 `description`
- **THEN** 系统返回 HTTP 400，提示缺少题面（`statement.md` 与 `manifest.description` 至少提供其一）

#### Scenario: 完整 manifest 导入

- **WHEN** `problem.json` 含全部必填字段与部分可选字段（`number`/`difficulty`/`type`/`categories`/`samples`）
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

### Requirement: 严格校验与 ZIP 安全

系统 SHALL 对导入包执行严格校验，根级缺失 `problem.json` 或 `evaluate.py` 的 zip MUST 被拒绝（HTTP 400）。ZIP 解析 MUST 复用既有安全约束：拒绝路径穿越条目（`..` 或 `/` 开头）、条目数 ≤ 1000、单文件 ≤ 64 MiB、总解压 ≤ 512 MiB。

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

系统 SHALL 在导入时将 `problem.json` 与 `statement.md` 两个元数据文件从 zip 中剥离，重建"纯净评测包"（仅含评测内容，`evaluate.py` 仍在根级）后通过 StorageProvider 存储，`support_package_storage_url` 指向剥离后的评测包。题面/元数据唯一事实来源为数据库。

#### Scenario: 剥离元数据后存储

- **WHEN** 导入包含 `problem.json`/`statement.md`/`evaluate.py`/`visible.jsonl`/`hidden.jsonl`/`assets/`
- **THEN** 存储的评测包仅含 `evaluate.py`/`visible.jsonl`/`hidden.jsonl`/`assets/`
- **THEN** `support_package_storage_url` 的 SHA-256 为剥离后评测包的校验值

#### Scenario: 剥离后评测包可用

- **WHEN** 剥离后的评测包被 judge 下载解压
- **THEN** 解压到 `/workspace` 后 `evaluate.py` 位于根级，评测命令可正常执行

### Requirement: import-bundle 导入端点

系统 SHALL 提供 `POST /api/v1/problems/import-bundle` 端点，接受 multipart/form-data 格式（文件字段名 `file`）的统一题目包 zip 上传，执行解析 → 校验 → 剥离 → 存储 → 元数据 upsert 全流程。

权限：admin MUST 可导入任意 type 且可指定 `number`（幂等键）；题目所有者（U 型）MUST 可导入，其 `number` 被忽略（自动分配）；其他用户 MUST 返回 HTTP 403。

upsert 语义：admin 提供 `number` 且 (type, number) 匹配既有题目 → 更新元数据并替换评测包；未命中 → 创建新题目（id 一律由服务端生成 UUID，(type, number) 由 DB 联合唯一约束保证唯一）。

#### Scenario: admin 导入新题（P 型）

- **WHEN** admin 上传含 `type: "P"` 的合法统一包（无 `number`）
- **THEN** 系统创建 P 型题目（服务端生成 UUID，number 自动分配），注册剥离后评测包，返回创建结果

#### Scenario: admin 导入带 number 的包（幂等更新）

- **WHEN** admin 上传含 `number: 1001`、`type: "P"` 的统一包，P 题库中题号 1001 已存在
- **THEN** 系统更新该题元数据并替换评测包，返回 HTTP 200
- **THEN** 重复导入不产生新题目行（(type, number) 唯一）

#### Scenario: 所有者导入 U 型题目（number 被忽略）

- **WHEN** 题目所有者上传合法统一包（manifest 含 `number`）
- **THEN** 系统创建新 U 型题目（服务端生成 id），`number` 被忽略（自动分配 type 内 MAX+1），所有者设为该用户

#### Scenario: 非所有者/非 admin 导入被拒

- **WHEN** 普通用户对 P 型 manifest 或他人题目上传统一包
- **THEN** 系统返回 HTTP 403

#### Scenario: 上传非 zip 被拒

- **WHEN** 上传文件扩展名非 `.zip` 或 Content-Type 非 zip
- **THEN** 系统返回 HTTP 400，提示"仅支持 .zip 格式文件"

#### Scenario: 审计日志

- **WHEN** admin 或所有者成功导入/更新题目
- **THEN** 系统记录审计日志（action 含导入来源标识与题目 id）

### Requirement: CLI 管理工具集

系统 SHALL 提供基于 Cliffy 的单入口 CLI（`scripts/noj.ts`，task 前缀 `noj`），以子命令形式承载全部管理操作：`db migrate`（迁移）、`init system`（系统基础数据：root 用户 + RBAC 预置 + 镜像白名单 + 分类）、`bootstrap admin`（管理员引导，支持 `--email`/`--password` 传参）、`problems build`（源目录 → 统一题目包构建，`--id` 可选）、`problems import`（扫描目录导入统一题目包，`--dir` 可选）、`dev-setup`（开发环境聚合命令）。

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

构建排除规则：`build-packages` 打包时 MUST 排除 `submission*`（参考实现）、`__pycache__`、`.git` 等非评测内容。

#### Scenario: 存储与构建产物分离

- **WHEN** `STORAGE_PROVIDER=local`
- **THEN** `storage.put()` 落盘到独立存储目录（默认 `data/storage/`），不写入 `data/packages/`
- **THEN** `data/packages/` 仅含构建产物 zip

#### Scenario: 参考实现不进入评测包

- **WHEN** `build-packages` 打包 `problems-src/<id>/`（含 `submission_sample.py` 与 `__pycache__/`）
- **THEN** 构建产物与剥离后评测包均不含 `submission*` 与 `__pycache__` 条目
