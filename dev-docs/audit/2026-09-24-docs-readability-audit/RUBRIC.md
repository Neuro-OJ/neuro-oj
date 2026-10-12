# noj-docs 面向读者审计 —— 统一规范（RUBRIC）

> 供 2026-09-24 文档可读性审计的各 subagent 共用。审计范围：noj-docs 的
> `users/`（做题人）、`operators/`（运营者）、`problemsetters/`（出题人）以及
> 「面向主题」的 `standards/`、`mechanisms/`、`system/`、`features/`。

## 一、目标

1. **正确性审计**：找出文档与当前代码/实现不符之处（命令、路径、字段名、状态
   机、默认值、端点、限制等），以源码为唯一事实源修正。
2. **可读性提升**：从人类读者视角判断文档是否易读，并用 VitePress 语法与
   Markdown 提升层次、强调重点、降低扫读成本。
3. **视觉评价**：用浏览器截图，评价渲染后的层次、密度与容器使用是否恰当。

## 二、正确性：取证方法

- 事实源按优先级：**源码** > 模块 `CLAUDE.md`/`AGENTS.md` > 既有文档。
- 关键源码位置：
  - `noj-core/src/`（后端 API、服务规则、配置注册表 `shared/config/settings-registry.ts`）
  - `noj-ui/app/`（前端路由/页面/文案）
  - `noj-judge/src/`（评测协议、容器、RPC）
  - `noj-llm-gateway/src/`（网关端点、限流/额度）
  - `noj-cli/src/`（运维 CLI 命令与参数）
  - `docker-compose.prod.yml`、`.env.prod.example`（生产部署与变量）
- 常见漂移类型：已删除的命令/端点仍被文档推荐；默认值与配置项不符；字段/
  状态/限制与实现不同；同文自相矛盾；指向已重命名路径。
- **只读你的页面范围**。若发现跨页不一致，写进报告（不要越界修改其他页面）。
- 每条正确性结论必须给出可复核证据（文件路径 + 关键行/符号）。

## 三、可读性：允许的改进手段

按优先级使用，**禁止滥用**：

1. **VitePress 容器**：`::: tip` / `::: info` / `::: warning` / `::: danger` /
   `::: details`。
   - `tip`：省时/推荐做法；`info`：背景补充；`warning`：易错/前置条件；
     `danger`：不可逆或高破坏操作；`details`：可选细节/长清单折叠。
   - 每页建议 **1–5 个**，聚焦"读者不看会踩坑"的内容。不要给每段都套容器。
2. **`<Badge text="..." type="info|tip|warning|danger" />`**：用于状态/类型/版本
   等行内标记（VitePress 内置组件，无需 import）。
3. **表格**：并列信息用表格胜过段落；列多时克制。
4. **有序步骤 / 无序要点**：操作流程用编号步骤；并列项用列表。
5. **`> 引用块`**：给"结论先行"的一两句提示或要点摘录。
6. **加粗 / 行内代码**：强调关键术语、命令、字段；不要整段加粗。
7. **短导语与小结**：长页在开头补 1–3 句"本页讲什么"，必要时结尾补小结。
8. **标题层次**：避免过深（≥4 级）；用 H2/H3 组织可扫读结构。

## 四、硬约束

- **不改技术事实**（除修正错误）；**不新增/删除页面**；**不改文件名/路径/
  侧边栏**（`noj-docs/docs/.vitepress/config.ts` 不动）。
- 不修改 `dev-docs/**` 之外的代码；**不改任何源码**（只审文档）。
- 中文书写，代码标识符英文；提交信息（如需）用中文。
- 保持 VitePress 语法正确：容器必须成对闭合，`:::` 顶格，`<Badge>` 标签闭合。
- **不要运行 `npm run docs:build`**（多个 agent 并行会互相踩 `dist/`）；
  编排者稍后统一构建。可依赖本地 dev server 的 HMR 预览效果。
- **接口语义必须先取证再落笔**（血泪教训）：任何**新增**的说明文字，只要它断言了
  某个 API 端点 / 命令 / 字段 / 状态的行为，就必须先在源码里**定位到该端点/符号**
  并读其实现，确认无误后再写。**禁止**依据端点名或上下文"望文生义"地推断语义
  （已有真实案例：把 `GET /problems/:id/template` 误写成"支持包模板下载"，实为
  编辑器初始代码模板）。无法在源码中定位的断言，一律不写，或放进"遗留问题"。
- **只读你的页面范围**：发现跨页问题写进报告，不要越界修改其他页面。

## 五、视觉评价方法

- 本地 dev server：**http://localhost:5173**（已在运行，反映工作树，改动自动热更）。
  路径可写 `/users/submit` 或 `/users/submit.html`。
- 备用：预发站点 `https://docs-data-dictionary.noj-docs.pages.dev/`（反映已推送版本，
  不含你的新改动；仅用于基线对照）。
- **截图命令**（无头 Chrome，VitePress 为客户端渲染，必须带 `--virtual-time-budget`
  等待 JS 水合，否则截到空白）：

```bash
mkdir -p /tmp/opencode/audit-shots/<group>
google-chrome-stable --headless=new --disable-gpu --no-sandbox \
  --hide-scrollbars --window-size=1440,2200 --virtual-time-budget=12000 \
  --run-all-compositor-stages-before-draw \
  --screenshot=/tmp/opencode/audit-shots/<group>/<page>.png \
  "http://localhost:5173/<path>"
```

- 截图后用 `read` 工具打开 PNG 即可目视评价（模型可直接看图）。
- 每页组至少截 3–5 张代表性页面，评价：信息密度是否过高、层次是否清晰、
  容器使用是否得当、有无"一堵墙文字"。截图落盘到
  `/tmp/opencode/audit-shots/<group>/`（**不进仓库**）。

## 六、产出（两部分）

1. **实际改进**：直接编辑你名下的页面文件。
2. **审计报告**：写入 `dev-docs/audit/2026-09-24-docs-readability-audit/<group>.md`，
   结构：
   - `# <组名> 文档审计报告`
   - `## 范围`：文件清单（含行数）
   - `## 正确性发现`：表格（`位置 | 问题 | 证据（路径+符号） | 处置`）
     —— 处置为「已修正 / 建议（未改，需人确认）」
   - `## 可读性改进`：表格（`页面 | 改动 | 理由`）
   - `## 视觉评价`：人类视角的整体评价与截图要点
   - `## 遗留问题 / 建议`：需人拍板或跨页面的问题
