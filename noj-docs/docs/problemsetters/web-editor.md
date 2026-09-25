# Web 题目编辑器

正式出题的默认入口是 Web 管理界面：在管理后台创建或编辑题目，并在题目编辑器中上传统一题目包 zip。

::: info 只用于开发环境
仓库里的 `problems:build` / `problems:import` 只用于样例题与开发环境初始化，**不是**正式出题发布流程。
:::

## 创建 / 编辑题目

入口：管理后台 →「题目」→「新建题目」，或从题目列表进入编辑。

编辑器包含以下区块：

### 基础信息

| 字段 | 说明 |
|------|------|
| 标题 | 必填 |
| 描述 | 题面，Markdown 格式，支持公式与代码块 |
| 难度 | `easy` / `medium` / `hard` |
| 题型 | U 型（用户题，创建者本人与 admin 可管理）或 P 型（主题题，仅 admin） |
| 提交模式 | `code`（默认，单文件代码注入）或 `artifact`（zip 产物提交，见下文） |
| 标签 | 多选，来自[标签管理](../operators/admin-guide.md#problem-tags) |

### 运行时配置（runtime_config）

双容器评测模型下，每个题目声明两个运行时的资源限制（字段与题目包 manifest 一致，见[题目包格式规范](../standards/problem-bundle.md)）：

| 容器 | 配置项 | 说明 |
|------|--------|------|
| Evaluator（出题人 `evaluate.py`） | `image` | 镜像名，须在 `judge_images` 白名单中且 `kind='evaluator'` |
| | `command` | 评测命令，manifest 缺省时注入默认值 `python3 /workspace/evaluate.py` |
| | `time_limit_ms` | Evaluator 容器总时间上限 |
| | `memory_limit_mb` | Evaluator 容器内存上限 |
| | `network.enabled` | 是否让 Evaluator 联网（缺省无网；LLM 题必须开启） |
| Solution（用户代码，Judge Worker 以硬编码名 `main.py` 注入） | `image` | 镜像名，须为 `kind='solution'` 的白名单镜像 |
| | `call_timeout_ms` | 单次 SDK 调用的题目级默认超时 |
| | `memory_limit_mb` | Solution 容器内存上限 |

`call_timeout_ms` 作为单次 SDK 调用的**默认**超时；出题人可在 `evaluate.py` 中用 `runner.call(..., timeout_ms=...)` 按调用覆盖（缺省时回退该默认值）。合理设置 Solution 的调用超时可以防止用户代码死循环拖垮整场评测（见[评测模型](judge-model.md)）。

两层超时的状态语义不同：

- `time_limit_ms` 超时 → 评测流程未正常完成，最终状态为 `error`。
- `call_timeout_ms` 超时若**未被** evaluator 捕获 → 最终状态为 `error`；捕获后由 evaluator 自行决定（通常记为失败用例，最终为 `finished` + 部分分）。详见[评测模型](judge-model.md)。

::: warning 敏感字段与资源上限
`evaluator.command` 与 `evaluator.network` 是**敏感字段**，需要对应 RBAC 权限（`problem:field_evaluator_command` / `problem:field_evaluator_network`）；资源限制字段还受管理员配置的全局上限约束，超限会被拒绝。
:::

### 统一题目包

编辑器中通过拖拽或选择文件上传**统一题目包**（zip）：

- 仅支持 `.zip` 格式，且带合法 zip Content-Type；单个 zip 上限 **128 MiB**（`MAX_SUPPORT_PACKAGE_SIZE`），压缩包还受 ZIP 安全检查约束（条目数 ≤ 1000、单文件 ≤ 64 MiB、总解压 ≤ 512 MiB）。
- 上传走 `POST /api/v1/problems/import-bundle`（multipart 文件字段 `file`）。
- 包结构、`problem.json`、导入语义（按 `(type, number)` 匹配更新/新建、管理员可指定题号等）见[题目包格式规范](../standards/problem-bundle.md)；用例目录约定见[测试数据与样例规范](../standards/test-data.md)。
- 上传后可通过编辑器内的状态确认包是否已生效；管理端也可以下载或删除当前支持包。

::: tip 先保存再上传
上传前需先保存题目（编辑器在上传区会提示"请先保存题目后再上传支持包"）。支持包需自行按[题目包格式规范](../standards/problem-bundle.md)组织，**没有**"支持包模板下载"接口；`GET /api/v1/problems/:id/template` 返回的是**初始代码模板（starter code）**，不是支持包。
:::

### 发布前预检

管理员可调用 `GET /api/v1/admin/catalog/problems/:id/preflight` 查看发布前检查。检查项如下：

| 检查项 | 缺失时的等级 |
|--------|:---:|
| 双容器 `runtime_config` 与镜像白名单 | 阻断错误 |
| 支持包可读取 | 阻断错误 |
| 根级 `evaluate.py`（代码题） | 阻断错误 |
| 根级 `visible.jsonl`（可见用例） | 阻断错误 |
| 隐藏数据（`hidden.jsonl` 或 `hidden/` 目录） | 质量警告 |
| 约定的标准解（`reference_solution.py` / `standard_solution.py` / `solution.py`） | 质量警告 |
| 初始代码模板可读取 | 质量警告 |

预检结果包含当前题目配置、模板和支持包内容指纹。任何一项发生变化都应重新预检，不能复用旧结果。

::: warning 预检只是静态检查
预检目前只做静态结构检查：它**不会**代替隔离 Judge 执行标准解，也**不能**证明隐藏标记不会出现在用户可见结果中，更不能代替对超时、资源限制和容器清理的真实验收。正式发布前仍应按[题目质量规范](../standards/quality.md)完成一次专用验收题自测。
:::

### 产物提交题

需要提交预测结果、模型或其他文件时，将提交模式设置为**产物提交（artifact）**，并配置可选的 zip 大小上限（`artifact_max_size_mb`，留空使用平台默认上限）。做题人提交 zip 后，Judge Worker 会将其解压到 Solution 容器；需要 CPU PyTorch、CV/ML 依赖的题目应使用 `noj-solution-ai`，普通题目可使用 `noj-solution-python`。

产物提交题的入口文件约定为 `submission.py`，不使用代码题的单文件 `main.py` 注入方式。

::: danger 产物提交不支持重测
产物提交评测完成后会立即删除存储对象，**不支持 rejudge**。题面应明确 zip 内目录结构、入口函数和依赖要求。
:::

## 保存与发布

保存题目后，建议按以下顺序自测：

1. 确认支持包已上传且内容完整。
2. 以非管理员身份提交一版参考答案，确认状态与得分符合预期。
3. 检查隐藏用例的可见性是否符合预期（由 evaluator 控制）。
4. 如需调整，修改后重新上传支持包，或对已提交记录触发 rejudge（管理端操作）。

::: tip 初始代码模板
`GET /api/v1/problems/:id/template` 返回题目的**初始代码模板（starter code）**（读取 `problem.json` 的 `template` 字段，缺省 `template.py`），供编辑器在无本地草稿时填入代码框；**不是**支持包模板下载。支持包请按[题目包格式规范](../standards/problem-bundle.md)自行组织后上传。
:::
