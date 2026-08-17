# noj-ui 审计报告

> 基线：`main` @ `31150781` · 只读静态审查 + 对抗性复核 · 真阳性 43 条（全部经逐条代码验证）

| 严重级 | 数量 |
|---|---|
| 严重 | 1 |
| 高 | 2 |
| 中 | 7 |
| 低 | 24 |
| 信息 | 9 |

## 严重

### NOJ-248 搜索高亮 v-html 未转义用户内容，导致存储型 XSS
- **位置**：`noj-ui/components/feature/search/SearchResultItem.vue:27,85-95`　**维度**：安全
- **描述**：highlightedTitle 将后端返回的 highlight 字段（PostgreSQL ts_headline 对题目标题/社区帖子标题或正文/用户名生成的片段，见 noj-core/src/services/search.ts:90-92、213-214、285-287，其中除 [[HIGHLIGHT]]/[[/HIGHLIGHT]] 标记外的原文未被 HTML 转义）仅做 .replaceAll 把标记替换为 <mark>，然后绑定 v-html。原文中的 <img src=x onerror=...>、<script> 等会被浏览器当作 HTML 执行。攻击者可在社区帖子标题/正文、U 型题目标题或用户名中植入载荷，其他用户搜索匹配关键词时即触发，无需点击，属可自动执行的存储型 XSS。
- **证据**：`const highlightedTitle = computed(() => { ... return raw.replaceAll("[[HIGHLIGHT]]", '<mark class="bg-yellow-200">').replaceAll("[[/HIGHLIGHT]]", "</mark>"); });
<template> <div ... v-html="highlightedTitle" />`
- **建议**：渲染前对原文做 HTML 转义后再插入 <mark>：先按标记 split，对非标记片段用 escapeHtml（如 md.utils.escapeHtml 或手写 & < > " ' 转义），仅标记位输出 <mark>；或改用 Vue 文本节点 + <mark> 的组合模板渲染，彻底移除 v-html。
- **验证**：确认存储型 XSS。SearchResultItem.vue:27 用 v-html 渲染 highlightedTitle，85-95 仅 replaceAll 标记为 <mark>、对原文零转义；search.ts:90-92/213-214/285-287 的 ts_headline 直接输出用户可控的 title/正文/用户名（ts_headline 不转义 HTML，<img onerror> 原样保留）；community.ts createPost(327-400) 对 title/content 仅 trim+长度校验、无任何 HTML 清洗。社区搜索公开可达（routes/search.ts:116-129 guest_read），普通用户发帖即可让任意搜索匹配者自动触发，无需点击；虽 JWT 为 HttpOnly，但可借受害者会话越权操作/窃取数据，严重成立。

## 高

### NOJ-215 登录/改密代理丢失客户端 IP，后端登录 IP 限流与 IP 黑名单失效
- **位置**：`noj-ui/server/api/[...slug].ts:57-67`　**维度**：安全
- **描述**：登录/改密拦截分支用 $fetch.raw 手工构造转发头，仅包含 content-type 与（可选）authorization，未透传 X-Forwarded-For / X-Real-IP。noj-core 的 getClientIp（src/lib/rate-limit-env.ts:136-166）依赖这些头解析客户端 IP，loginIpRateLimit（src/middleware/login-rate-limit.ts:59）据此建 Redis 桶。由于代理不透传，所有登录请求在后端视角均落在同一 'unknown' IP，导致 IP 维度限流（30s/10 次）变成全站共享桶：单个攻击者可耗尽该桶使所有用户登录被 429 拒绝（DoS），且 ipBans 的 CIDR 匹配永远命中不到真实客户端（'unknown' 不匹配任何条目），IP 封禁形同虚设。对比非登录路径使用 proxyRequest 会透传原始头，登录路径行为不一致。
- **证据**：`const headers: Record<string, string> = { 'content-type': 'application/json' };
if (token) headers['authorization'] = `Bearer ${token}`;
const response = await $fetch.raw(target, { method: 'POST', body, headers });`
- **建议**：从 event.node.req.headers 透传 x-forwarded-for、x-real-ip、user-agent 等头（或将登录/改密也改走 proxyRequest 并仅对响应体做后处理），确保 noj-core 的 getClientIp 能拿到真实客户端 IP，使登录 IP 限流与 IP 黑名单恢复生效。
- **验证**：确认 [...slug].ts:57-60 登录/改密分支仅手工构造 content-type+authorization，未透传 x-forwarded-for/x-real-ip；getClientIp(rate-limit-env.ts:136-166) 依赖这些头，缺失则返 unknown；loginIpRateLimit 以 unknown 建桶。非登录路径走 proxyRequest 透传原始头，行为确不一致。后果成立：所有登录共享单一 unknown IP 桶可被单攻击者耗尽造成全站登录 429 DoS，且 ipBans CIDR 永匹配不到真实 IP；账号维度限流+锁定仍在，故维持高。

### NOJ-249 Markdown SSR/降级净化器 simpleSanitize 可被实体/控制字符绕过 javascript: 协议，且白名单 style 属性
- **位置**：`noj-ui/utils/sanitize.ts:63,70-106,112-114`　**维度**：安全
- **描述**：sanitizeHtmlSync（SSR 首屏与 sanitizeHtmlAsync 中 DOMPurify 加载失败时的降级路径，见 sanitize.ts:120-128 的 catch）使用正则白名单 simpleSanitize。其 javascript: 协议检查 /^\s*javascript:/i 作用在属性原始字符串上，发生在浏览器实体解码与控制字符归一化之前：jav&#x61;script:、java\nscript:（tab/换行）等均不匹配从而被放行，浏览器解析后仍还原为 javascript: URL 并执行；同时 SAFE_ATTR_RE 白名单了 style 属性且未做任何 CSS 清洗（可注入 position:fixed 全屏钓鱼/UI 覆盖层，或历史 expression/url(javascript:) 向量）。由于 MarkdownRenderer.vue 中 markdown-it 开启 html: true（MarkdownRenderer.vue:14），用户 markdown 里的原始 <a href="jav&#x61;script:..."> 会原样流入 simpleSanitize；且 SSR 首屏固定走 sanitizeHtmlSync（MarkdownRenderer.vue:80-82），故社区帖子/用户简介/题目描述等服务端渲染内容在 DOMPurify 生效前就已携带绕过载荷。点击链接触发任意 JS（可执行存储型 XSS）。
- **证据**：`const SAFE_ATTR_RE = /^(?:href\|title\|alt\|src\|class\|width\|height\|target\|rel\|style\|align\|start)$/i;
if ((attrLower === 'href' \|\| attrLower === 'src') && /^\s*javascript:/i.test(val)) { return ''; }
export function sanitizeHtmlSync(raw: string): string { return simpleSanitize(raw); }`
- **建议**：SSR/降级路径不要自研正则净化器：在服务端也用具备 DOM 语义的净化（如 jsdom + DOMPurify，或统一在服务端调用 same-origin 的净化），至少补齐：1) 先对属性值做实体解码/控制字符归一化后再做协议黑名单匹配，并扩展黑名单到 data:、vbscript:、file: 及大小写/空白变体；2) 从 SAFE_ATTR_RE 移除 style，或接入 CSS 白名单清洗；3) 标记 SSR 输出为不可信，并在客户端水合后强制以 DOMPurify 结果覆盖重渲染。
- **验证**：simpleSanitize 的 javascript: 检查 /^\s*javascript:/i 作用在原始属性值上（sanitize.ts:93），实体编码 jav&#x61;script: 与控制字符 java\nscript: 均不匹配被放行，浏览器解码后还原执行；SAFE_ATTR_RE 白名单 style 且无 CSS 清洗（:63）；MarkdownRenderer.vue html:true（:14）且 SSR 走 sanitizeHtmlSync（:80-82）。绕过真实存在。降级理由：主 JWT 为 HTTP-only 不可窃取、客户端水合后 sanitizeHtmlAsync 走 DOMPurify 会重洗、javascript: 向量需点击，故由严重降为高。

## 中

