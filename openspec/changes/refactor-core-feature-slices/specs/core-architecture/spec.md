## Purpose

规定 noj-core 的代码组织与依赖约定，使新增功能改动集中、依赖清晰，且便于人与 AI
编码助手就近阅读与修改。

## ADDED Requirements

### Requirement: Core source is organized as kernel and features

noj-core 源码 SHALL 分为 `kernel/` 与 `features/` 两层。每个功能 SHALL
位于独立的 `features/<name>/` 目录，包含其路由、服务、表结构、测试与简短说明，并
SHALL 仅通过该目录的 `index.ts` 对外暴露。

#### Scenario: Adding a new feature stays local

- **WHEN** 开发者新增一个包含表、路由、一个后台任务与测试的普通功能
- **THEN** 所需改动不超过 6 个文件，且无需修改任何手工维护的登记表

### Requirement: Features declare themselves and are assembled from one list

每个功能 SHALL 在 `index.ts` 中声明其路由、后台任务、常驻 worker
与观测注册。应用 SHALL 通过遍历单一功能清单完成装配，SHALL NOT
在其他位置手工登记功能的路由或任务类型。

#### Scenario: Duplicate task type is rejected at startup

- **WHEN** 两个功能声明了相同的后台任务类型
- **THEN** 系统启动校验失败并指出冲突的功能与任务类型

### Requirement: Dependency rules are enforced by a single check

功能 SHALL 只引用 `kernel/` 与其他功能的 `index.ts`；`kernel/` SHALL NOT
引用任何功能；功能之间 SHALL NOT 存在循环依赖。CI SHALL
通过单一检查脚本强制这些规则，并在违规时给出可直接执行的修复提示。

#### Scenario: Deep import into another feature fails CI

- **WHEN** 某功能直接引用另一功能的内部文件而非其 `index.ts`
- **THEN** 检查失败，并提示改为从对方 `index.ts` 引入及需要导出的符号

#### Scenario: Kernel importing a feature fails CI

- **WHEN** `kernel/` 中的文件引用了 `features/` 下的任何文件
- **THEN** 检查失败并指出违规的 import

### Requirement: Domain tests are discovered by directory

`test:domain <name>` SHALL 解析为 `features/<name>/` 下的测试，新增功能 SHALL
NOT 需要登记测试路径。

#### Scenario: New feature tests run without registration

- **WHEN** 新功能目录中加入测试文件
- **THEN** `deno task test:domain <name>` 与 CI 按路径选择均会执行这些测试

### Requirement: Refactoring preserves behavior

结构调整 SHALL NOT 改变任何对外 API、响应格式、数据库结构或业务语义；每个调整 PR
SHALL 保持集成分支（当前为 `rc/v0.11`）可部署且全部测试通过。

#### Scenario: Route table unchanged after assembly switch

- **WHEN** 装配方式由手工导入切换为功能清单
- **THEN** 切换前后的路由表与中间件顺序快照一致
