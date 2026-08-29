## Purpose

定义 noj-ui 动态内容页 SEO 元信息、sitemap 与 robots.txt 规范。

## Requirements

### Requirement: 动态内容页提供 SEO 元信息

题目详情、用户主页、社区帖子、提交详情、公告详情、竞赛详情等动态内容页 SHALL 通过 `useSeoMeta` 或 `useHead` 设置页面标题、描述、Open Graph 与 canonical URL。

#### Scenario: 题目详情页 SEO 元信息

- **WHEN** 搜索引擎或社交平台抓取 `/problems/:id`
- **THEN** 页面 HTML 包含题目标题、题目描述摘要、`og:title`、`og:description` 与 canonical URL

#### Scenario: 用户主页 SEO 元信息

- **WHEN** 搜索引擎抓取 `/users/:id`
- **THEN** 页面 HTML 包含用户名、简介摘要与 canonical URL

### Requirement: 提供 sitemap

系统 SHALL 提供 `/sitemap.xml`，包含可公开访问的题目、竞赛、公告等资源 URL；sitemap SHOULD 由服务端动态生成并带短时间缓存。

#### Scenario: 获取 sitemap

- **WHEN** 客户端请求 `/sitemap.xml`
- **THEN** 返回合法 XML，包含公开资源 URL 列表

### Requirement: 提供 robots.txt

系统 SHALL 提供 `/robots.txt`，允许搜索引擎抓取公开内容页，禁止抓取管理后台、编辑器、设置、私信等非公开或交互页面。

#### Scenario: 获取 robots.txt

- **WHEN** 客户端请求 `/robots.txt`
- **THEN** 返回文本，其中公开路径允许抓取，私有路径标记 `Disallow`