### NOJ-235 编辑器切换题目时代码与草稿状态残留
- **位置**：`noj-ui/components/editor/EditorWorkspace.vue:82-88,159-190`　**维度**：UI可用性
- **描述**：code 用 ref('') 初始化后，没有任何 watch 监听 props.problem / props.draftKey 来重置 code；useDraftStorage 接收的是 ref(props.draftKey)（对传入字符串做快照，不响应 props.draftKey 变化），且草稿仅在 onMounted 加载一次。同一路由参数切换（如 /editor/1 → /editor/2，或竞赛 /editor/:id?contest=1&label=A → B）复用组件实例时，code 不会被清空，上一题的代码残留在编辑器里，草稿也不会按新题 key 重新加载。模板加载 watch 里 'if (code.value.trim() !== "") return' 又进一步阻止了新题模板的填充，用户可能在显示 B 题描述的同时把 A 题的代码提交给 B 题。
- **证据**：`const code = ref(''); const { state: draftState, ... } = useDraftStorage(ref(props.draftKey), code, draftEnabled) … watch(() => props.problem, async (p) => { if (!p \|\| !props.templateUrl) return; if (code.value.trim() !== '') return; … })`
- **建议**：在 watch(() => props.problem / draftKey) 中重置 code.value = ''（或先加载新题草稿），并将 useDraftStorage 的 key 改为 computed(() => props.draftKey) 以响应变化；切题时若 code 非空且未保存给出提示。
- **验证**：核实 EditorWorkspace.vue:82 code=ref('') 无重置 watch、:85 `ref(props.draftKey)` 快照不响应变化、useDraftStorage onMounted 仅加载一次、:163 模板 watch 遇非空即 return；父页 [id].vue:168 未加 :key，/editor/1→/editor/2 复用组件实例。切题后旧代码残留、可把 A 题代码提交到 B 题，真实正确性/可用性缺陷，维持中。

### NOJ-227 首页随机题目卡片一次性拉取 100 道题仅展示 3 道
- **位置**：`noj-ui/components/feature/RandomProblems.vue:67-75`　**维度**：性能
- **描述**：首页每次挂载（onMounted→fetchAndShuffle）都请求 /api/v1/problems?limit=100，后端返回完整题目对象（含 description 长文本、runtime_config、categories），随后仅 shuffle 后 slice(0,3) 展示 3 道。这是访问量最高页面上的一个不必要的大体积请求，浪费带宽与后端查询。
- **证据**：`const res = await api.get<{ data: ProblemItem[] }>("/api/v1/problems", { query: { limit: 100 }, silent: true }); const shuffled = [...list].sort(() => Math.random() - 0.5); problems.value = shuffled.slice(0, 3)`
- **建议**：改为后端提供随机题目端点（如 /api/v1/problems/random?limit=3）或带轻量字段（不含 description）的小 limit 请求，避免首页拉取 100 道完整题目。
- **验证**：fetchAndShuffle 请求 /api/v1/problems?limit=100 后仅 slice(0,3) 展示（RandomProblems.vue:67-75），且 onMounted 每次挂载触发。首页高频页的一次大体积请求，属真实性能问题，维持『中』。

### NOJ-210 useApi 的 401 统一跳转未清除本地认证状态与 session cookie，形成僵尸登录态
- **位置**：`noj-ui/composables/useApi.ts:62-69`　**维度**：正确性
- **描述**：任何（非认证页）请求返回 401 时，useApi 仅 navigateTo('/login?redirect=...')，既不调用 logout() 清除 useState('auth:user')，也不删除 noj:session cookie。跳转后 isLoggedIn 仍为 true、导航栏仍显示已登录头像；用户再次导航到受保护页时，auth 中间件因 isLoggedIn 仍为 true 而放行，页面加载后再次 401 又被弹回 /login，陷入「UI 显示已登录但所有请求 401」的僵尸态，只能等 cookie 过期或手动登出。与 fetchUser 的 401→logout 路径行为不一致。
- **证据**：`useApi.ts:62-69 在 401 分支只做 `navigateTo({ path: '/login', query: { redirect } })`，未清除 auth:user 或 noj:session。`
- **建议**：在 401 分支同时清除本地认证状态（调用 useAuth().logout() 或直接置空 auth:user 并删除 noj:session cookie），保证跳转后 isLoggedIn 与后端会话一致；并避免对并发多个 401 重复 navigateTo。
- **验证**：useApi.ts:62-69 在 401 分支只 navigateTo('/login')，不清 auth:user、不删 noj:session。middleware/auth.ts:45 仅 !isLoggedIn 才跳转，51 行仅在 !user.created_at 时才 fetchUser（fetchUser 的 401→logout 路径不会被触发），故 isLoggedIn 仍 true、再次进入受保护页被放行→再 401 回弹，僵尸登录态成立。保留中。

### NOJ-209 useAuth.fetchUser 将网络错误/超时/5xx 一律当作登出，瞬时故障即清会话
- **位置**：`noj-ui/composables/useAuth.ts:110-124`　**维度**：正确性
- **描述**：fetchUser() 的 catch 块无条件 await logout()（清除 auth:user 并删除 cookie）。但该 catch 捕获的是所有异常：既包含真实的 401（token 过期/无效），也包含网络错误、超时（timeout:5000）、5xx。一旦后端瞬时不可达或网络抖动，/auth/me 失败即触发登出，用户被静默踢出并删除 noj:session/noj:token cookie；配合 middleware/auth.ts 的 useAuthReady 5s 超时与 isLoggedIn 判断，会进一步把用户重定向到 /login。这混淆了「认证失败」与「服务不可用」两种语义，造成误登出。
- **证据**：`useAuth.ts:114 `const res = await api.get('/api/v1/auth/me', { silent: true, timeout: 5000 })`；120-123 `} catch { await logout(); return null; }` —— 未区分 err.status===401 与其他错误。`
- **建议**：仅当 extractApiError(err).status === 401（或 403 PASSWORD_CHANGE_REQUIRED 等认证类码）时才 logout；网络/超时/5xx 保留现有 user 状态并返回 null 或抛出，由调用方决定重试，避免瞬时故障导致误登出。
- **验证**：确认 useAuth.ts:110-124 fetchUser 的 catch 无条件 await logout()，未区分 401 与网络错误/超时(5s)/5xx，瞬时故障即清会话并删 cookie，误登出属实。维持中。

### NOJ-225 全局搜索分页参数名不一致：前端传 limit，后端读 per_page
- **位置**：`noj-ui/composables/useSearch.ts:156-167`　**维度**：正确性
- **描述**：前端 useSearch.ts（line 157/161/165 传 limit）与 pages/search.vue（line 140 传 limit）向 GET /api/v1/search 发送 limit 查询参数；但后端 search.ts 使用 parsePagination(c, {defaultPerPage:20, maxPerPage:50})（noj-core/src/routes/search.ts:79-82），其 perPageField 默认为 'per_page'（noj-core/src/lib/pagination.ts:79），即后端只读 per_page，完全忽略 limit。后果：命令面板 SearchPalette 期望 limit=5（题目）/3（用户、社区），实际每次返回默认 20 条，前端按 limit 裁剪的意图被静默破坏。CLAUDDE.md 搜索文档也误记为 limit，进一步印证命名漂移。
- **证据**：`前端 useSearch.ts:157 `params: { q, type: 'problem', limit }`；后端 search.ts:79 `parsePagination(c, { defaultPerPage: 20, maxPerPage: 50 })` + pagination.ts:79 `perPageField = "per_page"``
- **建议**：统一参数名：将后端 search.ts 改为 parsePagination(c, { perPageField: 'limit', ... }) 或前端改用 per_page；同时修正 noj-core/CLAUDE.md 中搜索分页参数的文档。
- **验证**：确认前端 useSearch.ts L157/161/165 传 limit（题目 5/用户 3/社区 3），后端 search.ts L79 parsePagination 默认 perPageField='per_page'（pagination.ts L79），完全忽略 limit，实际返回默认 20 条，前端裁剪意图被静默破坏，真实功能缺陷，维持中。

