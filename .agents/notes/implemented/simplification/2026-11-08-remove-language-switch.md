# Agent Note: 移除前端语言切换（中文 / English）

Status: implemented

## Problem

顶栏提供“中文 / EN”切换，但全站 283 个页面与组件中只有 5
个（顶栏、登录、注册、邮箱验证、搜索框）接入了
`t()`。切到英文后绝大部分界面仍是中文，issue #685 中约 10 条
“未翻译”都源于此。语言状态还渗透到错误提示、面包屑、状态 /
难度标签与比赛时长格式化，每处都维护一套英文分支。

## Decision

只提供中文界面，移除语言切换与全部英文文案：

- 删除顶栏切换按钮、`noj:locale` Cookie 与 `setLocale` / `isEnglish` / `locale`
  状态；`<html lang>` 固定为 `zh-CN`。
- `utils/i18n.ts` 改为单一中文文案表：`translate(key, params)`、
  `translateErrorCode(code)` 不再接收语言参数。保留文案表本身——它仍承担登录 /
  注册界面文案、后端机器错误码 → 中文提示与面包屑标签。
- `useI18n()` 只返回 `t`，调用方无需改动 `t()` 写法。
- `extractApiError(err)`、`resolveBreadcrumb(path)`、`getStatusLabel(status, result)`
  去掉语言参数与英文分支；`StatusBadge` / `DifficultyBadge`
  直接使用组件内的中文配置；`useContestAdminLabels` 删除英文时长格式。
- `noj-ui/docs/i18n.md` 改写为文案表说明；测试改为断言中文文案与错误码映射。

## Alternatives considered

- 补全英文翻译：需要为 278 个未接入的页面 / 组件逐一抽取文案，且之后每次改动都要
  维护双语，与当前用户群不匹配。
- 只隐藏按钮、保留双语基础设施：英文分支会继续在错误提示、标签等处产生维护负担，
  且无人能看到，属于死代码。

## Consequences

- 浏览器里残留的 `noj:locale` Cookie 不再被读取，无副作用。
- 已接入 `t()` 的页面行为不变（原本默认即中文）。
- 若日后需要英文版，应作为独立项目整体规划，而不是恢复本次删除的半成品。
