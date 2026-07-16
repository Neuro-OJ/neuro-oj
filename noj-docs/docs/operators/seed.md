# 初始化与 seed

## seed 做什么

`noj-core/scripts/seed.ts` 会同步示例题、分类、题目分类关联、默认评测镜像白名单和管理员账号。

seed 面向开发、测试和首次初始化。正式出题应通过 Web 管理界面创建或编辑题目并上传支持包，不应依赖 seed 注册题目或支持包。

常用命令：

```bash
cd noj-core
deno task setup
```

`setup` 会先构建支持包，再执行 seed。只需要重新同步数据库时，也可以运行：

```bash
cd noj-core
deno task seed
```

## 管理员初始化

如果设置了 `ADMIN_EMAIL` 和 `ADMIN_PASS`，seed 会创建或提升对应管理员，并要求首次登录后修改密码。

如果没有设置管理员环境变量，系统会在没有可登录管理员时创建临时引导管理员，并在终端输出随机密码。

## 样例题同步

seed 使用固定题目 ID 同步仓库内置样例题。重复运行时会更新样例题标题、描述、难度和运行时配置；支持包存储 URL 由样例支持包注册流程单独维护。

## 样例支持包注册

seed 会读取 `noj-core/data/packages/<id>.zip`，通过 StorageProvider 注册到存储层，并把返回的 `noj-storage://` URL 写入样例题的 `problems.support_package_storage_url`。

如果 zip 不存在，seed 会跳过该样例题的支持包注册。

## 默认镜像白名单

seed 会同步默认 Python 双容器镜像：

- evaluator：`noj-evaluator-python:3.12`
- solution：`noj-solution-python:3.12`

这两个镜像分别用于运行出题人的 evaluator 和做题人的 solution。
