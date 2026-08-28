## 1. OpenSpec 变更骨架
- [x] 1.1 创建 `.openspec.yaml` / `proposal.md` / `design.md` / `tasks.md`
- [x] 1.2 创建 delta specs（`database-schema`、`public-identifiers`）

## 2. 后端工具与迁移
- [ ] 2.1 新增 `src/lib/public-id.ts`
- [ ] 2.2 5 张表新增 `public_id` 唯一列 + 回填脚本 + NOT NULL 迁移

## 3. 后端实体接入
- [ ] 3.1 竞赛 `public_id` + 双解析
- [ ] 3.2 训练 `public_id` + 双解析
- [ ] 3.3 提交 `public_id` + 双解析
- [ ] 3.4 社区帖子 `public_id` + 双解析
- [ ] 3.5 公告 `public_id` + 双解析
- [ ] 3.6 用户路由支持 username

## 4. 前端切换
- [ ] 4.1 URL 工具与类型
- [ ] 4.2 用户/题目链接切换
- [ ] 4.3 竞赛/训练/提交/帖子/公告切换
- [ ] 4.4 admin 切换 + 展示清理

## 5. 验证
- [ ] 5.1 后端 fmt/lint/test
- [ ] 5.2 前端 fmt/lint/build/test
- [ ] 5.3 新旧链接交叉验证
