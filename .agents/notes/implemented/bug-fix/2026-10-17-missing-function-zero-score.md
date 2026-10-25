# Agent Note: 选手缺函数判 0 分而非平台错误

Status: implemented

## Problem

选手代码没有定义评测器要调用的函数时，Solution host 回 `NotFound`，evaluator SDK
抛出 `NotFoundError`。大量 evaluate.py（含样例 1001）不捕获或原样 raise，进程不输出
`---RESULT---`，judge 只能归为 SystemError → `platform_error`（提交状态 `error`）。
这是确定的选手侧结果，却显示为“评测出错”；生产 P18 已多次出现。core 的偶发平台
错误自动重试（ec406b9c）已把它排除在重试之外，但分类仍错误。

## Decision

在 SDK 层处理，无需修改任何题目脚本：

- Solution host 的 `NotFound` 帧新增 `reason`：entry 正常加载为 `not_registered`，
  entry 加载失败（语法错误/导入失败，注册表为空）为 `entry_load_failed`。
- `NotFoundError` 携带 `fn` 与 `reason`；`SolutionRunner()` 构造时幂等安装
  `sys.excepthook`，仅当 `NotFoundError` **未被捕获**、`reason == "not_registered"`
  且 result 尚未写出时，写出 `score=0`、`details.message="未定义函数 <fn>"`、
  `details.error_code="function_not_found"` 的 RESULT，再链式调用原 hook（traceback
  仍进 stderr）。judge 在拿到 RESULT 后忽略退出码，结果为 `finished` + 0 分。
- `SolutionRunner(missing_function_as_zero=False)` 可关闭兜底。

## Alternatives considered

- **在 runner.call() 内直接写 0 分并退出**：会剥夺 evaluate.py 捕获 `NotFoundError`
  做可选函数/自定义说明的能力，且进程内突然退出不可控；excepthook 只在未捕获时生效。
- **judge 侧识别 stderr 特征（`NotFoundError ... not registered`）转 0 分**：对旧
  镜像也生效，但依赖 evaluator 可控的文本，且 solution 的 log 帧也会转发到 evaluator
  stderr，选手可伪造该特征；同时把题目语义硬编码进 judge，与“分数只来自 RESULT”的
  协议相悖。故不采用。
- **不区分 entry 加载失败**：语法错误也会被判为“未定义函数 solve”，说明误导，且改变
  语法错误 → `error` 的既有语义；加 `reason` 正向标记后，新旧镜像混跑均安全回落旧行为。

## Consequences

- 需要同时升级 `noj-evaluator-python`、`noj-solution-python`、`noj-solution-ai`
  三个运行时镜像才生效；任一侧为旧镜像时保持旧行为（platform_error），升级顺序无关。
  noj-core / noj-judge 二进制 / 协议版本均无变化。
- 已经自行捕获 `NotFoundError` 的 evaluate.py 行为不变；结果已写出后才抛出的异常不重复写。
- 已知遗留：`test_runner.py` 中 `test_call_frame_*` 依赖 50ms sleep，存在偶发失败且失败后
  残留线程导致进程不退出；SDK Python 单测目前不在 CI 中运行。
