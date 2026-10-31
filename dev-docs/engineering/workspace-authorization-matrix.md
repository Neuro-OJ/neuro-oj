# 工作空间授权矩阵与关键数据约束

本文供工程 review、接口实现和验收使用，依据 2026-10-13 的实际服务及 Schema，
覆盖接续 main 后的 core 迁移 0117 和当前 Gateway Schema。原主题分支的 0137–0139
收缩按既有 main 迁移顺序整合入 0116，历史编号只用于解释实施沿革。
它记录当前授权行为，不能代替执行入口；下表区分数据库约束和服务检查。

## 1. 身份、访问与资源授权的层次

| 层次          | 权威依据                                                   | 当前检查                                                      | 不能据此推导的能力                                          |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| Instance 账号 | `users`、平台 RBAC、账号状态和实例访问政策                 | 身份认证；软删除、停用及全站封禁；实例是否要求登录            | 账号不直接具有任何学校或班级身份                            |
| Domain 进入   | URL slug、`domains`、当前有效 `domain_memberships`         | public/members、active/archived/suspended、当前平台管理员身份 | 可进入不等于可管理资源或查看他人代码                        |
| Domain 能力   | 当前成员的内置角色并集                                     | `assertWorkspacePermission`                                   | A 域能力不能用于 B 域；平台业务角色不自动继承到域           |
| Classroom     | 同域班级 ID、当前任职、固定助教 grants                     | `loadClassroom`、能力或教练断言                               | 教学人员身份不自动授予其他班级或比赛组织能力                |
| 资源          | 题库绑定、源共享授权、实际作业接收名单、比赛组织／报名关系 | 同域定位、当前授权、状态、版本及时间窗口                      | 创建者身份不越过域进入政策                                  |
| 返回字段      | 比赛视图、本人／教学关系、源资源状态                       | 后端 DTO 允许字段或专用历史 DTO                               | 读取权限不等于可获取测试数据、标准答案或原始 evaluator 文本 |

`WorkspaceContext` 是已解析事实，含稳定域 ID、slug、actor、平台能力、域能力和域
revision。 JWT 不保存当前
Domain；浏览器偏好、切换器和本地缓存键不参与授权。读写资源均需核对路径域。
同一账号可以同时在 A 域为学生、B 域为教练，两个标签页各自沿 URL 保持执行归属。

固定 `main` 的状态变更另有保护，不能将其归档或暂停；其他域按下表执行。

`loadWorkspace`
的读路径只校验必要的进入配置；功能开关由模块边界校验，首页选择不阻断普通资源读取。
加入政策只在加入入口检查，完整配置校验在初始化和配置写入时执行。

| Domain 状态 | 普通用户读取             | 普通用户写入         | 平台治理                                                 |
| ----------- | ------------------------ | -------------------- | -------------------------------------------------------- |
| active      | 按进入政策及具体资源授权 | 按具体能力及模块政策 | 明确目标后操作                                           |
| archived    | 获授权的历史读取         | `DOMAIN_READ_ONLY`   | 治理入口可明确变更状态；普通业务仍只读                   |
| suspended   | 404                      | 拒绝                 | 平台管理员可进入治理／授权读取；普通业务写入仍受状态检查 |

实现依据：[上下文契约](../../noj-core/src/shared/workspace/types.ts)、
[域访问](../../noj-core/src/modules/access/workspace/services/access.ts)、
[实例政策](../../noj-core/src/modules/access/workspace/services/instance.ts)、
[账号治理](../../noj-core/src/modules/access/identity/index.ts)。

## 2. Instance 与平台治理

| 操作                                   | 平台管理员                            | Domain 负责人／管理员                           | 教练／学生               |
| -------------------------------------- | ------------------------------------- | ----------------------------------------------- | ------------------------ |
| 实例访问、注册、模块允许范围与限额上限 | 使用平台设置权限和治理接口            | 无                                              | 无                       |
| 平台账号、密码、全站 RBAC、平台封禁    | 使用对应平台权限                      | 域角色不授予                                    | 教学身份不授予           |
| 发现或读取私有／暂停域的治理目录       | `/admin/instance/domains`，可分页筛选 | 只使用本域日常接口                              | 只列本人可用空间         |
| 域创建申请审批                         | 指定申请 ID，审批结果审计             | 可依实例政策提出创建申请                        | 可依实例政策提出创建申请 |
| 创建 Domain                            | 管理员政策下创建；平台可治理          | 无跨域创建特权，依实例 admin/approval/open 政策 | 同样依实例政策及数量限制 |
| 域成员邀请用于注册                     | 受实例注册政策约束                    | 只有实例允许域注册邀请时可以签发相应邀请        | 接受邀请不获得管理身份   |
| 仅管理员开户政策                       | 通过平台账号管理                      | 不能借成员／班级邀请绕过                        | 不能自行注册绕过         |

