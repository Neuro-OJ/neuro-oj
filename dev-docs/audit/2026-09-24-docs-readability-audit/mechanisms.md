# mechanisms 组 文档审计报告

> 执行日期：2026-09-24 ｜ 范围：`noj-docs/docs/mechanisms/`
> 规范：[RUBRIC.md](./RUBRIC.md)

## 范围

| 文件 | 改前行数 | 改后行数 |
| --- | ---: | ---: |
| `index.md` | 10 | 16 |
| `judge-model.md` | 86 | 105 |
| `evaluator-sdk.md` | 168 | 206 |
| `solution-sdk.md` | 68 | 76 |
| `rpc.md` | 140 | 163 |
| `runtimes.md` | 46 | 56 |
| `capability-networking.md` | 105 | 115 |

事实源：`noj-judge/src/dual/{protocol.rs,mod.rs,tracker.rs,llm_env.rs,container.rs}`、`noj-judge/src/{config.rs,types.rs,sandbox/container.rs,sandbox/host_config.rs,judge/runner.rs}`、`noj-judge/sdk/{common,evaluator,solution}`、`noj-core/src/domains/{catalog,submission}/...`、`noj-core/data/problems-src/1001/evaluate.py`。

## 正确性发现

| 位置 | 问题 | 证据（路径 + 符号） | 处置 |
| --- | --- | --- | --- |
| `runtimes.md` 第 6 行 | “支持包模板固定 `python3`”措辞不精确，与支持包无关；实为**前端初始代码模板的返回语言**固定 `python3` | `noj-core/src/domains/catalog/services/support-package.ts:199` `getProblemTemplate()` 返回 `{ content, language: "python3" }`，`:252` 注释 `TODO: 多语言时…目前固定 python3` | 已修正：改为“前端返回的**初始代码模板语言也固定为 `python3`**（`GET /problems/:id/template` 返回的 `language` 字段），与支持包无关” |
| `runtimes.md` 第 18 行（改前） | “题目可选的编程语言由出题人在运行时配置中声明，做题人页面只会看到该题启用的语言”——**无此字段**：`runtime_config` 不含语言开关，前端编辑器写死只提供 Python 3 | `noj-core/src/domains/catalog/types/runtime-config.ts` 无 languages 字段；`noj-ui/components/editor/EditorWorkspace.vue:157` `languages = [{ value: 'python3', label: 'Python 3' }]`（硬编码）；全仓无 `default_language`/`supported_languages`（仅 `support-package.ts:252` TODO 提及） | 已修正：删除该断言，改为“前端固定只提供 Python 3” |
| `runtimes.md` 语言表 | 语言表只给“说明”，未给默认文件名；与 `LANGUAGE_EXT_MAP` 不一致的风险 | `noj-core/src/domains/submission/types/index.ts:207` `LANGUAGE_EXT_MAP { python3: main.py, python: main.py, cpp: main.cpp, c: main.c, javascript: main.js }` | 已修正：表格补默认文件名列（值取自常量） |
| `runtimes.md` 第 22 行 | “`language` 字段决定提交文件名（当前固定映射为 `main.py`）”表述含混——实际 `LANGUAGE_EXT_MAP` 给出的是**默认文件名**，且 Judge Worker 对代码提交一律注入硬编码 `main.py` | `LANGUAGE_EXT_MAP`（上）；`noj-judge/src/dual/mod.rs:44` `SOLUTION_ENTRY_FILE = "main.py"`；`:384-403` 代码提交走 `inject_file_to_container(SOLUTION_ENTRY_FILE,…)` | 已修正：拆清「language 仅用于校验与默认命名」与「Judge Worker 统一注入 `main.py`」 |
| `evaluator-sdk.md` 输出结果示例 | `result.accept(score=1000)` / `wrong_answer(score=500)` 与“满分 10 分用 ×100”并置，**双重放大**（实际会写成 100000）。`score` 参数是实际分，SDK 内部再 ×100 | `noj-judge/sdk/evaluator/noj_evaluator_sdk/result.py:33` `payload["score"] = int(round(score * 100))`；实测 `accept(score=1000)` → `{"score":100000}` | 已修正：示例改为 `accept(score=10)`→`score:1000`，并补一句分数换算说明 |
| `evaluator-sdk.md` 输出结果 | 未说明 `result` 每次评测只能写一次（二次写入抛 `RuntimeError`） | `result.py:29-31` `if self._written: raise RuntimeError("result 已被写入一次，禁止重复")` | 已修正：新增 `::: warning` |
| `rpc.md` 第 140 行 | “单侧输出累计上限 1 MiB，超过后**追加截断提示**”与实现不符：超限丢弃头部、保留尾部，**无**截断提示文本 | `noj-judge/src/dual/mod.rs:160` `append_capped()` 逻辑（`buf.replace_range(..start,"")` 后直接追加，无提示）；`MAX_OUTPUT_BYTES` `:40` | 已修正：`::: details` 改为“丢弃头部、保留尾部、不追加提示” |
| `rpc.md` 第 140 行 | 未说明输出仅收集 Evaluator 侧；Solution 侧输出不被收集 | `noj-judge/src/dual/mod.rs:974` `handle_sol_chunk()` 只转发合法帧，`:985` stderr 仅 `debug!`；无任何 output 收集 | 已修正：`::: details` 补一句 |
| `rpc.md` 可传递数据类型 | “**不能**传递 `NaN`/`Infinity`”属过度断言：`validate_type` 只按类型名放行 `float`，实测 `NaN/±Infinity` **通过校验**并被序列化为非标准 JSON | `noj-judge/sdk/common/noj_sdk_common/serialization.py:32` `isinstance(value,(int,float,str))` 直接放行；`validate_type(float("nan"))` 实测通过，`json.dumps(encode_value(nan))` → `NaN` | 已修正：改为“不属于支持契约、行为未定义”（不再断言“不能传递”） |
| `rpc.md` “帧类型”列表 | 列表缺 `ready`；且 `shutdown` 被写成 Evaluator 方向（实际 host 只接受 Judge→host）；`log` 方向描述不精确 | `noj-judge/src/dual/protocol.rs:19-27` 常量含 `FRAME_READY`；`sdk/solution/noj_solution_sdk/host.py:166` 只处理 `shutdown`（judge→host）；`:13` host 启动发 `ready`；`src/dual/mod.rs` 编排循环注释“不发 `shutdown` 帧” | 已修正：新增独立「帧类型一览」表，标清方向；`ready` 补入 |
| `judge-model.md` “Solution Host”术语 | 报告预设其与“Solution 容器”不一致。复核结论：**术语本身正确**——`Solution 容器` 指容器，`Solution Host` 指其中 host 进程（`noj_solution_sdk.host`），与 `reference/glossary.md`、`users/submit.md`、`intro/what-is-noj.md`、`operators/judge-workers.md` 用法一致 | glossary:61「Solution Host」；`host.py` 模块 docstring；`noj-judge/src/dual/mod.rs:422` 启动 `-m noj_solution_sdk.host` | 已修正：**保留术语**，但新增 `::: info` 显式区分“Solution 容器（容器）”与“Solution Host（进程）”；并统一 flowchart/sequence 内混用的 “Solution Host” |
| `judge-model.md` Solution 容器段 | “如果用户函数不存在…如果用户函数抛异常…”两处“返回”易被读成 verdict；原页虽有澄清，但未给协议 code 对照表 | `host.py:76-99`（NotFound / Exception+`sanitize_trace`）、`:104-112`（Rejected）；`runner.py:249-264` 映射到 `NotFoundError/RejectedError/SystemError` | 已改进：以表格给出「情况 → 协议 code → Evaluator 异常」，并把 verdict 澄清改成 `::: warning` |
| `judge-model.md` 状态映射表 | “单次调用超时…最终 `error`”与实现一致，但缺“总超时优先于 CallTimeout”的判定顺序 | `noj-judge/src/dual/mod.rs:486` `finalize_outcome()`（`timed_out.is_some() → SystemError` 优先于 `sent_call_timeout → TLE`） | 未改（原文结论正确，仅属精度补充，避免新增未取证断言） |
| `evaluator-sdk.md` | **缺失** `noj_evaluator_sdk.llm` / `NOJ_LLM_*` 说明，出题人无从知晓 LLM 题如何取 gateway 地址与 token | `noj-judge/src/dual/llm_env.rs:17-24` 注入 6 个变量：`NOJ_LLM_GATEWAY_URL` / `NOJ_LLM_TOKEN` / `NOJ_LLM_PROVIDER_ID` / `NOJ_LLM_ALLOWED_MODELS` / `NOJ_SUBMISSION_ID` / `NOJ_REJUDGE_SEQ`；`sdk/evaluator/noj_evaluator_sdk/llm.py:52` `complete()` | 已修正：新增「调用 LLM（LLM 题）」小节（含全 6 个变量表 + `llm.complete()` 示例） |
| `capability-networking.md` 第 8 行 | 联网开启段落把“敏感字段 / RBAC 授权 / bridge 联网”全塞进有序列表一条，重点被淹没 | `noj-core/src/domains/catalog/services/problems/problem-field-guard.ts:38` `"evaluator.network": "problem:field_evaluator_network"`；`seed-rbac.ts:64-65` 从 user 角色撤销 | 已改进：拆为步骤 + `::: warning`（保留全部事实） |
| `capability-networking.md` 第 94-99 行 | 网络模式用 4 条无序列表，evaluator/solution 对照不直观 | `noj-judge/src/dual/mod.rs:334-344`（`evaluator_network_enabled ? mode : "none"`）、`container.rs:74`（Solution 恒 `"none"`） | 已改进：改为两行对照表 |
| `runtimes.md` 第 39 行 | “镜像由 build-sdk-images.sh 构建（默认 tag `:latest`，与种子数据一致）”正确，但“judge 预热时找不到 `:latest`”的背景未给，易误判 | `noj-judge/scripts/build-sdk-images.sh:5-11` 注释；`noj-core/src/domains/system/services/seed/seed-system.ts:89-110` 三个镜像 `all_versions` | 未改（原文正确，仅信息量差异） |