### NOJ-236 管理端移除竞赛参赛者无二次确认
- **位置**：`noj-ui/pages/admin/contests.vue:207-211`　**维度**：UI可用性
- **描述**：参与者管理弹窗中点击垃圾桶图标直接调用 removeParticipant 删除参赛者，没有任何 dialog.confirm 或确认弹窗，也无操作后 toast 反馈。移除参赛者会解除该用户的竞赛关联（可能连带其竞赛提交/成绩），属于破坏性操作却缺少确认与反馈，与同文件删除竞赛（removeContest 用 dialog.confirm）不一致。
- **证据**：`async function removeParticipant(participant: Participant) { if (!participantContest.value) return; await api.delete(`/api/v1/admin/contests/${participantContest.value.id}/participants/${participant.user_id}`); await loadParticipants() }`
- **建议**：移除前用 dialog.confirm 确认（如『确定移除 {username} 吗？其竞赛提交关联将一并解除』，danger: true），成功后 toast.success 反馈。
- **验证**：确认 contests.vue:207-211 removeParticipant 直接 api.delete 无 dialog.confirm 无 toast；同文件 removeContest(136-137) 使用 dialog.confirm，行为不一致属实。维持中。

### NOJ-207 「查看全部结果」跳转 type=all，后端不支持导致搜索完整页 400 报错
- **位置**：`noj-ui/pages/search.vue:93, 135-143`　**维度**：正确性
- **描述**：SearchPalette.vue 的「查看全部结果 →」链接（line 94）与未选中项回车（line 209）都跳转 /search?q=...&type=all；search.vue 把 route.query.type 原样作为 type 传入 GET /api/v1/search（line 135-143 的 params.type = type.value）。但后端 search.ts 仅接受 type ∈ {problem, user, community}，对 'all' 直接抛 ValidationError('type 参数必须为 problem、user 或 community')。结果是：从命令面板点击「查看全部结果」进入的完整搜索页必然显示错误态（asyncStatus=error），用户无法看到任何结果。useSearch 命令面板自身用三个独立端点（problem/user/community）避免了此问题，但跳转链接把 'all' 语义带到了只支持单类型查询的完整页。
- **证据**：`SearchPalette.vue:94  `:to="`/search?q=${encodeURIComponent(query)}&type=all`"`；search.vue:135 `params: { q, type: type.value, page: page.value, limit }`；后端 search.ts:65 `if (type !== "problem" && type !== "user" && type !== "community") throw new ValidationError(...)``
- **建议**：跳转时改用具体类型（如 type=problem 作为默认 tab），或在 search.vue 将 type='all' 归一化为 problem（并为 all 做三端点聚合展示），或后端补上对 type=all 的聚合支持。二者取其一，避免产生非法 type 请求。
- **验证**：SearchPalette.vue:94/209 跳转 `type=all`，search.vue:93 将 route.query.type 原样赋给 type.value、L138 原样传给后端；routes/search.ts:65-67 仅接受 problem/user/community，对 'all' 抛 ValidationError。点击『查看全部结果』必现错误态，真实正确性缺陷，维持『中』。

## 低

### NOJ-231 RefreshControl 100ms 定时器粒度过细
- **位置**：`noj-ui/components/admin/RefreshControl.vue:38-45`　**维度**：性能
- **描述**：管理后台「最近刷新」相对时间用 100ms 间隔刷新 now，每秒触发 10 次响应式更新。虽已隔离到单文本节点（沿用 LiveElapsed 修复思路），但显示粒度实际只需秒级，100ms 属过度刷新。
- **证据**：`nowTimer = setInterval(() => { now.value = Date.now() }, 100)`
- **建议**：将间隔放宽到 1000ms（相对时间显示无需毫秒精度），与页面其它时钟统一。
- **验证**：确认 RefreshControl.vue:41 setInterval 100ms（每秒 10 次响应式更新）属实。但 formatRelativeTime 用 toFixed(1)（0.1s 精度），100ms 与显示精度一致，属轻微性能偏好问题。维持低。

### NOJ-224 提交列表 problem 对象不含 runtime_config，最新评测卡片的时间/内存上限显示永不激活
- **位置**：`noj-ui/components/card/SubmissionCard.vue:34-44`　**维度**：正确性
- **描述**：SubmissionCard 通过 submission.problem.runtime_config.evaluator.time_limit_ms / memory_limit_mb 展示「用量/上限」及用量配色（line 34/38/44），hasRuntimeConfig（line 107）据此判空。但该组件仅被 LatestSubmissions.vue 使用，其数据来自 GET /api/v1/submissions 或 /submissions/public/recent，后端 listSubmissions 组装 problem 对象时只返回 {id, title}（noj-core/src/services/submissions-crud.ts:250-253），不含 runtime_config。因此 hasRuntimeConfig 恒为 false，永远走 else 分支（line 48-57），上限分母与用量配色功能静默失效（时间/内存数值本身仍能显示）。此外 LatestSubmissions.vue:46 本地类型声明 problem.memory_limit_mb 亦与后端不符。
- **证据**：`前端 SubmissionCard.vue:34 `submission.problem.runtime_config!.evaluator!.time_limit_ms`；后端 submissions-crud.ts:250-253 `problem: { id: row.problem_id, title: row.problem_title ?? "" }``
- **建议**：在 listSubmissions 的 SELECT 中 join problems.runtime_config（及 memory_limit 等）并纳入 problem 对象；或统一该卡片数据来源为详情接口，避免列表接口承载 runtime 信息。
- **验证**：submissions-crud.ts:250-253 listSubmissions 的 problem 对象仅含 {id,title}，不含 runtime_config；SubmissionCard.vue:107 hasRuntimeConfig 恒为 false，34/38/44 行的用量/上限分母与配色分支静默失效，时间/内存数值本身仍显示。属 UI 功能静默失效，无数据错误，从下调为低。

### NOJ-242 编程题编辑模式加载失败无重试入口
- **位置**：`noj-ui/components/editor/CodingProblemEditor.vue:240-242`　**维度**：UI可用性
- **描述**：编辑模式加载题目失败（loadError）时仅静态展示错误文案，没有『重试』按钮，用户只能整页刷新重试；notFound（题目不存在）分支同样无返回列表链接。与同项目其它页面（AsyncContent 自带重试）的交互不一致。
- **证据**：`<div v-else-if="isEditMode && loadError" class="text-center py-12 …">{{ loadError }}</div>`
- **建议**：在 loadError 分支提供『重试』按钮调用 loadProblem()，notFound 分支提供返回题目列表链接。
- **验证**：属实：CodingProblemEditor.vue:240-242 loadError 分支仅静态文案无重试按钮，230-232 notFound 分支无返回列表链接。维持「低」。

### NOJ-243 『评测命令』标注必填但校验未覆盖
- **位置**：`noj-ui/components/editor/CodingProblemEditor.vue:172-180,356`　**维度**：UI可用性
- **描述**：评测命令输入框 label 带红色星号『评测命令 *』（第 356 行），但 validate() 只校验 title/description/evaluatorImage/solutionImage，未校验 evaluatorCommand。用户清空该字段后前端仍放行提交，由后端拒绝，错误提示晚于预期且无字段级定位。
- **证据**：`function validate() { … if (!evaluatorImage.value.trim()) errors.evaluator_image = …; if (!solutionImage.value.trim()) errors.solution_image = …; } // 无 evaluatorCommand 校验，但 label 标注 *`
- **建议**：在 validate() 中补充 evaluatorCommand 非空校验，或移除 label 的必填星号以保持提示一致性。
- **验证**：CodingProblemEditor.vue:172-180 validate() 仅校验 title/description/evaluatorImage/solutionImage，未校验 evaluatorCommand；355 行 label 却带红色星号『评测命令 *』，清空后前端仍放行、由后端拒绝，提示与校验不一致，维持低。