平台管理员的能力来自当前服务端 `admin:full_access`，不是请求中声明的身份。
平台治理跨域操作有明确目标和审计；域权限只管理本域业务。 班级 CSV
匹配已有账号或生成邀请，不直接创建全站账号。 接受班级邀请在事务内加入所属 Domain
基础成员与班级学生，不授予其他班级或管理角色；
邀请绑定身份、有效期及使用规则，不能用于重置已有账号。

实现依据：[域治理目录](../../noj-core/src/modules/access/workspace/services/governance.ts)、
[域创建及审计](../../noj-core/src/modules/access/workspace/services/domains.ts)、
[班级邀请](../../noj-core/src/modules/education/services/invitations.ts)。

## 3. Domain 六种内置角色

下表「有」仍须满足域进入、资源归属、模块状态及时间条件；「本人」指服务实际校验创建者／维护者关系。
角色可以组合，能力按并集计算。Preset 仅初始化配置，不作为授权依据。

| 能力组                                   | 负责人 owner | 管理员 admin | 资源编辑者 editor | 教学人员 educator  | 社区管理员 moderator | 成员 member |
| ---------------------------------------- | ------------ | ------------ | ----------------- | ------------------ | -------------------- | ----------- |
| 获授权题目／题单读取、本人提交           | 有           | 有           | 有                | 有                 | 有                   | 有          |
| 正式提交、参赛、社区发布／评论           | 有           | 有           | 有                | 有                 | 有                   | 有          |
| 创建源题、编辑本人源题、发布             | 有           | 有           | 有                | 无                 | 无                   | 无          |
| 编辑／下架本域所有源题                   | 有           | 有           | 无                | 无                 | 无                   | 无          |
| 导入公开共享题、题单                     | 有           | 有           | 有                | 有                 | 无                   | 无          |
| 创建题单、编辑本人题单                   | 有           | 有           | 有                | 无                 | 无                   | 无          |
| 编辑所有本域题单、设置共享               | 有           | 有           | 无                | 无                 | 无                   | 无          |
| 设置源题共享及使用域有效版本策略         | 有           | 有           | 无                | 无                 | 无                   | 无          |
| 创建比赛、管理本人创建的比赛             | 有           | 有           | 有                | 无                 | 无                   | 无          |
| 管理本域所有比赛                         | 有           | 有           | 无                | 无                 | 无                   | 无          |
| 创建班级                                 | 有           | 有           | 无                | 有                 | 无                   | 无          |
| 管理任意本域班级                         | 有           | 有           | 无                | 无，需实际任职     | 无                   | 无          |
| 全域提交读取及重测                       | 有           | 有           | 无                | 无，按实际教学关系 | 无                   | 无          |
| 本域社区治理                             | 有           | 有           | 无                | 无                 | 有                   | 无          |
| 本域 Provider／默认模型／LLM 配额／用量  | 有           | 有           | 无                | 无                 | 无                   | 无          |
| 本域设置、普通成员与邀请、归档、基础限额 | 有           | 有           | 无                | 无                 | 无                   | 无          |
| 授予／移除管理员角色、移除管理员成员     | 有           | 无           | 无                | 无                 | 无                   | 无          |
| 转交负责人                               | 有           | 无           | 无                | 无                 | 无                   | 无          |

负责人不能直接退出、被移除或通过普通角色编辑降级。负责人交接在一个事务内更新
owner 引用与双方角色， 旧负责人保留管理员身份。平台管理员有明确的治理例外。
管理员不能通过普通成员编辑提升自己到负责人；对管理员身份的新增与移除均检查负责人关系。

所有内置角色都包含成员基础能力，但 public 域的匿名浏览者不是隐式成员。
编辑者只在本人资源上具有写入能力；跨域引用只授予使用，不授予编辑源题或读取源域提交。
域管理员的源码读取仍服从比赛组织关系与结果保密裁剪。

精确能力字符串与映射见
[域内角色实现](../../noj-core/src/modules/access/workspace/types.ts)， 角色修改及交接见
[成员服务](../../noj-core/src/modules/access/workspace/services/members.ts)。

## 4. Classroom、助教与作业访问

班级教练与学生身份来自当前有效班级关系；Domain
教学人员角色仅授予创建班级等域能力。 Domain
负责人／管理员和平台管理员可以治理本域班级，仍按班级路径与资源关系读取。

