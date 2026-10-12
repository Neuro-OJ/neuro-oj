/** 教学模块公开门面，其他模块不得深路径调用教学实现。 */
export * from "./services/access.ts";
export * from "./services/classrooms.ts";
export * from "./services/members.ts";
export * from "./services/account-lifecycle.ts";
export * from "../../shared/education-types.ts";
