# 题目包格式规范

统一题目包（Problem Bundle）是 Neuro OJ 的**题目导入载体**：单个 zip 包含题面、评测内容与评测配置，通过 `POST /api/v1/problems/import-bundle`（管理界面上传）或 `noj problems import` 一键导入，创建或更新题目。

> 本页是**强制规范**（MUST）：导入时系统会强制校验包结构与 manifest 字段，任一不合法都会以 HTTP 400 拒绝，并返回具体字段错误。导入校验只保证**结构合法**（字段、必填项、ZIP 安全），**不保证题面、测试数据与评测脚本的质量**——发布前请按[题目质量要求](quality.md)完成自测。

## 包结构

```text
编程题包：
<任意名>.zip
├── problem.json      # 必需：题目 manifest
├── evaluate.py       # 必需：评测脚本（必须位于 zip 根目录）
├── statement.md      # 可选：题面 Markdown（与 manifest.description 二选一，文件优先）
├── visible.jsonl     # 可选：可见测试数据（推荐约定）
├── hidden.jsonl      # 可选：不可见测试数据（推荐约定）
└── assets/           # 可选：其他 evaluate.py 需要的文件

客观题套卷包（is_objective=true）：
<任意名>.zip
├── problem.json      # 必需：manifest（is_objective: true）
├── questions.json    # 必需：小题数组
└── statement.md      # 可选：套卷说明
```

- `evaluate.py` **必须位于 zip 根级**——Judge Worker 将包解压到容器 `/workspace` 后路径固定为 `/workspace/evaluate.py`。
- 测试数据格式**不强制**：`visible.jsonl` / `hidden.jsonl` 是推荐约定，你可以用 `cases/*.json`、SQLite、CSV 等任何方式组织，只要 `evaluate.py` 自己能读取。推荐约定见[测试数据与样例规范](test-data.md)。
- 模板文件（如 `template.py`）与参考实现（如 `submission_sample.py`）**不要**放入包中；`problems:build` 打包时自动排除 `submission*`、manifest 声明的模板文件、`__pycache__` 与 `.git`（`noj-cli problem pack` 同规则）。

::: danger 三种"根级缺失"会导致导入失败（400）
- 编程题包根级缺 `problem.json`、`evaluate.py`，或题面（`statement.md` 与 `manifest.description` 皆缺）。
- 客观题包根级缺 `problem.json` 或 `questions.json`。

注意是 **zip 根级**而非任意子目录；`assets/evaluate.py` 这类嵌套路径不算数。
:::

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
| `format_version` | ✅ | 当前唯一支持 `1`；其他值导入返回 400 |
| `title` | ✅ | 非空字符串 |
| `runtime_config` | ✅* | 双容器配置（编程题必填）；`evaluator.command` 可缺省（默认 `python3 /workspace/evaluate.py`）；`is_objective=true` 时禁止提供 |
| `is_objective` | ❌ | 布尔值，缺省 `false`；`true` 表示客观题套卷包，不要求 `runtime_config` / `evaluate.py`，必须含 `questions.json` |
| `statement.md` 文件 | ❌ | 与 `manifest.description` 二选一（文件优先），二者皆缺 → 400 |
| `evaluate.py` 文件 | ✅* | 编程题根级缺失 → 400；客观题包不要求 |
| `questions.json` 文件 | ✅* | 客观题包根级缺失 → 400；编程题包不要求 |
| `number` | ❌ | 仅 admin 生效：幂等键——按 (type, number) 匹配既有题目则更新；缺省 type 内自动分配 |
| `difficulty` | ❌ | `easy` / `medium` / `hard`，缺省 `medium` |
| `type` | ❌ | `U` / `P`，缺省 `U`（P 型仅 admin） |
| `tags` | ❌ | 标签名数组，按 name 匹配已有标签；不存在的名字被忽略并 warning（字段缺省则不处理） |
| `samples` | ❌ | 预留字段：仅做 `{ input, output }` 字符串数组的结构校验，**当前不会落库**；题面样例由题面正文承载 |
| `template` | ❌ | 模板文件索引（纯文件名，禁止 `/`、`\`、`..`），缺省 `"template.py"`；客观题包禁止提供 |
| `submission_mode` | ❌ | 提交模式 `code`（缺省）/ `artifact`；客观题包禁止提供 |
| `artifact_max_size_mb` | ❌ | artifact 提交大小上限（MB），正整数或 `null`（缺省 `null` = 用平台硬上限）；客观题包禁止提供 |
| `llm` | ❌ | LLM 调用题配置 `{ max_calls?, max_tokens? }`（非 null 即启用，预算均可选）；仅 P 型 + evaluator 联网可启用；客观题包禁止提供 |

> `categories` 字段已退役，统一使用 `tags`。
> `runtime_config.solution` 无需配置入口文件名：Solution 入口为评测内部约定，用户代码由 Judge Worker 以硬编码名 `main.py` 注入容器，出题人不可见、不可配置。

::: danger 客观题包禁止提供的字段
`is_objective=true` 时，manifest 中**不得**出现 `runtime_config`、`llm`、`template`、`submission_mode`、`artifact_max_size_mb`，否则直接 400。客观题没有评测容器，这些字段无意义。
:::

::: tip `submission_mode: artifact` 的入口约定
产物提交题的 zip 由 Judge Worker 解压到 Solution 容器，入口文件固定为 `submission.py`（代码题才是硬编码的 `main.py`）。详见[Web 题目编辑器 § 产物提交题](../problemsetters/web-editor.md#产物提交题)。
:::

## 版本与校验

- `format_version` 当前唯一支持 `1`；未知版本导入返回 HTTP 400。
- `tags` 按 name 匹配已有标签；不存在的标签名被忽略并记录 warning（**不会**因此导入失败）。
- `llm` 校验：仅 P 型/官方题可启用，且必须开启 evaluator 网络；只校验可选预算字段，未知键（含存量的 `provider_id` / `model`）忽略。

::: warning ZIP 安全与上传入口约束
- 拒绝路径穿越条目：绝对路径（`/` 开头）或含 `..` 段的条目一律 400。
- 条目数 ≤ **1000**、单文件 ≤ **64 MiB**、总解压 ≤ **512 MiB**。
- 上传 zip 本体（压缩后）另有大小上限 **128 MiB**（`MAX_SUPPORT_PACKAGE_SIZE`），与支持包上传一致。
- `POST /api/v1/problems/import-bundle` 读取 multipart 的 **`file`** 字段；缺失或不是文件、扩展名非 `.zip`、Content-Type 不在 `application/zip` / `application/x-zip-compressed` 之内，都会 400。
:::

## 导入语义与存储

- 上传的 zip 是**导入载体**；编程题系统剥离 `problem.json` / `statement.md` 后重建**纯净评测包**存入存储（`noj-storage://`），题面/元数据的唯一事实来源是数据库。客观题套卷不产生评测包存储，`support_package_storage_url` 为 NULL。
- 重复导入幂等：admin 提供 `number` 且 (type, number) 匹配既有题目 → 更新元数据并替换评测包（客观题全量替换小题）；未命中 → 创建。
- 非 admin 提供 `number` 会被 400 拒绝，普通用户导入仅创建新题（题号自动分配）。

