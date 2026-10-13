# Agent Note: 工作空间升级代码审查与待修清单

Status: implemented

## Problem

用户要求审查本次 Instance / Domain / Classroom / Assignment 升级的代码质量，
尤其是对几乎不可能发生的内部状态进行防御、重复验证以及不必要的兜底。
当前升级目标因额度不足暂停；用户要求先记录审查，额度恢复并继续后先修复，再推进
剩余产品计划。

本记录最初记录只读审查；用户恢复开发后，以下整改已分别实施、审查并保存签名提交。
本 process Note 保留原问题依据，具体实现和验证见对应 architecture /
simplification 记录，不以整改完成代替整个产品升级验收。

审查依据为 2026-10-13 暂停时的当前工作区，包含已提交代码和保留的未提交改动。
初次审查未修改业务代码；后续整改验证列于本记录末尾，完整仓库质量签收仍待完成。

## Decision

恢复开发后，先完成下列整改，并按可审查范围保存独立签名 jj 提交。修改前核对
实际调用者和约束，修改后运行受影响模块的标准检查；不以删除检查数量作为目标。

- [x] **Q1，优先：取消配额记录缺失时的不限额兜底。**
      `noj-core/src/domains/workspace/services/limits.ts` 的
      `getDomainEffectiveLimits()` 在找不到配额行时使用
      `unlimitedDomainLimits()`。
      正常域创建和默认域初始化均建立该行，缺失不应被解释为不限额。先核实所有初始化、
      迁移和夹具路径，明确每域存在配额记录的不变量，再去掉静默放宽分支。默认域明确
      配置的 null 额度继续表示不限额；不要新增复杂的自动修复或恢复层。
- [x] **Q2，优先：复用同一事务中已授权的班级与使用域上下文。**
      `education/services/contest-remediation.ts` 已加载并锁定班级，随后
      `education/services/assignments.ts` 的 `insertAssignmentDraft()`
      再次加载班级。 `replaceItems()` 每题通过 `assignmentProblem()` →
      `resolveDomainProblem()`
      又查询相同使用域身份。内部写入函数应复用同一事务中已授权的上下文；仍逐题检查
      源资源、共享、绑定和版本。不要跨请求、跨事务缓存授权，也不要增加可由外部调用者
      传入的 skipAuthorization 开关。
- [x] **Q3：简化可信角色到权限集合的映射。** `workspace/types.ts` 的
      `domainPermissions(roles: readonly DomainRole[])` 再次逐项调用
      `isDomainRole()`。当前生产调用来自数据库角色查询，角色列具有 CHECK
      约束，成员角色写入也验证输入。核实调用者后，让该函数成为纯映射；未知 HTTP
      输入仍在写入边界验证，不将内部数据不变量问题伪装成用户请求的 400。
- [x] **Q4：合并配置解析中的重复异常包装。** `workspace/services/instance.ts` 的
      `resourcePolicy()` 与 `getInstanceResourcePolicy()`
      都将解析失败转换成相同的
      `ServiceUnavailableError`。在一个明确边界完成转换，保留脱敏的诊断依据，
      不重复吞掉已有异常。无效配额或模块配置继续拒绝执行，不回退成宽松政策。
- [x] **Q5：收窄授权读取对无关导航配置的依赖。** `workspace/services/access.ts`
      的 `loadWorkspace()` 每次校验完整配置，包含 homepage
      等导航字段，使导航错误阻断题库和提交读取。完整验证保留在写入、
      初始化和迁移边界；读取授权仍验证访问政策，具体模块执行检查必要开关。
      修改前核实 JSON 配置约束与全部写入路径，不能直接删除访问字段检查。

同时保留此前发现的独立正确性问题：

- [x] **S1：核查并修复参赛题目编辑者的客观题答案旁路。**
      `catalog/services/workspace/problem-read.ts` 将普通题面读取的 canEdit
      直接用于
      `trimProblemContentForViewer()`，编辑者可得到完整客观题答案与解析；
      `problem-binding-access.ts` 也允许编辑者越过普通题库的比赛保密阻断。
      客观题专用接口已处理参赛作者，但普通题面及编辑、版本等相关入口仍需统一核查。
      将题目维护权限与比赛答案可见性分开，核实实际比赛组织权限，并补真实接口回归。
      当前证据为静态调用链，尚未完成真实比赛复现，不声称已发生实际泄露。

以下检查有真实输入、并发或资源依据，整改时保留：

- 外部准备之后，在受理事务内重新检查当前成员、共享和作答版本。
- 可信持久域归属，以及 Domain → source 等已由真实 PostgreSQL 测试验证的锁顺序。
- 存储及 LLM 预占、幂等结算、失败释放与持久恢复依据。
- HTTP 输入验证、分页数值安全、ZIP 限制、结果字段允许列表及比赛保密规则。

## Alternatives considered

- 直接批量删除 typeof、空值检查、catch 和权限断言：无法区分不可信输入与内部
  不变量，可能破坏真实授权及计费边界，不采用。
- 为缺失配置增加更多兜底、自动补行和重试：会掩盖初始化错误并增加行为分支，
  不采用。
- 继续全面开发后再清理：用户要求恢复后先一起修复，因此将本清单放在恢复后的
  首个整改批次。
- 新增 proposed 目录并扩展校验脚本：本次仅要求记录审查，暂不增加工具改造。

## Consequences

总体原则为：边界处验证未知输入，事务内保护会变化的事实；内部复用已经成立的
不变量，失败明确，少做静默兜底。Q1、Q2 和 S1 优先处理；Q3、Q4 属于较小的
简化，Q5 需先核实配置约束。

用户恢复开发后，已保存两个 GPG 签名提交：

- `43ca8a60`：Q1、Q3、Q4 和 Q5 工作空间授权边界。 workspace PostgreSQL 47
  项通过；最后增加错误码选项后的 PGlite 39 项通过、 8 项 PostgreSQL
  专用场景忽略，类型和 lint 通过。
- `da6ea991`：Q2、S1 及六处教学写入口的 Q5 对齐。 catalog PostgreSQL / PGlite 各
  364 项通过；education PostgreSQL 104 项通过、 1 项忽略，PGlite 103 项通过、2
  项忽略。新增真实接口覆盖普通题面、固定版本、
  草稿、实际组织者、比赛结束恢复与跨域限制不扩散。

日志：`/tmp/noj-workspace-quality-*.log`、
`/tmp/noj-quality-catalog-{pg,pglite}-final2.log`、
`/tmp/noj-quality-education-{pg,pglite}-final.log`。
这六项整改已完成；后续继续产品任务清单中的迁移收缩、剩余功能、浏览器及服务
验收和 PR / CI。全量回归、完整入口验收及产品升级完成条件尚未满足。
