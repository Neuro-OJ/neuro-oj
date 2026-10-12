# education

教学组织、作业、学情、反馈、求助和补题的业务模块。产品 Domain 由 workspace
解析，教学资源始终携带 domain_id，不以全站账号角色代替班级关系。

Classroom 的教练、助教、学生身份在数据库读取；助教只组合六项固定能力。班级
归档和退出保留身份及历史，管理变更使用 revision。跨模块仅使用 index.ts 门面，
评测与题库策略通过共享持久事件驱动教学进度，不由 shared 反向依赖本模块。

验证使用 `deno task test:domain education`。生产路由按升级计划等待完整资源隔离
验收后开放，未挂载的准备接口不代表教学阶段完成。