| 操作                                     | 教练／域教学治理者           | 助教必要能力                               | 学生                                           |
| ---------------------------------------- | ---------------------------- | ------------------------------------------ | ---------------------------------------------- |
| 读取学情矩阵及授权导出                   | 有                           | `progress:read`                            | 仅本人进度，不读取同学矩阵                     |
| 读取本班学生同域提交、文本／产物安全预览 | 有                           | `submissions:read`                         | 仅本人获授权原提交                             |
| 创建、发布、复制、管理作业               | 有                           | `assignments:manage`                       | 无                                             |
| 读取未发布作业草稿                       | 有                           | `assignments:manage`                       | 无                                             |
| 整体／学生反馈的教学写入与私人反馈读取   | 有                           | `feedback:write`                           | 读取面向本人及作业整体反馈                     |
| 创建／修改源码行批注                     | 有                           | `feedback:write` **且** `submissions:read` | 读取本人批注，不能写教师批注                   |
| 管理求助、读取他人求助、处理状态         | 有                           | `help:manage`                              | 本人求助及回复                                 |
| 管理学生成员／学生邀请                   | 有                           | `students:manage`                          | 无                                             |
| 任命教练、调整助教授权、班级交接／设置   | 有，按教练断言               | 固定助教能力不授予                         | 无                                             |
| 通过作业入口提交                         | 可正常练习；不能伪造学生入口 | 可正常练习；不能伪造学生入口               | 实际接收名单、有效学生／域关系、同域同题同绑定 |
| 撤回他人反馈／批注                       | 教练／域治理者按接口允许     | 助教只可处理本人记录                       | 无                                             |
| 修改反馈／批注正文                       | 原作者且具有当前教学授权     | 原作者且具有对应能力                       | 无                                             |

六项助教能力固定且独立，学情或源码读取不隐含私人反馈／求助权限。
代码行批注需要同时读取对应提交文本，不能只授予 `feedback:write`
后借批注接口读取源码。
归档班级、归档作业及停用教学模块保留获授权的历史读取，停止对应教学写入。

学生读取作业必须是实际 recipient 且已发布；历史离班学生可在仍能进入 Domain
时读取本人已有任务。 作业来源 `assignment_id + assignment_item_id`
记录实际入口，不是新的提交授权凭据，也不决定提交只计入这一份任务。
受理事务检查来源的发布状态、学生名单、班级／域关系、题目与绑定；普通无来源练习不因此读取教学配置。
截止和提前结束改变按时统计范围，获授权补做仍可保留来源；升级副本保留原来源，重测不改写入口。

[班级授权](../../noj-core/src/modules/education/services/access.ts)、
[作业访问](../../noj-core/src/modules/education/services/assignment-access.ts)、
[固定助教能力](../../noj-core/src/shared/education-types.ts)、
[互动访问](../../noj-core/src/modules/education/services/interaction-access.ts)、
[提交文本授权](../../noj-core/src/modules/education/services/submission-text.ts)、
[作业入口受理](../../noj-core/src/modules/education/services/assignment-submission-origin.ts)。

## 5. 比赛组织关系与结果字段

Organizer 是当前使用域的关系：平台管理员、本域 `contest:manage`， 或具有
`contest:manage_own`
且创建了该比赛的人。源题维护者、教练和其他域管理员都不自动成为 Organizer。
Participant
必须具有当前可用域成员关系并已报名，读取／提交还检查比赛题目和时间窗口。

| 操作                                 | Organizer                    | Participant                      | 教练／助教但不是 Organizer               | 其他可进入域的用户          |
| ------------------------------------ | ---------------------------- | -------------------------------- | ---------------------------------------- | --------------------------- |
| 比赛配置、授权管理视图、正式成绩发布 | 有                           | 无                               | 无                                       | 无                          |
| 私有比赛读取                         | 按组织能力                   | 按报名关系                       | 需组织或报名关系                         | 404；加入入口另校验报名政策 |
| 比赛作答                             | 仍须满足相应作答／报名规则   | 赛题、固定版本、受理窗口         | 同参赛者规则                             | 无未授权作答                |
| 赛时本人结果                         | 管理视图可检查正式依据       | 按赛制 DTO                       | 不因教学身份放宽                         | 不读取他人结果              |
| 教学读取正在比赛内的学生提交         | 有组织能力时允许相应管理视图 | 本人视图                         | 教学全提交视图排除尚未结束比赛           | 无                          |
| 完整榜与补题选人依据                 | 按组织权限                   | 按榜单可见性、封榜及正式发布状态 | 教学权限不能绕过榜单，需授权完整成绩来源 | 依榜单公开范围              |