### NOJ-229 Monaco 编辑器异步初始化存在卸载竞态
- **位置**：`noj-ui/components/editor/MonacoEditor.vue:38-94,116-127`　**维度**：性能
- **描述**：initMonaco 为 async（await import('monaco-editor') + fetch workers.json），若组件在动态 import 尚未 resolve 前被卸载，onUnmounted 执行时 editor 仍为 null（editor?.dispose() 为空操作），随后 import resolve 后 containerRef.value 已被清空，monaco.editor.create(null,...) 会抛异常（未捕获的 async 拒绝）。快速切换编辑器页面时可能产生异常与残留。
- **证据**：`monacoModule = await import("monaco-editor") ... editor = monaco.editor.create(containerRef.value, {...}) ... onUnmounted(() => { ... editor?.dispose() })`
- **建议**：在 initMonaco 内增加卸载守卫（如 let disposed = false，onUnmounted 置 true，import 完成后先判断 disposed 再 create），或使用 AbortController 取消。
- **验证**：initMonaco 为 async，await import('monaco-editor') 前无卸载守卫（MonacoEditor.vue:38-63）；onUnmounted 时 editor 为 null、editor?.dispose() 空操作，import resolve 后 containerRef.value 已清空，monaco.editor.create(null) 抛未捕获拒绝。竞态逻辑成立，快速切页可触发，维持『低』。

### NOJ-244 客观题编辑模式套卷加载失败无重试（@retry 未接线）
- **位置**：`noj-ui/components/objective/ObjectiveProblemEditor.vue:282-286`　**维度**：UI可用性
- **描述**：编辑模式 AsyncContent 的 status 在 paperError 时为 'error'，error 文案『套卷加载失败』已提供，但未绑定 @retry 处理器。AsyncContent 默认错误插槽会渲染『重试』按钮并 emit retry 事件，因无监听，点击重试没有任何效果，用户只能刷新页面。
- **证据**：`<AsyncContent v-else :status="paperError ? 'error' : paper ? 'data' : 'loading'" error="套卷加载失败">  // 无 @retry`
- **建议**：补充 @retry 回调（如重新触发 useFetch 的 refresh，或刷新 paperData）。
- **验证**：确认 ObjectiveProblemEditor.vue L282-286 AsyncContent 在 paperError 时 status='error' 但未绑定 @retry 处理器，默认错误插槽的'重试'按钮点击无效果，只能刷新，维持低。

### NOJ-213 useMessages 未读计数方法注释声明「返回 0」但实际重抛，与行为不符
- **位置**：`noj-ui/composables/useMessages.ts:88-108`　**维度**：正确性
- **描述**：fetchUnreadCount() / fetchUnreadCountByConversation() 的 JSDoc 均写「轮询失败不弹窗，返回 0」，但函数体只有 `{ silent: true }`，没有 try/catch，也没有失败时返回 0 的分支——silent 只抑制 toast，异常仍会向上抛出。一旦未来有调用方按注释期望「失败返回 0」而不捕获，将产生 unhandled rejection。当前这两个方法实际无调用方（UserMenu 自行内联实现了同款轮询并自带 try/catch），属潜在缺陷。
- **证据**：`useMessages.ts:88-94 `async function fetchUnreadCount(): Promise<number> { const res = await api.get(... { silent: true }); return res.unread_count; }` —— 无 catch、无 0 兜底。`
- **建议**：补充 try/catch 并在失败时 return 0（与注释一致），或删除注释中「返回 0」的表述；同时可消除与 UserMenu 内联轮询的重复实现。
- **验证**：useMessages.ts:88-108 fetchUnreadCount/fetchUnreadCountByConversation 的 JSDoc 写「失败返回 0」，但函数体仅 { silent:true } 无 try/catch 无 0 兜底，silent 只抑制 toast，异常仍上抛。注释与实现不符真实，维持低。

### NOJ-241 hasActiveFilters 遗漏类型筛选，仅按类型筛选时空态文案错误
- **位置**：`noj-ui/composables/useProblemFilters.ts:22`　**维度**：UI可用性
- **描述**：hasActiveFilters 只判断 keyword/difficulty/categoryId，遗漏 problemType。用户仅按『类型=用户题库(U)』筛选且无结果时，problems.vue 的空态会显示通用的『暂无题目』且不显示『清除筛选』按钮（该按钮 v-if="hasActiveFilters"），误导用户以为题库为空。
- **证据**：`const hasActiveFilters = computed(() => !!keyword.value \|\| !!difficulty.value \|\| !!categoryId.value); // 缺 problemType`
- **建议**：将 problemType.value 纳入 hasActiveFilters 判断。
- **验证**：核实成立。useProblemFilters.ts:22 hasActiveFilters 只判断 keyword/difficulty/categoryId，遗漏 problemType(17 行存在)；仅按类型筛选且无结果时，problems.vue 空态走「暂无题目」且 v-if="hasActiveFilters" 的清除筛选按钮不显示，误导用户以为题库为空。UI 可用性小缺陷，维持低。

### NOJ-216 admin/community-moderation 守卫仅信任可伪造的 noj:session cookie，未复核 /auth/me
- **位置**：`noj-ui/middleware/admin.ts:29-32`　**维度**：安全
- **描述**：admin 守卫对 isAdminUser(user.value) 的判定完全依赖 noj:session（httpOnly:false，客户端可改写）恢复出的 user 状态，且不调用 fetchUser() 向 /auth/me 复核——与 auth.ts 在 user.created_at 为空时强制补拉 /auth/me 的做法不一致。后果：用户篡改 cookie 的 is_admin/role 字段，或管理员权限（admin:full_access）被撤销后（cookie 仍是旧值），仍能看到管理后台 UI 外壳与侧边栏，属于前端误导性越权显示。真正数据访问仍由 core 的 requireAdmin/requirePermission 拦截（403），因此不是真实越权，但守卫与 auth 守卫的复核策略不一致、且放大了 UI 误导。community-moderation.ts:29 的 isAdminUser 快速放行分支存在同样问题（其非管理员路径反而会调 /community/config 复核，唯独 admin 快速路径不复核）。
- **证据**：`if (!isAdminUser(user.value)) {
  return navigateTo('/');
}
// user.value 来自 useCookie('noj:session')（httpOnly:false）恢复，未经 /auth/me 复核`
- **建议**：在 admin/community-moderation 守卫中，与 auth.ts 一致：当 user.created_at 为空（即状态来自 session cookie 而非 /auth/me）时先 await fetchUser() 复核，再据后端返回的 is_admin 判定；使前端守卫的判定依据与后端 RBAC 结果一致。
- **验证**：admin.ts:29-32 与 community-moderation.ts:29 均直接 isAdminUser(user.value) 放行/拦截，不复核 /auth/me；user 可由 httpOnly:false 的 noj:session cookie 恢复（useAuth.ts sessionToUser 令 created_at=''，is_admin 取自 cookie）。与 auth.ts 守卫在 created_at 缺失时强制 fetchUser（auth.ts:51-53）不一致。但真实数据访问被 core requireAdmin/requirePermission 拦为 403，仅为前端误导性显示外壳，降为低。

### NOJ-217 auth 守卫在 fetchUser 失败/5s 超时时放行，且 useAuthReady 超时为死代码
- **位置**：`noj-ui/middleware/auth.ts:45-61`　**维度**：正确
- **描述**：守卫先以 isLoggedIn（基于 session cookie，初始为 true）通过首检，随后仅当 user.created_at 为空时 await fetchUser()。fetchUser 内部对 /auth/me 用 5s 超时，失败时 catch → logout()（将 user.value 置空并清 cookie）→ 返回 null。守卫在 fetchUser 返回后未再复查 isLoggedIn，直接落到 must_change_password 判断（user 已为 null 故跳过）并 return，导航被放行——即后端不可达/令牌失效时，受保护页面会以未登录态继续渲染，而非重定向 /login（未实现 fail-closed）。此外 useAuthReady 的 5s 超时兜底实为死代码：useAuth.ts 在初始化时同步 loading.value=false（第 57、66 行），故 useAuthReady 总是立即返回，真正的网络等待只发生在 fetchUser 内部。
- **证据**：`if (user.value && !user.value.created_at) {
  await fetchUser();  // 失败时内部 logout() 清空 user
}
// 之后未再检查 isLoggedIn，直接放行`
- **建议**：fetchUser() 后重新检查 isLoggedIn（或检查 fetchUser 返回值），失败/超时返回 navigateTo('/login')；并修正 useAuthReady/loading 的语义，使守卫在认证未就绪时真正等待或 fail-closed。
- **验证**：核实成立。useAuth.ts:57/66 在初始化同步 loading.value=false(useAuthReady 5s 超时实为死代码)；middleware/auth.ts:51-53 fetchUser 后未复查 isLoggedIn，fetchUser 失败内部 logout()(useAuth.ts:120-123)清空 user 后守卫仍直接放行。属 fail-open 真实性成立，但受保护数据仍由后端强制鉴权(API 401)，无数据泄露，仅 UX 层(未重定向 /login、以未登录态渲染)，故由中下调为低。

