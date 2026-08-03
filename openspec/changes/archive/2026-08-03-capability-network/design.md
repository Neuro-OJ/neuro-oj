# 评测网络能力（capability-network）设计

## Context

- 双容器评测：Evaluator（出题人编写的 `evaluate.py`）+ Solution（用户提交代码），judge 宿主机做 NDJSON 双向透明转发（`src/dual/mod.rs`）。
- 现状：所有容器统一 `network_mode: none`（`src/sandbox/host_config.rs`）；evaluator stdout 仅转发 `call` 帧到 solution（`handle_eval_chunk`）；solution stdout 全部帧转发到 evaluator（`handle_sol_chunk`）。
- SDK 现状：`noj_solution_sdk` 为单线程 reader loop（被动响应 call）；`noj_evaluator_sdk` 已有 pending/id 匹配的 `SolutionRunner.call()`；`call_capability` 仅存在于文档占位，代码中不存在。
- LMCC 场景：solution 需调用外部网络 API（LLM 接口、检索服务），但安全边界要求 solution 无网。

## Goals / Non-Goals

**Goals:**
- solution 容器保持无网（安全边界不变）；evaluator 按题目配置可联网（Docker bridge 全量）
- solution 通过 `call_capability(name, *args)` 经 RPC 调用 evaluator 注册的 capability，judge 透明转发
- 配置、SDK、协议、UI、文档全链路落地；向后兼容旧任务（network 缺省 = 无网）

**Non-Goals:**
- 网络层白名单代理 / egress 过滤（本期不做，文档中列为未来兜底选项）
- capability 并发、嵌套双向调用（capability handler 内再调 solution 会死锁至总超时，文档明示不支持）
- capability 鉴权/配额（信任模型：evaluator 可信，capability 参数校验由出题人负责）

## Decisions

### D1：网络配置形态 —— `evaluator.network.enabled: boolean`（可选，默认 false）

- 结构为对象 `{ "enabled": boolean }` 而非裸布尔，为未来 `allowlist` / `mode` 扩展留位。
- 旧任务（无 network 字段）反序列化为 `None` → 保持 `network_mode: none`，向后兼容。
- 备选：字符串枚举 `"none" | "bridge"` —— 弃用理由：对象结构更易演进（JSONB 无迁移成本）。

### D2：capability 协议 —— 新帧类型 `capability`，响应复用 `result/error`

- `{"type":"capability","id":hex,"name":str,"args":[...]}`，solution → judge → evaluator；响应 `{"type":"result","id","value"}` / `{"type":"error","id","code","message"}`，按 `id` 匹配。
- 备选：复用 `call` 帧加 `capability:` 前缀命名空间 —— 弃用理由：语义混淆（call 帧语义是 evaluator 调 solution 注册函数），judge 日志与 SDK 处理难以区分；新帧类型职责清晰。

### D3：judge 转发改动最小化 —— 仅新增 evaluator stdout 的 `result/error` 帧转发

- 现状 `handle_eval_chunk` 只转发 `call` 帧；capability 响应（result/error）来自 evaluator stdout，需新增转发到 solution stdin。
- `log` 帧不转发（solution → evaluator 方向语义，evaluator 不产出）；`shutdown` 保持不发（现有行为）。
- evaluator stdout 的普通文本与 `---RESULT---` 标记仍按现状处理，不转发。

### D4：solution SDK —— `call_capability` + host.py 双线程重构

- 现状 host.py 单线程：reader loop 内同步执行用户函数；若用户函数内调用 `call_capability` 阻塞等待响应，reader 无法读取响应帧 → 死锁。
- 重构：reader 线程（持续读 stdin，`call` 帧投递到队列、`result/error` 帧按 id 匹配 pending 队列）+ 单 worker 线程（顺序执行 call，保持现有"顺序执行"语义）。`ready` 帧时序、entry 加载、错误码行为保持不变。
- 帧大小限制对齐现有 `MAX_FRAME_BYTES = 1 MiB`（两端 `serialization.py` 均已定义该常量）：solution 发 `capability` 帧与 evaluator 回复 `result` 帧均受同限，防超大帧。

### D5：evaluator SDK —— `register_capability(name, handler)` + reader 同步执行

- runner 的 stdin reader 线程识别 `capability` 帧 → 查注册表 → 同步执行 handler → 写 `result/error` 帧到 stdout。
- 同步执行理由：solution 侧同步等待，天然无并发；handler 内网络请求超时由出题人控制（SDK 提供 `urllib`/`requests` 超时建议），整体受 evaluator `time_limit_ms` 兜底。
- 未注册的 capability → `{"type":"error","code":"NotFound","message":"capability 'x' not registered"}`。

### D6：安全模型 —— 调用边界即信任边界

- solution 永远无网；evaluator 默认无网，仅题目显式开启。
- capability 只能调用 evaluator 显式注册的 handler；**出题人负责 handler 参数校验**（禁止通用 URL 转发、禁访元数据/内网、校验重定向）。
- SSRF 缓解：最佳实践文档（封装精确函数如 `request_llm_completion(prompt)` 而非 `fetch_url(url)`）+ SDK 参考示例；网络层代理兜底列为未来选项。
- 本设计不改变"solution 可向 evaluator 发送任意帧"的既有信任模型（评测本身即黑盒验证）。

## Risks / Trade-offs

- [出题人注册通用转发 capability 导致 SSRF 面全开] → 文档最佳实践 + 示例强调精确封装；默认无网降低误开概率；未来可加网络层白名单代理
- [host.py 重构引入行为回归] → 既有 SDK 测试全量回归（ready 时序、error 码、顺序执行）；E2E 覆盖双容器全链路
- [evaluator 全量联网影响资源/安全基线] → 仅显式开启的题目受影响；evaluator 容器其他安全项（cap_drop、no-new-privileges、pids_limit 等）不变
- [嵌套双向调用死锁（handler 再调 solution）] → SDK 文档明示限制，总超时兜底

## Migration Plan

1. judge 端 `network` 字段 `#[serde(default)]` 可选 → 旧任务（无字段）自动按无网执行，无需迁移。
2. `runtime_config` 为 JSONB 列，新字段随 API 落库，无 schema 迁移。
3. SDK 双线程重构与协议新增向后兼容：旧 evaluate.py / solution.py 不导入新 API 则行为不变。
4. 回滚：仅需移除 judge 侧 `network` 字段解析与转发分支（新帧被旧 judge 忽略——solution stdout 全帧转发本就存在，旧 evaluator runner 忽略未知帧类型）。

## Open Questions

- ~~capability 帧大小上限~~ **已解决**：对齐现有 `MAX_FRAME_BYTES = 1 MiB`（见 D4），无需 judge 侧额外限制。
