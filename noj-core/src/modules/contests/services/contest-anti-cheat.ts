/**
 * 竞赛风控的共享前置校验。
 *
 * **2026-09-28 安全整改（审计 VULN-06）：基于「同 IP 多账号」的 IP 反作弊机制已整体
 * 移除。**
 *
 * 移除理由（审计判定为**直接下线**，而非收敛阈值）：
 * 1. **误伤率极高**：学校机房、高校实验室、集训队与线下赛场普遍有数十至数百名学生
 *    经同一出口 NAT 共用同一个公网 IP，"多账号同 IP"在该场景下是**常态而非异常**，
 *    以其作为作弊判定依据会产生大量误报并误导人工复核；
 * 2. **可规避性**：互联网远程比赛中，作弊者用手机热点 / VPN / 多网卡即可轻易改写
 *    来源 IP，检测对真正的攻击者近乎无效（低检出、高误报）；
 * 3. **数据最小化**：`submissions.client_ip` 是为此机制专门采集的个人数据，机制下线
 *    后不再采集、不再存储（列与相关索引已随迁移删除，留存任务一并移除）。
 *
 * 后续反作弊应聚焦于**代码相似度检测、行为时序分析与作答过程审查**等强相关特征
 * （相似度查重见 `contest-similarity.ts`，未受影响）。
 *
 * 本文件现仅保留竞赛风控端点共用的存在性断言。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { contests } from "../../../shared/db/schema.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";

/**
 * 断言竞赛存在，不存在时抛 NotFoundError。
 *
 * 供 `contest-similarity.ts` 等风控端点复用，保证同域风控端点对「竞赛不存在」
 * 的响应语义一致（404 而不是空结果）。
 */
export async function assertContestExists(contestId: string): Promise<void> {
  const db = getDb();
  const [row] = await db.select({ id: contests.id }).from(contests).where(
    eq(contests.id, contestId),
  ).limit(1);
  if (!row) throw new NotFoundError("竞赛不存在");
}
