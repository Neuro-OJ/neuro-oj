import { type AnyColumn, type SQL } from "drizzle-orm";
import { domainTeacherWhere } from "../../workspace/index.ts";

/** 域内现任教练可读取全域提交；班级归属和旧助教授权不产生源码权限。 */
export function currentTeacherSubmissionAccessWhere(
  studentId: AnyColumn | SQL | string,
  domainId: AnyColumn | SQL | string,
  actorId: AnyColumn | SQL | string,
): SQL {
  // studentId 保留为现有跨域门面契约；提交所属域由调用方限定。
  void studentId;
  return domainTeacherWhere(domainId, actorId);
}
