## ADDED Requirements

### Requirement: manifest 模板索引（template 字段）

系统 SHALL 支持 `problem.json` 顶层可选字段 `template`，用于索引题目源码目录中的模板文件（前端编辑器初始代码）。`template` MUST 为纯文件名（不含 `/`、`\`、`..`），缺省默认 `"template.py"`（保证未声明该字段的既有题目兼容）。

模板读取接口 `GET /api/v1/problems/:id/template` SHALL 按 manifest `template` 字段（缺省 `"template.py"`）定位题目源码目录中的对应文件并返回内容；文件不存在 MUST 返回 HTTP 404。模板候选集 MUST 不再包含 `submission_sample.py` / `submission.py`（参考实现从模板回退链中移除，**BREAKING**：仅提供参考实现而未提供 `template.py` 的题目模板接口返回 404）。

#### Scenario: 声明 template 字段

- **WHEN** `problem.json` 含 `"template": "template.py"`
- **THEN** 系统校验通过，模板接口按该文件名读取源码目录内容

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

## MODIFIED Requirements

### Requirement: manifest 结构

系统 SHALL 要求 `problem.json` 为合法 JSON 对象，字段定义如下：

| 字段 | 必填 | 规则 |
|------|:---:|------|
| `format_version` | ✅ | 当前为 `1` |
| `title` | ✅ | 非空字符串 |
| `runtime_config` | ✅ | 遵循 `problem-runtime-config` 规范，`evaluator.command` 可缺省（缺省注入 `python3 /workspace/evaluate.py`） |
| `number` | ❌ | 仅 admin 生效：幂等键——按 (type, number) 匹配既有题目则更新；缺省 type 内 MAX+1。非 admin 提供 number MUST 返回 HTTP 400 |
| `difficulty` | ❌ | `easy`/`medium`/`hard`，缺省 `medium` |
| `type` | ❌ | `U`/`P`，缺省 `U`（P 型仅 admin） |
| `description` | ❌ | 与 `statement.md` 二选一；两者均存在时以文件为准 |
| `categories` | ❌ | 字符串数组，按 name 匹配已有分类，缺省忽略 + warning |
| `samples` | ❌ | 预留字段（仅校验格式，不落库）：题目样例由展示层从题面（description）提取 |
| `template` | ❌ | 模板文件索引（纯文件名），缺省 `"template.py"`；非法值（含 `/`、`\`、`..`）MUST 返回 HTTP 400 |

#### Scenario: 题面缺失被拒

- **WHEN** zip 内无 `statement.md` 且 manifest 无 `description`
- **THEN** 系统返回 HTTP 400，提示缺少题面（`statement.md` 与 `manifest.description` 至少提供其一）

#### Scenario: 完整 manifest 导入

- **WHEN** `problem.json` 含全部必填字段与部分可选字段（`number`/`difficulty`/`type`/`categories`/`samples`/`template`）
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

### Requirement: 数据目录分层

系统 SHALL 将题目数据按生命周期分层存储：`data/problems-src/<id>/`（源目录，版本控制）→ `build-packages` 构建产物 `data/packages/<id>.zip`（导入载体，gitignored）→ StorageProvider 存储后端目录（gitignored，默认 `data/storage/`，`SUPPORT_PACKAGE_DIR` 可覆盖）。存储后端目录 MUST 与构建产物目录分离，`seed` 导入扫描 MUST 仅扫描构建产物目录。

题目源码目录 MUST 不再维护参考实现文件（`submission_sample.py` / `submission.py`）；`template.py`（或 manifest `template` 字段索引的文件）为模板（starter code）的唯一来源。构建排除规则：`build-packages` 打包时 MUST 排除 `submission*`、`template.py`、`__pycache__`、`.git` 等非评测内容（模板仅供前端编辑器使用，不属于评测包内容）。

#### Scenario: 存储与构建产物分离

- **WHEN** `STORAGE_PROVIDER=local`
- **THEN** `storage.put()` 落盘到独立存储目录（默认 `data/storage/`），不写入 `data/packages/`
- **THEN** `data/packages/` 仅含构建产物 zip

#### Scenario: 非评测内容不进入评测包

- **WHEN** `build-packages` 打包 `problems-src/<id>/`（含 `template.py` 与 `__pycache__/`）
- **THEN** 构建产物与剥离后评测包均不含 `submission*`、`template.py` 与 `__pycache__` 条目