> 未在源码中定位到的断言一律未写（如“容器池”“旧单容器路径”等）。

## 可读性改进

| 页面 | 改动 | 理由 |
| --- | --- | --- |
| `index.md` | 补“本部分讲什么”一句话 + 页面导航表 + `::: tip 想先动手？` | 目录页从纯链接列表升级为可扫读入口，点明各组读者 |
| 全部页面 | 每页开头加 `> 一句话：…` 结论先行 | 协议/SDK 页较长，读者需先知道“这页解决什么” |
| `judge-model.md` | 新增 `::: info` 区分 Host/容器；协议错误映射改表格；调用失败改 `::: warning`；host 常驻改 `::: tip`；Evaluator 输出通道改 `::: info` | 原页文字密集，读者最易混淆“调用错误 vs verdict”“stdout/stderr 去向” |
| `evaluator-sdk.md` | `timeout_ms` 校验改 `::: warning`；`result` 单次写入改 `::: warning`；`details` 字段改表格；隐藏用例约束改 `::: warning`；投影兼容改 `::: info`；新增「调用 LLM」表 | 让“照着实现”的读者一眼看到必填/禁止项 |
| `solution-sdk.md` | 错误语义改三列表格；顶层代码建议改 `::: tip`；补一句话导语 | 用户页面向实现，表格胜过长段 |
| `rpc.md` | 新增「帧类型一览」表；字段表加“必填”列；`::: info` 讲三通道；`::: warning` 讲旧错误码；`::: danger` 讲不支持数据；输出细节折叠进 `::: details` | 协议页是“照着实现”类，帧/字段/状态必须表格化，长噪声折叠 |
| `runtimes.md` | 现状改 `::: warning`；语言表加默认文件名与“是否可评测”列；新增 `::: info language 用途`；新增 `::: tip 镜像从哪来`；常见问题改表格 | 消除“语言标识=运行方式”的误解，问题定位更快 |
| `capability-networking.md` | 三步概览精简；权限改 `::: warning`；网络模式改对照表；横向移动面改 `::: warning`；验证步骤改有序列表 | 安全页需要“必错点”突出，正文保持克制 |
| 容器用量 | 每页 1–5 个，共：index 1 / judge-model 4 / evaluator-sdk 4 / solution-sdk 1 / rpc 4 / runtimes 3 / capability 5 | 符合 RUBRIC 第三节“1–5 个、不滥用” |

