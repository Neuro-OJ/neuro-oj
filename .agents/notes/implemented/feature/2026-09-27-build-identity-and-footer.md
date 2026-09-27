# Agent Note: 页脚展示构建身份（前后端版本 / commit / 构建时间）

Status: implemented

## Problem

1. **版本号没有事实源**：`health.ts` 三处与 `scripts/noj.ts` 一处硬编码
   `version: "0.9.5"`，而当时版本已是 `0.10.1-beta.2`——对外健康探针报告的版本
   与真实运行版本相差两个版本，且没有任何机制阻止再次漂移。
2. **无法回答"线上跑的是哪次提交"**：Release 流水线把 `github.sha` 写进镜像 OCI
   label，但页面上、`/healthz`、`/api/v1/site/meta` 都取不到；出题人与运维只能靠
   `noj-cli status` 之外的间接线索判断"我改的东西上线了没"（典型场景：修完前端
   缺陷后无法确认刷新到的页面是不是修复版）。
3. **前后端身份不可区分**：noj-ui 与 noj-server 是两个镜像、可能被分别升级，
   只显示一个版本号会在部分升级时给出错误结论。

## Decision

建立**构建身份三要素**（版本 / commit / 构建时间）的单一真相源，并在页脚同时展示
前端与后端两份身份：

- **注入方式**：`release.yml` 以 build-arg 传 `NOJ_BUILD_VERSION`（Release 标签）、
  `NOJ_BUILD_COMMIT`（`github.sha`）、`NOJ_BUILD_TIME`（UTC ISO 8601，构建步骤现场
  生成）。其余 5 个镜像未声明这些 ARG，传入即被忽略。
- **noj-core**：Dockerfile 把三要素落成容器 `ENV`；`shared/base/build-info.ts`
  读取并作为唯一入口，`/health/live`、`/health/ready`、`/health`、`scripts/noj.ts`
  的 `.version()` 与 `/api/v1/site/meta` 的 `data.build` 全部改用它。硬编码清零。
- **noj-ui**：`nuxt.config.ts` 在构建期读入三要素写入 `runtimeConfig.public.buildInfo`，
  随 `nuxt build` 编译进产物；页脚直接读 runtimeConfig，**不新增任何网络请求**。
- **开发回退**：无 ENV 时 version 取模块清单（`deno.json` / `package.json`）、
  commit 取本地 `git rev-parse --short HEAD`（工作区脏则缀 `-dirty`）、构建时间取
  进程启动时刻。镜像内没有 `.git`，因此生产路径不会调用 git。
- **页脚呈现**：品牌列内「标签 | 值」两列网格，值固定两行（版本·commit / 构建时间），
  纯文本不带外链；完整 SHA 与原始 ISO 时间放在 `title`。时间用 `<ClientOnly>` 渲染
  访问者本地时区、SSR 回退 UTC——服务端与浏览器时区不同，直接渲染会造成水合不一致。
- **环境变量登记**：三个键登记进 core 的 bootstrap 注册表（`visible: true`，后台
  环境配置页只读可见），并在 `.env.example` 以注释形式文档化；**不加入** `required`，
  因此 `.env.prod` / `docker-compose.prod.yml` / `noj-cli` 均无需改动。

## Alternatives considered

- **运行期由后端接口提供前端身份**（Nitro 路由 + 页脚额外请求）：能避免把值烘焙进
  产物，但多一次往返，且仍需解决"客户端渲染页面拿不到"的问题。实测证明烘焙方案在
  `ssr: false` 页面同样可用（`window.__NUXT__.config.public.buildInfo` 出现在响应里），
  因此不引入该通路。
- **版本与 commit 走部署侧 ENV**（写进 `.env.prod` 由 compose 注入）：版本号可以从
  已有的 `NOJ_VERSION` 免费获得，但 commit 只有 Release 流水线知道，必须让 noj-cli 在
  install/update 时回写 `.env.prod`（需要额外取数与写入链路），复杂度高于一对 build-arg。
- **只显示单一版本号**：部分升级（只换前端或只换后端镜像）时会给出错误结论。
- **页脚挂 Release / commit 外链**：初版实现过，随后按要求改为纯文本——底部信息条
  不需要跳转能力，纯文本更安静，完整值仍可通过 `title` 取用。
- **运行时用 `NUXT_PUBLIC_*` 覆盖 runtimeConfig**：依赖 SSR payload 注入时序，且对纯
  客户端页面行为不确定；构建期烘焙的确定性更好。

## Consequences

- `/healthz`、`/api/v1/site/meta`、页脚、镜像 OCI label 四个口径现在指向同一份身份；
  页面公开版本与 commit 不构成新的暴露面——`/healthz` 本就由 nginx 公开代理并返回版本，
  且仓库与 Release 本身公开。
- 硬编码版本清零：`tests/routes/health.test.ts` 与 `tests/scripts/noj-cli.test.ts`
  的版本断言改为与 `getBuildInfo()` 同源，任何再次硬编码都会被这两个测试挡住。
- 新增 `tests/shared/build-info.test.ts`（ENV 优先 / 空串视为未注入 / 开发回退 /
  常量化），noj-ui 新增 `tests/buildInfo_test.ts`（版本补 `v`、commit 前 7 位与
  `-dirty`、按时区渲染、缺失降级 `unknown`）。
- 运维文档新增「确认线上正在运行哪个构建」一节（四个口径 + 三个变量 + 本地回退语义）。
- 未命中 ENV 且无 git 时显示 `unknown`（不抛错、不阻塞启动）；本地镜像直接 build 时
  即为此情形。
