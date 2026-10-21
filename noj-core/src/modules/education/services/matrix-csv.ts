import {
  type AssignmentMatrixOptions,
  getAssignmentMatrix,
} from "./progress-read.ts";
import type { AssignmentProgressStatus } from "../../../shared/education-types.ts";

function cell(value: string | number | null) {
  const text = String(value ?? "");
  const safe = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

const statusLabels = {
  not_started: "未开始",
  judging: "评测中",
  below_target: "未达标",
  achieved: "已达标",
  unavailable: "资源不可用",
  updating: "更新中",
} satisfies Record<AssignmentProgressStatus | "updating", string>;

/** CSV 每页重新验证教学身份并按需输出，保留更新中标记，不导出过期口径的分数。 */
export async function exportAssignmentMatrixCsv(
  slug: string,
  id: string,
  actorId: string,
  options: Omit<AssignmentMatrixOptions, "page"> = {},
) {
  const first = await getAssignmentMatrix(slug, id, actorId, {
    ...options,
    page: 1,
  });
  async function* chunks() {
    yield "\uFEFF" +
      [
        "用户ID",
        "用户名",
        "名单状态",
        ...first.items.flatMap((item) => [
          `${item.reference.display_ref} 状态`,
          `${item.reference.display_ref} 分数`,
          `${item.reference.display_ref} 已通过`,
          `${item.reference.display_ref} 逾期`,
        ]),
      ].map(cell).join(",") + "\r\n";
    let matrix = first;
    for (let page = 1;; page++) {
      yield matrix.rows.map((row) =>
        [
          row.user_id,
          row.username,
          row.recipient_status === "active" ? "当前学生" : "历史学生",
          ...row.cells.flatMap((progress) => [
            statusLabels[progress.status],
            progress.score === null ? null : progress.score / 100,
            progress.accepted ? "是" : "否",
            progress.late ? "是" : "否",
          ]),
        ].map(cell).join(",")
      ).join("\r\n") + (matrix.rows.length ? "\r\n" : "");
      if (page * matrix.per_page >= first.total) break;
      matrix = await getAssignmentMatrix(slug, id, actorId, {
        ...options,
        page: page + 1,
      });
    }
  }
  return chunks();
}