## 视觉评价

截图：`/tmp/opencode/audit-shots/mechanisms/`（`before-*` / `after-*`，无头 Chrome 1440×N、`--virtual-time-budget=12000`）。重点查看 `index`、`runtimes`、`rpc`、`judge-model`、`evaluator-sdk`、`solution-sdk`、`capability-networking`。

- **改前**：
  - `runtimes.md` 语言表只有两列且无“是否可评测”列，`cpp/c/javascript` 一行信息量不足以支撑判断；现状警告把“仅 Python”和“支持包固定 python3”堆在一句，读者会误以为与支持包相关。
  - `rpc.md` “帧类型”仅内嵌在字段说明的单元格里（`call`、`result`、`error`、`capability`、`cap_reg`、`ready`、`log`、`shutdown` 等），无法扫读，也无法判断方向；错误码段整段是散文，关键“旧码已移除”不显眼。
  - `judge-model.md` 的“Solution 容器返回错误”长段无表格，`NotFound/Exception/Rejected` 三类混在句子里；“调用失败≠verdict”虽有文字但未视觉强调。
  - `evaluator-sdk.md` 输出结果示例误导（见正确性表），且 `details` 字段说明为长段。
- **改后**：
  - 表格化后信息密度更均衡，无“一堵墙文字”；`::: warning/danger` 容器把“易错/禁写”项从正文中拎出，扫读时一眼可见（`rpc` 的“帧类型一览”、`evaluator-sdk` 的“details 字段表”尤明显）。
  - `rpc.md` 新增帧类型表后，协议页首次可以“先看表、再看例子”。
  - 容器颜色分布合理：黄色（warning）集中在约束，红色（danger）仅出现在 `rpc` 不支持数据与 `capability` SSRF 反例，未泛滥。
  - `runtimes.md` 语言表三列后，`cpp/c/javascript` 的“不可评测评”语义清晰。
