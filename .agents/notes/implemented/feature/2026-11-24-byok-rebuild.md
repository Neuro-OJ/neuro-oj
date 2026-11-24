# Agent Note: 用户自带模型（BYOK）重建——练习 LLM 题用选手自己的 Key

Status: implemented

## Problem

LLM 题评测只能使用工作空间配置的 Provider 与共享额度。练习量大的选手很快耗尽
域/平台额度，管理员也不愿为纯练习付费。旧版 BYOK 已移除，移除时留下的重建约束是：
用户 Provider 与管理员 Provider 归属分离、更新字段白名单化、出网走精确主机白名单
且禁止内网/元数据地址、judge 侧每任务调用有上限、契约变更须同步 fixture。

## Decision

1. **网关独立存储**：新表 `llm_user_providers`（主键 `user_id`，每人一条，
   Key 信封加密，`revision` 乐观锁），由 `db:generate` 生成迁移。内部 API
   `GET/PUT/DELETE /internal/user-providers/:userId` 与 `POST .../test`；
   PUT 只取 `base_url/model/api_key/enabled`，归属只取自路径。
2. **eval_token 不改协议**：BYOK 时 `provider_id = "byok:<user_id>"`，
   题目全部别名映射到用户模型名。网关校验 `provider_id === byok:${user_id}`
   后读取用户 Provider；`JudgeTask.llm` 形态不变，judge 与 fixture 无需改。
3. **额度隔离**：`enforceAndCount` 新增 `sharedQuotas`，BYOK 时只保留单次尝试
   的 calls/tokens/cost 计数（即 judge 侧每任务上限）与分钟限流，不计域/平台
   日月额度；成本记 0。
4. **出网**：独立白名单 `NOJ_LLM_BYOK_ALLOWED_HOSTS`（精确主机或 host:port，
   仅 https，为空即关闭），之后再做公网 DNS 校验并 `fetchPinned` 防 rebinding；
   不受 `NOJ_LLM_UPSTREAM_ALLOWED_HOSTS` 放行。
5. **core**：新切片 `features/byok`（`/api/v1/me/llm-provider` GET/PUT/DELETE、
   `/test` 限流 10 次/10 分钟）。域提交 JSON 接受 `use_own_llm_key`；比赛与作业
   提交拒绝 `BYOK_NOT_ALLOWED`。冻结快照按 `byok:` 前缀识别，重新派发时
   重新校验用户 Provider 仍可用且属于提交者。题目详情新增不敏感的 `uses_llm`。
6. **ui**：设置页「自带模型」分区（`UserByokSettings`）；独立代码编辑器
   （`EditorCodeWorkspace`）顶栏「平台模型 / 我的 Key」切换与题目页内嵌作答
   （`ProblemAnswer`）开关，仅在 LLM 题、非比赛、非作业来源时显示。

## Alternatives considered

- **扩展 JudgeTask 携带用户 Key**：Key 会进入 judge 与评测容器环境，违背
  「Key 只在网关解密」；且需改契约与 judge。否决。
- **把用户 Provider 存进 `llm_providers` 加 owner 字段**：与管理员 Provider
  共用写路径，易出现越权改写与 mass assignment，正是旧版被移除的原因。否决。
- **比赛中允许 BYOK**：不同选手模型能力不同，破坏公平性。仅练习开放。
- **用户可配置别名映射**：增加 UI 与校验复杂度，收益小；先统一映射到单一模型。

## Consequences

- 部署需执行网关 `db:migrate` 并按需配置 `NOJ_LLM_BYOK_ALLOWED_HOSTS`；默认空即
  关闭，升级后行为不变。
- 选手删除/停用自带模型后，已有 BYOK 提交的重测会以 `BYOK_*` 400 失败。
- 注销账户在提交后 best-effort 删除网关中的 Key；签发 token 前另查 `users.deleted_at`，已注销即 `BYOK_OWNER_DELETED`，网关删除失败也不会再消耗该 Key。
- BYOK 调用不进入域成本统计，管理端用量页按 `provider_id = byok:*` 区分。
- 已在全新库上端到端验证：设置页保存/测试连接、编辑器提交冻结 `byok:` 快照、
  用队列中的 eval_token 调网关转发到用户上游，且只产生单次尝试计数。
