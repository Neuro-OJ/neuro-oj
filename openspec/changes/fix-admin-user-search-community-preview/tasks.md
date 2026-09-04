## 1. OpenSpec and search contract

- [x] 1.1 更新管理员用户搜索规范，明确用户名/邮箱匹配、邮箱返回和非管理员拒绝行为
- [x] 1.2 更新社区 UI 规范，明确分页追加时摘要只处理新增帖子

## 2. NOJ-226 administrator participant search

- [x] 2.1 在全局用户搜索的结果查询和精确总数查询中加入邮箱模糊匹配
- [x] 2.2 将竞赛参与者管理页切换到管理员用户搜索响应，并正确展示邮箱
- [x] 2.3 增加或更新搜索服务回归测试，覆盖邮箱命中和 root 排除

## 3. NOJ-230 community list summary

- [x] 3.1 为社区列表行增加预计算摘要，并在首屏/追加加载路径生成摘要
- [x] 3.2 将模板中的 Markdown 实时处理改为渲染预计算摘要
- [x] 3.3 增加摘要处理回归验证，确保加载更多不会重新处理历史内容

## 4. Verification

- [x] 4.1 运行受影响模块格式化、lint、类型检查和相关测试
- [x] 4.2 运行 `openspec validate fix-admin-user-search-community-preview --strict`
- [x] 4.3 新增中文 Agent Note，记录隐私边界和列表预计算决策