| 赛制     | 赛时本人 `result_visibility` | 允许内容                                                                    | 默认赛时榜               |
| -------- | ---------------------------- | --------------------------------------------------------------------------- | ------------------------ |
| Kaggle   | cases                        | AI 使用既有反馈裁剪；客观题只有原始总分                                     | 本人榜，按赛前配置       |
| OI       | hidden                       | 受理身份、原代码和中性 submitted 状态；不返回成绩、判定、耗时／内存或测试点 | 隐藏成绩榜               |
| IOI      | cases                        | 汇总与测试点／子任务的编号、判定、分数、耗时／内存                          | 参赛者完整实时榜         |
| IOI 严格 | summary                      | 汇总判定、分数及允许汇总字段，无测试点／子任务                              | 参赛者完整实时榜         |
| ACM/ICPC | summary                      | 汇总判定及适用的受限编译诊断，无测试数据                                    | 实时榜，封榜期按冻结视图 |

`cases` 不表示允许测试输入、标准答案、隐藏输出、存储路径或任意原始 evaluator
文本。 OI/IOI/ACM 视图使用字段允许列表；Kaggle 沿用其已实现的反馈裁剪。
所有赛中客观题视图不返回标准答案、解析或逐题正确性，出题者参赛身份不能借题面／草稿入口恢复答案。
参赛维护者的管理内容入口受 `CONTEST_AUTHORING_RESTRICTED`
限制，具有该场组织权限的管理视图除外。
限制只作用于比赛的使用域，不因学校引用公开题而隐藏源域或其他学校的公开练习。

相同使用域内进行中的赛题不能通过普通练习、自测、升级或作业入口获得隐藏反馈。
比赛成绩在允许结果公开前不进入作业矩阵、公开统计和题单进度。
赛后本人结果解除赛时字段限制，但资源授权仍需校验；正式榜继续使用发布快照，后续重测不自动改写。

实现依据：[比赛关系](../../noj-core/src/modules/contests/services/domain-access.ts)、
[比赛题目／窗口](../../noj-core/src/modules/contests/services/contest-access.ts)、
[结果裁剪](../../noj-core/src/modules/evaluations/services/submissions/submission-projection.ts)、
[参赛出题者限制](../../noj-core/src/modules/problems/services/workspace/problem-contest-authoring.ts)、
[教学成绩依据](../../noj-core/src/modules/contests/services/teaching-basis.ts)。

## 6. 撤销、离班、离域与旧治理入口

| 变化                                                 | 后续访问及写入                                                                 | 保留的历史                                           | 授权依据                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------- |
| 源题转私有、取消共享、源绑定下架、源域暂停或不再公开 | 目标域内容、附件、版本、正式提交、自测、新升级／重测执行拒绝；已受理评测可完成 | 已有成绩、本人原提交、已有反馈／批注；不返回隐藏数据 | 每次读取当前源域、源绑定与共享目标授权            |
| 学生离班                                             | 停止新任务与全部后续个人练习的教师读取；停止作业入口来源受理                   | 该班已有任务与历史接收区间、原批注依据               | 当前有效关系，或历史 recipient 时间区间／已有批注 |
| 教练／助教离职或移除                                 | 后续请求、通知、SSE 重新检查，失去班级访问                                     | 原反馈与批注保留作者依据                             | 当前任职与 grants，不使用历史任职授予权限         |
| 用户离域                                             | 私有域普通资源停止访问，域写入能力撤销；公开资源仍按公开政策                   | 统一本人提交历史提供受控原代码／答案和成绩摘要       | 本人身份不恢复域题面或其他人的数据                |
| Domain／Classroom 归档                               | 获授权历史只读                                                                 | 历史提交、教学依据与互动                             | 域进入和班级关系仍需检查                          |
| 教学模块停用                                         | 新教学写入停止；停用期间练习不自动回填教学进度                                 | 获授权历史读取及停用区间                             | 对应功能边界，而非要求后台及时切换生命周期        |

教师读取当前班级学生的全部同域提交，不扩展到其他 Domain。
离班后的历史读取仅覆盖已有作业信用时间区间或该班已有批注依据，并检查归档上界和比赛结束／组织权限。
查询、计数和分页使用相同授权条件；本人跨域历史不向公共主页增加私有域通过数或活跃数据。

旧无域业务入口固定 `main`，不使用上次工作空间偏好。 旧
`/admin/community/reports` 与 `/content-review` 默认混合列表要求 main
当前可进入且社区模块可用； `reports?content_type=message`、审核队列
`channel=dm`／`content_type=message` 是明确账号私信专项，独立于 main。
统一审核快照按真实目标域或服务器保存的 `meta.domain_id`
定位；其他域或未知归属的孤立记录不借用 main。

