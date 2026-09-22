# 出预测提交题（本地 GPU 出分）

本页面向出题人：当题目需要选手**在自己的本地 GPU 上训练 / 推理**，再提交一份预测结果文件、由服务端对照隐藏标签算分时，如何配置与实现 prediction 提交题。

预测题的评测在**单个 Evaluator 容器**内完成：选手提交的是纯数据，平台**不创建 Solution 容器、不执行任何不可信代码**。

## 适用场景

- 选手需要在本地 GPU 训练 / 推理（平台无高性能 GPU，也不会把隐藏判据下发到选手机器）。
- 公开数据集过大，不适合作为评测包的一部分随支持包分发。
- 评分是「预测文件 ↔ 隐藏标签」的确定性计算（准确率、F1、RMSE 等）。

不适合 prediction 的场景：

- 需要执行选手代码才能评分 → 用[代码题](../users/submit.md)（Python 双容器）。
- 需要选手提交模型权重 / 产物目录 → 用**产物提交（artifact）**，见[Web 题目编辑器](web-editor.md)。

## 核心信任边界（不可动摇）

::: warning 公平性基石
任何 prediction 评测的**隐藏标签、标准答案、评分脚本**都不得写入选手可见的响应（含 `output` 与 `details`），也不得下发到选手机器。
:::

- 判据（隐藏标签文件、`evaluate.py`）只进 **Evaluator 容器**。
- 选手本地 GPU 只做「拿不到答案也能算出答案」的计算；平台**不观测、不信任、也不需要信任**选手机器。
- 平台**不托管公开数据集**：公开数据由出题人在题面外链，平台无法校验公开数据与隐藏标签的一致性，这是出题人责任。
- Phase 1 **没有公开榜 / 私有榜**；过拟合仅由提交限次约束。

如果判据需要离开服务端才能工作，说明该题**不适合**用 prediction 模式，请改用其他提交模式。

## 题目配置

在题目编辑器（或题目 JSON）中：

1. 提交模式选择 **预测提交（prediction / 单文件）**。
2. `runtime_config` **只配置 `evaluator`**，省略 `solution`（prediction 无 Solution 容器）。
3. 使用「产物大小上限」字段限制预测文件大小（该字段对 prediction 同样生效）。
4. 如需更大的容器 `/workspace`，设置 `runtime_config.evaluator.workspace_size_mb`（有效范围 512–16384；管理员可设 `judge_max_prediction_workspace_mb` 再收一层上限，超限保存即 400）。

::: warning 不支持 LLM 配置
prediction 题**不能配置 LLM**（创建、更新、题目包导入三处都会拒绝）。评测只运行 Evaluator、不注入 `NOJ_LLM_*` 环境变量，题目级 `llm_config` 不会生效，因此平台在保存期即 fail-fast，而不是拖到提交期。
:::

```json
{
  "submission_mode": "prediction",
  "artifact_max_size_mb": 512,
  "runtime_config": {
    "evaluator": {
      "image": "noj-evaluator-python",
      "command": "python3 /workspace/evaluate.py",
      "time_limit_ms": 60000,
      "memory_limit_mb": 2048,
      "workspace_size_mb": 4096
    }
  }
}
```

- `workspace_size_mb` 缺省时由 Judge Worker 的 `JUDGE_PREDICTION_WORKSPACE_MB` 决定（默认 2048MB）。
- 支持包 **只装评分材料**（`evaluate.py` + 隐藏标签），**不要**把公开数据集打进支持包。
- 预测文件大小受「题目上限」与系统硬上限共同约束，取较小者；文件以 tmpfs 形式落在容器 `/workspace/prediction/`，会占用 Judge Worker 内存，请按需设置 `workspace_size_mb`。

## 题面必须写清楚

1. **公开数据集外链**：给出 HTTPS 下载地址与数据说明，选手自行下载。
2. **预测文件格式**：扩展名、列名 / 张量形状、ID 列约定。
3. **提交大小上限**与提交入口说明（单文件，不是 zip）。
4. 说明**不会**拿到隐藏标签，评分在服务端完成。

