## ADDED Requirements

### Requirement: 消息侧镜像与命令白名单
judge SHALL 在执行前复验 `runtime_config.evaluator.image` 匹配受信镜像前缀、`evaluator.command` 匹配受信可执行白名单；不符合 MUST 拒绝执行。

#### Scenario: 恶意消息指定任意镜像
- **WHEN** 消息携带非白名单镜像或命令
- **THEN** judge 拒绝该任务且不创建容器

### Requirement: 解压实时限额
支持包解压 SHALL 在解压过程中按实际读取字节数执行单文件与总量上限，不得信任 zip 条目声明大小。

#### Scenario: 伪造条目大小
- **WHEN** zip 条目声明较小但解压输出超过上限
- **THEN** 解压中止并返回错误

### Requirement: 孤儿容器回收
judge 启动时 SHALL 按带实例标识的标签清理本实例残留容器；正常路径容器清理 MUST 在显式路径执行而非 fire-and-forget。

#### Scenario: 启动时清理残留容器

- **WHEN** judge 启动且存在带本实例标识标签的残留容器
- **THEN** 系统按标签清理这些容器，避免资源泄漏
- **WHEN** 正常评测路径完成容器清理
- **THEN** 清理操作在显式路径同步执行，不采用 fire-and-forget