### NOJ-226 /api/v1/users/search 不返回 email，管理后台却渲染并提示按邮箱搜索
- **位置**：`noj-ui/pages/admin/contests.vue:155-159`　**维度**：正确性
- **描述**：管理后台参与者搜索将响应类型声明为 UserSearchResult {id, username, email}（line 155-159），模板 line 246 渲染 {{ user.email }}，且搜索框占位提示『搜索用户名或邮箱』。但后端 searchUsers（noj-core/src/services/users.ts:292-324）仅返回 {id, username, avatar_url, created_at} 且只用 username ILIKE 匹配，既无 email 字段也不支持按邮箱搜索。后果：每条搜索结果旁边 email 恒为空字符串；「按邮箱搜索」提示具有误导性（实际搜不到邮箱）。
- **证据**：`前端 admin/contests.vue:246 `<span class="ml-2 text-text-muted">{{ user.email }}</span>`；后端 users.ts:309-314 select 仅 {id, username, avatar_url, created_at}`
- **建议**：若需按邮箱搜索，扩展后端 searchUsers 返回 email 并将匹配条件加入 email ILIKE；否则移除前端 email 字段渲染与「邮箱」占位提示，仅保留用户名搜索。
- **验证**：admin/contests.vue:155-159 声明 UserSearchResult{id,username,email}、246 行渲染 {{user.email}} 且占位提示『搜索用户名或邮箱』；而 users.ts:309-314 searchUsers 仅返回 {id,username,avatar_url,created_at} 且只用 username ILIKE 匹配，email 恒为空、按邮箱搜索无效，维持低。

### NOJ-230 社区列表 stripMarkdown 全量重算且「加载更多」无上限
- **位置**：`noj-ui/pages/community/index.vue:363-374`　**维度**：性能
- **描述**：帖子列表采用游标式「加载更多」，posts 无限追加、无虚拟滚动；模板内对每一条 post 内容调用 stripMarkdown(item.post.content)。每次追加（或 loadingMore 切换）都会对已加载的全部帖子重新执行 stripMarkdown，长会话下呈 O(N²) 增长。
- **证据**：`<article v-for="item in posts" :key="item.post.id" ...>{{ stripMarkdown(item.post.content) }}</article>`
- **建议**：在 loadPosts 时将 stripMarkdown 结果预计算为字段存储（只处理新增项），或对超长列表引入虚拟滚动/固定分页上限。
- **验证**：核实 community/index.vue:364-373 `v-for` 内直接调用 stripMarkdown(item.post.content)，游标无限追加、无虚拟滚动，每次重渲染全量重算呈 O(N²)。属实，维持低。

### NOJ-218 401 统一跳转的 redirect 回跳目标未被 login 页消费
- **位置**：`noj-ui/pages/login.vue:109-115`　**维度**：正确
- **描述**：useApi.ts:67-68 在 401 时 navigateTo({ path:'/login', query:{ redirect: route.fullPath } }) 携带回跳目标；但 login.vue 的 handleLogin 成功后无条件 router.replace('/')（或 '/change-password'），从不读取 route.query.redirect，也从未把 redirect 拼入跳转。结果是用户会话过期被弹到登录页后，重新登录总是回到首页而非原访问页，与 useApi 注释宣称的「携带回跳目标」不符。
- **证据**：`const redirect = route.fullPath;
navigateTo({ path: '/login', query: { redirect } });  // useApi.ts:67-68
// login.vue handleLogin：
router.replace('/');   // 忽略 route.query.redirect`
- **建议**：在 login.vue 成功后读取 route.query.redirect，存在且为站内安全路径（以 / 开头、非 // 开头）时 replace(redirect)，否则回退 '/'；改密分支也按需保留 redirect。
- **验证**：属实：useApi.ts 401 时 navigateTo 携带 redirect query，但 login.vue handleLogin（109-115）成功后无条件 router.replace('/') 或 '/change-password'，从不读取 route.query.redirect。回跳目标未被消费，属会话过期后的体验缺陷，由「中」下调「低」。

### NOJ-211 私信页切换会话存在竞态，旧会话响应覆盖新会话消息
- **位置**：`noj-ui/pages/messages/index.vue:51-68, 130-145`　**维度**：正确性
- **描述**：loadMessages() 与 fetchOtherUserName() 是异步函数，await 返回后直接写入 messages/currentPage/totalPages/otherUserName，均未校验 selectedConversationId 是否仍是发起请求时的值。用户快速切换会话 A→B 时，A 的较慢响应可能在 B 之后返回，把 A 的消息列表覆盖到已选中 B 的界面上（数据错显）；fetchOtherUserName 也会把 A 的对方昵称写到 B 的顶栏。SSE 的 message:new 分支（line 120）与 fetchFn（line 125）有 conversation_id 守卫，但 onSelect 触发的首屏加载路径没有。
- **证据**：`messages/index.vue:55-62 `const result = await fetchMessages(...)` 后直接 `messages.value = ...; currentPage.value = ...; totalPages.value = ...`，无 id 校验；130-145 onSelect 未对在途请求做失效处理。`
- **建议**：引入「当前会话请求版本号」（每次 onSelect 递增），await 返回后校验版本一致才写入；或对每个会话缓存各自消息，切换时按选中 id 渲染，避免跨会话覆盖。
- **验证**：确认竞态存在，但下调为低。loadMessages(51-68) 与 fetchOtherUserName(35-48) await 后直接写 messages/otherUserName，不校验 selectedConversationId 是否变化；onSelect(130-145) 对在途请求无失效处理，快速 A→B 切换可致 A 的慢响应覆盖 B 视图。SSE message:new(120) 确有 conversation_id 守卫。但 send() 用 selectedConversationId 正确、仅为瞬时显示错乱、下次交互自愈，无数据损坏/安全影响，降低。

### NOJ-223 题目列表接口不返回 acceptance_rate，通过率列永远显示"--"
- **位置**：`noj-ui/pages/problems.vue:236`　**维度**：正确性
- **描述**：前端题库页模板通过 formatAcceptanceRate(row.original.acceptance_rate) 渲染「通过率」列（line 140 定义列、line 236 取值），但后端 GET /api/v1/problems 的列表项 toProblemResponse（noj-core/src/services/problems-list.ts:48-67）与 ProblemResponse 类型（noj-core/src/services/problems-types.ts:22-38）均不含 acceptance_rate 字段。后端列表服务 problems-list.ts 只做 select() 原行 + attachCategories，从不计算通过率。由于 formatAcceptanceRate(undefined) 返回 '--'（noj-ui/utils/submissionFormat.ts:223-226），该列静默降级为永久 '--'，功能静默失效。
- **证据**：`前端 problems.vue:236 `{{ formatAcceptanceRate(row.original.acceptance_rate) }}`；后端 toProblemResponse 返回 {id,title,description,difficulty,support_package_storage_url,has_support_package,runtime_config,number,owner_id,type,is_objective,display_id,created_at,updated_at} —— 无 acceptance_rate`
- **建议**：在 listProblems 的列表查询中 LEFT JOIN evaluation_results 按题目聚合通过率（accepted/total），或在 toProblemResponse 增加 acceptance_rate 字段；若短期不实现，应从模板移除该列或明确降级文案，避免误导。
- **验证**：problems.vue:236 渲染 formatAcceptanceRate(row.original.acceptance_rate)；后端 problems-list.ts toProblemResponse(48-67) 与 ProblemResponse(problems-types.ts:22-38) 均无 acceptance_rate，listProblems 只 select()+attachCategories 从不计算。submissionFormat.ts:224 rate==null 返回 '--'，列永久显示 '--'。功能静默失效属实，但仅为展示列占位、无数据/安全影响，『高』明显高估，下调为低。