实现依据：[当前教师关系 SQL](../../noj-core/src/modules/education/services/submission-access-sql.ts)、
[教学历史提交](../../noj-core/src/modules/education/services/student-submissions.ts)、
[本人历史 DTO](../../noj-core/src/modules/evaluations/services/own-submission-history.ts)、
[共享实时检查](../../noj-core/src/modules/problems/services/workspace/problem-binding-access.ts)、
[旧治理路由](../../noj-core/src/modules/http/admin/routes/community.ts)。

## 7. Provider、限额与平台敏感评测字段

| 资源／操作                        | 域权限                                                     | 平台／执行限制                                                                                                         |
| --------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 本域 Provider、默认模型、LLM 用量 | `llm:manage`；目前由负责人／管理员拥有                     | Gateway 全部查询限定当前域，普通其他域管理员不能列出名称、地址、掩码或用量                                             |
| Provider 密钥                     | 可提交本域密钥                                             | Gateway 加密；客户端列表不返回明文；历史 Provider 保留，只停用                                                         |
| 引用源域 LLM 题                   | 使用域成员正常提交                                         | Provider／模型由使用域决定；新域未配置返回 `DOMAIN_LLM_NOT_CONFIGURED`，不借用源域密钥                                 |
| 一次 LLM 评测                     | 不通过客户端选择任意 Provider                              | 尝试冻结域、Provider、模型、预算；token protocol v3 含强制 domain_id，Gateway 核对 Provider 域                         |
| 本域 LLM 日／月额度               | `llm:manage`，域管理员只能降低已有域总额并受实例 caps 限制 | 实例 global 额度仅平台管理；Redis 预占／结算键含域；单尝试计量独立                                                     |
| 基础成员／题库条目／存储／频率    | `domain:limits` 修改本域配置                               | 受实例默认／上限约束；显式 null 为未限制，0 为禁止；缺少配额行是初始化异常，不能当作无限                               |
| Provider／quota 更新              | 本域治理能力及资源 revision                                | 创建 If-Match=0；更新使用该资源 revision；Gateway DB 原子比较，不用 domain.revision 替代                               |
| 本域模型别名治理                  | `llm:manage`；按使用域与 alias 定位                        | 新建 If-Match=0，更新／删除用别名 revision；core DB 原子比较，本域 Provider 归属检查；default 保留别名使用本域默认配置 |
| 出题人模型能力目录                | 当前域 `problem:create`                                    | 只返回 alias／description；发布验证能力名称语法，评测时在使用域解析模型集合且只使用同一 Provider，不借源域映射         |
| Provider RPM／TPM                 | 本域 Provider 治理权限与资源 revision                      | `0` 不额外限制；执行同时检查 Gateway 请求／Token 限流及实例／域预算，不改变评测尝试冻结的模型依据                      |
| LLM 请求正文和响应原文            | LLM 管理能力不授予                                         | 域用量 DTO 只返回计量与定位允许字段，不透传 prompt、response、evaluator details                                        |
| 自定义 evaluator.command          | 源题维护能力之外另查平台权限                               | `problem:field_evaluator_command`；仅生效值相对基线变化触发敏感字段授权                                                |
| evaluator 网络                    | 源题维护能力之外另查平台权限                               | `problem:field_evaluator_network`；LLM 题需合法启用 evaluator 网络                                                     |
| 镜像及时间／内存资源              | 域题库管理不突破平台限制                                   | 发布验证镜像类型与允许范围，资源受 `judge_max_*` 等平台上限限制                                                        |

Gateway 与 core 使用独立数据库，不存在跨数据库 Provider 外键。 Provider
归属由服务 token、域参数、可信尝试与 Gateway 查询共同校验。 Gateway
`llm_providers.domain_id` 和用量域字段已 NOT NULL；global quota 的 `domain_id`
使用空字符串， 它不是一个产品 Domain，也不是 SQL NULL。API quota 未限制使用
null，Gateway 内部历史数值用 -1 表示未限制。

实现依据：[域 LLM 管理](../../noj-core/src/modules/platform/gateway/services/domain-management.ts)、
[可信 LLM token](../../noj-core/src/modules/platform/gateway/services/llm-token.ts)、
[Gateway 原子更新](../../noj-llm-gateway/src/routes/internal.ts)、
[基础配额](../../noj-core/src/modules/access/workspace/services/limits.ts)、
[域模型别名](../../noj-core/src/modules/platform/gateway/services/llm-model-aliases.ts)、
[敏感评测字段](../../noj-core/src/modules/problems/services/problems/problem-field-guard.ts)、
[草稿／发布安全](../../noj-core/src/modules/problems/services/versioning/content-security.ts)。

