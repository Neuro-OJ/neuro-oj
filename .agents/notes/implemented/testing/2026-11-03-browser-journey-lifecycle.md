# Agent Note: Browser E2E 生命周期复用与题包夹具统一

Status: implemented

## Problem

Browser E2E 的每个文件各自 launch/teardown：`launchBrowser()` 每次启动一个
Chromium，却只为一个 journey 建一个 context，多角色场景（教学、治理、公开混合、
班级矩阵、LLM 治理、私有注册批注）因此按角色重复启动浏览器进程。四角色的班级
矩阵用例单次就启动 4 个 Chromium，Browser job 反复支付进程启动与退出成本，
角色隔离靠"独立进程"而不是"独立上下文"，也没有集中收尾点。

同时有三处可复现的清理缺陷：

- `ui_flows` 的前置用例成功时不关闭浏览器，后续用例再 `launch()` 会覆盖模块级
  句柄，一次运行泄漏 5 个 Chromium 进程；
- 失败诊断产物名只有固定标签与时间戳，无法区分同一次运行中的 journey 与角色；
- 第二个 context 或页面创建失败时，已创建的 browser/context 不会被关闭，失败
  路径残留浏览器进程。

题包夹具则各自手写 `zipSync` 组装 ZIP，重复实现，且"空包/绝对路径"这类构造
错误要到服务端才暴露。

## Decision

新增 `withBrowserJourney(label, fn)` 与 `BrowserJourneyFixture`：

- 每个顶层 journey 只启动一个 headless Chromium；
- 每个角色或独立场景通过 `newSession(actorLabel)` 建一个 BrowserContext （独立
  Cookie/storage/trace），返回 `{context, page, actorLabel}`；
- session 收尾只关 context，Browser 由 journey 的 `finally` 关闭；
  `closeSession(session)` 供匿名上下文提前关闭且幂等，收尾不重复关；
- 新建 context 先登记再启动 tracing/页面，其中任一步失败都会在收尾关闭已登记
  context 与 Browser；
- 失败诊断按 run/journey/actor 命名： `trace-<run>-<journey>-<actor>.zip` 与
  `failure-<run>-<journey>-<actor>.png`；trace 与截图各自独立捕获错误，
  一个失败不掩盖另一个；
- 失败语义：业务步骤抛错时保留原始错误（断言差异可读），清理错误逐条
  `console.error` 上报；业务通过但清理失败抛 `AggregateError`，不静默吞掉；
- launcher 可注入（`JourneyBrowser`/`JourneyContext`/`JourneyPage` 结构子集），
  零依赖单测用 fake 覆盖启动次数、第二 context 失败、tracing 启动失败、截图
  失败与清理失败；`assertClassContains` 惰性 import playwright，模块导入本身
  不加载 Playwright；
- 14 个 Browser 文件全部迁移，`launchBrowser`/`teardownBrowser` 删除且仓库内 0
  调用；`ui_flows` 保留 7 个独立用例名与独立 Chromium（不跨用例共享进程），
  前置用例也真实启动一次浏览器并关闭。

题包夹具统一为 `buildProblemBundle(files)` + `problemBundleForm(archive)`：
`coding-problem.ts` 不再手写 zipSync，并新增 `createPublishedCodingProblem()`
显式返回 `problemId/versionId/reference/domain`；原
`createCodingProblemFixture()` 保留为只返回题目 ID 的入口，8 个非 Browser
调用方不受影响。搜索与 `ui_flows` 的同款组装也改用同一 builder。

## Alternatives considered

- 全仓库共享一个长驻 Chromium 单例：跨用例共享进程，违反"每个用例独立"的排障
  前提，也把用例耦合进执行顺序；不采用。
- 保留每角色一个浏览器，只把 launch 参数抽成 helper：省不掉进程启动成本，且
  仍无集中清理失败路径；不采用。
- teardown 同时关 context 与 Browser：多角色 journey 会提前关掉其他角色仍在
  使用的 Browser；改为 session 只关 context。
- 失败时用 AggregateError 包裹业务错误：会埋掉断言差异、降低可读性；改为保留
  原始错误并用日志上报清理错误。
- 直接改 `createCodingProblemFixture` 返回结构化句柄：会破坏 8 个非 Browser
  调用方；改为新增显式函数并保留旧入口。

## Consequences

- 14 个 Browser 文件的 Chromium 启动合计从 34 次降到 24 次：班级矩阵 4→1、 教学
  3→1、治理 3→1、公开混合 3→1、私有注册批注 2→1、LLM 治理 2→1；单角色
  文件保持每文件 1 次。`ui_flows` 从"6 次启动、5 个进程泄漏"变为 7 次启动且
  全部关闭，前置用例不再依赖上一个用例遗留的页面。
- 角色隔离从"独立进程"变成"独立 BrowserContext"：A 的登录/退出不影响 B。 真实
  Chromium 冒烟确认 A 写入的 Cookie 在 B 的上下文不可见。
- 诊断产物按 run/journey/actor 命名，同一次运行内可定位到具体角色；命名中的
  空格与非常用字符折叠为横线。
- 收尾路径统一：第二 context 创建失败、tracing 启动失败、截图失败、context
  关闭失败都由 fake 单测覆盖，且不会掩盖原始业务错误。
- 题包夹具只剩一处 ZIP 组装；`coding-problem.ts` 的显式句柄让"已发布不可变
  版本"在同一 journey 内可安全复用，调用方不必再额外 GET 题目拿题号。
- 迁移保持断言语义：只替换生命周期与清理，未删改 journey 断言、步骤与覆盖。

验证范围（如实）：

- 零依赖单测 `deno test -A tests/unit/` 60 passed / 0 failed，其中本变更为 9 个
  fake-browser 生命周期用例（同批 P6-A 另有 15 个 Browser 分组规划用例）；
- 真实 Chromium 生命周期冒烟（4 角色同一 journey）：1 个浏览器、4 个上下文、
  Cookie 隔离成立、失败产出 4 份 trace 与 4 张截图、成功路径 0 残留 chromium
  进程；
- 真实 UI 断言只重跑了 LLM 治理单 journey（同批 P2 在同一共享栈执行， 1 passed /
  9 steps）；其余 Browser journey 的 UI 断言语义未在真实栈重跑， 需完整 E2E 栈与
  `NOJ_RUN_BROWSER_E2E=1` 才能验收；
- Browser 文件的实测耗时基线尚未生成，分组规划当前按 15 秒回退估值。
