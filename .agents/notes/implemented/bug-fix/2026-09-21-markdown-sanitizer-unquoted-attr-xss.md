# Agent Note: 无引号属性值分支未转义引号导致的 SSR 首屏 XSS

Status: implemented

## Problem

`noj-ui/utils/sanitize.ts` 的 `simpleSanitize` 是 DOMPurify 不可用时的兜底净化器，
也是 SSR 首屏渲染的唯一防线（`MarkdownRenderer.vue` 只在 `import.meta.client`
分支用 DOMPurify，服务端走 `sanitizeHtmlSync`）。

该函数的属性重建逻辑有三个分支：

```ts
if (dq != null) return ` ${attrLower}="${dq.replace(/"/g, '&quot;')}"`;
if (sq != null) return ` ${attrLower}='${sq.replace(/'/g, '&#039;')}'`;
return val ? ` ${attrLower}="${val}"` : ` ${attrLower}`;   // ← 无引号分支
```

前两个分支都实体化了引号，唯独无引号分支把 `val` 直接拼进双引号里。而提取该值的
正则用 `(\S+)` 匹配，会把引号一并吃进 `val`：

```text
输入        <img src=x"onerror="alert(1)>
修复前输出  <img src="x"onerror="alert(1)">
```

浏览器把这段输出解析为 `src` **和** `onerror` 两个属性 —— 净化器亲手构造出了它
本应剥离的事件处理器，且无需用户交互即可触发（`onerror` 属自动触发）。

攻击面是任何用户可控的 Markdown：社区帖正文、公告、用户 bio、题目描述。配合既有
CSP 的 `script-src 'unsafe-inline'`，内联处理器可执行。

### 取证

用按浏览器引号规则取值的属性分词器（引号内的 `&quot;` 实体不终止属性值）对
修复前后输出解析，统计标签上的 `on*` 属性：

| 载荷 | 修复前解析出的 `on*` | 修复后 |
| --- | --- | --- |
| `<img src=x"onerror="alert(1)>` | `onerror` | 无 |
| `<div><img src=x"onerror="alert(document.domain)></div>` | `onerror` | 无 |
| `<div title=x"onmouseover="alert(1)>x</div>` | `onmouseover` | 无 |

三个载荷在修复前均产生真实事件处理器属性，修复后全部消失。

注意：**字符串级断言不足以判定该缺陷**。修复前的输出里 `onerror=` 确实存在，但
修复后输出中 `onerror=` 这串字符依然存在（已被实体化为 `&quot;onerror=&quot;`），
只是不再是属性。判据必须落在解析结果上，而不是子串匹配。

## Decision

把无引号分支与另外两个分支对齐，同时实体化单/双引号：

```ts
return val
  ? ` ${attrLower}="${val.replace(/"/g, '&quot;').replace(/'/g, '&#039;')}"`
  : ` ${attrLower}`;
```

补 4 个回归用例（`noj-ui/tests/sanitize_test.ts`），断言净化结果中不含任何可解析的
`on*` 属性，并覆盖单引号值、表格内注入等变体。

## Alternatives considered

- **删除无引号分支、一律丢弃此类属性值**：会破坏正常内容（`<img src=/a.png>` 这类
  合法无引号写法很常见），属行为变更，需人工裁决。
- **改用 DOMPurify 在服务端也跑**：需要 DOM 实现（jsdom/linkedom），是引入新依赖的
  架构变更，超出缺陷修复范围。
- **仅在 `val` 上做 `\s` 截断**：`\S+` 已把整段吃进 `val`，截断会改变属性语义且
  仍可能漏掉其他分隔符变体；转义才是与既有两个分支一致的做法。

## Consequences

无引号属性值中的引号被实体化，注入不再能闭合成新属性。既有防护（`script`、
`javascript:` 协议、未知标签降级）与正常内容（KaTeX、代码块、表格）用例均保持通过。

该修复**不覆盖**同一函数的另一个分支（未知标签整体降级为纯文本时属性原文照抄），
后者是独立根因与独立修复，见
`2026-09-21-markdown-sanitizer-unknown-tag-ssr-xss.md`。
