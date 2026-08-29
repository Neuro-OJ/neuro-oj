# Web 题目编辑器

正式出题的默认入口是 Web 管理界面：在管理后台创建或编辑题目，并在题目编辑器中上传统一题目包 zip。仓库里的 `problems:build` / `problems:import` 只用于样例题与开发环境初始化，不是正式出题发布流程。

## 创建 / 编辑题目

入口：管理后台 →「题目」→「新建题目」，或从题目列表进入编辑。

编辑器包含以下区块：

### 基础信息

| 字段 | 说明 |
|------|------|
| 标题 | 必填 |
| 描述 | 必填，Markdown 格式，支持公式与代码块（题面） |
| 难度 | `easy` / `medium` / `hard` |
| 题型 | U 型（用户题，创建者本人与 admin 可管理）或 P 型（主题题，仅 admin） |
| 标签 | 多选，来自[标签管理](../operators/admin-guide.md#problem-tags) |

### 运行时配置（runtime_config）

双容器评测模型下，每个题目声明两个运行时的资源限制：

- **Evaluator**（出题人代码 `evaluate.py`）：`time_limit_ms`、`memory_limit_mb`
- **Solution**（用户代码，Judge Worker 以硬编码名 `main.py` 注入）：调用超时 `call_timeout_ms`（**题目级默认值**）、`memory_limit_mb`

配置保存在题目上，Judge Worker 评测时读取。`call_timeout_ms` 作为单次 SDK 调用的**默认**超时；出题人可在 `evaluate.py` 中用 `runner.call(..., timeout_ms=...)` 按调用覆盖（缺省时回退该默认值）。合理设置 Solution 的调用超时可以防止用户代码死循环拖垮整场评测（见[评测模型](judge-model.md)）。

两层超时的状态语义：`time_limit_ms` 超时表示评测流程未正常完成，最终状态为 `SystemError`；`call_timeout_ms` 超时若未被 evaluator 捕获，最终状态为 `TimeLimitExceeded`，捕获后由 evaluator 自行决定（详见[评测模型](judge-model.md)）。

### 统一题目包

编辑器中通过拖拽或选择文件上传**统一题目包**（zip）：

- 仅支持 `.zip` 格式，且带合法 zip Content-Type；大小受系统限制。
- 上传走 `POST /api/v1/problems/import-bundle`（multipart 文件字段 `file`）。
- 包结构、`problem.json`、导入语义（按 `(type, number)` 匹配更新/新建、管理员可指定题号等）见[题目包格式规范](../standards/problem-bundle.md)；用例目录约定见[测试数据与样例规范](../standards/test-data.md)。
- 上传后可通过编辑器内的状态确认包是否已生效；管理端也可以下载或删除当前支持包。

### 产物提交题

需要提交预测结果、模型或其他文件时，将提交模式设置为**产物提交（artifact）**，并配置可选的 zip 大小上限。做题人提交 zip 后，Judge Worker 会将其解压到 Solution 容器；需要 CPU PyTorch、CV/ML 依赖的题目应使用 `noj-solution-ai`，普通题目可使用 `noj-solution-python`。

产物提交题的入口文件约定为 `submission.py`，不使用代码题的单文件 `main.py` 注入方式。产物提交不支持重测，题面应明确 zip 内目录结构、入口函数和依赖要求。

## 保存与发布

保存题目后，建议按以下顺序自测：

1. 确认支持包已上传且内容完整。
2. 以非管理员身份提交一版参考答案，确认状态与得分符合预期。
3. 检查隐藏用例的可见性是否符合预期（由 evaluator 控制）。
4. 如需调整，修改后重新上传支持包，或对已提交记录触发 rejudge（管理端操作）。

::: tip 模板
编辑器提供支持包模板下载（`GET /api/v1/problems/:id/template`），新题目可以从模板起步，避免手写包结构出错。

:::
