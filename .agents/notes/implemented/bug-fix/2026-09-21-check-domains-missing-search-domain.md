# Agent Note: 域边界门禁遗漏 search 域，跨域 import 完全不设防

Status: implemented

## Problem

`scripts/check-domains.ts` 的 `DOMAINS` 集合登记了 12 个业务域，但
`noj-core/src/domains/` 下实际有 13 个（不含聚合门面 `admin`）：**`search`
未被登记**。

`domainOf()` 对未登记域返回 `null`，而 `checkFile()` 在
`if (!sourceDomain) return []` 处早退。后果：

- `search` 域生产文件的**任意深路径跨域 import 全部放行**；
- 与之对称的 `query` 域（同为读模型域）受约束，说明这是新域建立时漏登记，
  而非"只读域豁免边界"的设计。

触发条件与实测：

```ts
// noj-core/src/domains/search/services/search.ts 顶部
import { getProblem } from "../../catalog/services/problems/problems-crud.ts";
```

- 修复前：`deno run -A scripts/check-domains.ts` → `域边界检查通过`（exit 0）。
- 对照：把同一行放到 `domains/messaging/services/messages.ts` → 立即报
  `messaging 域不得深路径导入 catalog 域`。

## Decision

1. 把 `"search"` 加入 `DOMAINS`，并写明"必须与 `noj-core/src/domains/` 实际
   目录一致（admin 有意豁免）"以及本次修复的实测证据。
2. 新增 4 条回归用例（`scripts/check-domains_test.ts`）：
   - `domainOf` 识别 `search` 域；
   - `search` 域跨域深路径 import 报违规；
   - `search` 域同域 / `shared` import 不误报；
   - **防新域漏登记守卫**：枚举磁盘上 `domains/` 的每个子目录，断言除
     `admin` 外都能被 `domainOf` 识别。这条守卫让"未来新增域忘记登记"从
     静默失效变成一次可发现的失败。

第 2 条的"磁盘目录枚举"是本次修复的关键：只补 `search` 一个名字无法防止
下一次同类遗漏。

## Alternatives considered

1. **只加 `"search"`，不加守卫**：拒绝。该缺陷的根因是"集合与磁盘现实必须
   手工保持同步"，无守卫时下一次新增域会重演。
2. **反过来由 `domainOf` 动态从磁盘推导域集合**：拒绝。`check-domains` 的
   测试会在临时夹具目录（`Deno.makeTempDir`）中运行，动态推导会把夹具目录里的
   任意子目录也当成域；且"哪些目录是域、哪些是门面/例外"本身是需要显式登记的
   策略，不应隐式化。
3. **把 `search` 归到 `query` 域**：拒绝。那是目录结构的重构（`search` 已是
   独立域，有自己的 routes/services/middleware/consumer），远超门禁修复范围。

## Consequences

- `search` 域自此受与其他业务域相同的跨域边界约束；实测真实仓库当前
  **0 违规**（其生产代码只 import `shared/**` 与本域），无需改动任何生产代码。
- 新增域若忘记登记，`check-domains_test.ts` 的守卫会立即失败。
