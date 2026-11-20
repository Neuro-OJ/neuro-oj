/**
 * 生产安装的默认值。
 *
 * 单独成模块：避免"默认仓库"这样的部署级常量与参数解析混在一起。
 */

/** 默认仓库主页。 */
export const DEFAULT_REPOSITORY = "https://github.com/Neuro-OJ/neuro-oj";

/** 默认 Release ref（无 Release 时由 `--ref` 覆盖）。 */
export const DEFAULT_REF = "main";
