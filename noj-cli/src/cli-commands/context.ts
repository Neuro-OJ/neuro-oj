// 命令上下文的共享类型：供 cli.ts 门面与 cli-commands/ 下的分发模块共同使用。

/**
 * CLI 执行上下文，供各子命令共享。
 *
 * T23：原先还有 `deployDir`（由 `findDeployDir()` 向上查找 `noj-deploy.json`
 * 得到）——那是 JSON 编排模式的目录发现。该模态删除后，生产目录改由
 * `findProductionDir()` 单独负责（它按 `PRODUCTION_MARKERS` 判定，并会检查
 * 已安装二进制的位置），因此这个字段失去意义。
 */
export interface CommandContext {
  cwd: string;
}
