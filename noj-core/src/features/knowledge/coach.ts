/**
 * 教练视角（P4）：班级掌握矩阵与按知识点挑题。
 *
 * 权限由路由层用 `loadClassroom` + `assertClassroomCoach` 判定（域教练、域管理员
 * 或平台管理员）；本文件只做取数与拼装。阶梯可见性仍按普通口径读取——
 * 教练也不得看到进行中比赛 / 保密保护期题目（{@link readKnowledgePick}）。
 *
 * - 掌握矩阵：一次取回班级学生与（学生 × 节点）掌握记录，不逐学生/节点查库；
 * - 挑题：复用 P2 阶梯读取 {@link loadLadderItems}（已发布、域绑定可用、非进行中
 *   比赛 / 保密保护期），在难度序列上均匀抽样，不创建作业。
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../shared/db/connection.ts";
import {
  classroomMemberships,
  knowledgeNodes,
  userKnowledgeMastery,
  users,
} from "../../shared/db/schema.ts";
import { readKnowledgeGraph } from "./graph.ts";
import { loadNodeProblems } from "./mastery.ts";
import { type LadderItem, loadLadderItems } from "./difficulty.ts";

/** 班级掌握矩阵（`GET /domains/:slug/classrooms/:id/knowledge-mastery`）。 */
export interface ClassMasteryView {
  classroom_id: string;
  students: {
    user_id: string;
    username: string;
    /** 账号资料暂无昵称列，恒为 null（保持合同字段）。 */
    display_name: string | null;
  }[];
  areas: {
    id: string;
    name: string;
    nodes: {
      id: string;
      name: string;
      problem_count: number;
      counts: { mastered: number; learning: number; none: number };
    }[];
  }[];
  /** 稀疏：`{ [user_id]: { [node_id]: "learning" | "mastered" } }`，`none` 省略。 */
  cells: Record<string, Record<string, "learning" | "mastered">>;
}

/** 班级活跃学生（按 username 排序；已注销账号不列）。 */
async function loadClassStudents(classroomId: string) {
  return await getDb().select({
    user_id: users.id,
    username: users.username,
  }).from(classroomMemberships).innerJoin(
    users,
    eq(users.id, classroomMemberships.user_id),
  ).where(and(
    eq(classroomMemberships.classroom_id, classroomId),
    eq(classroomMemberships.status, "active"),
    eq(classroomMemberships.role, "student"),
  )).orderBy(users.username, users.id);
}

/**
 * 班级掌握矩阵。
 *
 * 节点集合 = 本域有可访问题目（`problem_count > 0`）或班级成员有掌握记录的
 * 非废弃节点；按领域/节点 sort 排序，空领域不出现。cells 只含 learning /
 * mastered，counts 三项之和恒等于学生数（无记录按 none 计）。
 */
export async function readClassMastery(
  classroomId: string,
  domain: { id: string; slug: string },
): Promise<ClassMasteryView> {
  const db = getDb();
  const [students, graph, domainProblemRows] = await Promise.all([
    loadClassStudents(classroomId),
    readKnowledgeGraph(),
    loadNodeProblems(db),
  ]);
  const studentIds = students.map((s) => s.user_id);

  // 本域可访问题目数（与 P2/P3 同口径：已发布、绑定未禁用、源域未停用）。
  const problemCounts = new Map<string, number>();
  for (const row of domainProblemRows) {
    if (row.domain_id !== domain.id) continue;
    problemCounts.set(row.node_id, (problemCounts.get(row.node_id) ?? 0) + 1);
  }

  // 班级成员的掌握记录：一条聚合 SQL（学生 × 节点）。
  // 聚合 SQL 按（学生 × 节点）一次取回，不逐学生 / 逐节点查询。
  type MasteryRecord = {
    user_id: string;
    node_id: string;
    state: "learning" | "mastered";
  };
  const records: MasteryRecord[] = studentIds.length === 0 ? [] : await db
    .select({
      user_id: userKnowledgeMastery.user_id,
      node_id: userKnowledgeMastery.node_id,
      state: userKnowledgeMastery.state,
    })
    .from(userKnowledgeMastery)
    .where(and(
      inArray(userKnowledgeMastery.user_id, studentIds),
      inArray(
        userKnowledgeMastery.state,
        ["learning", "mastered"],
      ),
    )) as MasteryRecord[];

  const recordedNodes = new Set(records.map((r) => r.node_id));
  const cells: Record<string, Record<string, "learning" | "mastered">> = {};
  for (const record of records) {
    (cells[record.user_id] ??= {})[record.node_id] = record.state;
  }

  const included = graph.nodes.filter((node) =>
    (problemCounts.get(node.id) ?? 0) > 0 || recordedNodes.has(node.id)
  );
  const byArea = new Map<string, typeof included>();
  for (const node of included) {
    const list = byArea.get(node.area) ?? [];
    list.push(node);
    byArea.set(node.area, list);
  }

  const areas: ClassMasteryView["areas"] = [];
  for (const area of graph.areas) {
    const nodes = byArea.get(area.id);
    if (!nodes || nodes.length === 0) continue;
    areas.push({
      id: area.id,
      name: area.name,
      nodes: nodes.map((node) => {
        const counts = { mastered: 0, learning: 0, none: 0 };
        for (const studentId of studentIds) {
          const state = cells[studentId]?.[node.id];
          if (state === "mastered") counts.mastered++;
          else if (state === "learning") counts.learning++;
          else counts.none++;
        }
        return {
          id: node.id,
          name: node.name,
          problem_count: problemCounts.get(node.id) ?? 0,
          counts,
        };
      }),
    });
  }

  return {
    classroom_id: classroomId,
    students: students.map((student) => ({
      user_id: student.user_id,
      username: student.username,
      display_name: null,
    })),
    areas,
    cells,
  };
}