### NOJ-228 题目列表页为标记已做状态拉取 100 条提交记录
- **位置**：`noj-ui/pages/problems.vue:81-103`　**维度**：性能
- **描述**：登录用户每次进入题库页，fetchUserProblemStatus 请求 /api/v1/submissions?per_page=100，用整页完整提交对象（含 code 之外字段）只为构建 solvedIds/attemptedIds 两个 Set。请求体积偏大且 per_page=100 存在截断（超过 100 条提交时标记不完整），属功能与性能双重缺陷。
- **证据**：`query: { per_page: 100 } ... for (const s of subs) { if (s.result?.score != null && s.result.score >= 100) solved.add(s.problem_id) ... }`
- **建议**：使用后端专用端点（如 /api/v1/submissions/solved-ids 仅返回 problem_id 列表），或降低 per_page 并分页，避免一次性拉取完整提交对象。
- **验证**：确认 problems.vue L81-85 拉取 /api/v1/submissions?per_page=100 并遍历完整提交对象仅构建 solved/attempted 两个 Set，请求偏大且 >100 条提交时标记不完整，功能与性能双重缺陷，维持低。

### NOJ-238 URL 页码越界未钳制，越界页展示误导性空态
- **位置**：`noj-ui/pages/problems.vue:173-176`　**维度**：UI可用性
- **描述**：页码直接取自 URL（useProblemFilters.ts:12 `Number(route.query.page) || 1`，仅保证 ≥1 下限，不校验 ≤ totalPages 上限）。用户访问 /problems?page=99 时会请求第 99 页，后端返回空数组，页面落入空态显示『暂无题目』（误导——并非没有题目，只是页码越界），且 PaginationNav 的 :page 超出 :total 会渲染异常。ranking.vue（12-16 行仅钳制 page≥1）、search.vue（94 行 page 直取 URL）存在同样问题。
- **证据**：`const page = computed(() => Number(route.query.page) \|\| 1); // 无上限钳制 … :empty-text="hasActiveFilters ? '…' : '暂无题目'"`
- **建议**：对 page 做 `Math.min(page, totalPages)` 钳制或在越界时自动重定向到最后一页，越界空页应提示『页码超出范围』而非『暂无数据』。
- **验证**：useProblemFilters.ts:12 `Number(route.query.page)||1` 无上限钳制；后端 problems-list.ts:112 仅 Math.max(1,page) 同样无上限，page=99 返回空数组、页面落入空态。属实，保留低。

### NOJ-212 problems/[id].vue 直接使用 $fetch 绕过 useApi 统一层（无错误映射/401 跳转/超时）
- **位置**：`noj-ui/pages/problems/[id].vue:69-79`　**维度**：正确性
- **描述**：题解列表与发布资格通过原生 $fetch 直接请求 /api/v1/community/posts 与 /api/v1/community/solutions/eligibility，违反「业务代码禁止直接 $fetch、统一走 useApi」的约定。后果：这些请求不经过 useApi 的错误处理（无统一 401 跳转、无 HTTP 错误码映射、无 timeout），且 watch(problem, { immediate: true }) 会在 SSR 与客户端各执行一次（SSR 端无 cookie 大概率 401/403 空返回、客户端再拉一次，形成双跑）。当前靠外层 try/catch 静默吞错兜底，掩盖了真实失败原因。
- **证据**：`problems/[id].vue:70-71 `$fetch<{ data: PostRow[] }>(`/api/v1/community/posts?type=solution&problem_id=${p.id}&limit=5`)`；78-80 `$fetch(.../solutions/eligibility...)`；均未走 useApi。`
- **建议**：改用 useApi().api.get（并显式 silent:true），统一错误语义与超时；SSR 端可加 import.meta.server 守卫避免无效双跑，或改用 useAsyncData 复用服务端结果。
- **验证**：确认。problems/[id].vue:70-72、78-80 用裸 $fetch 请求 /api/v1/community/posts 与 /solutions/eligibility，违反『业务代码禁止直接 $fetch、统一走 useApi』约定；watch(problem,{immediate:true})(63-97) 在 SSR 与客户端各执行一次形成双跑，错误仅靠 try/catch 吞掉，属实。

### NOJ-221 401 处理遗漏：直接 $fetch 绕过 useApi 的页面与守卫
- **位置**：`noj-ui/pages/problems/[id].vue:70-84`　**维度**：正确
- **描述**：problems/[id].vue 的题解/资格查询直接用 $fetch（第 70、78 行），绕过 useApi，故 401 不会触发统一跳转（静默降级为空列表）；community-moderation.ts:33 也直接用 $fetch 调 /community/config，令牌过期时 401 被 catch 当作「无权限」处理，重定向到 '/' 而非 '/login'。二者均属近期 401 统一跳转的遗漏路径。
- **证据**：`$fetch<{ data: PostRow[] }>(`/api/v1/community/posts?...`);
const el = await $fetch<...>(`/api/v1/community/solutions/eligibility?...`);`
- **建议**：统一改走 useApi().api.get（题解区可用 silent:true 保留静默降级），或在守卫内区分 401 与 403 分别跳 /login 与 /。
- **验证**：属实：problems/[id].vue:70/78 直接用 $fetch 绕开 useApi，401 被 catch 静默降级为空列表，不触发统一登录跳转；属 401 统一跳转的遗漏路径。维持「低」。

### NOJ-239 题解加载失败静默降级为误导性『暂无题解』
- **位置**：`noj-ui/pages/problems/[id].vue:63-97,276-278`　**维度**：UI可用性
- **描述**：题解列表用裸 $fetch 拉取，catch 分支吞掉所有错误（含网络超时、500），统一置 solutions=[]，模板渲染『暂无题解，来发布第一篇吧。』。网络故障/后端异常时用户被误导为『没有题解』，且无重试入口；注释仅声明处理 403/401 降级，实际也吞掉了 5xx 与网络错误。
- **证据**：`catch { solutions.value = []; eligibility.value = null } … <div v-else-if="solutions.length === 0">…暂无题解，来发布第一篇吧。`
- **建议**：区分错误态与真空态：加载失败显示错误提示+重试，仅在明确返回空列表时显示『暂无题解』。
- **验证**：确认。problems/[id].vue:88-91 catch 吞掉所有错误（含 5xx/网络超时）统一置 solutions=[]，模板 276-278 渲染『暂无题解，来发布第一篇吧。』，把加载失败与真空态混淆且无重试入口，属实（UX 问题）。

### NOJ-208 search.vue 无请求竞态防护，快速输入/切换类型时过期响应覆盖新结果
- **位置**：`noj-ui/pages/search.vue:121-156, 187-197`　**维度**：正确性
- **描述**：fetchResults() 是纯 async 函数，无 requestSeq/AbortController 防护；watch(query)（line 187-197）在每次输入（无防抖）即触发 fetchResults，onSearch/setType/setPage 也直接调用。当用户快速输入「abc→ab」或快速切换类型/翻页时，先发出的慢请求可能晚于后发出的请求返回，直接把过期的 items/total/tookMs 覆盖到当前结果上，造成结果与输入不一致（数据错显）。同文件所属 useSearch.ts 命令面板已用 requestSeq 防护，但完整结果页未复用同一机制。
- **证据**：`search.vue:135 `const res = await api.get("/api/v1/search", { params: { q, type, page, limit }, silent: true })`；随后 145-147 直接 `items.value = data.items; total.value = data.total`，无任何序号校验；watch(query) 无 debounce、无取消。`
- **建议**：引入自增请求序号（或 AbortController），在 await 返回后校验仍为最新请求再写入 items/total，过期则丢弃；对输入可选加防抖或与 useSearch 共用状态。
- **验证**：核实 search.vue:121-156 fetchResults 无 requestSeq/AbortController，watch(query) 无防抖；useSearch 已有 requestSeq 防护但本页未复用。竞态属实，但仅致结果错显、下次输入自愈，无安全/数据完整性影响，中→低。

