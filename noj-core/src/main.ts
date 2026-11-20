/** Core 进程入口只负责调用 application composition。 */
import { startCore } from "./modules/application/create-system.ts";

await startCore();
