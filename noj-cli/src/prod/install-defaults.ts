/**
 * 生产安装的默认值（原 `install.sh` 的常量，T24 迁移）。
 *
 * 为什么单独一个模块：这些值原先硬编码在 `scripts/deploy/install.sh:12` 等位置，
 * 而 T24 删除该脚本后必须有一个**显式**的落点。放在 `prod/cli.ts` 会让"默认仓库"
 * 这样的部署级常量与参数解析混在一起。
 */

/** 默认仓库主页（`install.sh:12` 的 `DEFAULT_REPOSITORY` 逐字）。 */
export const DEFAULT_REPOSITORY = "https://github.com/Neuro-OJ/neuro-oj";

/** 默认 Release ref（`install.sh` 的 `REF` 缺省；无 Release 时由 `--ref` 覆盖）。 */
export const DEFAULT_REF = "main";
