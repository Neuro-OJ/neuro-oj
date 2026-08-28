## Purpose

修订统一题目包（Problem Bundle）导入规范：对齐 manifest 字段、补全包结构/版本/校验、标准化测试数据推荐约定、覆盖特殊题型边界。

## Requirements

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

系统 SHALL 在规范中明确：LLM 调用题通过 manifest `llm` 字段配置（`provider_id`/`model`），必须 P 型 + evaluator 联网；客观题套卷不通过统一题目包导入，走 Web 编辑器/API 管理。

#### Scenario: LLM 字段校验

- **WHEN** `problem.json` 含 `llm` 且 type 非 P 或未开启 evaluator 网络
- **THEN** 系统返回 HTTP 400

#### Scenario: 客观题不通过包导入

- **WHEN** 用户尝试用统一题目包导入客观题套卷
- **THEN** 文档明确该路径不支持，应使用 Web 编辑器/API
