# Agent Note: 空间动态导航图标的离线客户端打包

Status: implemented

## Problem

空间导航在 utils/workspace-navigation.ts 中配置动态图标名称。
实际运行日志报告 chart-no-axes-column-increasing、library-big、bot 和 user-round-cog 加载失败。
四个名称均存在于已安装的 lucide 图标集，原客户端包的 200 个图标中没有它们。
已安装的 Nuxt Icon 扫描器默认扫描 Vue、JSX、TSX 和内容文件，不扫描普通 TypeScript 文件。

## Decision

在 nuxt.config.ts 的 icon.clientBundle.icons 中明确加入这四个 lucide 图标。
保留 scan:true 为模板内图标自动打包，并保留 serverBundle:local。
不改变导航图标名称、品牌 token、图标依赖或联网加载策略。

## Alternatives considered

扩大扫描到所有 TS 会把测试和纯工程代码中的字符串也纳入扫描范围；
只缺四个动态导航图标时，显式列举足够。
修改图标名称不能解决扫描遗漏，也会无必要地改变导航视觉。

## Consequences

生产客户端集合由 200 个增加到 204 个图标。
已直接解析生产构建的客户端集合，四个名称各自包含完整 SVG body，
无需请求外部图标服务即可提供客户端图标数据。
服务端离线图标接口的实际 HTTP 验收在浏览器旅程结束后的集成窗口执行；
本批没有重启服务或把构建成功视为运行端验收。
