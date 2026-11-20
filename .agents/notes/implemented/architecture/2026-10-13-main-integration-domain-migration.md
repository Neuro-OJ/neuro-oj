# Agent Note: 接续已发布 main 的工作空间迁移

Status: implemented

## Problem

工作空间分支从题目版本升级后的 main 派生。开发期间 main
又发布了预测提交、界面题、模型别名和 LLM 自测修复，其 0113–0115
与尚未发布的工作空间迁移编号冲突。直接保留任一侧会丢失已发布功能，或者让已有迁移记录跳过新的表结构。

## Decision

在独立 jj 工作区集成两条历史，保留原分支及其签名提交供 review。最终迁移目录保留
main 的已发布文件和快照，由标准 `deno task db:generate` 生成追加的
`0116_peaceful_gorilla_man.sql` 与快照；没有手改 journal。原主题分支 0113–0139
的过程文件留在原提交历史，不作为正式升级链执行。

对生成的 SQL
落实存量升级顺序：新表及可空列、默认域与成员、源题及真实本域绑定、策略沿革、执行和社区归属、域内模型别名，再设置非空与复合约束。所有父表复合唯一约束先于外键，别名旧单列主键先移除，回填完成后建立
`(domain_id, alias)` 主键。移除生成的 public 限定，测试分片按自身 search_path
执行。

P/U 收缩先检查未处理 U
题和旧比赛，发现数据时明确中止，不在迁移中删除。先移除依赖 type
的旧生成列，再按数字题号重建搜索向量及 GIN 索引。历史版本不可变触发器沿用
main，不重复创建。旧 `create_p` 权限从种子关系中清除。新模型别名归
main，其他域仍独立配置；题目版本的 models 只声明能力，执行时解析使用域。

core 锁文件恢复此前已经验证的标准 npm 依赖基线，再通过官方
`deno install --lockfile-only --frozen-lockfile=false`
确认。依赖声明保持合并后的版本，不手工修改锁字段。这样默认构建不再因 main 锁内的
npmmirror tarball 与默认 registry 不符而失败。

## Alternatives considered

- 重编号已发布 main 迁移：已有库无法可靠判断迁移是否应用，不采用。
- 直接 replay 原工作空间链：与 main 编号冲突，且会重复修改相同表，不采用。
- 仅测试空库或重建数据库：不能证明源题、历史提交和已发布别名保留，不采用。
- 自动删除未知旧数据或将缺失归属统一猜为
  main：运行时不能这样处理。迁移仅回填升级前已知的单一题库；新运行数据依靠非空归属和真实绑定。

## Consequences

真实独立 PostgreSQL 标准共享测试 310 通过、0 失败、6
忽略；新迁移实际执行。Schema parity 检查为 Drizzle / DDL 各 108 表，985
列一致；迁移安全检查通过。catalog 新 HTTP 组合测试在 PostgreSQL、PGlite 各 11
通过，另各 8 个引导测试通过。

另从原开发备份恢复独立库 `noj_upgrade_official_main_20261013b`，先使用实际 main
迁移到 0115，再按用户授权核对备份哈希，清理准确的 10 道 U 题和 5
场旧开发比赛。保留 22 个账号、3 道 P 题及其 3 个不可变版本、2
个原板块。由于原备份普通提交为零，显式补入一个合成未知版本提交、正式尝试、分版本桶与成绩指针，以及一个
main 模型别名，用于实际存量验收。

标准迁移到 0116
后，逐行比较上述原始数据：ID、源码、时间、版本、尝试输出、详情、成绩指针与别名配置保持一致，仅增加
main
归属及真实绑定。两次系统初始化、三次默认域初始化、两次重建搜索均保持业务依据，搜索
25 条一致。持源题锁通过公开门面重建三个绑定的成绩投影，未知提交仍为有效 AC /
10000；本人历史 DTO 返回原代码，隐藏原始输出和详情。

证据：`/tmp/noj-root-integration-shared-migration-first.log`、`/tmp/noj-root-integration-schema-parity-first-20261013.log`、`/tmp/noj-root-official-main-domain-upgrade-proof-b-20261013.log`、`/tmp/noj-root-official-main-projections-proof-20261013.log`。验收脚本最初的列名与
DTO 断言不符已修正；实际失败没有改为忽略，最终进程退出
0。整合后的其他模块、生产镜像和整栈旅程验收另行记录。
