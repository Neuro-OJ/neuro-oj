# Agent Note: rc/v0.11 审计阻断项修复（SSR 净化 / 邮箱验证政策 / 恢复演练契约 / 答疑授权 / 依赖审计）

Status: implemented

## Problem

2026-11-02 的 rc/v0.11 审计（提交 28c87925）确认六项缺陷，其中三项 P1：

1. **SSR 富文本净化可绕过**：`utils/sanitize.ts` 的服务端分支用正则重写 HTML，并
   手写实体解码且只识别带分号的数字实体。浏览器接受 `&#58`（省略分号）等形式，
   于是 `javascript&#58alert(1)` 通过协议检查、被解析成 `javascript:` URL —— SSR
   首屏与降级路径存在点击触发 XSS。
2. **新域写接口绕过邮箱验证政策**：政策挂在认证中间件的 URL 前缀清单上，未覆盖
   `/domains/:slug/...`，未验证账号可发帖、可提交评测。
3. **恢复演练调用已删除的接口**：演练仍打 `POST /problems/import-bundle`（真实
   core 404），825 个 CLI 单测因 mock 与契约脱节全部通过。
4. 域 owner 无法处理他人创建的比赛答疑（服务层退回“管理员或创建者”旧模型）。
5. 个人主页仍发 `type=U`，后端已拒绝该参数，页面静默显示空列表。
6. 生产 Nginx 全站 64 MiB 与后端 128 MiB/2 GiB 上传上限冲突。
7. 运行时依赖（markdown-it / Nuxt /
   DOMPurify）公告未闭环，且没有任何依赖审计门禁。

## Decision

- **净化改为解析型、政策单一来源**：新增
  `noj-ui/utils/sanitize-policy.ts`（标签/ 属性/协议/图片处置），服务端用
  `sanitize-html`（htmlparser2 + 实体解码交给解析器）， 客户端保留
  DOMPurify；`simpleSanitize`/`decodeHtmlEntities`/`isUnsafeUrl` 删除。
  服务端解析器由 Nitro 插件注册，避免进入浏览器 bundle；净化失败一律降级纯文本
  （fail-closed）。语料集中在
  `noj-ui/tests/fixtures/xss-corpus.ts`，Deno、vitest 与 真实
  Chromium（`scripts/verify-bff-ssr.mjs`）共用。
- **邮箱验证绑定到能力**：新增
  `assertContentWriteAccount()`，由两个写用例必经闸口 调用 ——
  `assertCommunityWritable()`（新旧社区入口共用）与评测受理
  (`composeEvaluationAdmissionContext` /
  `composeDomainEvaluationAdmissionPlan`)。 认证中间件的 URL
  前缀清单删除；`/api/v1/admin/*` 语义不变。
- **演练改走域契约**：新增 `noj-cli/src/problem/client.ts` 作为路径唯一来源，
  `problem push` 与演练共用；演练走 域导入 → 显式发布（`If-Match`）→ 域读题 →
  域支持包 → 域自测（带 `version_id`）。drill 单测新增“请求路径白名单”断言，
  旧路径一出现就失败。
- **答疑只消费授权结论**：服务接收
  `ClarificationAccess`（`canManage`/`isParticipant`）， 由路由层
  `loadDomainContest(...)` 算一次。
- **主页“创建的题目”改成域感知聚合**：profile 聚合新增 `created_problems`
  （跨域、逐行按 viewer 可见性过滤，`display_id` 带域 slug 前缀），页面删除
  `?type=U` 请求并改用 `workspaceProblemUrl()` 生成域路由链接；同时清掉
  `ObjectivePaper.type`、`ProblemId.type`、IDE 无调用方的 `listProblems()`。
- **上传上限做成契约**：`deploy/nginx/default.conf` 按端点分档（题包/支持包
  128m、 产物 2048m，均 `proxy_request_buffering off`），契约表在
  `dev-docs/engineering/upload-limits.md`；题包导入改为**读体前**完成域解析、
  `problem:import` 授权与 `Content-Length` 预检（新增
  `assertDeclaredBodyWithin()`），超大请求不再先缓冲 128 MiB 再拒绝。
- **比赛授权收敛为单一实现**：`contests/services/contest-access.ts` 变成
  `access/contest-policy.ts` 的薄适配器（`userId|null` → `AccessActor` + DTO
  映射 +
  fail-closed），删除重复的窗口/成员判定；“赛后题目被另一场未结束保密比赛保护”
  的规则现在只有一处。适配器保留“未显式传域名即固定 `main`”的旧语义。