## 预测文件格式与 ID 对齐

### 允许的格式

| 扩展名 | 说明 |
|--------|------|
| `.csv` / `.tsv` | 结构化文本，首行表头；`load_predictions` 按对应分隔符解析 |
| `.jsonl` | 每行一个 JSON 对象 |
| `.json` | JSON 数组或单个对象 |
| `.txt` | 纯文本；`load_predictions` 按逗号分隔（CSV 语义）解析，需要自定义解析时请自行读文件 |
| `.npy` | NumPy 单数组 |
| `.npz` | NumPy 多数组（**不解析对象数组**） |
| `.parquet` | 列式二进制 |

::: warning SDK 解析能力与镜像依赖
平台格式白名单允许 `.parquet`，但 `load_predictions` 只解析文本格式与 `.npy` / `.npz`——`.parquet` 需出题人自行解析。基础 Evaluator 镜像（`python:3.12-slim`）**不含 numpy / pandas / pyarrow**：`.npy` / `.npz` 需要你提供 numpy 依赖（例如随支持包放入并在 `evaluate.py` 中引入），`.parquet` 还需要 pyarrow / pandas。
:::

### 禁止 pickle 类格式

以下扩展名**一律拒绝**（反序列化即任意代码执行，与「数据非代码」前提冲突）：

```text
.pkl .pickle .pt .pth .bin .joblib .ckpt
```

此外，平台还会做**魔数检测**：不论扩展名，只要文件头是 pickle 协议头（`\x80\x04` / `\x80\x05`）即拒绝；结构化文本格式前若干字节出现 NUL 字节也视为二进制伪装并拒绝。这些校验发生在提交入库之前，返回错误码 `PREDICTION_FORMAT_REJECTED`。

### ID 对齐

- 预测文件应带一个稳定 ID 列（推荐列名 `id`）；缺失时按**行号**（`0, 1, 2, ...`）作为 ID。
- `evaluate.py` 必须校验预测 ID 与隐藏标签 ID **完全一致**（数量、重复、缺失、多出都会报错），错位不得静默计分。
- SDK 提供 `assert_id_alignment()` 完成该校验。

## 写 evaluate.py

预测文件会被注入到 Evaluator 容器的 `/workspace/prediction/`，且该目录下**只有一个文件**。SDK 通过环境变量暴露位置：

| 环境变量 | 值 |
|----------|-----|
| `NOJ_PREDICTION_DIR` | `/workspace/prediction` |
| `NOJ_PREDICTION_FILE` | 选手上传时的原始文件名 |

### 推荐写法：`load_predictions` + `emit_case_scores`

```python
import json

from noj_evaluator_sdk import (
    assert_id_alignment,
    emit_case_scores,
    load_predictions,
)

# 自动定位 /workspace/prediction 下的唯一文件；
# 永不使用 pickle，.npy/.npz 强制 allow_pickle=False。
preds = load_predictions()

# 隐藏标签随支持包进入 Evaluator 容器，绝不出现在 details 中。
with open("/workspace/hidden_labels.jsonl", encoding="utf-8") as fh:
    gold = {}
    for line in fh:
        if line.strip():
            rec = json.loads(line)
            gold[str(rec["id"])] = rec["label"]

assert_id_alignment(preds, list(gold.keys()))

# 每个 case 自动带 hidden: true，且不写入任何隐藏标签内容。
emit_case_scores(preds, gold, metric="accuracy")
```

`emit_case_scores` 的约定：

