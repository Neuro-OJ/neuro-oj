/** access 持有的域级、同事务资源能力。 */
import { eq, sql } from "drizzle-orm";
import { AppError } from "../../shared/base/errors.ts";
import type { DbTx } from "../../shared/db/executor.ts";
import { domains } from "../../shared/db/schema.ts";

/**
 * 在已锁定的 access 域行上分配题号；题目业务不能直接更新 domains 游标。
 * 调用者必须把该能力放入自己的 application 外层 DbTx。
 */
export async function allocateDomainProblemNumberTx(
  tx: DbTx,
  domainId: string,
  requestedNumber?: number,
): Promise<number> {
  if (
    requestedNumber !== undefined &&
    (!Number.isSafeInteger(requestedNumber) || requestedNumber < 1 ||
      requestedNumber >= 2147483647)
  ) {
    throw new AppError(
      "题号必须是有效正整数",
      400,
      "INVALID_PROBLEM_REFERENCE",
    );
  }
  const [allocated] = await tx.update(domains).set({
    next_problem_number: requestedNumber === undefined
      ? sql`${domains.next_problem_number} + 1`
      : sql`GREATEST(${domains.next_problem_number}, ${requestedNumber} + 1)`,
  }).where(eq(domains.id, domainId)).returning({
    next: domains.next_problem_number,
  });
  if (!allocated) {
    throw new AppError("源题工作空间不存在", 404, "DOMAIN_NOT_FOUND");
  }
  return requestedNumber ?? allocated.next - 1;
}
