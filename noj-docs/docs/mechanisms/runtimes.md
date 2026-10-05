# 评测镜像与沙箱运行时（Runtimes）

在 Neuro OJ 中，所有评测工作均被封装在纯净的 Docker
容器镜像内执行。系统建立了三层运行时配置模型，依托严格的镜像白名单与沙箱隔离策略，为
AI 模型训练与算法评测提供安全、确定性的执行环境。

---

## 运行时架构与语言选型准则

Neuro OJ 保留面向 AI 题目的 Python 双容器模式，同时提供传统 OI 题的独立
`judge_type: "oi"` 模式。两种模式共享提交队列与结果协议，但不共享题目运行配置：

- `dual`：Evaluator + Solution 双容器，面向 Python/LLM 题；
- `oi`：固定 C/C++ 工具链执行，题包只在 worker 侧读取输入与标准答案；原生后端生产环境
  经受控的 `go-judge` 节点编译/运行，WASM 后端由 Rust Wasmtime 执行。

OI 的 `backend` 按题目固定，不会在 native 与 WASM 之间静默回退。native 没有配置
`JUDGE_GO_JUDGE_URL` 时只保留本地 Docker 兼容路径，便于开发和离线测试；testlib
checker 在独立的受信 checker sandbox 中编译和运行。

---

## 运行时三层派生模型

评测任务在从提交到落入 Docker 执行的过程中，经过三层清晰的模型解析：

```mermaid
flowchart TD
    Sub[1. 提交元数据: language='python3' / 'c' / 'cpp'] --> Srv[noj-core 校验语言有效性并设定默认入口文件名]
    Srv --> Conf[2. 题目配置: runtime_config]
    Conf --> Whitelist{3. 校验镜像是否在 judge_images 白名单}
    Whitelist -- 校验通过 --> Judge[noj-judge Worker 拉起对应容器]
    Whitelist -- 校验失败 --> Err[阻断提交并报告非法镜像错误]
```

1. **第 1 层：提交语言标识（Language Identifier）**：客户端提交时携带的
   `language` 字段。双容器题使用 `/workspace/main.py`；OI 题按语言使用
   `/workspace/main.c` 或 `/workspace/main.cpp`，编译器与入口由 worker 固定；
2. **第 2 层：题目运行时配置（`runtime_config`）**： 题目出题人在 Web 编辑器或
   `problem.json` 中明确声明 Evaluator 与 Solution 分别使用的具体镜像名称、CPU
   配额、内存配额以及 Evaluator 的启动指令（缺省为
   `python3 /workspace/evaluate.py`）；
3. **第 3 层：镜像白名单与纵深防御（Whitelist & Prefix Verification）**：
   - **业务层准入**：`noj-core` 在创建或更新题目时，比对 `judge_images`
     数据库注册表；
   - **沙箱层熔断**：`noj-judge` 评测机在从 Redis
     队列取出任务启动容器前，使用宿主环境变量 `JUDGE_IMAGE_PREFIX`
     对目标镜像名称实施**二次前缀白名单校验**，阻断非官方镜像执行。

---

## 官方标准评测镜像矩阵

官方提供经过裁剪与安全加固的标准基础镜像（通过
`noj-judge/scripts/build-sdk-images.sh` 脚本统一部署构建）：

| 镜像标识                   | 运行类别       | 预装依赖与适用场景                                                                                                 |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| **`noj-evaluator-python`** | Evaluator 容器 | 包含出题人 SDK（`noj_evaluator_sdk`）、标准测试工具库与 HTTP 客户端，用于运行 `evaluate.py`                        |
| **`noj-solution-python`**  | Solution 容器  | 轻量级 Python 运行时，内置 `noj_solution_sdk.host` 协议服务，适用于绝大多数标准算法与客观推理题                    |
| **`noj-solution-ai`**      | Solution 容器  | **数据科学与机器学习专享沙箱**。预装 CPU 版 PyTorch、NumPy、Pandas、Scikit-learn、OpenCV 与 SciPy 等科学计算全家桶 |
| **`noj-oi-cpp`**           | OI 容器        | GCC/G++ C99/C++11 编译器；每个测试点使用一次性非 root、无网络容器 |

