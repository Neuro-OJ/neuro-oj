import { BadRequestError } from "../base/errors.ts";
import type { AssignmentSubmissionOrigin } from "../education-types.ts";

/** 解析显式作业来源。JSON 从 body 读取，流式产物从 URL query 读取。 */
export function parseAssignmentOrigin(
  input: Record<string, unknown>,
): AssignmentSubmissionOrigin | undefined {
  const assignment = input.assignment_id, item = input.assignment_item_id;
  if (assignment === undefined && item === undefined) return undefined;
  if (
    typeof assignment !== "string" || !assignment || typeof item !== "string" ||
    !item
  ) {
    throw new BadRequestError(
      "assignment_id 与 assignment_item_id 必须同时提供非空字符串",
    );
  }
  return { assignment_id: assignment, assignment_item_id: item };
}