// ── 按知识点挑题 ─────────────────────────────────────────

/** 挑题默认与上限。 */
export const PICK_DEFAULT_COUNT = 5;
export const PICK_MAX_COUNT = 20;

/** 挑题结果（`GET /domains/:slug/classrooms/:id/knowledge-pick`）。 */
export interface KnowledgePickView {
  node_id: string;
  node_name: string;
  items: {
    problem_id: string;
    number: number | null;
    /**
     * 作业编辑器使用的题目引用：本域题为题号，跨域共享题为「来源域:题号」
     * （与 `domainProblemReference` 的 `display_ref` 规则一致）；无题号为 null。
     */
    display_ref: string | null;
    title: string;
    difficulty: number;
    tier: LadderItem["tier"];
  }[];
}

/**
 * 在难度升序序列上均匀抽样：第 i 个取下标 `round(i*(n-1)/(count-1))`。
 *
 * `count >= n` 时全部返回；`count = 1` 取中位（`n` 为奇数时恰为中位，偶数时取
 * 靠后的一道）。返回序列保持原顺序（难度升序）。
 */
export function sampleEvenly<T>(items: readonly T[], count: number): T[] {
  const n = items.length;
  if (count <= 0 || n === 0) return [];
  if (count >= n) return [...items];
  if (count === 1) return [items[Math.floor(n / 2)]!];
  const picked: T[] = [];
  let previous = -1;
  for (let i = 0; i < count; i++) {
    // 向上取整，避免浮点误差把边界下标抹掉。
    const index = Math.min(
      n - 1,
      Math.ceil((i * (n - 1)) / (count - 1)),
    );
    if (index === previous) continue;
    picked.push(items[index]!);
    previous = index;
  }
  return picked;
}

/**
 * 读取节点（必须 active）并返回挑题结果；节点不存在或已废弃 → null。
 *
 * 候选复用 {@link loadLadderItems}（主知识点、已发布、域绑定可用、非进行中比赛 /
 * 保密保护期），难度升序。教练不是阶梯学习者，`passed` 不参与。
 */
export async function readKnowledgePick(input: {
  nodeId: string;
  count: number;
  domain: { id: string; slug: string };
}): Promise<KnowledgePickView | null> {
  const [node] = await getDb().select({
    id: knowledgeNodes.id,
    name: knowledgeNodes.name,
  }).from(knowledgeNodes).where(and(
    eq(knowledgeNodes.id, input.nodeId),
    eq(knowledgeNodes.status, "active"),
  ));
  if (!node) return null;
  // 保护期题目即使对教练也不得暴露（设计第 11 节），因此不用 is_admin 放行。
  const items = await loadLadderItems(input.nodeId, input.domain.id, null);
  const picked = sampleEvenly(items, input.count);
  return {
    node_id: node.id,
    node_name: node.name,
    items: picked.map((item) => ({
      problem_id: item.problem_id,
      number: item.number,
      display_ref: item.number === null
        ? null
        : item.domain === input.domain.slug
        ? String(item.number)
        : `${item.domain}:${item.number}`,
      title: item.title,
      difficulty: item.difficulty,
      tier: item.tier,
    })),
  };
}