- **遗留观感**：`evaluator-sdk.md` 仍偏长（206 行），但结构已分节；`capability-networking.md` 的安全清单是必要的长列表，未强折叠。

## 遗留问题 / 建议

1. **`NaN`/`Infinity` 处理未定**（建议人拍板）：codec 当前放行非有限浮点并序列化为非标准 JSON（`NaN`）。文档已改为“行为未定义”，但**更稳的做法是在 `validate_type` 里显式拒绝非有限 float**（否则 `json.dumps` 产出的 `NaN` 可能让对端 `json.loads` 失败）。涉及改源码，未在本次范围内动。
2. **跨页术语重复/漂移（不越界修改）**：
   - `problemsetters/` 下的 `judge-model.md`、`evaluator-sdk.md` 等已是**跳转存根**（“本文档已迁移至 …”），指向 `mechanisms/`，无重复正文，无需处理。
   - `problemsetters/web-editor.md`（第 62/104 行）已正确澄清 `GET /problems/:id/template` 是**初始代码模板**而非支持包模板——与本次 `runtimes.md` 修正一致，未重复。
   - `reference/glossary.md` 已定义「Solution Host」；本次未改术语，仅在 `judge-model.md` 加注区分，**跨页无需联动**。
3. **`standards/` 与 `mechanisms/` 的题包/运行时描述**：`standards/problem-bundle.md` 未在本次范围内，但其 `runtime_config`/`template` 描述可能与本次修正的 `runtimes.md` 表述有出入，建议统一由 standards 组复核。
4. **`NOJ_SUBMISSION_ID` / `NOJ_REJUDGE_SEQ` 文档分散**：`problemsetters/llm-problem.md:94` 已提到，本次在 `evaluator-sdk.md` 补齐全 6 个变量表，二者可后续合并为一处单一事实源。
5. **`runtimes.md` 未提 `judge_images.kind` 的 `mode` 取值**：`mode ∈ {exact, all_versions}`（`noj-core/src/shared/db/schema/system.ts:25,40-43`），本次仅概要点到“含 `image`/`kind`/`mode` 匹配规则”，未展开，属可接受留白。
