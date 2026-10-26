---
version: 1
slug: "d-slug-assignments-assignmentid-index-vue-6a24710e"
primary_target: "noj-ui/pages/d/[slug]/assignments/[assignmentId]/index.vue"
related_targets: ["noj-ui/components/education/AssignmentMatrix.vue","noj-ui/components/education/AssignmentConversation.vue"]
---

## Direction contract

THESIS: 一份作业是一张备课批阅台，不是设置表单。页面拒绝把筛选器、管理按钮、反馈表单与成绩矩阵平铺成同权重区块；成绩矩阵是唯一主体，其余内容按「先回答学情、再处理对话、最后维护作业」三层退后。

OWN-WORLD: 沿用 NOJ 已确认的浅蓝纸面、白色面板、天青蓝交互与信号绿状态；4–6px 近直角、细分隔线、`tabular-nums`。不引入新色、渐变、装饰性图标块或嵌套卡片。矩阵使用纸面表格语言，状态只用语义色与符号编码。

STORY: 教练进入后先回答「谁已达标、哪道题卡住、谁还没开始」；点单元格在抽屉里核对提交并给该生写反馈；回复求助切到「反馈与求助」；发布、截止、复制、归档收进右侧「管理作业」抽屉。学生进入后直接看到每道题的进度与下一步动作，并可向老师求助。

FIRST VIEWPORT: 面包屑 + 作业标题、阶段徽标、班级与截止信息同一视线；标题右侧只保留「管理作业」。标题下是安静的作业说明块，随后是标签栏与整宽成绩矩阵面板。矩阵工具条含统计范围分段、搜索、筛选、导出；表头显示题号、题名、达标要求与列达标率；单元格以「✓ 100 / 20 / —」编码状态。

FORM: 用户已确认的结构 A（双标签批阅台：学情矩阵 / 反馈与求助），在既有 NOJ 视觉世界内重组信息架构，不创建新视觉世界。
seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
