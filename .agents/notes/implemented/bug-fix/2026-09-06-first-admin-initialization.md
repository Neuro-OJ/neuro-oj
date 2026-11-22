# Agent Note: 首个管理员改为部署者本机初始化

Status: implemented

## Problem

Issue #424：空站首个公开注册用户自动获得管理员，无法确认其是否为部署者。
安装提示鼓励抢先注册，增加误操作风险。

## Decision

公开注册只分配普通角色。服务端 CLI 新增
`bootstrap first-admin`，以服务器本机操作权限
确认部署者，通过交互终端隐藏输入并确认密码，不接收密码参数、不输出密码。
仅空站可创建管理员，强制首次改密，不自动标记邮箱已验证。

复用 `system_settings` 的内部、未注册为可编辑配置的永久关闭标记。 初始化以唯一键
INSERT 的返回值决定是否获得资格，将标记、用户和角色原子提交；
公开注册先写入相同标记，阻止并发提权。OAuth 创建用户前也关闭初始化。 服务启动和
`init system` 发现已有真实用户时持久关闭，不改变现有权限。 CLI
即使未经启动检查也拒绝已有用户站点并提交关闭标记。

## Alternatives considered

- 保留首注册提权：操作少，但公网注册者身份不可信，拒绝。
- 短期一次性网页认领令牌：能验证部署者，但增加令牌生成、传递、存储、过期和重放处理；
  采用 issue 提出的本机 CLI 直接创建方案，无网页认领端点或 bearer 初始化令牌，
  因此认领令牌过期和重放验收不适用。
- 复用旧
  `bootstrap admin`：保留其维护和开发兼容性，但它支持提升已有用户并把临时密码
  写入本机文件，不作为生产首次初始化入口，也不加入自动启动和升级流程。

## Consequences

部署者需要在开放注册前执行一次本机命令。公开注册抢先完成只会关闭首次初始化，
不会产生管理员；此时须由部署者通过既有维护命令人工核实并恢复管理员。
删除管理员、重启或升级均不会重新开放首次初始化。没有新增环境变量或数据库迁移。
新增交互输入依赖由 Deno 自动更新锁文件。

验证基线：`60e0e15b`，2026-09-06，本地验证，未操作生产环境。

- `deno task test`：初始化、注册 service/route、旧 seed 测试 56 通过，5
  个原有环境相关用例跳过。
- OAuth、RBAC、管理接口回归：66 通过。
- 独立 PostgreSQL 16 容器先执行 `deno task test:pg tests/00_migrate_test.ts`
  初始化， 再执行
  `deno task test:pg src/domains/identity/tests/services/admin-initialization.test.ts`：9
  通过，含真实连接并发竞争。
- 类型检查、改动代码 lint、格式检查及部署脚本测试通过。
- CLI 交互终端实际创建成功、密码输入仅显示星号；非交互输入拒绝且退出码为 1。
- OAuth 新增关闭标记断言后单独复跑通过。
- 身份域全量测试被既有 revokedTokens Redis
  重连用例阻塞，停止该轮；不声称全量通过。
- 域边界检查报告既有 `system/services/observability.ts` 和
  `query/routes/admin-dashboard.ts` 两处深路径跨域导入，均非本次改动。

更新至 `main` 的 `12ebbeba`
后，移除邮件门槛中的首次公开注册例外；邮件未配置时本机初始化仍可成功。
重新执行初始化、注册、注册状态和 OAuth 身份测试：53 通过，5
个原有环境相关用例跳过；类型检查与改动 lint 通过。

`2026-11-22` 起，`dev-setup` / `bootstrap admin` 兜底创建的管理员密码不再进入
日志：密码写入启动目录的 `.data/bootstrap-admin.txt`（文件 0600、目录 0700，
Windows 无 POSIX 权限位），终端只打印文件路径。该调整用于消除 CodeQL
`js/clear-text-logging` 告警，密码仍以明文落盘，因此该命令继续只用于开发/维护路径，
生产首次初始化仍用 `bootstrap first-admin`。

同一日期起，凭据交付顺序改为**先写文件、后落库**：写盘失败时命令抛错并非零退出，
数据库中没有管理员，修好目录后重跑不会被 `hasLoginableAdmin` 挡住；若先落库再删号，
第二次数据库写失败会留下没有密码的管理员，把初始化锁死。落库失败时保留刚写的凭据
文件而不是删除（提交结果不确定时文件里的密码仍可能对应已建账号），重跑会另存新文件。
目标文件已存在时一律不覆盖，改写同目录下带时间戳和随机后缀的兄弟文件，旧凭据原样
保留。路径可用 `bootstrap admin --credentials-file <path>` 注入，测试指向每次运行
独有的临时目录；生产 `core` 容器根文件系统只读，默认启动目录 `/app/.data/` 不可写，
正常生产流程（`migrate` 的 `init system` 与 `bootstrap first-admin`）不触发本文件
写入，只有在该容器内手动执行 `bootstrap admin` 且未设置 `ADMIN_EMAIL` 时才需要
显式传入挂载的可写路径。