### NOJ-240 个人主页关注按钮状态未初始化，标签与实际操作可能相反
- **位置**：`noj-ui/pages/users/[id].vue:103,153-157,202`　**维度**：UI可用性
- **描述**：following 初始化为 ref(false)，页面加载时从未从后端读取当前用户是否已关注该用户（profile 接口的 community_stats 无 is_following 字段，也无额外关注态请求）。因此若用户此前已关注，按钮仍显示『关注』，而点击会触发 toggle 端点执行的是『取消关注』——标签与实际动作方向相反，可能造成误取消关注。
- **证据**：`const following = ref(false) … async function toggleFollow() { const result = await api.post(.../follow); following.value = result.data.following } // 无 onMounted 初始化关注态`
- **建议**：加载页面时获取当前用户的关注状态（如 GET /community/users/:id/follow-status）初始化 following，或让 follow 端点返回语义明确的字段。
- **验证**：users/[id].vue:103 following=ref(false)，全文件无 onMounted/接口初始化关注态（profile 的 community_stats 仅 following_count/follower_count，无 is_following，:47）；仅 :153-157 toggleFollow 在点击后写 following.value。已关注用户会显示「关注」且点击实际执行取消关注，标签与动作相反真实，维持低。

### NOJ-108 认证 Cookie 属性与 cookie-auth 规范不符（SameSite=Strict→lax，Path=/api→/）
- **位置**：`noj-ui/server/api/[...slug].ts:88-95`　**维度**：规范符合性
- **描述**：cookie-auth 规范（openspec/specs/cookie-auth/spec.md L85-90、L32-33）要求 noj:token 为 `HttpOnly; Path=/api; SameSite=Strict; Secure`，noj:session 为 `Path=/; SameSite=Strict`。实现中 cookieOptions 对两个 cookie 统一使用 `sameSite: 'lax'` 与 `path: '/'`，即 SameSite 从 Strict 降级为 lax、token 的 Path 从 /api 放宽为 /。
- **证据**：`规范：cookie-auth/spec.md L89 `noj:token: HttpOnly; Path=/api; SameSite=Strict`；实现：[...slug].ts L90 `sameSite: 'lax'`、L91 `path: '/'`，且 token/session 共用该配置（L98、L103-118）。`
- **建议**：按规范将 noj:token 设为 SameSite=Strict、Path=/api（或明确修订规范为 lax+/ 并同步文档），避免 CSRF 缓解强度与 cookie 作用域比规范更宽松。
- **验证**：实现 [...slug].ts L90 sameSite:'lax'、L91 path:'/'，与 cookie-auth/spec.md 要求的 SameSite=Strict、Path=/api 确实不符，规范漂移成立。但 AGENTS.md §11.7 已声明 lax 为设计取舍（无 CSRF token，依赖 sameSite），且 token 为 HttpOnly、同源注入 Authorization，lax 与 Strict 对 CSRF 的实际差异及 Path 放宽的可利用性都很小，安全影响有限，主要属规范/文档不一致，故由高下调为低。

### NOJ-011 noj:session 可读 Cookie 暴露邮箱等 PII（httpOnly:false）
- **位置**：`noj-ui/server/api/[...slug].ts:103-118`　**维度**：安全
- **描述**：登录/改密成功后设置可读 Cookie noj:session，httpOnly:false，内容含 userId、username、role、email、must_change_password、is_admin。令牌本体在 httpOnly 的 noj:token 中（安全），但任何 XSS 均可读取邮箱、userId、角色等 PII 与登录态字段；前端 admin 守卫信任该 cookie 的 is_admin 仅用于 UI 展示，后端仍实时校验，故风险有限。
- **证据**：`setCookie(event, 'noj:session', JSON.stringify({ userId: user.id, username, role, email, must_change_password, is_admin }), { ...cookieOptions, httpOnly: false });`
- **建议**：精简 noj:session 内容（移除 email，或仅保留登录态布尔 + must_change_password），减少可读面；email 等 PII 改为通过受保护的 /auth/me 获取。
- **验证**：真阳性。registerUser（auth.ts:114-159）直接 INSERT 用户并返回，无邮箱验证链接/验证码/email_verified 状态，schema 无 email_verified 列。维持低。

## 信息

### NOJ-247 编辑器工具栏与工作区移动端无响应式适配
- **位置**：`noj-ui/components/editor/EditorToolbar.vue:82-167`　**维度**：UI可用性
- **描述**：工具栏为单行 flex 且无 flex-wrap/overflow-x-auto，容纳返回、标题、保存状态、语言选择、主题、侧栏、设置、提交等 8+ 控件；配合 EditorWorkspace 的固定侧栏（ResizableSplitter min=240px）与 h-screen 满屏布局，在窄屏（手机）下工具栏控件会被挤压/溢出、侧栏占用大半屏导致 Monaco 编辑区仅剩极小宽度，明显不可用。编辑页虽为桌面优先工具，但当前完全无 sm 断点降级。
- **证据**：`<div class="h-12 flex-shrink-0 … flex items-center px-3 gap-3"> … <div class="flex-1" /> … 多个按钮无响应式隐藏`
- **建议**：窄屏下隐藏次要按钮（保存状态/主题/设置收纳进菜单）、侧栏在移动端默认收起或改为抽屉，主编辑区保证最小可读宽度。
- **验证**：核实成立。EditorToolbar.vue:82-167 工具栏为单行 flex(h-12 flex-shrink-0 ... flex items-center px-3 gap-3)无 flex-wrap/overflow-x-auto，容纳返回+标题+徽标+保存状态+语言选择(min-w-[110px])+主题+侧栏+设置+提交 8+ 控件；仅 draftLabel 有 hidden sm:inline(117 行)，窄屏下控件溢出、侧栏+编辑区挤压。编辑页桌面优先工具，无 sm 断点降级，UI 可用性观察，维持信息。

### NOJ-246 编辑器模板加载错误 templateError 永不展示（死代码）
- **位置**：`noj-ui/components/editor/EditorWorkspace.vue:180-184,239`　**维度**：UI可用性
- **描述**：模板加载失败时（非 404）设置 templateError，但 templateError 只在『题目加载失败』错误分支（v-else-if="error || !problem"）中作为兜底文案展示；而模板加载的 watch 前置条件是 props.problem 存在（if (!p) return），因此当该错误分支可见时 templateError 必然为空字符串。结果：模板拉取失败对用户完全无感知（silent: true 不弹 toast，且错误分支不展示）。
- **证据**：`catch (e) { if (err.statusCode !== 404) templateError.value = extractApiError(e).message } … <p class="text-sm">{{ templateError \|\| '题目加载失败' }}</p>`
- **建议**：将 templateError 在正常状态下（编辑器区域或侧栏）单独展示，或直接对非 404 模板错误弹 toast/内联提示。
- **验证**：EditorWorkspace.vue:182-183 非 404 时写 templateError，但 :239 仅在 v-else-if="error || !problem" 分支展示；而模板加载 watch 前置条件 if (!p) return（:162）保证该分支可见时 templateError 必为空串。模板拉取失败对用户无感知，死代码真实，维持信息。

### NOJ-233 StatsToggle 5s 切换触发计数器反复 rAF 动画
- **位置**：`noj-ui/components/feature/StatsToggle.vue:45-51`　**维度**：性能
- **描述**：首页「最新评测」卡片的统计数字每 5 秒在「今天/总共」间切换，每次切换触发 3 个 AnimatedCounter 执行 1500ms 的 requestAnimationFrame 数字动画；叠加 SSE 每次 stats:updated 更新 value 也会重启动画。评测活跃期首页会产生近乎持续的 rAF 渲染，虽已隔离但属可避免的动画开销。
- **证据**：`modeTimer = setInterval(() => { mode.value = mode.value === 'today' ? 'total' : 'today' }, 5000)  // 配合 <AnimatedCounter :value="stats.total" ...>`
- **建议**：仅在数字实际变化时重启动画（AnimatedCounter 已按 value 变化触发），或将切换间隔放宽、关闭循环切换。
- **验证**：确认 StatsToggle.vue:47-50 每 5s 切换 today/total，stats 计算属性随 mode 切换导致 3 个 AnimatedCounter 的 value 变化重启动画，叠加 SSE 更新，评测活跃期存在近持续 rAF 动画开销。维持信息。

