# Agent Note: 日志渲染 span 化与模块列

Status: implemented

## Problem

上一轮「统一日志渲染」迁移落地后，实际渲染仍有四个可用性缺陷。其中两个是
**契约承诺与实现不符**——文档写了、测试也「通过」，但真实输出里根本不存在：

1. **「WARN/ERROR 整行粗体」从未生效。** 旧实现把 `\x1b[1m` 套在整行**最外层**，
   而行内第一个片段（时间戳）后紧跟 `\x1b[0m`，外层样式立即被清掉。实测状态机
   解析确认：message 与字段值的粗体属性恒为 `false`，唯一被影响的是时间戳
   （bold+dim 叠加，属意外副作用）。judge 侧更糟——`\x1b[1m` 写在**所有内容之后、
   换行之前**，是纯死字节，且**不带 `reset`**，会把粗体状态泄漏到后续输出。
   既有断言（`line.startsWith("\x1b[1m")`）恰好被旧实现满足，因此这个缺陷
   **对测试完全不可见**。

2. **模块名在 core/gateway 完全缺失。** core 有 15 个 category、48 个 logger，
   但 `formatPretty` 从不读 `record.category`；契约 §5 自认「本期不做列内对齐」。
   结果核心后端的日志无法区分 `submission` 与 `db` 的输出，而 judge 反而渲染了
   `target=`——四个运行时里只有两个看不见来源。

3. **Error 被压成一行 JSON。** `serializeValue` 会把 `Error` 转成普通对象，导致
   `formatFieldValue` 里的 `value instanceof Error` 分支**永远不可达**（实测确认）。
   Error 最终走 `JSON.stringify`，`stack` 的换行被转义成字面 `\n`：
   `error={"name":"Error","message":"…","stack":"Error: …\n    at …"}`，整行无法阅读。

4. **cli `prefixLine` 名实不符。** 函数名与文档承诺「彩色模块前缀」，实际把整行
   套进 `开 → 文本 → 关`。行体自带 SGR 时（转发的 core/gateway/judge pretty 输出
   就是如此），外层前缀色被行内第一个 `reset` 清掉——表现为「纯文本行整行染色、
   含 SGR 行只有前缀染色」，同一视图两种表现。

## Decision

- **渲染层改为 span 化。** 行内每一段文本携带自己的 SGR 参数码，渲染时各自
  输出闭合的 `开 → 文本 → 关`；行级强调（ERROR 粗体）**前置合成**进每个非空白
  片段的参数码，而不是套在外层。这是唯一能让行级样式真正生效的结构——外层
  包裹与行内 `reset` 在语义上不可能共存。错误合成码因此与契约表一致：
  ERROR 徽章 `31` + 行级 `1` → `1;31`。
- **`SGR` 常量从完整转义序列改为参数码**，复合码由 `sgr()` 合成（去重，避免
  `1;1`）。旧常量无外部消费者，改动不外溢。
- **整行粗体收窄为 ERROR 专属。** WARN 只着色徽章（`33`）。理由：`LOG_LEVEL`
  生产默认 `warn`，若 WARN 也整行加粗，整个生产日志流被加粗淹没，粗体不再
  指示「需要立刻处理」。
- **模块列进入契约 §2**：`padEnd(14)`，取 LogTape `category` 末段 / tracing
  `target` 去 crate 前缀；超宽按**字符**（非字节）截断加 `…`；无 category 时
  保留列宽，避免同批日志两种缩进。msg 起始列由 21 推到 37。
- **Error 渲染为缩进多行块**，首行级别色、栈帧 dim，剔除与首行重复的 stack 首行。
  识别方式：`serializeValue` 给结果打**不可枚举 Symbol 标记**——`JSON.stringify`
  与 `Object.entries` 均不可见，故不改动契约 §4 的 JSON 形状与既有脱敏遍历。
- **数值字面量着色 `35`**，与字符串值区分，便于长行扫读。
- **跨运行时一致性由 `scripts/check-log-parity.ts` 锁定**：同一组 fixture 分别
  驱动 core 与 gateway 的 formatter，逐字符比对，接入 `check-ci`。

## Alternatives considered

- **在整行尾部用 `\x1b[22m` 代替 `\x1b[0m` 来「部分恢复」粗体**：实测无效——
  行内片段各自的 `reset` 已经先把外层样式清掉了，改尾部码不改变任何文本的属性。
- **保留外层包裹、改为剥除行内 `reset`**：需要在渲染层解析并改写内容里的转义
  序列（字段值可能来自用户数据），既脆弱又引入注入面。span 化是更小的改动。
- **core 与 gateway 共享一份渲染实现**：两个 Deno 模块各自部署，跨模块相对
  导入会破坏 `deno check` 与 exports 边界（上一轮已确认）。改为用 fixture
  测试锁定等价——不影响部署边界，且能挡住「只在一侧生效」的漂移。
- **给 core 的 48 个 logger 补 category 参数**：不需要。LogTape 的
  `record.category` 本就携带该信息，只是渲染层此前没有使用。
- **把 Error 标记做成可枚举字段（如 `__isError: true`）**：会进入 JSON 输出，
  污染契约 §4 的形状，也污染 `redactNested` 的遍历。Symbol 不可枚举是必需的。

## Consequences

- **契约文档 §1/§2/§5 已同步**（颜色表、布局图、模块列、Error 块）。
  §1 新增「行级强调必须合成进片段」与「不允许未闭合 SGR」两条硬规则说明。
- **反向验证已做**：把 span 化退回外层包裹、把 ERROR 粗体退回末尾写入、
  把 cli 前缀着色退回整行——对应的新测试**全部变红**，证明护栏不是恒真断言。
  （旧断言 `startsWith("\x1b[1m")` 在缺陷实现下通过，是本轮新增状态机解析的
  直接动因。）
- **`check-log-parity.ts` 的反向验证**：把 gateway 模块列宽改成 12，8 个 fixture
  全部报出漂移并以 exit 1 失败。
- **parity fixture 需重建真实 `Error` 实例**：fixture 经 JSON 传给子进程会丢掉
  `instanceof Error` 语义，不重建则 Error 详情块路径**两侧都不会执行**，
  parity 会「通过」却毫无覆盖（已在 fixture 中显式声明 `errorFields`）。
- **未做**：模块名不做颜色以外的对齐美化；不建设日志聚合平台；judge 仍不实现
  JSON 与脱敏（契约 §4/§6 边界不变）；不动 `LOG_FORMAT=json` 路径（恒无色）。
- **cli 的模块前缀仍由 `colorFor()` 按名字哈希取色**（8 色轮转），与 §1 的
  固定语义色是两套体系：cli 前缀标识的是**部署组件**（server/ui/judge/postgres），
  不是日志级别。本轮只修正其着色范围，未统一取色策略。
