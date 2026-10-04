# Agent Note: 管理表格单元格内复选框无法勾选

Status: implemented

## Problem

题目管理「题目评定」页的复选框点击后不变，无法批量转公开 / 转 P。`AdminTable` 无条件向 `UTable` 传入 `onSelect`；Nuxt UI v4 的行点击处理只放行 `button` / `a`，其余点击一律 `preventDefault()`，原生 checkbox 的默认切换被取消，`change` 事件不触发。而当前没有任何页面监听 `row-click`。

## Decision

`AdminTable` 的 `row-click` 由 emit 改为 `onRowClick` prop（父组件 `@row-click` 写法不变），仅在父组件确实监听时才向 `UTable` 传 `onSelect`。补充组件回归测试。

## Alternatives considered

- 在题目评定页的 checkbox 上 `@click.stop`：只修一处，其他管理页在单元格中放原生控件仍会踩坑。
- 改用 `AdminTable` 内置 `selectable` 选择列：同样受 `onSelect` 的 `preventDefault` 影响，不解决根因。

## Consequences

未监听 `row-click` 的表格不再拦截单元格点击。若将来某页同时监听 `row-click` 并在单元格放原生表单控件，仍需在控件上阻止点击冒泡。