- **门禁补齐**：`check-legacy-api-removed` 现在识别相对 URL 与跨行方法； 新增
  `check-dependency-audit`（解析 `deno.lock` 的锁定版本 + npm bulk advisory， 与
  registry 原点无关，忽略清单必须写可达性与复核期限）与
  `check-upload-limits`（代理 ≥ 应用、上传 location 必须关闭请求体缓冲）；
  `verify-bff-ssr` 增加 routeRules 大小写/点段变体回归；新增
  `check-contract-reexports`（67 个纯重导出合同必须登记能力与 DTO，含真实实现的
  合同不受限），把"合同文件数量"与"语义边界"分开记账。
- **网关出站校验与连接绑定（R1）**：`upstream-guard.ts` 新增
  `resolvePublicUpstream()` 返回**已验证地址集合**，`fetchPinned()` 用
  `node:https` 的 `lookup` 把连接钉在这批地址上（保留真实 `servername` 做 TLS
  校验），`routes/llm.ts` 改用它发起上游请求，校验对象与连接对象合一。spike 结论、
  实现细节、残余风险与回滚点见
  [`dev-docs/engineering/gateway-dns-binding.md`](../../../../dev-docs/engineering/gateway-dns-binding.md)。
- **`vue` 版本与 Nuxt 对齐**：`noj-ui` 的 devDependency `vue` 从 `3.5.43` 提到
  `3.5.44`（nuxt 4.6.3 要求 `vue ^3.5.44`）。此前两版并存导致 `@vue/runtime-core`
  出现两份类型实例，`.nuxt/types/imports.d.ts` 的 `ComponentCustomProperties`
  增强无法合并，`deno task check:types:nuxt` 在 `navigateTo` / `workspacePath`
  上误报 TS2339。

## Alternatives considered

- **DOMPurify + happy-dom 跑服务端**：每请求建 Window，`deno compile`
  产物与内存代价高； 且 happy-dom 自身的解析偏差已让组件测试无法反映浏览器行为。
- **继续修正则净化器**：实体解码是 whack-a-mole，与审计建议相悖。
- **未验证账号全站默认拒绝**：会波及入域/受邀/出题，且把发布可用性绑死在邮件服务上，
  与旧口径（仅限制内容写）不一致。
- **`deno audit --frozen-lockfile` 直接入门禁**：`noj-ui/.npmrc` 固定的镜像源把
  tarball 原点写进锁文件，换官方 registry 会因 origin 不匹配拒绝读取锁文件；
  `--no-lock` 又会跳过审计。因此改为自行解析锁定版本 + bulk advisory。
- **R1 用受控出口代理（方案 B）**：需要固定出口 IP 与 Provider 侧配置权限，且掩盖
  而非消除“校验对象≠连接对象”；spike 证明方案 A 在 Deno 下可用，故不采用。

## Consequences

- 服务端净化行为变化：未知标签由“转义成可见文本”改为“丢标记留文本”；`script`/`style`
  连内容丢弃（与旧行为一致）。已用测试固化。
- `noj-ui` 锁定依赖前移：nuxt 4.6.3、markdown-it 14.3.3、dompurify 3.4.17，
  并新增 sanitize-html；`deno task build` 与 `test:bff:ssr` 均通过。
- 依赖审计的阻断级别默认 `critical`，high/moderate 全部打印但需逐条登记；
  当前未登记项（prosemirror-view、zod 等）仍需产品级判断。
- 上传契约的已知限制：产物提交在 `/domains/:slug/submissions` 上参考题目来自
  multipart，因此限流/受理仍在读流之后；带 `:label` 的竞赛路径可以前置。
- 网关出站流量不再走 `fetch`：上游请求由 `node:https` 发起，3xx 一律拒绝（等价原
  `redirect: "error"`）、只连第一个已验证地址、白名单主机不做钉住。测试通过
  `setPinnedTransport()` / `setRequestImplementations()` 两个接缝注入替身，路由用例
  仍由 `stubFetch` 拦截，生产路径始终是默认实现。
- 演练契约补上了**真实 HTTP** 证据：`noj-tests/e2e/cross-domain/restore_drill_contract.test.ts`
  用子进程编排真实 core（独立库 + 迁移 + 系统初始化 + `runBusinessVerification`
  经真实 HTTP 跑 `skipEvaluation` 分支），并断言已删除的
  `POST /api/v1/problems/import-bundle` 返回 404、域入口存在、演练 `passed`。
  这是 F3 从“mock 全绿”走向“契约可验证”的闭环，缺它时 CLI 侧只有路径白名单断言。
- `noj-ui/deno.lock` 仍由镜像源生成（预约的“锁文件原点归一化”未执行）：
  `check-dependency-audit` 因此按锁定版本 + advisory 判断，不依赖 registry 原点；
  若要恢复 `deno audit --frozen-lockfile`，需先以官方 registry 重装并确认 CI 可下载。
