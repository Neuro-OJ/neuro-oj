# 题目包格式规范

统一题目包（Problem Bundle）是 Neuro OJ 的**题目导入载体**：单个 zip
包含题面、评测内容与评测配置，通过
`POST /api/v1/problems/import-bundle`（管理界面上传）或 `noj problems import`
一键导入，创建或更新题目。

> 本页是**强制规范**（MUST）：导入时系统会强制校验包结构与 manifest
> 字段，任一不合法都会以 HTTP 400
> 拒绝，并返回具体字段错误。导入校验只保证**结构合法**（字段、必填项、ZIP
> 安全），**不保证题面、测试数据与评测脚本的质量**——发布前请按[题目质量要求](quality.md)完成自测。

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

客观题套卷包（kind: "objective"）：
<任意名>.zip
├── problem.json      # 必需：manifest（kind: "objective"）
├── questions.json    # 必需：小题数组
└── statement.md      # 可选：套卷说明
```

传统 OI 题包（`kind: "oi"`）不需要 `evaluate.py`，由固定的 C99/C++11
评测后端读取题包中的测试数据和标准答案：

```text
<任意名>.zip
├── problem.json      # 必需：包含 OI runtime_config
├── statement.md      # 可选：题面
└── testdata/
    ├── 1.in
    └── 1.out