### NOJ-245 删除套卷/小题使用原生 confirm()，与全局 useDialog 不一致
- **位置**：`noj-ui/components/objective/ObjectiveProblemEditor.vue:120,240`　**维度**：UI可用性
- **描述**：onDeletePaper 与 onDeleteQuestion 使用浏览器原生 window.confirm()，而项目其余破坏性操作统一走 useDialog().dialog.confirm（样式化模态，danger 态红色按钮）。原生 confirm 视觉风格突兀、在部分嵌入/受限环境中可能被拦截，且与设计规范（CLAUDE.md『弹窗基于 Nuxt UI，已移除 SweetAlert2』）不一致。
- **证据**：`if (!confirm('确定删除该套卷？其下全部小题与提交记录将一并删除。')) return`
- **建议**：改用 useDialog().dialog.confirm(..., { danger: true }) 统一确认交互。
- **验证**：确认。ObjectiveProblemEditor.vue:120 与 240 均用 window.confirm()（onDeletePaper/onDeleteQuestion），与项目其余破坏性操作走 useDialog().dialog.confirm 的规范不一致，属 UI 一致性/可用性问题。

### NOJ-214 useEventSource 的 fallback 轮询无防重入，慢请求可能并发重叠
- **位置**：`noj-ui/composables/useEventSource.ts:110-126`　**维度**：正确性
- **描述**：startFallback() 用 setInterval 直接调用 fetchFn()，没有像 usePolling.ts 那样的 inFlight 防重入。若 fetchFn（如 queue.vue / messages 的 GET 刷新）单次耗时超过 fallbackIntervalMs（queue 为 2000ms、messages 为 3000ms），多轮请求会并发执行，可能以乱序写回 data/messages。对幂等 GET 影响有限，但语义上与项目内 usePolling 的「防重入」约定不一致，且增大后端压力。
- **证据**：`useEventSource.ts:121-125 `fallbackTimer = setInterval(() => { if (fetchFn) { fetchFn(); } }, fallbackIntervalMs)` —— 无 in-flight 标记。`
- **建议**：参照 usePolling 引入 inFlight 标记，上一轮未完成则跳过本轮；或对 fetchFn 返回值做 Promise 跟踪。
- **验证**：确认 useEventSource.ts L121-125 startFallback 用 setInterval 直接调 fetchFn()，无 inFlight 防重入；若单次请求超过 fallbackIntervalMs 会并发重叠（幂等 GET 影响有限），与 usePolling 约定不一致，维持信息。

### NOJ-234 客户端图标集合全量打包（潜在 bundle 膨胀）
- **位置**：`noj-ui/nuxt.config.ts:11-18`　**维度**：性能
- **描述**：@nuxt/icon 配置为 clientBundle: { scan: true, collections: ['lucide'], includeAllCollections: true }。scan 本可只打包用到的图标，但 includeAllCollections: true 可能覆盖按需扫描、将整个 lucide 集合（约千余图标）打入客户端 bundle，增加首屏 JS 体积。
- **证据**：`icon: { serverBundle: 'local', clientBundle: { scan: true, collections: ['lucide'], includeAllCollections: true } }`
- **建议**：移除 includeAllCollections: true，仅保留 scan: true 按需打包；构建后检查 .output/public/_nuxt 的 JS 体积确认 tree-shaking 生效。
- **验证**：nuxt.config.ts:11-18 clientBundle 确含 includeAllCollections:true + scan:true，配置事实属实；但『可能覆盖按需打包』为未实测的性能推测，保留信息。

### NOJ-232 首页多路 SSE + 轮询并发常驻
- **位置**：`noj-ui/pages/index.vue:161-169`　**维度**：性能
- **描述**：登录用户停留在首页时，同时存在：Navbar 社区通知 SSE（Navbar.vue:129-137，fallback 30s）、UserMenu 会话未读 30s 轮询（UserMenu.vue:110-125）、首页公告 SSE（index.vue:161-169，fallback 60s）、最新评测 SSE（LatestSubmissions.vue:150-163，fallback 10s）。即 3 条 SSE 长连接 + 1 个 interval 轮询并存，每条均轻量但连接/请求数量偏多。
- **证据**：`useEventSource({ url: "/api/v1/announcements/events", ... fallbackIntervalMs: 60000 })  // 与 Navbar/UserMenu/LatestSubmissions 的 SSE 与轮询并存`
- **建议**：评估是否可将公告/通知/评测统一到单一 SSE 通道或合并轮询，减少并发连接数。
- **验证**：核实 index.vue:161 useEventSource(公告 SSE, fallback 60s) 属实；与 Navbar 社区通知 SSE、UserMenu 轮询、LatestSubmissions SSE 并存属设计观察，无正确性/安全问题，维持信息。

### NOJ-222 Cookie maxAge 硬编码 24h，与可配置的 JWT_EXPIRES_IN 可能不一致
- **位置**：`noj-ui/server/api/[...slug].ts:92`　**维度**：正确
- **描述**：代理与 useAuth 的 useCookie 均硬编码 maxAge:60*60*24，注释称「与 JWT_EXPIRES_IN 一致」但未从配置读取。若后端 JWT_EXPIRES_IN 调大（如 7d），cookie 会先于 JWT 到期造成提前登出；调小则 cookie 残留至下次 /auth/me 401 才被清。属一致性问题而非直接漏洞。
- **证据**：`maxAge: 60 * 60 * 24, // 24h，与 JWT_EXPIRES_IN 一致`
- **建议**：通过 runtimeConfig 暴露并读取 JWT 有效期，使 cookie maxAge 与后端 JWT_EXPIRES_IN 同源，避免二者漂移。
- **验证**：[...slug].ts:92 硬编码 `maxAge: 60*60*24` 且注释称与 JWT_EXPIRES_IN 一致，但未从 runtimeConfig 读取，JWT 有效期调大/调小时 cookie 与后端漂移，属一致性问题，维持『信息』。

### NOJ-219 注销 deleteCookie 未匹配 secure/sameSite 属性
- **位置**：`noj-ui/server/api/auth/logout.post.ts:33-38`　**维度**：安全
- **描述**：登录/改密时 setCookie 对 noj:token 使用 secure:isProductionEnv()、sameSite:'lax'（[...slug].ts:88-95）；注销时 deleteCookie 仅传 path:'/'，未匹配 secure/sameSite。HTTPS 下浏览器按 name+domain+path 匹配仍能清除（Secure 不参与身份匹配），但属性不一致属脆弱写法：若部署经 HTTP 或反向代理终止 TLS 等场景，带 Secure 的 cookie 可能无法被无 Secure 的删除指令覆盖，导致登出后令牌残留。
- **证据**：`deleteCookie(event, 'noj:token', { path: '/' });
deleteCookie(event, 'noj:session', { path: '/' });`
- **建议**：deleteCookie 传与 setCookie 一致的属性：{ path: '/', secure: isProductionEnv(), sameSite: 'lax' }，确保删除指令与设置指令属性对齐。
- **验证**：事实部分成立但后果不成立：logout.post.ts:33-38 deleteCookie 仅传 path:'/'，与 [...slug].ts:88-95 setCookie 的 secure/sameSite 不一致(代码不一致属实)。但按 RFC 6265，cookie 删除/覆盖按 name+domain+path 匹配，Secure/SameSite 不参与身份匹配，HTTPS 下仍能正常清除，不会令牌残留；finding 描述的「带 Secure 无法被无 Secure 删除指令覆盖」不成立。故属纯代码一致性 nit，由低下调为信息。