## 特殊题型

### LLM 调用题

在 manifest 中增加 `llm` 字段，只声明**预算**；用哪个 Provider、哪个模型由平台全局
默认统一决定（后台「系统设置 → LLM」），因此题包不含部署期 UUID 或模型名，可跨部署
直接导入。

下面是**与完整 manifest 合并的片段**（`runtime_config` 也需补齐 `image` / `time_limit_ms` / `memory_limit_mb`，此处省略）：

```json
{
  "type": "P",
  "llm": {
    "max_calls": 30,
    "max_tokens": 20000
  },
  "runtime_config": {
    "evaluator": {
      "network": { "enabled": true }
    }
  }
}
```

- `llm` 非 null 即启用；`max_calls` / `max_tokens` 均可选，若提供必须为正整数。
- 旧 manifest 中的 `provider_id` / `model` 被容忍并忽略（不报错）。
- 必须 P 型 + evaluator 联网，否则导入被拒。
- 安全与配额要求见[出 LLM 调用题](../problemsetters/llm-problem.md)。

### 客观题套卷

客观题套卷（`is_objective=true`）支持通过统一题目包导入：`problem.json` 中声明 `"is_objective": true`，根级提供 `questions.json`（小题数组），不要求 `evaluate.py` / `runtime_config`。导入时系统创建/更新套卷并全量替换小题，不产生评测包存储，也不自动重测历史提交。

`questions.json` 是一个**非空数组**，每项对应一道小题：

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `type` | ✅ | `single`（单选）/ `multiple`（多选）/ `judge`（判断） |
| `prompt` | ✅ | 非空题干 |
| `options` | ✅* | `{ key, text }` 数组；`judge` 型省略（服务端用固定「正确 / 错误」选项） |
| `answer` | ✅ | 标准答案数组：单/多选为选项 key 字符串（单选恰好 1 个、多选不重复）；判断题为 `[true]` / `[false]` |
| `explanation` | ❌ | 答案解析（判卷后展示） |
| `sort_order` | ❌ | 卷内排序（非负整数，缺省按数组下标；同一份数组内不得重复） |

```json
[
  {
    "type": "single",
    "prompt": "1+1=?",
    "options": [{ "key": "A", "text": "2" }, { "key": "B", "text": "3" }],
    "answer": ["A"],
    "explanation": "因为 1+1=2"
  }
]
```

::: warning 客观题的两个附加约束
- `questions.json` 必须是非空数组，且每道小题的 `answer` 选项必须存在于该题 `options` 中（判断题除外）。
- 套卷**不得关联算法标签**（系统强制 400），因为客观题没有"通过"概念。
:::
