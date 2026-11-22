# Agent Note: 清理 rc/v0.11 迁移期兼容层

Status: implemented

## Problem

Issue #698 P1-3：v0.11 把 `src/domains/*` 迁到 `src/modules/*`
时留下了多层只做转发的兼容入口，与 v0.10.6 对照均为本次重构新引入：

- `modules/platform/legal-legacy/`：`services/` 只把旧 `userId` 字符串参数包成
  `UserActor` 再转发到 `services/legal/`；`routes/` 是真实路由，但放在 legacy
  目录下。
- `modules/assets/legacy.ts`，以及在它之上再转发一次的
  `modules/platform/system/services/storage/`（5 个文件）和
  `modules/access/workspace/services/storage-quota.ts`；`platform/system/index.ts`
  又把这些存储能力整体再导出。
- `src/domains/admin/`：`src/domains/` 下最后一个未迁移的目录，与 `src/modules/`
  并存。
- `isBcryptHash`：竞赛邀请码明文兼容的遗留函数，已无调用方，却经 `cross-module`
  合同一路导出。

清理过程中还发现兼容层掩盖的实际缺陷：`scripts/storage-audit.ts`（`deno task storage:audit`）导入的
`system/services/storage/audit.ts`
早已不存在，脚本无法运行；`tests/shared/storage/s3.test.ts` 动态导入不存在的
`s3.ts`，只因未配置 S3 被跳过。

## Decision

1. 删除 `legal-legacy/`：路由移到
   `modules/platform/legal/routes/`；`platform/index.ts` 补齐 `LEGAL_KINDS` /
   `isLegalKind` 与法律类型导出，作为唯一 legal 门面；测试改为传入
   `userActorFromAuthenticatedId(...)`。
2. 删除
   `assets/legacy.ts`、`platform/system/services/storage/`、`workspace/services/storage-quota.ts`，以及
   `platform/system/index.ts`、`access/workspace/index.ts`
   中的存储再导出。生产调用方改为从 `modules/assets/index.ts`
   导入；测试与脚本中门面未覆盖的 transport/审计能力改为直接引用
   `modules/assets/storage/*`、`modules/assets/services/audit.ts`（与
   `create-system.ts` 的组合层做法一致）。顺带修复 `storage-audit.ts` 与
   `s3.test.ts` 的失效导入。
3. `src/domains/admin/` 整体移到 `src/modules/http/admin/`（模块元数据中 `admin`
   早已映射到
   `http`），按新位置重算全部相对导入；同步测试启动器、分片表、模块测试元数据、写端点限流白名单、`verify-domain-ci`（`src/domains`
   不存在时不再报错）、Capability Seam 白名单，重新生成路由目录。
4. 删除 `isBcryptHash` 及其导出。
5. `OAUTH_GITHUB_SECRET` 别名保留但定为 v0.12
   移除：启动时若设置该变量打印告警，注册表描述与 `.env.example` 同步注明。
6. `http/retired-endpoints.json` 保留到 v0.12：LMCC VS Code
   插件由用户自行安装、升级滞后，旧版插件调用已下线接口时需要明确的替代提示；在
   `retired-endpoints.ts` 注明保留期限与理由。

## Alternatives considered

- 把 `admin` 路由按归属拆进各业务模块的 `routes/`：涉及 12
  个路由文件与共享的管理端中间件、审计服务，改动面大且与 #698
  P1-4（重整跨模块边界）重叠。本次先消除 `src/domains` 与 `src/modules`
  并存，拆分留待 P1-4。
- 直接删除 `OAUTH_GITHUB_SECRET` 与已下线接口表：会让仍在用旧变量的部署静默失去
  GitHub 登录、让旧版 LMCC 插件得到无提示的 404，需要先给出一个版本的过渡期。

## Consequences

- `src/` 下只剩 `modules/` 与 `shared/` 两层；legal、存储能力各只有一个门面。
- 跨模块访问存储 transport 的测试直接依赖
  `modules/assets/storage/*`，比以前经三层转发更直观，但也意味着这些测试感知
  assets 内部目录结构。
- `deno task storage:audit` 恢复可用。
