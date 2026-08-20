## 1. 提案与基础设施

- [x] 1.1 创建 OpenSpec 变更 `fix-audit-2026-08-15-critical-findings`（proposal/design/specs/tasks）
- [ ] 1.2 确认 GPG 签名可用、jj 工作副本基于 main、不直推 main（工作副本基线已确认，签名/提交由仓库约定流程执行）

## 2. core：启动与认证安全

- [x] 2.1 NOJ-000 JWT 验证固定 HS256 并补测试
- [x] 2.2 NOJ-032 生产环境缺失 DATABASE_URL 启动期失败（NOJ_ENV=test 保留 PGlite）
- [x] 2.3 NOJ-031 TRUSTED_PROXIES 生产校验移到 initSystemSettings 之后
- [x] 2.4 NOJ-030 HTTP 优雅关闭（Deno.serve signal + server.shutdown + Redis/DB 清理）
- [x] 2.5 NOJ-007/008 封禁用户与角色变更后不信任旧 JWT；删除 role claim 权限短路

## 3. core：IP 防护与限流

- [x] 3.1 NOJ-091 getClientIp 对 X-Real-IP 套用 TRUSTED_PROXIES 白名单
- [x] 3.2 NOJ-097 IP 封禁对 unknown fail-closed（受保护写端点）
- [x] 3.3 NOJ-092 登录账号限流/锁定改用规范化 user.id
- [x] 3.4 NOJ-093 注册接口 IP 限流
- [x] 3.5 NOJ-094 forgot/reset-password 增加 IP+邮箱维度限流
- [x] 3.6 NOJ-096 私信发送 per-user 限流
- [x] 3.7 NOJ-069 提交创建限流（IP+用户维度）

## 4. core：评测消息可靠性

- [x] 4.1 NOJ-066/074 结果消费改 BRPOPLPUSH + LREM + 失败重投（含 DB 重试）
- [x] 4.2 NOJ-179 增加 processing 列表超时扫描重投任务（sweeper）
- [x] 4.3 NOJ-067 提交创建入队失败/崩溃恢复（pending 超时重投或事务化保障）
- [x] 4.4 NOJ-065 rejudge_seq 校验移入事务并加行锁/条件更新 + 状态机校验
- [x] 4.5 NOJ-068/182 结果幂等去重，重复结果不重复统计
- [x] 4.6 NOJ-075 批量重测逐行使用各自 rejudge_seq

## 5. core：存储越权与题目权限

- [x] 5.1 NOJ-115/061 storage key 规范化 + resolve 边界校验（local）
- [x] 5.2 NOJ-116 S3 provider 增加 key 归属/形态校验
- [x] 5.3 NOJ-115/116 题目 create/update 拒绝客户端直传 support_package_storage_url
- [x] 5.4 NOJ-102 题目 RBAC 细粒度权限强制执行（create/write_own/delete_own/package_manage_own）
- [x] 5.5 NOJ-062 seed-rbac 默认权限移除 evaluator.command/network 等敏感字段授权
- [x] 5.6 NOJ-103 匿名枚举他人 U 型题修复（owner_id 越权）
- [x] 5.7 NOJ-049/043 队列状态接口传入 viewerUserId 执行 owner 校验

## 6. core：中危正确性/性能/配置

- [x] 6.1 NOJ-005 mock 邮件日志脱敏重置令牌
- [x] 6.2 NOJ-033 degraded 模式 /queue 优雅降级
- [x] 6.3 NOJ-077 队列监控分页 + 长度上限/TTL
- [x] 6.4 NOJ-081 未读数批量聚合消除 N+1
- [x] 6.5 NOJ-082 会话列表取最新消息改 SQL（DISTINCT ON/LATERAL）
- [x] 6.6 NOJ-084 仪表盘计数并行 + 基础缓存
- [x] 6.7 NOJ-085 榜单物化视图刷新节流
- [x] 6.8 NOJ-053/054/056 依赖版本约束与 imports 映射修正
- [x] 6.9 NOJ-083 社区搜索索引迁移（如低成本则加，否则记录后续）

