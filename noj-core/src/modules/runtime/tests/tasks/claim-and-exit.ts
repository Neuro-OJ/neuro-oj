/**
 * P4 故障夹具：领取一条后台任务后立即退出，不执行完成写入。
 *
 * 该文件只由 `worker.pg.test.ts` 作为真实子进程启动；不能作为普通测试直接运行。
 */
import { claimTasks } from "../../tasks/repository.ts";

const workerId = Deno.env.get("NOJ_CRASH_WORKER_ID") ?? "crash-fixture";
const tasks = await claimTasks(workerId, 1, 60_000);
if (tasks.length !== 1) {
  console.error(`故障夹具预期领取 1 条任务，实际 ${tasks.length}`);
  Deno.exit(2);
}

// 模拟进程在提交业务事实后、完成任务标记前退出。操作系统会关闭连接，
// 数据库只保留 leased 行，下一次 claim 会按租约回收并重试。
Deno.exit(0);
