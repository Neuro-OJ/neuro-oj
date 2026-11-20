# Agent Note: 知识图谱 P4 教练视角

Status: implemented

## Problem

P3
让学习者看到自己的掌握情况，但教练看不到全班在各知识点上的分布，也不能按知识点
快速布置一组从易到难的题目，只能逐题手动查找。

## Decision

- 两个只读接口放在 `features/knowledge/coach.ts`，经教学模块公开出口
  `loadClassroom` + `assertClassroomCoach`
  鉴权（域教练、域管理员、平台管理员；学生
  403），教学模块代码不改、不依赖知识图谱。
- 班级掌握矩阵 `GET /domains/:slug/classrooms/:id/knowledge-mastery`：活跃学生 ×
  （本域有题或班内有记录的）知识点，单元格稀疏只放
  learning/mastered，每列附三态计数； 固定条数的聚合查询。
- 按知识点挑题 `GET /domains/:slug/classrooms/:id/knowledge-pick`：复用 P2
  阶梯的
  可见性过滤（保护期题对教练也不出现），在难度序列上均匀抽样覆盖从易到难；只返回列表，
  不创建作业，不新增作业类型。
- 前端：班级「知识点掌握」页（按领域折叠的色块矩阵、只看有人在学的知识点）；作业编辑器
  「按知识点添加」。
- 验收时修正两处前端缺陷：工蜂把题目引用一律拼成「当前域:题号」，与编辑器本域题用纯
  题号的规则不一致（去重失效、跨域题来源错）；且直接以空 `binding_id`
  加入，保存会失败。 改为后端返回
  `display_ref`，前端逐题走与「按题号添加」相同的解析接口取得绑定。

## Alternatives considered

- 在教学模块里实现、反向调用知识图谱：违反「旧模块不 import
  feature」的边界规则。
- 挑题接口直接创建作业：会绕过现有作业编辑与校验流程，改为只返回列表。
- 挑题结果附带 binding_id 省去逐题解析：要在 knowledge 里复制绑定解析规则，最多
  20 次解析请求可以接受。

## Consequences

- 学生的 `display_name` 暂恒为 null（账号无昵称列），矩阵显示用户名。
- 学生和知识点很多时矩阵较大；目前按领域折叠且只渲染展开领域，规模继续增大时需分页。
- 讲解效果对比（4.5）与自学支持后续项（4.7）仍未做。