## 8. 数据库约束与服务不变量

「数据库」表示当前
Schema／迁移已有约束；「服务」表示受理、修改或授权代码检查，不能等同于数据库
CHECK。 外键证明身份关联存在，不证明关联对象目前
active，也不证明当前用户拥有权限。

| 对象／关系                                | 已有数据库约束                                                                                                       | 服务补充检查                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| domains                                   | slug 唯一及格式、状态／preset 枚举、配置为 JSON object、非负 revision、owner 指向账号                                | slug 创建后不变；完整配置与模块依赖；负责人交接事务保持有效负责人                            |
| domain_memberships／roles                 | domain/user NOT NULL，域×用户唯一，成员状态与角色枚举，成员×角色主键                                                 | 当前账号／成员有效；只有负责人或平台治理管理管理员身份；owner 不由普通角色接口授予           |
| domain_limits／counters                   | 每域配额主键，非负有限数值；counter 域×资源主键且 used/reserved 非负                                                 | 创建域同时建立限额与计数；写前原子检查／预留／释放；不存在自动修复缺失行                     |
| problems／trainings 源归属                | 两表 domain_id **已 NOT NULL**；源题 `(domain_id, number)` 唯一，源资源身份复合唯一                                  | 创建使用明确域；原子题号分配；引用不复制源字节、不分配目标本地题号                           |
| domain_problem_bindings                   | domain/problem NOT NULL；同域同源唯一；kind/visibility/revision 与 any/exact CHECK；exact 版本复合 FK 属于源题       | owned 必须对应本域源题、shared 必须对应其他源域；共享及比赛状态实时校验                      |
| classroom 与 membership                   | 非空域；班级域复合身份；教练账号属于同域成员；班级成员与同域成员／班级复合 FK，角色及状态 CHECK                      | 活跃任职与 grants、教练交接、自我提升限制、邀请注册政策                                      |
| classroom_assistant_grants                | 成员×capability 唯一，固定六项能力 CHECK                                                                             | 仅教练／域治理任命，不能由助教给自己提升能力                                                 |
| classroom_join_requests                   | 同班级×用户只有一份 pending 请求的部分唯一索引                                                                       | 审核在明确目标班级核对成员、当前处理权限与请求状态；不存在 SQL NULL 的域归属例外             |
| assignments                               | 非空域，班级×域 FK，来源作业／比赛同域 FK，状态／revision 与定时／发布依据非空 CHECK                                 | 发布时间与截止窗口校验；发布事务固定题集、达标规则、初始名单，校验共享；已发布内容不直接编辑 |
| assignment_items                          | 同域作业／绑定 FK，绑定×源题 FK，作答／要求版本属于源题，排序与策略 CHECK                                            | 发布依据保留；当前策略和版本变化记录历史并重算                                               |
| assignment_recipients                     | 同作业学生唯一；同域同班作业与成员 FK                                                                                | 实际目标学生、自动补入未截止任务、离班信用区间与历史名单                                     |
| assignment_progress                       | 条目×学生×统计范围唯一，条目／作业／接收名单 FK，统计范围／状态／分数 CHECK                                          | 候选同域、版本口径、按时／补做时间、比赛保密、来源正式尝试；幂等事实重算                     |
| 提交／客观题／自测的绑定                  | 域与绑定 NOT NULL；`(domain_id, binding_id)` 与 `(binding_id, problem_id/paper_id)` 复合 FK                          | 新写入实际域和绑定来自可信执行上下文；外部输入不能覆盖                                       |
| 作业入口三表                              | 来源两字段同时 NULL 或同时非 NULL；同域作业条目与题目复合 FK                                                         | 实际学生资格、名单、发布／归档／模块、题目绑定在受理事务核对；来源不授予成绩或读取权限       |
| submission_jobs／items                    | 两表域 NOT NULL；job×域、binding×域、binding×题目复合 FK；只有 failed/skipped 可空绑定；状态／序号／重试次数 CHECK   | 有效任务条目执行前重新验证；无效来源条目可明确失败／跳过，不假造有效绑定                     |
| contests／contest_problems                | 比赛域、赛题域与绑定 NOT NULL；contest×域、binding×域、binding×源题、固定／要求版本×源题复合 FK                      | 合法赛制题型、组织关系、发布／固定版本、赛后不能写入原比赛上下文                             |
| 提交／客观题比赛上下文                    | 两表 `(domain_id, contest_id)` 指向同域比赛；练习允许空比赛；删除比赛仅清空 contest_id                               | 受理时间、参赛身份、题目集合及保密窗口仍在服务验证                                           |
| community boards/posts/comments/sanctions | 域 NOT NULL；post×board×域、post×binding×域／源题，comment×post×域／parent 复合 FK；题解必须有绑定，讨论／动态无绑定 | 当前模块、板块、共享源及比赛门控；治理目标固定在路径域                                       |
| community reports/notifications/actions   | 举报／通知的帖子和评论同域复合 FK；类型区分域内容与账号事件；内容通知删除目标后仍须有原域                            | report 通知由真实举报记录定位；多态审核 target_id 的实际资源关系由服务核对                   |
| feedback/help/replies                     | 非空域与同域作业／recipient／条目／求助复合 FK，正文／状态／revision CHECK                                           | 私人互动能力独立；目标提交的同域／学生关系由服务核对，不声称普通 ID FK已证明这些关系         |
| submission_annotations                    | 非空域；同域班级、同域原提交×学生复合 FK；SHA-256 格式、行范围、正文与 revision CHECK                                | 原提交授权、实际文件和行数／哈希、比赛保密、作者编辑及受控 ZIP 预览                          |
| education notifications/outbox            | 非空域；同域资源复合 FK；event×recipient 去重；通知类型与关联字段组合 CHECK                                          | 每次列表、发送、点击和 SSE 推送重新授权，只推定位，不保存私有正文摘要                        |
| education_outbox 的矩阵刷新定位           | assignment.refresh 未处理记录按域×作业×COALESCE(user_id,'') 部分唯一                                                 | 合并同一范围的待处理刷新；领取租约、处理 revision 和最新事实重算仍由消费者执行               |
| llm_model_aliases                         | domain_id NOT NULL；(domain_id, alias) 复合主键；revision ≥0 CHECK                                                   | default 不写表；管理者只写本域，Provider 属于同域；Gateway 独立数据库不伪造跨库 Provider FK  |

