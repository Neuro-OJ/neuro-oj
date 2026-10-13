# Gateway 业务门面

本模块管理 core 对独立 LLM Gateway 的调用及评测凭据，不保存 Provider 明文密钥。
跨模块调用通过 `index.ts`，独立网关的数据库迁移由 `noj-llm-gateway` 自己执行。

## 使用域配置与执行

`domain_llm_settings` 以稳定 `domain_id` 作为主键，保存 Provider、模型及
revision。 默认域首次从旧系统配置初始化，`ON CONFLICT DO NOTHING`
保留后来显式修改和关闭。 其他新域始终从空选择开始，引用公共 LLM 题也不能使用源域
Provider。

`buildJudgeTaskLlm` 接收已授权提交的使用域，以及尝试与版本 ID。协议 v3 凭据强制
携带使用域和尝试，冻结 Domain、Provider、模型与单次预算；重新派发冻结尝试仅续签
token。Gateway 在调用上游前复查 Provider 归属及启用状态。题目中的旧 Provider/
模型声明不参与执行选择。旧无域调用仅固定映射默认域，不能选择其他域。

## 管理准备接口

`routes/domain-llm.ts` 在 `/domains/:slug/llm` 下提供：

- `GET/PUT /settings`：当前域选择；PUT 必须带 `If-Match`，缺少返回 428，冲突返回
  409。
- `GET/POST /providers` 与 `PUT /providers/:id`：域内 Provider
  列表、创建及修改/停用。
- `GET/POST /quotas`：域内持久配额，Domain 管理入口拒绝实例 global 配额。
- `GET /usage`：当前域用量分页与筛选。

实例治理调用 `listInstanceLlmQuotas` 明确发送实例标记，读取实例 global
行；该门面 不挂入 Domain 路由，也不混入 `listLlmQuotas(domainId)` 的域内列表。

所有操作重新读取工作空间上下文与 `llm:manage`，写操作持有域锁；跨域已知 ID 不能
跳过路径域校验。Provider/配额写入发生于独立 Gateway 服务，core
将操作目标记录审计。 读取不返回其他域 Provider
名称、地址、掩码、调用正文或用量。接口设置 `no-store`。
组合根在完整域隔离验收后挂载准备路由。

## 验证与剩余工作

使用 `deno task test:domain gateway` 验证当前域设置、版本冲突、授权在 fetch
之前、 冻结模型以及无源域回退；独立 Gateway 的 PostgreSQL/Redis 验证命令见其
README。 实际提交执行链 Domain 参数由 submission 模块接入；完整 Judge
调用、持久用量与 Redis
对账、实例可设上限及完整浏览器旅程仍需跨模块验收，不能由本模块单测替代。
