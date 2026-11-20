# 模板：预测提交题（CSV + 指标）

由 `problem init --template prediction` 生成的**可直接验题**的预测提交题模板
（类 Kaggle）：选手离线训练/推理，上传一个 CSV 预测文件，评测脚本对照隐藏标签
计算准确率。

## 文件

| 路径                | 说明                                               |
| ------------------- | -------------------------------------------------- |
| `problem.json`      | `submission_mode: "prediction"`，只配 evaluator    |
| `statement.md`      | 题面：数据说明、提交格式、指标                     |
| `evaluate.py`       | 评测脚本：`load_predictions` + `emit_case_scores`  |
| `hidden_labels.csv` | 隐藏标签，随支持包进入 Evaluator，**不得**写进结果 |
| `submissions/`      | 参考预测文件与断言，**不进题目包**                 |

## 验题

```bash
noj-cli problem test .      # 满分预测 100、全 0 预测 <60、空文件 0
noj-cli problem lint --strict .
```

## 改造步骤

1. 公开数据集放到外部下载地址，在题面写清下载方式与字段说明（支持包只放评分材料）；
2. 替换 `hidden_labels.csv`，ID 与公开测试集一一对应；
3. 需要其他指标（F1、RMSE、AUC 等）时，改用 SDK 的 `f1_score` / `rmse` /
   `roc_auc` 自行计算，再 `result.accept(分数)`；
4. 按预测文件实际大小设置 `artifact_max_size_mb`，大文件同时调
   `workspace_size_mb`；
5. 更新 `submissions/` 中的预测文件与 `expect.json`。

## 常见坑

- **预测题不能配置 LLM**，也没有 Solution 容器，`runtime_config` 只写
  `evaluator`；
- **ID 对齐默认严格**：缺少、多余或重复 ID 都判 0，防止只交有把握的子集刷高分；
- **选手文件格式错误**应判 0 分并说明原因，不要上抛成平台错误；
- **隐藏标签泄露**：标签只能用于比较，不能出现在 `details` 或打印输出里；
- 基础 Evaluator 镜像不含 numpy / pandas，需要时自行随支持包提供依赖。