约束依据：[工作空间 Schema](../../noj-core/src/shared/db/schema/workspace.ts)、
[源题及版本](../../noj-core/src/shared/db/schema/catalog.ts)、
[绑定](../../noj-core/src/shared/db/schema/catalog-workspace.ts)、
[教学组织](../../noj-core/src/shared/db/schema/education.ts)、
[作业](../../noj-core/src/shared/db/schema/assignment.ts)、
[互动](../../noj-core/src/shared/db/schema/education-interactions.ts)、
[批注](../../noj-core/src/shared/db/schema/submission-annotations.ts)、
[提交](../../noj-core/src/shared/db/schema/submission.ts)、
[客观题](../../noj-core/src/shared/db/schema/objective.ts)、
[比赛](../../noj-core/src/shared/db/schema/contest.ts)、
[社区](../../noj-core/src/shared/db/schema/community.ts)。

### 8.1 具有明确业务意义的可空列

源题、题单及执行归属已收缩。原主题分支 0137 将三种单次执行的域与绑定、批量任务
及条目的域设为 NOT NULL；0138 收缩比赛及赛题归属并约束提交的同域比赛上下文；
0139 按真实父关系收缩社区内容归属并增加 mixed 数据约束。这些变更已整合入接续
main 的 0116，保留存量回填与原始身份。0116 同时将模型别名归入使用域，旧平台
别名归 main；0117 补齐班级加入申请和教学刷新事件的 pending 部分唯一索引。
任务条目的空绑定只允许失败或跳过的历史引用。下列可空列有明确产品语义，不能一律非空。

| 表                                         | 当前仍可空的工作空间列    | 后续收缩需区分                                                                                           |
| ------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------- |
| submission_job_items                       | domain_problem_binding_id | CHECK 限定为空时只能 failed/skipped，保留已删除来源历史                                                  |
| community_posts                            | domain_problem_binding_id | 仅 solution 非空；discussion／moment 必须为空                                                            |
| community_moderation_actions               | domain_id                 | message／user_ban 账号历史为空；其他域审核目标非空                                                       |
| community_reports、community_notifications | domain_id                 | 私信举报、全站关注及账号封禁为空；reply／like／moderation／clarification 通知非空；report 由真实举报决定 |
| education_disabled_intervals               | domain_id                 | 空域表示实例级停用区间；域级区间保存实际域                                                               |

PostgreSQL 复合 FK 采用默认 MATCH SIMPLE；归属非空列与类型 CHECK
限定可以跳过关系的合法业务形态。账号举报／通知的空域不授予域资源访问。
普通与客观题提交的非空比赛上下文已有同域 FK；外键不代替当前访问授权。

