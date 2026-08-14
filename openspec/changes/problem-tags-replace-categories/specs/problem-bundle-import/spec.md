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
| `tags` | ❌ | 字符串数组，按 name 匹配已有标签，缺省忽略 + warning |
| `samples` | ❌ | 预留字段（仅校验格式，不落库）：题目样例由展示层从题面（description）提取 |
| `template` | ❌ | 模板文件索引（纯文件名，禁止 `/`、`\`、`..`），缺省 `"template.py"`；前端编辑器初始代码 |

#### Scenario: 题面缺失被拒

- **WHEN** zip 内无 `statement.md` 且 manifest 无 `description`
- **THEN** 系统返回 HTTP 400，提示缺少题面（`statement.md` 与 `manifest.description` 至少提供其一）

#### Scenario: 完整 manifest 导入

- **WHEN** `problem.json` 含全部必填字段与部分可选字段（`number`/`difficulty`/`type`/`tags`/`samples`）
- **THEN** 系统校验通过并按其声明创建/更新题目

#### Scenario: 必填字段缺失

- **WHEN** `problem.json` 缺失 `title` 或 `runtime_config` 或 `format_version`
- **THEN** 系统返回 HTTP 400，错误信息指明缺失字段

#### Scenario: 非法字段值

- **WHEN** `difficulty` 非法、`type` 非法或 `runtime_config` 未通过结构/白名单校验
- **THEN** 系统返回 HTTP 400，错误信息指明非法字段