```

OI 的 `runtime_config` 需要声明 `backend`、`languages`、`checker` 和
`subtasks`；每个测试点的 `input`/`output` 必须引用包内文件，子任务分值总和为
100。支持 `default`、`strict`、`testlib` checker，以及标准输入输出或 `filename`
文件输入输出。题包导入时会拒绝路径穿越、缺失测试数据和不支持的 Hydro 计分语义。

- `evaluate.py` **必须位于 zip 根级**——Judge Worker 将包解压到容器 `/workspace`
  后路径固定为 `/workspace/evaluate.py`。
- 测试数据格式**不强制**：`visible.jsonl` / `hidden.jsonl` 是推荐约定，你可以用
  `cases/*.json`、SQLite、CSV 等任何方式组织，只要 `evaluate.py`
  自己能读取。推荐约定见[测试数据与样例规范](test-data.md)。
- 模板文件（如 `template.py`，即 `manifest.template`
  声明的文件）**必须放入包中**：平台在导入时读取它并落库，作为编辑器初始代码（starter
  code）；参考实现（如
  `submission_sample.py`）**不要**放入包中。`problems:build` 与
  `noj-cli problem pack` 打包时自动排除 `submission*`、`__pycache__` 与 `.git`。

::: danger 三种"根级缺失"会导致导入失败（400）

- 编程题包根级缺 `problem.json`、`evaluate.py`，或题面（`statement.md` 与
  `manifest.description` 皆缺）。
- 客观题包根级缺 `problem.json` 或 `questions.json`。

注意是 **zip 根级**而非任意子目录；`assets/evaluate.py` 这类嵌套路径不算数。 :::

## manifest（problem.json）

当前格式为 `format_version: 3`，用 `kind` 一个字段声明题型。最小 AI
编程题只需三个字段：

```json
{ "format_version": 3, "kind": "ai", "title": "A+B Problem" }
```

完整示例（只写与缺省值不同的字段即可）：

```json
{
  "format_version": 3,
  "kind": "ai",
  "number": 1001,
  "title": "题目标题",
  "difficulty": "easy",
  "tags": ["入门", "LMCC 样例题"],
  "runtime_config": {
    "evaluator": { "time_limit_ms": 60000 }
  },
  "template": "template.py"
}
```

### 题型（kind）与允许字段

| `kind`      | 含义                                          | 题型专属字段                                                                   | 根级必需文件                         |
| ----------- | --------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| `ai`        | 双容器 AI 评测（code/artifact/prediction/ui） | `runtime_config`、`submission_mode`、`template`、`artifact_max_size_mb`、`llm` | `evaluate.py`（`ui` 另需 `ui.html`） |
| `oi`        | 传统 C/C++ 测试点评测                         | `runtime_config`（必填，OI 结构）                                              | 被引用的测试数据文件                 |
| `objective` | 客观题套卷                                    | 无                                                                             | `questions.json`                     |

所有题型通用的字段：`format_version`、`kind`、`title`、`description`、`number`、
`difficulty`、`tags`、`samples`。出现不属于「通用字段 ∪ 该题型字段」的顶层字段
（包括拼写错误）时导入以 400 拒绝，错误信息会列出该题型支持的全部字段。

| 字段                   | 必填 | 说明                                                                                                                  |
| ---------------------- | :--: | --------------------------------------------------------------------------------------------------------------------- |
| `format_version`       |  ✅  | 新包使用 `3`；旧格式 `1` / `2` 仍可导入，见[版本与兼容](#版本与兼容)                                                  |
| `kind`                 |  ✅  | `ai` / `oi` / `objective`                                                                                             |
| `title`                |  ✅  | 非空字符串                                                                                                            |
| `description`          |  ❌  | 题面兜底；`statement.md` 存在时以文件为准，二者皆缺 → 400                                                             |
| `number`               |  ❌  | 可选目标域数字题号；域内编号由数据库原子分配                                                                          |
| `difficulty`           |  ❌  | `easy` / `medium` / `hard`，缺省 `medium`                                                                             |
| `tags`                 |  ❌  | 标签名数组，按 name 匹配已有标签；不存在的名字被忽略并 warning                                                        |
| `samples`              |  ❌  | 独立公开样例数组，每项含唯一 `id`、`input`、`output` 和可选 `explanation`                                             |
| `runtime_config`       | ✅*  | `ai` 可整体或逐字段缺省（见下表）；`oi` 必填                                                                          |
| `template`             |  ❌  | 模板文件名（纯文件名，禁止 `/`、`\`、`..`），缺省 `"template.py"`                                                     |
| `submission_mode`      |  ❌  | `code`（缺省）/ `artifact` / `prediction` / `ui`；界面题需根级 `ui.html`，见[界面题](../problemsetters/ui-problem.md) |
| `artifact_max_size_mb` |  ❌  | artifact 提交大小上限（MB），正整数或 `null`（缺省 = 平台硬上限）                                                     |
| `llm`                  |  ❌  | LLM 调用题预算 `{ max_calls?, max_tokens?, models? }`，声明即开启 evaluator 网络                                      |

### AI 题 runtime_config 缺省值

`kind: "ai"` 的 `runtime_config` 每个字段都可缺省，导入时补全为完整配置后保存：

| 字段                        | 缺省值                                                |
| --------------------------- | ----------------------------------------------------- |
| `evaluator.image`           | 平台官方镜像 `noj-evaluator-python`（带部署仓库前缀） |
| `evaluator.command`         | `python3 /workspace/evaluate.py`                      |
| `evaluator.time_limit_ms`   | 5000                                                  |
| `evaluator.memory_limit_mb` | 512                                                   |
| `evaluator.network.enabled` | 声明 `llm` 时为 `true`，否则不联网                    |
| `solution.image`            | 平台官方镜像 `noj-solution-python`（带部署仓库前缀）  |
| `solution.call_timeout_ms`  | 5000                                                  |
| `solution.memory_limit_mb`  | 512                                                   |

- 缺省镜像取导入平台登记的官方镜像（部署配置 `JUDGE_IMAGE_BASE` 决定仓库前缀），
  与显式填写的镜像一样需要在镜像白名单中。
- `submission_mode: "prediction"` 不补全 `solution`（无 Solution 容器）。
- 同时声明 `llm` 与 `evaluator.network.enabled: false` 属冲突声明 → 400。

> `runtime_config.solution` 无需配置入口文件名：用户代码由 Judge Worker
> 以硬编码名 `main.py` 注入容器，出题人不可见、不可配置。

::: tip `submission_mode: artifact` 的入口约定 产物提交题的 zip 由 Judge Worker
解压到 Solution 容器，入口文件固定为 `submission.py`（代码题才是硬编码的
`main.py`）。详见[Web 题目编辑器 § 产物提交题](../problemsetters/web-editor.md#产物提交题)。
:::

## 版本与兼容

| `format_version`     | 处理方式                                                        |
| -------------------- | --------------------------------------------------------------- |
| `3`                  | 当前格式，严格校验                                              |
| `2`                  | 自动转换为格式 3 后导入并给出升级告警                           |
| `1`                  | 仅显式 `type: "P"` 的包自动转换并告警；U 包或未声明分类的包拒绝 |
| Hydro `problem.yaml` | 自动识别为 `oi` 题导入                                          |

- 旧格式转换规则：`is_objective: true` → `objective`；`judge_type: "oi"` →
  `oi`； 其余 → `ai`。`type` / `domain_id` 被移除，`llm` 只保留预算与模型别名，
  格式 3 不认识的字段（如已退役的 `categories`）被忽略并告警。
- 旧包不必立即修改，但建议运行 `noj-cli problem migrate <题目目录>` 把源
  `problem.json` 原地改写为格式
  3；迁移与导入期转换使用同一实现，不写入任何平台缺省值。
- 旧格式缺省 `runtime_config` 时同样按上表补全；声明 `llm`
  时不再要求显式开启网络。
- `noj-cli problem lint` 与服务端导入共用同一份校验代码，离线通过即可导入。

::: warning ZIP 安全与上传入口约束

- 拒绝路径穿越条目：绝对路径（`/` 开头）或含 `..` 段的条目一律 400。
- 条目数 ≤ **1000**、单文件 ≤ **64 MiB**、总解压 ≤ **512 MiB**。
- 上传 zip 本体（压缩后）另有大小上限 **128
  MiB**（`MAX_SUPPORT_PACKAGE_SIZE`），与支持包上传一致。
- `POST /api/v1/problems/import-bundle` 读取 multipart 的 **`file`**
  字段；缺失或不是文件、扩展名非 `.zip`、Content-Type 不在 `application/zip` /
  `application/x-zip-compressed` 之内，都会 400。 :::

## 导入语义与存储

- 上传的 zip 是**导入载体**；编程题系统剥离 `problem.json` / `statement.md`
  后重建**纯净评测包**存入存储（`noj-storage://`），题面/元数据的唯一事实来源是数据库。客观题套卷不产生评测包存储，`support_package_storage_url`
  为 NULL。
- 导入目标由域路径或 CLI `--domain <slug>`
  指定；同域更新已有题时写入共享草稿并校验 `If-Match` /
  revision，随后显式发布，不直接改写已发布版本。
- 编辑已有题使用
  `POST /api/v1/domains/:slug/problems/:reference/import-bundle`，multipart
  `file` 携带题包；公开题号只是定位信息，权限仍按域与题目检查。

## 特殊题型

### LLM 调用题

在 manifest 中增加 `llm` 字段，只声明**预算**；用哪个
Provider、哪个模型由使用域配置决定（域内「LLM → Provider
管理」），因此题包不含部署期 UUID 或模型名，可跨部署 直接导入。

```json
{
  "format_version": 3,
  "kind": "ai",
  "title": "LLM 调用题",
  "llm": {
    "max_calls": 30,
    "max_tokens": 20000
  }
}
```

- `llm` 非 null 即启用；`max_calls` / `max_tokens` 均可选，若提供必须为正整数。
- `llm.models` 可选：允许评测代码调用的模型别名（1–8 个，格式
  `^[a-z][a-z0-9_-]{0,31}$`，不得重复），缺省
  `["default"]`。题包只含别名，不含真实模型名；别名在目标平台由运营者配置，导入时未配置的别名只告警，评测前须配置，且同一道题的别名须属于同一个
  Provider。
- 旧 manifest 中的 `provider_id` / `model` 被容忍并忽略（不报错）。
- 声明 `llm` 即开启 evaluator 网络；显式写 `network.enabled: false` 会被拒绝。
- 安全与配额要求见[出 LLM 调用题](../problemsetters/llm-problem.md)。

### 客观题套卷

客观题套卷（`kind: "objective"`）支持通过统一题目包导入：`problem.json` 中声明
`"kind": "objective"`，根级提供 `questions.json`（小题数组），不要求
`evaluate.py` /
`runtime_config`。导入时系统创建/更新套卷并把小题写入**共享草稿**（全量替换），不产生评测包存储，也不自动重测历史提交；**导入后需要显式发布版本**（管理端「发布版本」或
CLI `problems import --publish`），否则题目没有可作答的版本。

`questions.json` 是一个**非空数组**，每项对应一道小题：

| 字段          | 必填 | 说明                                                                                                                                                 |
| ------------- | :--: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`      |  ✅  | 非空题干                                                                                                                                             |
| `options`     | ✅*  | `{ key, text }` 数组；`judge` 型省略（服务端用固定「正确 / 错误」选项）                                                                              |
| `answer`      |  ✅  | 标准答案数组：单/多选为选项 key 字符串（单选恰好 1 个、多选不重复）；判断题为 `[true]` / `[false]`                                                   |
| `explanation` |  ❌  | 答案解析（判卷后展示）                                                                                                                               |
| `sort_order`  |  ❌  | 卷内排序（非负整数，缺省按数组下标；同一份数组内不得重复）                                                                                           |
| `key`         |  ❌  | 小题的**跨版本稳定标识**（非空字符串，同一份数组内不得重复）。重判按 key 匹配历史答案；缺省时服务端生成 UUID。**不会按序号或题干猜测旧小题对应关系** |

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

- `questions.json` 必须是非空数组，且每道小题的 `answer` 选项必须存在于该题
  `options` 中（判断题除外）。
- 套卷**不得关联算法标签**（系统强制 400），因为客观题没有"通过"概念。 :::
