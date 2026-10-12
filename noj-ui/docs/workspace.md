# 工作空间前端

当前提供空间目录、创建 / 创建申请、域概览、成员角色、加入申请审核、邀请与 负责人交接、配置 / 模板预览及成员 /
题目配额页面。资源做题、教学、比赛和 域搜索入口在后续隔离及功能验收完成后接入，不能把管理外壳视为完整多域 OJ。

## 上下文及权限

`layouts/workspace.vue` 只建立一份 `provideWorkspaceContext()`，子页面通过 `useWorkspace()` 注入同一状态。Domain 始终从
`/d/:slug/...` URL 解析；导航偏好 只在主动进入空间时保存，不改变当前标签页域，不更换 JWT。

概览按域和统一账号缓存；响应中的实际 `actor_id` 必须与请求身份一致。
切换域或账号立即停止使用旧事实，背景刷新可保留同域名称但暂停使用旧权限。 所有动作仍由后端实时鉴权；可读 Session Cookie
不能授予管理能力。

`useWorkspaceActionScope()` 在确认之前捕获目标域和账号。切换、退出或卸载后
不继续旧确认，不把旧请求结果显示给新账号。生成的邀请明文只在当前创建响应 显示，目录不返回令牌或哈希。

`workspacePath`、`workspaceProblemPath` 保留使用域。引用 `main:1001` 时网址仍为
`/d/school/problems/main:1001`。资源缓存键另包含资源、稳定 ID 和版本；现有题目 页面、IDE 编辑草稿的全面接入尚未完成。

## 邀请注册

邀请链接使用 `/join#invitation=...` 或 `/register#invitation=...`，令牌留在 URL fragment 中，以 POST
请求体向认证入口预览，不进入请求路径或 Referer。 预览只返回目标空间、受邀邮箱、到期时间和能否注册，不枚举账号。

已有账号可在邀请页登录及接受，支持两步验证码。其他登录方式可在新标签页完成，
回到邀请页时重新验证账号；初始密码更新使用独立页面，不改写已有账号凭据。
受邀注册固定邮箱，后端事务只加入目标域，管理员开户政策和签发者撤权仍生效。

登录回跳只接受经 `safeAuthRedirect()` 检查的本站路径。私有实例登录后只有一个
可用域时直接进入该域；两个以上域显示选择入口。邀请令牌不进入登录回跳查询参数。

## 配置与冲突

配置、配额和模板写入携带 `If-Match`。保存冲突保留未保存内容及原编辑 revision，
不能自动将旧修改绑定到新版配置。模板必须先预览差异再显式确认应用。 配额保存不清除基本设置草稿；基本设置继续使用原
revision，若需刷新，由用户 明确重新读取。域和账号变化后不复用其他空间的管理表单或邀请。

目前配额页面展示已实际接入的成员、题库条目限制。存储、提交频率和 LLM 额度
管理在其执行链实现后补齐。归档和暂停状态由服务端政策决定，不隐藏失败响应。

## 验证

```sh
deno task test
deno task test:components
deno task check:types
deno task check:types:nuxt
deno task build
```

Vue 新页面另用 `deno fmt --unstable-component` 格式化。组件测试固定线程池， 避免本地 Deno 下默认 fork 池全部断言通过后以
BrokenPipe 退出。 域来源、身份变化、缓存、确认期间切换、冲突草稿及模板预览有对应测试。
构建和组件测试不能证明真实交互、窄屏布局或完整 Public / Private / Mixed 旅程；这些验收仍记录在
[升级任务清单](../../dev-docs/superpowers/plans/2026-10-12-workspace-upgrade-tasks.md)。