## OI 题包配置

OI 题包的 `problem.json` 使用以下核心字段；`subtasks` 分数总和必须为 100，子任务
只有其全部测试点通过时才得分，依赖失败的子任务记为 `IGN`：

```json
{
  "format_version": 1,
  "title": "A+B",
  "judge_type": "oi",
  "runtime_config": {
    "backend": "native",
    "languages": ["c", "cc"],
    "time_limit_ms": 1000,
    "memory_limit_mb": 256,
    "checker": {"type": "default"},
    "subtasks": [{
      "id": "all",
      "score": 100,
      "cases": [{"input": "tests/1.in", "output": "tests/1.out"}]
    }]
  }
}
```

`default` checker 按 Hydro 兼容的 token 比较，`strict` 按字节比较，`testlib` 使用
题包中的受信 checker 源码并在隔离 checker sandbox 中以
`checker input output answer` 参数运行。输入、输出和 checker 路径会在题包导入时
做路径穿越与存在性校验；题目版本不单独保存，重测时读取题目的最新配置和支持包。
题包辅助文件分为 `user_extra_files`（选手编译/运行可见）、`compile_extra_files`
（用户与 checker 编译可见）和 `checker_extra_files`（仅 checker sandbox 可见）；导入
Hydro 题包时，`user_extra_files` 与 `judge_extra_files` 分别保留在对应的用户和 checker
范围。

WASM 任务使用活动 OI 成本表把 `floor(time_limit_ms * fuel_per_ms)` 转成 Wasmtime
fuel 预算，并同时记录等效耗时、执行线程 CPU 时间和墙钟时间。校准特征严格对应
Wasmtime 49 的变量成本字段，并包含平坦算子的 `base_fuel`。普通指令基准拟合
`fuel_per_ms`，变量成本按同一尺度量化，留出集验证使用最终部署的成本表。
输入数据大小不增加执行预算。成本表由管理员通过 `noj-cli judge calibrate`
生成，必须通过独立留出集验证后才能启用；比赛进行期间不能切换。

---

## 产物提交（Kaggle 模式）运行时特征

针对提交离线训练成果（如预测结果 CSV、微调模型权重或生成策略代码）的题目：

- **ZIP 解包交付**：选手上传打包的 `.zip` 成果，评测宿主自动解压至 Solution
  沙箱工作区 `/workspace`；
- **统一入口约定**：系统一律以约定入口 **`python3 /workspace/submission.py`**
  启动选手程序；
- **存储自洁与重测限制**：为避免海量模型权重迅速撑爆存储集群，选手上传的 ZIP
  产物在沙箱评测完毕后**即刻触发物理垃圾回收**。因此，此类产物题**不支持管理员执行
  Rejudge 重测**。

---

## 常见运行时排错索引

| 异常现象                              | 核心根因定位                                                                 | 权威解决方案                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 提交立即显示 **`error`**，无评测日志  | 题目配置的 Docker 镜像未在宿主机预先拉取，或未被录入 `judge_images` 白名单表 | 在评测宿主机执行 `bash scripts/build-sdk-images.sh` 构建基础镜像，并核实题目 `runtime_config` 镜像名称拼写 |
| OI 提交显示 `SE`                       | Worker 未安装固定工具链/镜像、go-judge 或 checker sandbox 返回系统错误，或 WASM 成本表无效 | 检查 `JUDGE_OI_IMAGE`、`JUDGE_GO_JUDGE_URL`、WASI 工具链和活动成本表摘要；不要把题目命令或镜像写入提交消息 |
| 导入 `torch` 报 `ModuleNotFoundError` | 题目未配置使用 AI 专用镜像                                                   | 出题人在题目配置中将 Solution 镜像切换为 `noj-solution-ai`                                                 |