- 从预测行中读取名为 **`value`** 的列（`.npy` 自动映射为 `value`）；ID 取 `id` 列，缺失时按行号。
- `gold` 是 `{case_id: 标签}` 映射；标签只用于比对，不写入 `details`。
- 每个 case 输出 `{"case_id": ..., "status": "Accepted"|"WrongAnswer", "hidden": true}`。
- 分数按 `score_scale`（默认 100.0）× 正确率计算，SDK 再按平台约定写入 ×100 整数值。
- **ID 覆盖率默认 fail-closed**：预测 ID 与 `gold` 键集合必须完全一致（重复/缺少/多余/行数不等都报错），
  因此只提交子集**不会**得到更高分数。确需宽松匹配（gold 只覆盖部分 case）时，
  必须显式传 `on_missing="skip"`，此时未命中的预测行被跳过、分母只算交集。
- 目前 `emit_case_scores` 仅支持 `metric="accuracy"`；其他度量以独立函数导出，由出题人自行组合后用 `result.accept(...)` 输出。

因此若你的预测列不叫 `value`（例如 `label` / `prediction`），请改用下面的自定义评分，或在题面约定列名为 `value`。

### 自定义评分

需要自定义度量时，SDK 导出确定性度量函数：`accuracy` / `f1_score` / `rmse` / `mae` / `roc_auc`，并提供 `values_equal(pred, gold)` 作为归一化比较（数值容差 `rel_tol=1e-9`、`abs_tol=1e-12`，数值字符串如 CSV 的 `"1"` 可与 `1` 相等）。

```python
import json

from noj_evaluator_sdk import load_predictions, result, rmse

preds = load_predictions()
pred = [r["value"] for r in preds.rows]
gold = json.load(open("/workspace/hidden_gold.json"))  # 仅用于比对

cases = [
    {"case_id": pid, "status": "Accepted", "hidden": True}
    for pid in preds.ids
]
# 分数含义由出题人定义：越低越好时需自行换算为「越高越好」的分数。
result.accept(score=max(0.0, 100.0 - rmse(pred, gold)), details={"cases": cases})
```

度量必须**确定性**（不依赖随机、时间、并发顺序），否则同一文件多次评测分数会漂移。

## 不得回写隐藏标签

- `details.cases[]` 中每个用例**必须**带布尔 `hidden: true`。提交结果投影以 `hidden` 为唯一判定依据；任意用例缺失该字段会被 fail-safe 视为旧脚本，整份用例详情不返回。
- 隐藏用例**只能**输出 `case_id` / `status` / `hidden` / `time_ms` / `memory_kb`，**MUST NOT** 写入 `input`、`expected_output`、`actual_output`。
- 不得把隐藏标签、标准答案或评分脚本的内容写进选手可见的 `output`（含 stdout 诊断文本）、`details.message` 或异常信息。
- 调试信息（`print` 到 stdout）同样会进入选手可见的 `output`，请勿打印标签。

约定细节见[测试数据与样例规范](../standards/test-data.md)与 [Evaluator SDK](../mechanisms/evaluator-sdk.md)。

## 生命周期与限制

- 预测文件复用提交的 `artifact_storage_url`；**评测完成后对象即被删除**。
- **不支持重测**：预测文件是一次性的，需要重算请重新提交。
- 评测期间容器内 `workspace_size_mb` 为 tmpfs，大文件会占用 Worker 内存，请按需设置。
- prediction 题不执行 Solution 容器，因此没有 `call_timeout_ms` / 用户函数调用语义。

## 验证方法

1. 在题目编辑器创建 prediction 题，确认 `runtime_config` 只含 `evaluator`。
2. 构造一个预测文件与隐藏标签的**小型**合成集，在本地 / E2E 环境提交一次，确认输出 `---RESULT---`、每个 case 带 `hidden: true`、分数符合预期。
3. 恶意用例：
   - 上传 `.pkl` / 带 pickle 协议头的文件 → 应返回 `PREDICTION_FORMAT_REJECTED`。
   - 上传 ID 错位（缺行 / 重复 / 多出）→ `evaluate.py` 应报可读错误而不是算错分。
   - 尝试重测已完成的 prediction 提交 → 应被拒绝。
4. 检查提交详情页的 `details` 中**没有任何隐藏标签内容**。
