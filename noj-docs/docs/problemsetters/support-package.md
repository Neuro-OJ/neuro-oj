# 统一题目包（Problem Bundle）

统一题目包是 NOJ 的**题目导入载体**：单个 zip 包含题面、评测内容与评测配置，
通过 `POST /api/v1/problems/import-bundle`（管理界面上传）或 `noj problems import`
一键导入，创建或更新题目。

## 包结构

```text
<任意名>.zip
├── problem.json      # 必需：题目 manifest
├── statement.md      # 必需：题面 Markdown
├── evaluate.py       # 必需：评测脚本（必须位于 zip 根目录）
├── visible.jsonl     # 可选：测试数据（格式由题目自定）
├── hidden.jsonl
└── assets/           # 可选：其他 evaluate.py 需要的文件
```

- `evaluate.py` **必须位于 zip 根级**——Judge 将包解压到容器 `/workspace` 后
  路径固定为 `/workspace/evaluate.py`。
- 测试数据（testcase）**不标准化**：`visible.jsonl` / `hidden.jsonl` 只是内置
  样例题的约定，你可以用 `cases/*.json`、SQLite、CSV 等任何方式组织，只要
  `evaluate.py` 自己能读取。
- 参考实现（如 `submission_sample.py`）**不要**放入包中；`problems:build` 打包时
  自动排除 `submission*` / `__pycache__` / `.git`。

## manifest（problem.json）

```json
{
  "format_version": 1,
  "id": "1001",
  "number": 1001,
  "title": "题目标题",
  "difficulty": "easy",
  "type": "P",
  "categories": ["算法"],
  "runtime_config": {
    "evaluator": {
      "image": "noj-evaluator-python",
      "time_limit_ms": 5000,
      "memory_limit_mb": 512
    },
    "solution": {
      "image": "noj-solution-python",
      "entry": "submission_sample.py",
      "call_timeout_ms": 5000,
      "memory_limit_mb": 512
    }
  }
}
```

| 字段 | 必填 | 说明 |
|------|:---:|------|
| `format_version` | ✅ | 当前 `1` |
| `title` | ✅ | 非空 |
| `runtime_config` | ✅ | 双容器配置；`evaluator.command` 可缺省（默认 `python3 /workspace/evaluate.py`） |
| `statement.md` 文件 | ✅ | 与 `manifest.description` 二选一（文件优先） |
| `evaluate.py` 文件 | ✅ | 根级缺失 → 400 |
| `id` | ❌ | 仅 admin 生效：命中主键 → 更新；未命中按 `(type, number)` 匹配；都不命中 → 以该 id 创建 |
| `number` | ❌ | 仅 admin 生效，缺省 type 内自动分配 |
| `difficulty` | ❌ | `easy` / `medium` / `hard`，缺省 `medium` |
| `type` | ❌ | `U` / `P`，缺省 `U`（P 型仅 admin） |
| `categories` | ❌ | 分类名数组，按 name 匹配已有分类，缺省忽略 |
| `samples` | ❌ | 预留；缺省从题面自动提取 |

## 导入语义与存储

- 上传的 zip 是**导入载体**；系统剥离 `problem.json` / `statement.md` 后重建
  **纯净评测包**存入存储（`noj-storage://`），题面/元数据的唯一事实来源是数据库。
- 重复导入幂等：manifest 带 `id` 且题目存在 → 更新元数据并替换评测包；
  带 `id` 且不存在 → 以该 id 创建（保证下次导入命中更新路径）。
- 旧的松散支持包上传端点（`POST /problems/:id/support-package`）已废弃，一律
  通过 `import-bundle` 导入。

## 目录三层模型

```text
data/problems-src/<id>/    题目源目录（版本控制）
        │  noj problems build（排除 submission* / __pycache__ / .git）
        ▼
data/packages/<id>.zip     构建产物 = 导入载体（gitignored，可重建）
        │  noj problems import / 管理界面上传（剥离元数据）
        ▼
data/storage/<hash>.zip    LocalStorageProvider 存储后端（gitignored）
```

`SUPPORT_PACKAGE_DIR` 环境变量可覆盖本地存储目录（默认 `data/storage/`）。