## 7. judge：MQ 可靠性与生命周期

- [x] 7.1 NOJ-179 BRPOPLPUSH processing + LREM + 超时回投由 core sweeper 兜底
- [x] 7.2 NOJ-152/155 SIGTERM 监听与 shutdown 竞态修复
- [x] 7.3 NOJ-180 fallback 文件启动重投
- [x] 7.4 NOJ-181 坏消息日志原文 + 死信/错误回投
- [x] 7.5 NOJ-156 drain 超时从 config/下载超时推导

## 8. judge：双容器编排与沙箱

- [x] 8.1 NOJ-160 跨 chunk 结果标记/payload 解析修复 + 回归测试
- [x] 8.2 NOJ-161 成功路径传 rejudge_seq
- [x] 8.3 NOJ-190 镜像/命令白名单复验 + network 默认拒绝
- [x] 8.4 NOJ-193 zip 解压实时限额
- [x] 8.5 NOJ-189/163 内存上限封顶与 0 值防护
- [x] 8.6 NOJ-188 CPU 限制
- [x] 8.7 NOJ-153 Drop 清理显式化 + NOJ-154 启动孤儿清扫（含实例标签）
- [x] 8.8 NOJ-158 容器 start 失败立即清理
- [x] 8.9 NOJ-162 OOM 识别/内存峰值实现或文档修正
- [x] 8.10 NOJ-168/171 镜像 digest/非 root 运行修复
- [x] 8.11 NOJ-194 S3 下载强制 HTTPS 并限制重定向

## 9. ui：XSS 与认证代理

- [x] 9.1 NOJ-248 搜索高亮移除 v-html，改为转义分段渲染
- [x] 9.2 NOJ-249 SSR/降级净化器补齐实体解码+协议黑名单，移除 style 白名单
- [x] 9.3 NOJ-215 代理透传 x-forwarded-for/x-real-ip/user-agent
- [x] 9.4 NOJ-209 fetchUser 仅在明确 401 时登出
- [x] 9.5 NOJ-210 401 统一处理清除本地认证态与 session cookie

## 10. ui：中危正确性/交互

- [x] 10.1 NOJ-225 搜索分页参数 limit→per_page
- [x] 10.2 NOJ-207 搜索「查看全部」type=all 兼容
- [x] 10.3 NOJ-227 随机题目卡片限量拉取
- [x] 10.4 NOJ-235 编辑器切题重置草稿/代码
- [x] 10.5 NOJ-236 移除竞赛参赛者二次确认
- [ ] 10.6 NOJ-223 题目列表接受 acceptance_rate（后端当前未提供该字段，非本次 P2 清单项，暂缓）
- [x] 10.7 NOJ-208/211 搜索与私信竞态防护

## 11. docs：中危文档与配置对齐

- [x] 11.1 NOJ-122/123 移除 entry/tuple 过时描述
- [x] 11.2 NOJ-124 删除 Redis RPC 白名单过时说法
- [x] 11.3 NOJ-126/140/142 修正备份目录、manifest、镜像名与脚本路径
- [x] 11.4 NOJ-130/131/200 清除 env 模板已知 JWT 密钥与默认管理员口令
- [x] 11.5 核对 NOJ-120 密码策略与其他报告中文档不一致并统一

## 12. 验证与收尾

- [x] 12.1 core：deno fmt + deno lint + 全量测试
- [x] 12.2 judge：cargo fmt + cargo clippy -D warnings + cargo test 全绿（Docker E2E 因环境/镜像构建未运行，已同步 E2E compose 配置）
- [x] 12.3 ui：nuxt build 全绿（项目未配置独立 lint/fmt 脚本，构建含类型/SSR 检查）
- [x] 12.4 更新 tasks.md 完成勾选，总结未纳入 P2 项与后续建议
