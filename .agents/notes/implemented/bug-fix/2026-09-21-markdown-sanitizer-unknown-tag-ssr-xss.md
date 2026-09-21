# Agent Note: Markdown 净化器未知标签降级分支的 SSR 首屏 XSS

Status: implemented

## Problem

`noj-ui/utils/sanitize.ts` 的 `simpleSanitize` 是 DOMPurify 不可用时的**最后防线**，
也是 SSR 首屏渲染的唯一防线：`MarkdownRenderer.vue` 只在客户端用 DOMPurify，
服务端分支走 `sanitizeHtmlSync`。该函数对非白名单标签的处理是"降级为纯文本"：

```ts
return `&lt;${close}${tag}${attrs}&gt;`;
```

它只实体化了标签两侧的**定界符** `<` / `>`，却把 `attrs` 原文照抄。于是属性值里的
`<` 会在浏览器重新解析这份"纯文本"时开启一个**新标签** —— 净化器反而构造出了它本要
剥离的处理器：

```text
输入  <foo bar="<img src=x onerror=alert(1)//>">
输出  &lt;foo bar="<img src=x onerror=alert(1)//&gt;">
浏览器解析  <foo bar=" <img src="x" onerror="alert(1)//>">   ← img 是真元素，onerror 已挂上
```

**实测已执行**。在 Chromium 中把输出直接写进 `innerHTML`，`onerror` 回调被调用；
把输出放进首屏 HTML（模拟 SSR 交付）同样在解析时触发，**无需任何用户交互**。

攻击面是任何用户可控的 Markdown 文本，且 SSR 分支意味着载荷进入首屏 HTML：
社区帖正文（`pages/community/posts/[postId].vue`）、公告
（`pages/announcements/[id].vue`）、用户 bio（`pages/users/[id].vue`、
`pages/settings.vue`）、题目描述（`components/problem/ProblemStatement.vue`）。
配合既有 CSP 的 `script-src 'unsafe-inline'`，内联处理器可执行。

同一函数的另一个分支（无引号属性值 `(\S+)` 捕获组直接拼接）此前已修复
（`tests/sanitize_test.ts` 中的"无引号属性值内的双引号"用例），但**该修复不覆盖本分支**：
本分支根本不走属性白名单正则，而是整体降级为文本，因此需要独立修复。

### 为什么字符串级断言会漏掉它

`tests/sanitize_test.ts` 既有的 `assertNoEventHandlers` 匹配输出里的 `\son[a-z]+\s*=`。
本载荷的输出中 ` onerror=` 确实存在，但它已是**文本**而非属性 —— 字符串匹配既会
**误报**（把安全的转义文本判为危险），也无法表达真正的判据（"输出里没有可解析的标签"）。
判据必须落在 DOM 解析结果上。

## Decision

在 `simpleSanitize` 的未知标签分支整体转义标签文本，新增 `escapeHtmlText`
统一做 `&` / `<` / `>` / `"` / `'` 五个字符的实体化：

```ts
return escapeHtmlText(`<${close}${tag}${attrs}>`);
```

`&` 先转义（避免二次实体化），随后是 `<>"'`。降级文本仍完整可读，
只是不再含任何可解析的标签。

白名单标签的属性分支**未**改用该函数：那里 `attrs` 已按属性白名单逐项重建，
且若转义 `&` 会让真实 URL 中的 `&amp;` 二次转义。两处需求不同，故只修降级分支。

新增两层回归测试：

- `tests/utils/sanitize.spec.ts`（vitest + happy-dom）：把净化结果真正 `innerHTML`
  解析后断言"无 `on*` 属性、载荷标签未成为元素"。这是唯一能表达真实判据的层次。
- `tests/sanitize_test.ts`（deno test）：断言内层标签被实体化为 `&lt;img` / `&lt;svg`，
  并显式说明为何此处不能复用 `assertNoEventHandlers`。

### 验证

- 反向对照：在**未修复**代码上跑新增 spec，10 个用例失败；修复后 12 个用例全通过。
- 端到端：经真实 `MarkdownRenderer` 管线（markdown-it → secureExternalImages →
  `sanitizeHtmlSync`）产出，在 Chromium 中 `onerror`/`onload` 均不再挂载或执行
  （`LIVE: []`、`FIRED: []`）。
- 全量门禁：`deno task test` 139 passed；`deno task test:components` 51 passed；
  `deno fmt --check`、`deno lint`、`deno task check:types` 均通过。
- 正常内容不回归：KaTeX / 代码块 / 表格 / 带引号属性的用例保持逐字节不变。

## Alternatives considered

**只转义 `<` / `>`（保留引号原样）。** 最小改动，但属性值里的引号仍能提前闭合属性，
在降级文本内重新造出 `on*` 属性的边界；统一五字符转义成本相同且无需再论证边界。

**不再输出标签原文，直接丢弃未知标签及其属性（只留文本内容）。** 更安全，但会把
`<foo bar="x">hi</foo>` 降级成 `hi`，用户看到"自己写的标签凭空消失"，且与既有
"转为纯文本显示"的产品行为不一致 —— 现有测试明确要求未知标签以 `&lt;iframe` 形式可见。

**在 SSR 分支也引入 DOMPurify。** 需要 DOM 实现才能在服务端运行，是依赖与性能上的
更大变更；本次只需修正一个分支的转义缺陷。若后续要收敛两套净化实现，应作为独立提案。

**只修降级分支的正则而不加 DOM 级测试。** 字符串级断言已被证明会误报且无法表达判据，
没有 DOM 级测试就无法阻止该缺陷以别的形态回归。

## Consequences

- 未知标签降级现在是**幂等安全**的：输出再经一次净化或直接解析都不会产生元素。
- 降级文本出现更多实体（`&quot;` 等），纯文本显示语义不变，但若有外部代码对净化输出
  做字符串比较（例如快照测试）需同步更新。
- `tests/utils/sanitize.spec.ts` 成为净化器的 DOM 级回归基线；后续修改
  `simpleSanitize` 应在此补充载荷，而非只加字符串断言。
- 同类"降级/转义"代码若存在，应检查是否也犯了"只转义定界符"的错误 —— 本仓库中
  `v-html` 仅有 `MarkdownRenderer.vue` 一处，且已确认走净化器。
