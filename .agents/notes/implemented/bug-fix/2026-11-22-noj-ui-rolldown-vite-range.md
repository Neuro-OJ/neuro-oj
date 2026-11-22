# Agent Note: noj-ui 依赖升级中 rolldown 越出 vite 兼容区间导致产物 JS 语法错误

Status: implemented

## Problem

- dependabot #765 将 `rolldown` 与 `overrides.rolldown` 从 1.2.13 升到 1.3.2，
  但 nuxt 4.6.4 解析到的 vite 8.3.8 声明依赖 `rolldown: ~1.2.18`。`overrides`
  强制 vite 使用 1.3.2 后，动态 import 预加载占位替换错位，产物中出现
  `__vite__mapDeps([...])<hash>` 残留，6 个客户端 chunk 报
  `missing ) after argument list`，E2E Browser 全部页面无法水合。
- 同 PR 将 `playwright` 升到 1.65.1，但 `ci.yml` 仍以
  `npm:playwright@1.62.1 install` 下载浏览器，UI (Nuxt) 任务的 `test:bff:ssr`
  找不到对应 chromium。

## Decision

- `rolldown` 与 `overrides.rolldown` 固定为 1.2.19（满足 vite `~1.2.18`）， 其余
  nuxt / vue / vue-router / playwright 升级保留。
- `ci.yml` 的 Playwright 浏览器安装版本与 `noj-ui/package.json` 对齐为
  1.65.1；`tests/browser/editorTheme.browser.test.ts` 的 `npm:playwright` 导入及
  noj-ui 文档中的安装命令同步为 1.65.1。
- `dependabot.yml` 对 noj-ui 的 `rolldown` 忽略 semver-minor 更新，随 vite
  升级手动调整，防止再次越出 vite 声明区间。

## Alternatives considered

- 删除 `overrides` 让 vite 自带 rolldown：会出现多份 rolldown 并存，偏离当前
  统一版本的做法；保持 override 但对齐 vite 区间改动最小。
- 整体回退本次 dependabot 升级：nuxt / vue 等补丁升级本身无问题，没有必要放弃。

## Consequences

- 本地 `deno task build` 产出的 375 个客户端 chunk 均可被 acorn 解析；
  `deno task test`（358 通过）与 `deno task test:bff:ssr` 通过。
- 后续升级 vite 时需同步检查其 `rolldown` 依赖区间并手动调整 override。
