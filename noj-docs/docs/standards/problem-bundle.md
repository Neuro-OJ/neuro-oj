# 题目包格式规范

统一题目包（Problem Bundle）是 Neuro OJ 的**题目导入载体**：单个 zip 包含题面、评测内容与评测配置，通过 `POST /api/v1/problems/import-bundle`（管理界面上传）或 `noj problems import` 一键导入，创建或更新题目。

## 包结构

```text
<任意名>.zip
├── problem.json      # 必需：题目 manifest
├── evaluate.py       # 必需：评测脚本（必须位于 zip 根目录）
├── statement.md      # 可选：题面 Markdown（与 manifest.description 二选一，文件优先）
├── visible.jsonl     # 可选：可见测试数据（推荐约定）
├── hidden.jsonl      # 可选：不可见测试数据（推荐约定）
└── assets/           # 可选：其他 evaluate.py 需要的文件
```

- `evaluate.py` **必须位于 zip 根级**——Judge Worker 将包解压到容器 `/workspace` 后路径固定为 `/workspace/evaluate.py`。
- 测试数据格式**不强制**：`visible.jsonl` / `hidden.jsonl` 是推荐约定，你可以用 `cases/*.json`、SQLite、CSV 等任何方式组织，只要 `evaluate.py` 自己能读取。推荐约定见[测试数据与样例规范](test-data.md)。
- 模板文件（`template.py`）与参考实现（如 `submission_sample.py`）**不要**放入包中；`problems:build` 打包时自动排除 `template.py` / `submission*` / `__pycache__` / `.git`。

## manifest（problem.json）

```json
{
  "format_version": 1,
  "number": 1001,
  "title": "题目标题",
  "difficulty": "easy",
  "type": "P",
  "tags": ["入门", "LMCC 样例题"],
  "runtime_config": {
    "evaluator": {
      "image": "noj-evaluator-python",
      "time_limit_ms": 5000,
      "memory_limit_mb": 512
    },
    "solution": {
      "image": "noj-solution-python",
      "call_timeout_ms": 5000,
      "memory_limit_mb": 512
    }
  },
  "template": "template.py"
}
```

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `format_version` | ✅ | 当前 `1` |
| `title` | ✅ | 非空 |
| `runtime_config` | ✅ | 双容器配置；`evaluator.command` 可缺省（默认 `python3 /workspace/evaluate.py`） |
| `statement.md` 文件 | ❌ | 与 `manifest.description` 二选一（文件优先），二者皆缺 → 400 |
| `evaluate.py` 文件 | ✅ | 根级缺失 → 400 |
| `number` | ❌ | 仅 admin 生效：幂等键——按 (type, number) 匹配既有题目则更新；缺省 type 内自动分配 |
| `difficulty` | ❌ | `easy` / `medium` / `hard`，缺省 `medium` |
| `type` | ❌ | `U` / `P`，缺省 `U`（P 型仅 admin） |
| `tags` | ❌ | 标签名数组，按 name 匹配已有标签，缺省忽略 + warning |
| `samples` | ❌ | 预留；缺省从题面自动提取 |
| `template` | ❌ | 模板文件索引（纯文件名，禁止 `/`、`\`、`..`），缺省 `"template.py"` |
| `llm` | ❌ | LLM 调用题配置 `{ provider_id, model }`；仅 P 型 + evaluator 联网可启用 |

> `categories` 字段已退役，统一使用 `tags`。
> `runtime_config.solution` 无需配置入口文件名：Solution 入口为评测内部约定，用户代码由 Judge Worker 以硬编码名 `main.py` 注入容器，出题人不可见、不可配置。

## 版本与校验

- `format_version` 当前唯一支持 `1`；未知版本导入返回 HTTP 400。
- ZIP 安全约束：拒绝路径穿越条目（`..` 或 `/` 开头）、条目数 ≤ 1000、单文件 ≤ 64 MiB、总解压 ≤ 512 MiB。
- `tags` 按 name 匹配已有标签；不存在的标签名被忽略并记录 warning。
- `llm` 校验：仅 P 型/官方题可启用，且必须开启 evaluator 网络。

## 导入语义与存储

- 上传的 zip 是**导入载体**；系统剥离 `problem.json` / `statement.md` 后重建**纯净评测包**存入存储（`noj-storage://`），题面/元数据的唯一事实来源是数据库。
- 重复导入幂等：admin 提供 `number` 且 (type, number) 匹配既有题目 → 更新元数据并替换评测包；未命中 → 创建。
- 非 admin 提供 `number` 会被 400 拒绝，普通用户导入仅创建新题（题号自动分配）。

## 特殊题型

### LLM 调用题

在 manifest 中增加 `llm` 字段：

```json
{
  "type": "P",
  "llm": {
    "provider_id": "uuid-of-provider",
    "model": "qwen-plus"
  },
  "runtime_config": {
    "evaluator": {
      "network": { "enabled": true }
    }
  }
}
```

- `provider_id` 必须是管理后台中已存在且 `enabled=true` 的 Provider。
- `model` 必须在该 Provider 可用的模型范围内。
- 必须 P 型 + evaluator 联网，否则导入被拒。
- 安全与配额要求见[出 LLM 调用题](../problemsetters/llm-problem.md)。

### 客观题套卷

客观题套卷（`is_objective=true`）**不通过统一题目包导入**：它没有 `evaluate.py` / `runtime_config`，走 Web 编辑器/API 管理。本规范只覆盖 U/P 评测题。
