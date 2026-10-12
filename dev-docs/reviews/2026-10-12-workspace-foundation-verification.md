# 工作空间基础实现验证记录

日期：2026-10-12。范围：升级阶段 0 / 1 / 2 / 4 的当前基础实现及既有业务回归。
完整阶段仍未签收，以
[任务清单](../superpowers/plans/2026-10-12-workspace-upgrade-tasks.md)为准。

## 实现与审查依据

| 签名提交       | 当前行为                                                           |
| -------------- | ------------------------------------------------------------------ |
| `105925c89492` | 成员组合角色、申请目录、限定邀请预览、签发者撤权、仅加入邀请目标域 |
| `71706ff8982a` | Vitest 使用线程池，测试正常退出而非忽略 BrokenPipe                 |
| `aa53c737b029` | URL 空间上下文、响应身份校验、域 / 账号 / 版本缓存和延迟操作保护   |
| `4751a7fe60a7` | 空间目录、成员治理、邀请加入、模板预览、设置及登录回跳页面         |
| `f99b8630a829` | workspace 并行分片登记，Schema 覆盖检查实际展开的 DDL              |
| `5ea3efe54`    | no-store / Vary 仅匹配工作空间入口，保留比赛导出响应契约           |
| `0c99f4a76b4c` | 真实默认域负责人、注销前交接守卫、成员历史及额度保留               |

上述提交逐一确认 GPG 签名有效。没有推送 main，没有以本次本地检查替代 PR CI。

## 环境与隔离

源码目录为 `/home/xyber-nova/Github/neuro-oj`。本地运行时：Deno 2.9.7、Node
26.11.1，组件运行器 Vitest 2.1.9。PostgreSQL 为本地开发容器 PostgreSQL 16。

标准模块及共享检查默认使用 PGlite，不设置 DATABASE_URL。全量并行检查创建
独立数据库 `noj_upgrade_checks_20261012`，使用 `test_unit` / `test_db` 两个
schema； Redis 按标准脚本隔离至 DB 1 / 2，本地对象存储隔离到分片目录。
并行检查明确使用 local 存储及测试 JWT / TFA 配置；没有对生产数据库执行操作，
没有通过重建原开发库替代迁移验证。

## 验证入口与结果

| 模块 / 入口                                     | 结果                                     | 证据范围                                         |
| ----------------------------------------------- | ---------------------------------------- | ------------------------------------------------ |
| core `deno task test:domain workspace`          | 27 通过、0 失败                          | 当前角色、邀请、注册、默认负责人、注销与缓存行为 |
| core `deno task test:domain identity`           | 312 通过、0 失败、26 跳过                | 身份回归，含真实管理员初始化及注销               |
| core `deno task test:domain contest`            | 94 通过、0 失败、1 跳过                  | 既有比赛及成绩导出缓存契约；不是五种赛制验收     |
| core `bash scripts/test-shared.sh`              | 291 通过、0 失败、16 跳过                | 错误契约、DDL、分片覆盖等共享基础                |
| core `deno task test:parallel`                  | unit 373 / db 1600 通过，0 失败；17 跳过 | 真实 PG 全量回归；两个分片正常退出               |
| core `deno task check:types`                    | 通过                                     | 当前完整 src，包括测试类型                       |
| UI `deno task test`                             | 240 通过、0 失败                         | 引用、缓存、邀请、回跳、面包屑及既有工具         |
| UI `deno task test:components`                  | 22 文件、112 通过，退出码 0              | 空间组件、实际响应式 props、冲突及确认期间切换   |
| UI `deno task check:types` / `check:types:nuxt` | 通过                                     | 工具、Nuxt 和 Vue 全量类型                       |
| UI `deno task build`                            | 通过                                     | 当前管理页面 SSR / 客户端产物可构建              |
| UI lint / fmt 及新 Vue 页面组件格式             | 通过                                     | 当前代码规范；不证明实际布局                     |

标准共享、模块和全量检查有重叠，不能把上述各行通过数相加称为独立测试数量。 PG 的
1973 是两个分片的执行计数合计；迁移入口按每个隔离 schema 各执行一次。
跳过项从未计为通过。

全量并行复现入口（先创建专用空库；测试密钥为测试值，不能用于部署）：

```sh
DATABASE_URL=postgres://noj:noj@127.0.0.1:5432/noj_upgrade_checks_20261012 \
STORAGE_PROVIDER=local \
JWT_SECRET=noj-test-jwt-secret-fixed-value-with-32-chars-min \
TFA_ENCRYPTION_KEY=noj-test-tfa-key-independent-from-jwt-at-least-32 \
deno task test:parallel
```

其他门禁：Schema parity 85 表 / 719 列、迁移安全、快照链、模块边界、Domain CI
路径覆盖、Markdown 链接及 Agent Note 格式均通过。Schema parity 只验证表 / 列
一致性；约束的行为另由迁移及数据库测试验证，不据此宣称所有约束完整。

## 本次发现与关闭的问题

1. 五个新页面没有面包屑映射：已注册并验证域内回跳。
2. 响应式配置无法
   structuredClone，保存配额会清除其他草稿：独立复制配置、保留草稿。
3. 延迟确认及邀请返回可能串入新域 / 账号：捕获操作目标，切换或卸载后取消旧操作。
4. 组件断言通过却以 BrokenPipe 退出：线程池对比验证，标准任务正常退出。
5. workspace 漏入并行分片，DDL 主文件扫描漏导入模块 / 引号：补齐目录并读取实际
   DDL。
6. 通配缓存中间件覆盖比赛 CSV 响应头：限定工作空间路径，保留原导出契约。
7. root 被误选为默认负责人，注销可能留下失效负责人并先删头像：真实管理员补入，
   事务守卫及提交后对象清理；保留当前成员历史并释放名额。

## 未完成的验收

当前浏览器连接不能打开本地网页，交互式旅程、窄屏布局和实际教师操作均未验收。
成员新增 / 邀请 / 申请与注销的真实并发屏障、治理幂等和完整实例前端仍需补齐。

域数字题号与全部写入、P/U 移除、题包 2、资源隔离、社区 / 搜索 / 统计、共享
全入口撤销、域 LLM / 真实额度、五赛制、Classroom、Assignment、教学工作台、 IDE
和完整 E2E 仍按批准计划实施。当前新域菜单未将这些资源接入旧全局 API。
以上验证不构成产品整体完成、正式恢复演练或发布授权检查通过的声明。