以下空值具有正常业务意义，应保留：普通练习无
contest_id、无作业来源的来源两字段、 any 策略无
required_version_id、未开始进度无来源提交／尝试、整体作业反馈无特定学生、
全站账号事件无 Domain、教育 outbox 的可选定位、用户无上次工作空间偏好。
`evaluation_attempts` 不另存可被回调覆盖的 Domain，其归属沿可信原提交确定。

## 9. 门面、错误与审计边界

跨源码业务模块经公开 `index.ts` 门面调用；本模块内部 helper
不是给客户端授予权限的开关。

| 门面                                                                           | 主要授权职责                                             | 调用者仍需完成                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------- |
| workspace `loadWorkspace`／`assertWorkspacePermission`                         | 实例、账号、域进入及域能力                               | 具体模块、资源、比赛窗口与 DTO               |
| catalog `resolveDomainProblem`／版本与共享服务                                 | 使用域绑定、源授权、目标作答版本                         | 已知上下文下的正式提交／自测受理与预算       |
| contest `loadDomainContest`／`verifyContestAccess`／`loadContestTeachingBasis` | 路径域、组织／报名、题目窗口、授权成绩来源               | 本人结果裁剪、教学习题权限与正式快照发布流程 |
| education `loadClassroom`／`loadAssignment`／来源与教师读取门面                | 任职、固定能力、实际名单及教学历史依据                   | 对应操作 revision、文本作者、源题及比赛保密  |
| submission/objective 正式受理与专用读取门面                                    | 可信执行上下文、版本、排队和 DTO                         | 不接受调用者自行构造域覆盖值                 |
| gateway 域管理与 token 门面                                                    | llm:manage、域 Provider、远端原子 revision、冻结尝试计量 | 不将 LLM 管理能力当作比赛或源码权限          |
| community `withDomainCommunity`／`withDefaultCommunity`                        | 当前模块、路径域、板块／资源授权及事务                   | 具体治理能力、账号私信与域内容的明确分类     |

| 情况                                                     | 当前稳定处理                                                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 未认证而实例／接口要求认证                               | 401                                                                                                                              |
| 不可进入域、错误路径域、不可见资源、其他域共享／审核目标 | 404，不确认资源存在                                                                                                              |
| 已可见但缺域／班级操作能力                               | 403；`DOMAIN_PERMISSION_DENIED`／`CLASSROOM_PERMISSION_DENIED`                                                                   |
| 域只读、班级／作业归档                                   | 403；`DOMAIN_READ_ONLY`、`CLASSROOM_READ_ONLY`、`ASSIGNMENT_READ_ONLY`                                                           |
| 模块停用                                                 | 403；通用 `DOMAIN_MODULE_DISABLED`，教学边界保留 `MODULE_DISABLED`                                                               |
| 必需 revision 缺失                                       | 428 `REVISION_REQUIRED`；草稿等既有接口使用其现有专用契约                                                                        |
| revision 冲突                                            | 409 `REVISION_CONFLICT`；草稿／哈希等继续使用专用冲突 code                                                                       |
| 参赛维护者进入管理数据                                   | 403 `CONTEST_AUTHORING_RESTRICTED`                                                                                               |
| LLM 未配置／额度突破                                     | 未配置 `DOMAIN_LLM_NOT_CONFIGURED`；caps `DOMAIN_LLM_QUOTA_CAP_EXCEEDED`；域管理员提升额度 `DOMAIN_LLM_QUOTA_INCREASE_FORBIDDEN` |
| 持久策略或绑定不一致                                     | 503，保留脱敏诊断；不退化为公开访问或无限额度                                                                                    |

本文不将旧 admin 各接口的可选乐观锁描述为统一强制 If-Match。
新工作空间、教学及域 LLM 接口按各自 revision
契约执行；旧接口是否必填需查其路由。 幂等结果在授权后返回；教学操作的 DB
唯一范围含 Domain、actor、操作类型和
key，存定位及摘要，不保存邀请码明文或学生源码。

`workspaceAudit` 在业务事务内写入 actor、action、目标 type/id 及可信
`detail.domain_id`。 实例创建申请、审批等实例级动作可以没有 Domain，但仍有明确
request 目标，不能用空域表示可操作所有域。
平台治理读取与各模块敏感读取按其门面写审计；不能声称所有普通读取都会产生审计。
通知和 SSE
只推受控定位，客户端重新读授权接口，成员撤销后不能凭旧连接继续取私有正文。

实现依据：[workspace 门面](../../noj-core/src/modules/access/workspace/index.ts)、
[education 门面](../../noj-core/src/modules/education/index.ts)、
[审计目标](../../noj-core/src/modules/access/workspace/services/domains.ts)、
[错误体系](../../noj-core/src/shared/base/errors.ts)、
[模块边界规范](domain-boundaries.md)。
