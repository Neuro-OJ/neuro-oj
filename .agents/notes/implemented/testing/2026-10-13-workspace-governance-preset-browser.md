# Agent Note: 实例治理、Preset 和公开目录真实浏览器验收

Status: implemented

## Problem

平台治理、域额度和 Preset 已有后端及组件验证，但没有实际页面批准、拒绝、
暂停恢复及配置冲突证据。新增首页和 sitemap 修复也需要从真实部署验证，
不能把组件通过算作运行端权限撤销成功。

## Decision

新增独立 workspace-governance.test.ts，通过标准 test:browser 过滤执行七段旅程。
使用已有平台管理员及两个新普通账号，API 只准备题目、邀请等前置资源和核对
持久事实；申请、治理、额度、模板及交卷操作均通过真实 Chromium 页面。

- 平台管理员在 Web 将创建政策改为申请审核。普通用户在表单提交两份申请，
  管理员在明确申请行分别批准和拒绝，确认普通申请人成为新域负责人。
- 普通学生通过已授权题面实际交卷获得 100 分，保留原提交答案和版本依据。
- 管理员通过治理目录暂停和恢复明确目标域，普通成员进入请求即时拒绝后恢复。
- 两个管理员标签页读取同一 revision，分别填写 40 和 30 人额度。第一份保存
  成功，第二份真实 PATCH 返回 409，旧输入保留且页面显示冲突；持久额度为 40。
- 普通域负责人预览社区 Preset，预览本身不修改配置。显式确认应用后，成员
  列表、源题完整 DTO 和学生原提交答案及成绩完整 DTO 均未改变。
  再通过设置页面选择题单首页，访问域根页实际进入当前域题单。
- 独立新建公开题进入匿名 sitemap，响应 no-store；管理员通过资源管理页面
  下架本次新题后，下一次匿名目录不再含原题号。管理员通过 Web 禁止实例匿名
  访问后，匿名 sitemap 请求拒绝，返回内容不含题目目录。

finally 恢复 instance_access 和 domain_creation_policy 的原有效值并 GET 核对。
main 原配置没有修改，仍 GET 核对一致；只下架本批新建公开题，不删除旧资源
或修改既有比赛、教师及学生的历史。

## Alternatives considered

- 通过 API 批准、停用或应用模板再打开页面：不能证明用户实际操作，因此捕获
  页面发起的明确 HTTP 写请求并核对状态及 If-Match。
- 人为模拟冲突响应：没有并发配置证据，使用两个真实标签页的旧 revision。
- 仅检查数量未减少：无法证明原记录未改写，核对成员、题目及提交完整返回。
- 使用平台管理员代替域负责人做所有操作：无法证明域角色闭环，模板与首页由
  普通负责人操作，交卷由普通成员操作。

## Consequences

2026-10-13 在当前协调栈 core 0139 与最终生产 UI、隔离数据库
noj_upgrade_acceptance_e2e_20261013 上，以
NOJ_RUN_BROWSER_E2E=1 deno task test:browser --filter=workspace-governance
获得 **1 passed（7 steps）、0 failed、17 filtered out，18 秒**。
日志为 /tmp/noj-browser-governance-third.log，新增文件通过格式、lint 和类型检查。
失败轮保留共享 helper 生成的 trace 与截图；两处测试协议预期修正为客观交卷
201 和额度 PATCH，未增加产品测试开关或改写业务实现。

本次不重新执行其余浏览器旅程、Judge 代码评测或远端 CI。政策窗口已释放，
完整备份和隔离恢复可以使用已还原的实例政策继续采集。
